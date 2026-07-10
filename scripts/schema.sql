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
