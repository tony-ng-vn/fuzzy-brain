\set ON_ERROR_STOP on

-- Run only inside the disposable pgGraph 0.1.8 Docker database described in README.md.
DO $$
BEGIN
  IF current_database() <> 'graph' THEN
    RAISE EXCEPTION 'native pgGraph probe requires the disposable graph database';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'graph'
      AND extversion = '0.1.8'
  ) THEN
    RAISE EXCEPTION 'native pgGraph probe requires graph extension 0.1.8';
  END IF;
END
$$;

CREATE SCHEMA recall_lab_native;

CREATE TABLE recall_lab_native.entities (
  id text PRIMARY KEY,
  kind text NOT NULL,
  canonical_name text NOT NULL
);

CREATE TABLE recall_lab_native.claim_edges (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES recall_lab_native.entities(id),
  target_id text NOT NULL REFERENCES recall_lab_native.entities(id),
  predicate text NOT NULL,
  why text NOT NULL,
  evidence text NOT NULL
);

INSERT INTO recall_lab_native.entities (id, kind, canonical_name)
VALUES
  ('tony', 'person', 'Tony'),
  ('doan', 'person', 'Doan'),
  ('safford', 'place', 'Safford'),
  ('arizona', 'region', 'Arizona');

INSERT INTO recall_lab_native.claim_edges (
  id,
  source_id,
  target_id,
  predicate,
  why,
  evidence
)
VALUES
  (
    'tony-doan-partner',
    'tony',
    'doan',
    'partner_of',
    'Girlfriend is the human-readable role Tony used for this relationship.',
    'Synthetic fixture approved only for the isolated experiment.'
  ),
  (
    'doan-safford-home',
    'doan',
    'safford',
    'lives_in',
    'The fixture models Doan current home as Safford.',
    'Synthetic fixture approved only for the isolated experiment.'
  ),
  (
    'safford-arizona-location',
    'safford',
    'arizona',
    'located_in',
    'Safford is a city in Arizona.',
    'Synthetic fixture approved only for the isolated experiment.'
  );

SELECT *
FROM graph.create_graph(
  graph_name := 'fuzzy_brain_recall_lab',
  namespace := 'experiments',
  graph_kind := 'user',
  residency := 'hot',
  materialization := 'shared',
  projection_mode := 'csr_readonly'
);

SELECT graph.add_table_to_graph(
  graph_name := 'fuzzy_brain_recall_lab',
  table_name := 'recall_lab_native.entities'::regclass,
  id_column := 'id',
  columns := ARRAY['kind', 'canonical_name'],
  graph_namespace := 'experiments'
);

SELECT graph.add_edge_to_graph(
  graph_name := 'fuzzy_brain_recall_lab',
  from_table := 'recall_lab_native.claim_edges'::regclass,
  from_column := 'source_id',
  to_table := 'recall_lab_native.entities'::regclass,
  to_column := 'target_id',
  label := 'claim',
  bidirectional := false,
  label_column := 'predicate',
  graph_namespace := 'experiments'
);

SELECT *
FROM graph.build_graph(
  graph_name := 'fuzzy_brain_recall_lab',
  force_persist := true,
  graph_namespace := 'experiments'
);

SELECT *
FROM graph.set_current_graph(
  graph_name := 'fuzzy_brain_recall_lab',
  namespace := 'experiments'
);

SELECT table_name, id_columns, columns
FROM graph.registered_tables();

SELECT from_table, from_column, to_table, to_column, label, label_column
FROM graph.registered_edges();

SELECT node_id, depth, edge_path, node
FROM graph.traverse(
  seed_table := 'recall_lab_native.entities'::regclass,
  seed_id := 'tony',
  max_depth := 3,
  edge_types := ARRAY['partner_of', 'lives_in', 'located_in'],
  direction := 'out',
  include_start := true,
  hydrate := true,
  max_rows := 20
);

SELECT row
FROM graph.gql(
  'MATCH (a:entities)-[r:partner_of]->(b:entities) RETURN a, r, b',
  hydrate := true
);
