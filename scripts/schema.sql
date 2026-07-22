-- The whole brain: atoms of meaning, and human-decided connections between them.
create table if not exists nodes (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

-- Two layers per node: raw is Tony's verbatim words, body is the readable layer.
-- raw is immutable by convention and by omission: no tool exposes an update path.
alter table nodes add column if not exists raw text not null default '';

-- Backfill for nodes created before the raw layer existed: the stored body is
-- the closest surviving version of the original words; title is the last resort.
update nodes set raw = body where length(trim(raw)) = 0 and length(trim(body)) > 0;
update nodes set raw = title where length(trim(raw)) = 0;

-- Same spirit as the why gate below: a node without its raw words is rejected.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'nodes'::regclass and conname = 'nodes_raw_not_blank'
  ) then
    alter table nodes add constraint nodes_raw_not_blank check (length(trim(raw)) > 0);
  end if;
end $$;

-- Every edge must carry a "why" sentence. A connection without a reason is noise.
create table if not exists edges (
  id uuid primary key default gen_random_uuid(),
  source uuid not null references nodes(id) on delete cascade,
  target uuid not null references nodes(id) on delete cascade,
  why text not null check (length(trim(why)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists edges_source_idx on edges (source);
create index if not exists edges_target_idx on edges (target);

-- The companion's memory: ratified recaps of talking sessions.
-- Talks are conversation records, not atoms of meaning; the views never render them.
create table if not exists talks (
  id uuid primary key default gen_random_uuid(),
  recap text not null check (length(trim(recap)) > 0),
  created_at timestamptz not null default now()
);

-- === Evidence store (Phase 1) ===
-- A second, separate layer alongside nodes/edges/talks above: ingested life
-- data that is mechanical, high-volume, and NEVER treated as true. Zero
-- foreign keys point from here into nodes or edges, in either direction --
-- meaning only ever arrives later as a ratified node/edge from conversation
-- with Tony. See AGENTS.md and docs/adr/0002-digital-brain-phase-0-decisions.md.

-- sources: registry of where ingested evidence comes from. One row per
-- configured source (not per ingested item). This table is CONFIGURATION,
-- not record: unlike episodes/evidence below, a narrow, named set of its
-- columns may be updated after creation (see scripts/brain.mjs) -- kind and
-- label never change once written, but exclusions is operational state.
create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (length(trim(kind)) > 0),
  label text not null check (length(trim(label)) > 0),
  sync_cursor text,
  last_synced_at timestamptz,
  exclusions jsonb not null default '[]'
    check (jsonb_typeof(exclusions) = 'array'),
  created_at timestamptz not null default now(),
  constraint sources_kind_label_unique unique (kind, label)
);

-- episodes: one ingested unit (a session, a meeting, a thread window),
-- captured whole. raw has already passed through the local sensitive-
-- pattern filter before this row is ever written (scripts/brain.mjs's
-- add-episode) -- "lands... untouched" (the master plan's Phase 2) means
-- unedited for meaning, not unfiltered for SSN/credit-card-shaped spans.
-- Immutable once written: no verb ever updates any column here, ever.
--
-- Deferred, named but not built: whole-episode deletion tracking (an entire
-- thread or meeting removed at the source after ingestion, as opposed to a
-- single message inside one -- that is evidence.sender_deleted_at below).
-- No column exists yet; it is a single additive nullable timestamptz when
-- the first source that can produce this signal ships (candidate: Phase 5
-- iMessage). Not building it now is ADR-0001 discipline: no Phase 1 source
-- can produce this signal.
create table if not exists episodes (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete restrict,
  source_locator text,
  raw text not null check (length(trim(raw)) > 0),
  occurred_at timestamptz,
  occurred_until timestamptz,
  ingested_at timestamptz not null default now(),
  constraint episodes_occurred_span_ordered
    check (occurred_until is null or occurred_at is null or occurred_until >= occurred_at)
);

create index if not exists episodes_source_idx on episodes (source_id);
create unique index if not exists episodes_source_locator_idx
  on episodes (source_id, source_locator)
  where source_locator is not null;

-- evidence: atomic verbatim spans inside an episode. Immutable once
-- written, with exactly one deliberate exception: sender_deleted_at,
-- set-once via scripts/brain.mjs's mark-sender-deleted -- the only update
-- statement this store's tooling ever issues against a record column.
-- quote, once written, never changes: same discipline as nodes.raw.
create table if not exists evidence (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references episodes(id) on delete restrict,
  quote text not null check (length(trim(quote)) > 0),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null,
  speaker text check (speaker is null or length(trim(speaker)) > 0),
  occurred_at timestamptz,
  ingested_at timestamptz not null default now(),
  sender_deleted_at timestamptz,
  redaction_reason text check (redaction_reason is null or length(trim(redaction_reason)) > 0),
  constraint evidence_offsets_ordered check (end_offset > start_offset),
  constraint evidence_unique_span unique (episode_id, start_offset, end_offset),
  constraint evidence_redaction_is_placeholder_only
    check (redaction_reason is null or quote = ('[REDACTED:' || redaction_reason || ']'))
);

create index if not exists evidence_episode_idx on evidence (episode_id);

-- === Retrieval columns (Phase 3) ===
-- Embeddings + full-text over evidence (and nodes, nearly free) so recall
-- can find spans across everything ingested. Additive only: no existing
-- column, row, or constraint above changes.

-- pgvector; WITH SCHEMA public so the vector type resolves from both
-- public and brain_dev through the migration's search_path.
create extension if not exists vector with schema public;

-- embedding is DERIVED data: nullable on purpose, filled after the fact by
-- scripts/embed-sweep.mjs so every write path stays lean and model-free.
-- Recall tolerates nulls -- full-text still finds unswept rows.
alter table evidence add column if not exists embedding vector(768);
alter table nodes add column if not exists embedding vector(768);

-- Generated full-text projections. left() caps the indexed text because
-- tsvector has a 1MB hard limit and real spans already reach 365k chars
-- (pasted transcripts); a pathological span must never be able to fail an
-- insert or a migration rewrite. Search sees the capped prefix only.
alter table evidence add column if not exists fts tsvector
  generated always as (to_tsvector('english', left(quote, 200000))) stored;

-- Node weights: a title hit outranks the same word buried in raw or body.
alter table nodes add column if not exists fts tsvector
  generated always as (
    setweight(to_tsvector('english', left(title, 10000)), 'A')
    || setweight(to_tsvector('english', left(raw, 100000)), 'B')
    || setweight(to_tsvector('english', left(body, 100000)), 'C')
  ) stored;

create index if not exists evidence_fts_idx on evidence using gin (fts);
create index if not exists nodes_fts_idx on nodes using gin (fts);

-- HNSW cosine indexes for the vector lane; null embeddings simply never
-- enter the index, which is how unswept rows stay invisible to it.
create index if not exists evidence_embedding_idx on evidence using hnsw (embedding vector_cosine_ops);
create index if not exists nodes_embedding_idx on nodes using hnsw (embedding vector_cosine_ops);
