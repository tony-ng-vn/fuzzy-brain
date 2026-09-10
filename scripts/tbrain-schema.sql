-- Additive capture metadata. Existing sources, episodes and evidence stay canonical.
create table if not exists archive_records (
  id uuid primary key,
  source_id uuid not null references sources(id) on delete restrict,
  source_key text not null,
  revision text not null,
  episode_id uuid not null unique references episodes(id) on delete restrict,
  parent_id uuid references archive_records(id) on delete restrict,
  digest text not null check (length(digest) = 64),
  stored_digest text not null check (length(stored_digest) = 64),
  bundle jsonb not null check (bundle->>'format' = 'tbrain.transfer.v1'),
  receipt jsonb not null check (receipt->>'state' = 'committed'),
  created_at timestamptz not null default now(),
  unique (source_id, source_key, revision),
  check (bundle->'reflection' = 'null'::jsonb or
    (bundle->'reflection'->>'author' = 'assistant' and bundle->'reflection'->>'status' = 'provisional'))
);
create index if not exists archive_records_parent_idx on archive_records(parent_id);
create table if not exists archive_messages (
  evidence_id uuid primary key references evidence(id) on delete restrict,
  archive_id uuid not null references archive_records(id) on delete restrict,
  ordinal integer not null check (ordinal >= 0),
  unique (archive_id, ordinal)
);

create or replace function reject_archive_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'archive history is append-only';
end;
$$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid='archive_records'::regclass and tgname='archive_records_immutable') then
    create trigger archive_records_immutable before update or delete on archive_records
      for each row execute function reject_archive_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='archive_messages'::regclass and tgname='archive_messages_immutable') then
    create trigger archive_messages_immutable before update or delete on archive_messages
      for each row execute function reject_archive_mutation();
  end if;
end $$;

create or replace function protect_archived_source() returns trigger language plpgsql as $$
declare protected boolean;
begin
  if tg_table_name = 'episodes' then
    execute format('select exists(select 1 from %I.archive_records where episode_id=$1)',tg_table_schema) into protected using old.id;
    if protected then raise exception 'archived source is append-only'; end if;
  else
    execute format('select exists(select 1 from %I.archive_messages where evidence_id=$1)',tg_table_schema) into protected using old.id;
    if protected and (tg_op='DELETE' or
      (to_jsonb(new)-'embedding'-'fts'-'sender_deleted_at') is distinct from (to_jsonb(old)-'embedding'-'fts'-'sender_deleted_at')) then
      raise exception 'archived source is append-only';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
do $$ begin
  if not exists(select 1 from pg_trigger where tgrelid='episodes'::regclass and tgname='archived_episode_immutable') then
    create trigger archived_episode_immutable before update or delete on episodes for each row execute function protect_archived_source();
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='evidence'::regclass and tgname='archived_evidence_immutable') then
    create trigger archived_evidence_immutable before update or delete on evidence for each row execute function protect_archived_source();
  end if;
end $$;
