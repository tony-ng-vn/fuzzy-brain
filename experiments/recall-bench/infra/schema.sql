-- DDL for all four recall-bench tiers, guarded by :tier (DESIGN.md section 3.5).
--
-- Invoke as: psql -v tier=quality50k -f infra/schema.sql
-- tier defaults to quality50k when not supplied. Valid values: smoke1k,
-- quality50k, rehearsal1m, full10m.
--
-- This file only ever runs against the disposable recallbench database
-- (DESIGN.md section 0). It never touches the managed brain.

\set ON_ERROR_STOP on

\if :{?tier}
\else
  \set tier quality50k
\endif

-- Map tier -> schema name (section 3.4) and tier -> vector shape (section 3.5)
-- in one round trip. schema_name comes back NULL, and \gset unsets it, when
-- the tier name is not one of the four recognized values.
select case :'tier'
         when 'smoke1k'     then 'bench_smoke'
         when 'quality50k'  then 'bench_q50k'
         when 'rehearsal1m' then 'bench_r1m'
         when 'full10m'     then 'bench_x10m'
       end as schema_name,
       :'tier' in ('smoke1k', 'quality50k') as is_real_vector
\gset

\if :{?schema_name}
\else
  \echo 'schema.sql: unknown tier ':tier'; expected smoke1k, quality50k, rehearsal1m, or full10m'
  do $$ begin raise exception 'schema.sql: unknown tier'; end $$;
\endif

create extension if not exists vector;
create extension if not exists pg_trgm;

create schema if not exists :schema_name;

-- Destructive is fine here and only here (section 0): recallbench is created,
-- filled, measured, and thrown away, so a rerun of this file must be able to
-- replace a tier's table rather than fail on a leftover from a prior sweep.
drop table if exists :schema_name.memories;

-- The term-statistics side tables (DESIGN.md 6.6) are derived from memories,
-- so they are dropped alongside it rather than left describing a corpus that
-- no longer exists. load.mjs's buildTermStats rebuilds both after the load.
drop table if exists :schema_name.term_stats;
drop table if exists :schema_name.lexeme_stats;

\if :is_real_vector

-- Real-vector tiers (smoke1k, quality50k): 768-dim real embeddings, weighted
-- fts mirrors scripts/schema.sql (title A, raw B, body C) so what the bench
-- learns transfers to the real recall path.
create table :schema_name.memories (
  id            bigint primary key,
  kind          text not null,
  title         text not null,
  body          text not null,
  raw           text not null,
  people        text[] not null default '{}',
  places        text[] not null default '{}',
  tags          text[] not null default '{}',
  occurred_at   timestamptz not null,
  cluster_id    int not null,
  dup_group     int,
  rare_token    text,
  embedding     vector(768),
  fts tsvector generated always as (
      setweight(to_tsvector('english', title), 'A')
   || setweight(to_tsvector('english', raw),   'B')
   || setweight(to_tsvector('english', body),  'C')
  ) stored
);

create index on :schema_name.memories using gin (fts);
create index on :schema_name.memories using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 200);
create index on :schema_name.memories using gin (people array_ops);
create index on :schema_name.memories using gin (tags   array_ops);
create index on :schema_name.memories (occurred_at);
create index on :schema_name.memories using gin ((title || ' ' || body) gin_trgm_ops);

\else

-- Synthetic-vector tiers (rehearsal1m, full10m): 256-dim halfvec, unlogged
-- (disposable, and it skips WAL).
--
-- `fts` is stored, not an expression index over to_tsvector('english', body).
-- An earlier revision skipped it to save heap at 10M; the 1M rehearsal then
-- measured what the recompute costs and reversed the trade (DESIGN.md 6.7).
-- Measured at 1M: the column adds 213 bytes/row -- 227 MB here, ~2.1 GB at
-- 10M against the 30 GB rung-3 gate -- and removes 10.4 us per candidate row,
-- which every lexical lane pays up to its 400-row cap on every query.
create unlogged table :schema_name.memories (
  id          bigint primary key,
  body        text not null,
  kind_id     smallint not null,
  person_id   smallint not null,
  place_id    smallint not null,
  occurred_at date not null,
  cluster_id  int not null,
  embedding   halfvec(256),
  fts         tsvector generated always as (to_tsvector('english', body)) stored
);

create index on :schema_name.memories using gin (fts);
create index on :schema_name.memories using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 128);
create index on :schema_name.memories (occurred_at);
create index on :schema_name.memories (person_id, occurred_at);

\endif

\echo 'schema.sql: tier ':tier' ready in schema ':schema_name
