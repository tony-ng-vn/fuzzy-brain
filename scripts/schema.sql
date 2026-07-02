-- The whole brain: atoms of meaning, and human-decided connections between them.
create table if not exists nodes (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

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
