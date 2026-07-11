# Polygres recall lab

This is an isolated correctness experiment for Fuzzy Brain's future recall system.

It does not change the current application schema or the public brain.
All fixture tables use the `brain_dev.recall_lab_` prefix, and the setup command verifies that the public node, edge, and talk counts remain unchanged inside the same transaction.

## What it tests now

- PostgreSQL tables as the authoritative evidence and claim store.
- Built-in full-text search over generated `tsvector` columns.
- pgvector similarity search over deterministic fixture vectors.
- An HNSW vector index in `brain_dev`.
- Typed claim traversal with a recursive relational query.
- A generic epistemic policy for supported, missing, conflicting, inaccessible, and retrieval-failure states.
- A source registry that tells the controller which authorized action may resolve missing knowledge.

The fixed eight-dimensional vectors only test plumbing.
They do not measure whether a production embedding model understands Tony.

## Native pgGraph isolation

The managed database currently has pgGraph 0.1.7.
That version has one database-global graph registration and projection.
Registering the synthetic `brain_dev` tables would therefore alter the graph configuration already pointing at the public brain.

Native pgGraph experiments become safely isolatable after either:

1. The managed extension is upgraded to pgGraph 0.1.8 and the lab receives its own named graph.
2. The lab runs in a disposable PostgreSQL database or container with pgGraph 0.1.8.

The managed `brain_dev` lab intentionally uses recursive SQL while leaving that global registration untouched.
The companion `native-pggraph.sql` probe runs the same topology in a disposable local pgGraph 0.1.8 container and uses its own named graph.

## Run it

```sh
node experiments/polygres-recall-lab/run.mjs setup
node experiments/polygres-recall-lab/run.mjs status
node experiments/polygres-recall-lab/run.mjs compare
```

The compare command is read-only.
It reports sentence-only retrieval, vector seeding, typed multi-hop traversal, and epistemic-state decisions from the same Polygres database.

## Run the disposable pgGraph 0.1.8 probe

Do not run this SQL against the managed brain.
It is guarded for the Docker image's `graph` database and graph extension 0.1.8, but the intended boundary is a fresh disposable container.

```sh
docker run -d --rm --name fuzzy-brain-pggraph-lab \
  -e POSTGRES_PASSWORD=lab \
  -p 127.0.0.1:55432:5432 \
  ghcr.io/evokoa/pggraph:0.1.8

docker exec -i fuzzy-brain-pggraph-lab \
  psql -X -U postgres -d graph -f - \
  < experiments/polygres-recall-lab/native-pggraph.sql

docker stop fuzzy-brain-pggraph-lab
```

The verified fixture loads four entities and three direct relationship edges.
Traversal from Tony reaches Doan at depth 1, Safford at depth 2, and Arizona at depth 3.
The hydrated `partner_of` relationship also returns its `why` and `evidence` fields.
The official pgGraph image does not include pgvector, so the managed `brain_dev` lab remains the vector and HNSW probe.

## Scale ladder

Do not jump directly to a large synthetic corpus.
Advance only after the prior tier preserves correct evidence paths and epistemic states.

1. 100 claims: correctness and identity resolution.
2. 1,000 claims: duplicate names and ambiguous anchors.
3. 10,000 claims: index behavior and bounded path expansion.
4. 100,000 claims: p50 and p95 latency, storage, index build time, and false-path rate.

Correctness gates come before speed because a fast unsupported answer is still a failed personal brain.
