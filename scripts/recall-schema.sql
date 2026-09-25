-- Hash keys stay small even when a saved title exceeds the B-tree entry limit.
-- Recall also compares the full title, so a hash collision cannot create a match.
create index if not exists nodes_title_lookup_idx on nodes (md5(lower(title)));
