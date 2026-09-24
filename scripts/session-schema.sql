select pg_advisory_xact_lock(hashtextextended(current_schema() || ':session-checkpoint-migration', 0));
create table if not exists session_ingest_checkpoints (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete restrict,
  session_key text not null check (length(trim(session_key)) > 0),
  parser_version integer not null check (parser_version > 0),
  file_mtime_ms double precision not null check (file_mtime_ms >= 0 and file_mtime_ms < 'Infinity'::double precision),
  file_size bigint not null check (file_size >= 0),
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  checked_at timestamptz not null default now(),
  unique (source_id, session_key, parser_version, input_digest),
  check ((result->>'state') is not distinct from 'committed'
    and (result->>'checkpoint_id') is not distinct from id::text)
);
create index if not exists session_ingest_checkpoints_source_latest_idx
  on session_ingest_checkpoints(source_id, session_key, checked_at desc);

create or replace function reject_session_checkpoint_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'session checkpoints are append-only';
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'session_ingest_checkpoints'::regclass and tgname = 'session_checkpoints_append_only') then
    create trigger session_checkpoints_append_only before update or delete on session_ingest_checkpoints
      for each row execute function reject_session_checkpoint_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'session_ingest_checkpoints'::regclass and tgname = 'session_checkpoints_no_truncate') then
    create trigger session_checkpoints_no_truncate before truncate on session_ingest_checkpoints
      for each statement execute function reject_session_checkpoint_mutation();
  end if;
end $$;
