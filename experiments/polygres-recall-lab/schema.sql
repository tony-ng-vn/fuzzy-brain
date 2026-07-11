create table if not exists brain_dev.recall_lab_relation_types (
  predicate text primary key,
  human_label text not null,
  aliases text[] not null default '{}',
  inverse_predicate text,
  subject_kinds text[] not null default '{}',
  object_kinds text[] not null default '{}',
  is_temporal boolean not null default false,
  traversal_policy text not null default 'allowed'
    check (traversal_policy in ('allowed', 'evidence_only', 'blocked'))
);

create table if not exists brain_dev.recall_lab_episodes (
  id uuid primary key,
  source_kind text not null,
  source_locator text,
  raw text not null check (length(trim(raw)) > 0),
  occurred_at timestamptz,
  recorded_at timestamptz not null default now(),
  is_synthetic boolean not null default true
);

create table if not exists brain_dev.recall_lab_evidence_spans (
  id uuid primary key,
  episode_id uuid not null references brain_dev.recall_lab_episodes(id),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  quote text not null check (length(trim(quote)) > 0),
  source_locator text,
  unique (episode_id, start_offset, end_offset)
);

create table if not exists brain_dev.recall_lab_entities (
  id uuid primary key,
  kind text not null,
  canonical_name text not null,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (kind, canonical_name)
);

create table if not exists brain_dev.recall_lab_claims (
  id uuid primary key,
  subject_entity_id uuid not null references brain_dev.recall_lab_entities(id),
  predicate text not null references brain_dev.recall_lab_relation_types(predicate),
  object_entity_id uuid references brain_dev.recall_lab_entities(id),
  object_value jsonb,
  evidence_span_id uuid references brain_dev.recall_lab_evidence_spans(id),
  authority text not null
    check (authority in ('tony_ratified', 'source_asserted', 'machine_proposed')),
  status text not null
    check (status in ('ratified', 'proposed', 'disputed', 'superseded', 'rejected')),
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz not null default now(),
  supersedes_claim_id uuid references brain_dev.recall_lab_claims(id),
  check ((object_entity_id is null) <> (object_value is null)),
  check (valid_to is null or valid_from is null or valid_to > valid_from)
);

create index if not exists recall_lab_claim_subject_predicate_idx
  on brain_dev.recall_lab_claims (subject_entity_id, predicate);

create index if not exists recall_lab_claim_object_idx
  on brain_dev.recall_lab_claims (object_entity_id)
  where object_entity_id is not null;

create table if not exists brain_dev.recall_lab_meaning_edges (
  id uuid primary key,
  source_kind text not null check (source_kind in ('episode', 'entity', 'claim')),
  source_id uuid not null,
  target_kind text not null check (target_kind in ('episode', 'entity', 'claim')),
  target_id uuid not null,
  why text not null check (length(trim(why)) > 0),
  authority text not null default 'tony_ratified'
    check (authority = 'tony_ratified'),
  ratified_at timestamptz not null default now()
);

create table if not exists brain_dev.recall_lab_search_documents (
  id uuid primary key,
  document_kind text not null
    check (document_kind in ('sentence_only', 'claim_projection', 'episode_projection')),
  source_id uuid not null,
  body text not null check (length(trim(body)) > 0),
  search_vector tsvector generated always as (to_tsvector('english', body)) stored,
  embedding vector(8),
  metadata jsonb not null default '{}',
  unique (document_kind, source_id)
);

create index if not exists recall_lab_search_documents_fts_idx
  on brain_dev.recall_lab_search_documents using gin (search_vector);

create index if not exists recall_lab_search_documents_hnsw_idx
  on brain_dev.recall_lab_search_documents
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

create table if not exists brain_dev.recall_lab_resolution_paths (
  id uuid primary key,
  subject_entity_id uuid references brain_dev.recall_lab_entities(id),
  predicate text not null,
  source_kind text not null,
  source_locator text not null,
  required_scope text,
  authorized boolean not null default false,
  lookup_hint text,
  priority integer not null default 100,
  unique (subject_entity_id, predicate, source_kind, source_locator)
);

create table if not exists brain_dev.recall_lab_search_traces (
  id uuid primary key default gen_random_uuid(),
  query text not null check (length(trim(query)) > 0),
  epistemic_state text,
  selected_action text,
  plan jsonb not null default '[]',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists brain_dev.recall_lab_search_trace_steps (
  trace_id uuid not null references brain_dev.recall_lab_search_traces(id) on delete cascade,
  step_no integer not null check (step_no > 0),
  operator text not null,
  from_ref text,
  to_ref text,
  result_state text,
  reason text not null,
  evidence_span_id uuid references brain_dev.recall_lab_evidence_spans(id),
  elapsed_ms double precision,
  primary key (trace_id, step_no)
);

