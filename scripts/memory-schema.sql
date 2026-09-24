-- Delivery receipts record an operation, never a new approved belief.
select pg_advisory_xact_lock(hashtextextended(current_schema() || ':memory-write-migration', 0));
create table if not exists memory_write_receipts (
  request_id uuid primary key,
  operation text not null check (operation in ('add-node', 'mark-complete')),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  check ((result->>'state') is not distinct from 'committed'
    and (result->>'request_id') is not distinct from request_id::text
    and (result->>'operation') is not distinct from operation)
);

create or replace function reject_memory_receipt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'memory write receipts are append-only';
end;
$$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'memory_write_receipts'::regclass
      and tgname = 'memory_write_receipts_append_only'
  ) then
    create trigger memory_write_receipts_append_only
    before update or delete on memory_write_receipts
    for each row execute function reject_memory_receipt_mutation();
  end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'memory_write_receipts'::regclass
      and tgname = 'memory_write_receipts_no_truncate'
  ) then
    create trigger memory_write_receipts_no_truncate
    before truncate on memory_write_receipts
    for each statement execute function reject_memory_receipt_mutation();
  end if;
end $$;
