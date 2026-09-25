-- Hash keys stay small even when a saved title exceeds the B-tree entry limit.
-- Recall also compares the full title, so a hash collision cannot create a match.
-- Qualify the table so a missing sandbox prerequisite cannot fall back to public.
do $$
begin
  execute format('create index if not exists nodes_title_lookup_idx on %I.nodes (md5(lower(title)))', current_schema());
end;
$$;
