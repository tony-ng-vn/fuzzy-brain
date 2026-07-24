# Polygres knowledge base

A living reference for everything we know about Polygres and the Evokoa extension ecosystem.

This doc has two jobs.
First, it is a place to keep adding what we learn, so knowledge does not get lost in chat history.
Second, it is portable: an AI working in a different project can read this one file and understand what Polygres is, what it offers, and how to decide whether to use it.

Last verified: 2026-07-22.
Maintainer note: when you learn something new, add it under the right section and update the "Last verified" date and the changelog at the bottom of this file. Prefer appending over rewriting, and keep point-in-time claims dated.

---

## What Polygres is

Polygres is a hosted PostgreSQL platform built by a company called Evokoa.
The pitch is that you keep everything (application data, vectors, graph structure, permissions, backups, replication) inside one PostgreSQL database instead of bolting a separate vector database or graph database next to it.

- Website: https://polygres.com
- Company GitHub org: https://github.com/Evokoa
- Community: Discord at https://discord.gg/RFSHD5DgKP
- Team size: small (self-described three-person team as of July 2026), shipping fast.

The strategy is to move the hard retrieval work into Postgres extensions written in Rust, and to offer those same extensions pre-installed on their managed platform.
That means you get Rust-level performance and safety exactly where it matters (inside the database engine, in index structures and traversal loops) without writing or maintaining any Rust yourself.

---

## The Evokoa product family

As of July 2026 there are three related products, all from the same team, all Rust, all Postgres-native.
They are complementary, not competitors: graph traversal, vector/hybrid search, and a hosted agent-memory product built on top.

### pgGraph (extension name: `graph`)

Graph traversal and relationship queries over your existing relational tables.

- Repo: https://github.com/Evokoa/pgGraph
- Docs: docs.evokoa.com (was returning HTTP 522 during our July 2026 checks, so lean on the README and the live function catalog).
- Maturity as of 2026-07-22: ~549 stars, 311 commits, release line 0.1.x (0.1.8 published 2026-06-29), active maintenance. The most mature of the three.
- Supported Postgres: 14 through 18.
- License: check the repo (Apache-2.0 family, consistent with pgContext).
- Install paths: Docker (`ghcr.io/evokoa/pggraph:0.1.8`, multi-arch), Homebrew (Evokoa tap, macOS/PG17), PGXN (source, needs Rust + cargo-pgrx), or `make install` from source. Managed: pre-installed on Polygres.

How it works:

- It builds a derived graph index (compressed sparse row / CSR structures in memory) over tables you already have. Your application data does not move; the tables stay the source of truth.
- Registration does attach live sync triggers to the source tables, so it is more than a passive shadow index: every insert/update/delete on a registered table is captured to keep the graph in sync. This is worth stating plainly because it is a write-path instrumentation, not read-only.
- Claims: O(1) adjacency lookup, sub-millisecond traversal, bounded traversal with depth limits, visited-node tracking, and circuit breakers. Multi-tenant support. SQL-native, no Cypher required (though Cypher and GQL are supported).

Core SQL API (signatures pulled from a live install; the README documents fewer parameters):

```
graph.add_table(table_name oid, id_column text, columns text[], tenant_column text) -> void
graph.add_table(table_name oid, id_columns text[], columns text[], tenant_column text) -> void
graph.add_edge(from_table oid, from_column text, to_table oid, to_column text, label text,
               bidirectional boolean, weight_column text, label_column text) -> void
graph.build() -> ...            -- materialize the traversable projection
graph.build_status() -> ...     -- build progress
graph.status() -> ...           -- node_count, edge_count, sync_mode, pending_sync_rows, etc.
graph.search(property_key text, property_value text, table_filter oid, mode text,
             case_sensitive boolean, max_rows integer, row_offset integer, tenant text,
             hydrate boolean) -> TABLE(node_table oid, node_id text, match_type text,
             score real, verified boolean, node jsonb, node_table_name text)
graph.shortest_path(source_table oid, source_id text, target_table oid, target_id text,
                    max_depth integer, hydrate boolean) -> TABLE(step integer, ...)
graph.weighted_shortest_path(...) -> ...
graph.cypher(query text, params jsonb, hydrate boolean) -> TABLE("row" jsonb)
graph.gql(query text, params jsonb, hydrate boolean) -> TABLE("row" jsonb)
graph.traverse(...) -> ...
graph.registered_tables() / graph.registered_edges()   -- introspection, read-only
```

A live install exposes roughly 97 functions in the `graph` schema; the above is the load-bearing subset.

### pgContext

Vector search plus hybrid (dense + full-text) retrieval, built into Postgres.
This is the direct pgvector competitor.

- Repo: https://github.com/Evokoa/pgContext (note: lowercase in some links, `evokoa/pgContext`).
- Launched 2026-07-21, release v0.1.0. Very new.
- Maturity as of 2026-07-22: ~59 stars, Apache-2.0, primary language Rust. A recent commit was `ci(jobs): remove failing Rust and pgvector checks` (2026-07-22), which is a maturity signal worth watching.
- Supported Postgres: 17 only for V1. 15/16/18 are on a post-V1 certification roadmap.
- Install: Docker (`ghcr.io/evokoa/pgcontext:pg17-v0.1.0`, multi-arch), source (Rust 1.96.0, cargo-pgrx 0.19.1, PG17 headers), PGXN (`pgxn install pgContext`). Homebrew in progress. Managed version on Polygres.

Capabilities:

- Distance metrics: L2, inner-product, cosine, L1.
- Exact vector search and persisted, page-native HNSW indexes.
- Filter-aware ANN over registered columns and JSONB paths (filter alongside vectors without building separate indexes).
- Exact-score rechecks under Postgres MVCC, ACLs, and RLS.
- Collections, scrolling, counts, facets, grouping.
- Dense + full-text hybrid retrieval fused with reciprocal-rank fusion (RRF), no application glue.

Core SQL API:

```
pgcontext.create_collection(name, table)
pgcontext.register_vector(collection, vector_name, column, dims, metric)
pgcontext.register_filter_column(...)
pgcontext.register_jsonb_path(...)
pgcontext.upsert_points(...)
pgcontext.search(collection, vector, filter jsonb, limit)
pgcontext.query(collection, vector, text_query, text_column, limit)   -- hybrid RRF
pgcontext.grouped_search(...) / pgcontext.facet(...) / pgcontext.count(...) / pgcontext.scroll(...)
```

Benchmark claim (from the README, verbatim intent):
On GloVe-100-angular (1,183,514 vectors, cosine), pgContext matches pgvector recall at every setting while answering each query 3.8x to 5.3x faster.
Example: 0.910 recall@10 at 2.4 ms versus 13.0 ms for pgvector at ef_search 512.
Same PostgreSQL 17 container, same parallel build budget, Apple M4 Pro (NEON).
A three-way comparison against Qdrant is referenced; Qdrant is said to lead at very high recall via per-query segment parallelism.
Caveat: the benchmark is at ~1.18M vectors, which is far above small personal datasets. At small scale pgvector already answers in low milliseconds, so the practical win is ergonomics and headroom, not wall-clock speed.

CRITICAL COMPATIBILITY FACT (verified from pgContext's own migration docs, 2026-07-22):
pgContext is NOT a drop-in replacement for pgvector and does NOT read existing pgvector `vector(n)` columns.

- It defines its own PostgreSQL vector type and index access method. The displayed type name is also `vector`, but it is a different type OID, so values are not interchangeable.
- Coexistence with pgvector in one database is "still evolving and is not yet fully supported."
- There is experimental tooling (`pgcontext.migration_report()`, `pgcontext.adopt_pgvector(dry_run=true)`, `pgcontext.compare_indexes(...)`) but the docs call it experimental and incomplete, and `pgcontext.enable_pgvector_binding()` always raises `feature_not_supported`.

Implication: adopting pgContext on a database already using pgvector means migrating the embedding layer into pgContext's collection format, not a swap.
The signal to revisit is not elapsed time; it is their changelog stating that pgvector coexistence is supported.

### Pocket

Persistent, "infinite" context memory for coding agents.
Launched 2026-07-22, free at launch with $50 in credits for a new Polygres account.

- What it is: a hosted place where a coding agent stores an entire codebase plus surrounding context (files, symbols, ADRs, PR/issue history, test results, learned conventions, cross-session progress) and retrieves the right pieces on demand instead of grepping. Marketed as "a graphRAG you never have to learn how to build."
- Built on Polygres' architecture (the same graph + vector + full-text stack).
- No published benchmarks yet as of 2026-07-22 (a reply in the launch thread asked, answer was "we will").
- It is a vendor-hosted context store. It has no ratification or provenance layer of its own.

### SDK, CLI, and skills

The Evokoa org also ships tooling (all Python as of July 2026):

- `polygres-sdk` (Python SDK)
- `polygres-cli` (command-line interface)
- `polygres-skills` (agent skills for operating Polygres from Codex, Claude Code, and compatible agents)
- `homebrew-tap` (Homebrew packages for the extensions)

---

## How to decide whether to use Polygres (for any project)

A short decision guide, generalized from the fuzzy-brain analysis.

1. If your data already lives in Postgres and you need vector search, graph traversal, or hybrid retrieval, these extensions let you avoid standing up a separate service. That is the main reason to care.
2. The language of your application layer almost never needs to change. The heavy lifting is in the C/Rust engine (Postgres itself, the extensions, and any ONNX/embedding runtime). Your app code is glue; keep it in whatever language your team is productive in. Rust arrives correctly through the extension layer, not through rewriting your own orchestration code.
3. Check the compatibility fine print before committing. Specifically: pgContext does not currently coexist cleanly with pgvector. If you already use pgvector, treat pgContext as a future migration, gated on their changelog, not a swap.
4. Prefer derived-index extensions (pgGraph, pgContext) for experiments because they build structures over your existing tables and leave your source data portable. You can walk away.
5. Weigh maturity honestly. pgGraph is the most proven. pgContext and Pocket are days old at the time of writing; let other people find the bugs before you depend on them for anything important.
6. If a project's value is data sovereignty and provenance (you must own the data and control what is trusted), be cautious with the fully hosted products (Pocket). Self-hosted or managed extensions over tables you own preserve ownership; a hosted context store does not.

---

## This project's Polygres instance (fuzzy-brain specifics)

These facts are specific to fuzzy-brain's database and may differ in other projects.

- Connection: `DATABASE_URL` in `.env.local` (not committed). Points at a managed Polygres instance.
- Server: PostgreSQL 17.10 (Debian build).
- Connecting role: `project_owner`. NOT a superuser, cannot create databases, cannot `CREATE EXTENSION`. Extension installation happens at the platform level, not from app credentials.
- Installed extensions (as of 2026-07-22): `plpgsql`, `vector` 0.8.2 (pgvector), and `graph` 0.1.7 (pgGraph).
- Schemas: `public` (the real brain, production data) and `brain_dev` (destructive experiments, tests, seeds only; migrations rehearse here first).

pgGraph state on this instance (important):

- Polygres pre-installed and auto-registered pgGraph over the LIVE `public.nodes` and `public.edges` tables (not staged in `brain_dev`). This was done platform-side; the app credentials could not have done it (needs superuser).
- Sync triggers are attached and enabled on `public.nodes` and `public.edges` (`graph_sync_insert/update/delete/truncate`). No columns were added to those tables; the schema is unchanged.
- Registered mapping:
  - `public.nodes` with id column `id`, tracked columns `type, title, body`.
  - `public.edges` with id column `id`, tracked column `why`.
  - Edges: `public.edges.source -> public.nodes.id` (label "source", bidirectional) and `public.edges.target -> public.nodes.id` (label "target", bidirectional).
- The graph projection has NOT been built yet: `graph.status()` showed `node_count=0`, `edge_count=0`, empty `last_build`, `pending_sync_rows=14`, `projection_mode=csr_readonly`. Registration is wired, but no traversable graph exists until someone runs `graph.build()`.
- As of 2026-07-22 the ratified brain is tiny: 6 nodes, 3 edges. A traversal lane cannot demonstrate value at this size (everything is within one hop of what it links to). The right trigger to build the graph and add a traversal lane to recall is graph density (a few dozen edges), not the calendar.

Known platform quirk (from earlier guardrails work):

- The Polygres connection pooler strips the `statement_timeout` startup parameter. Setting it as a client connection parameter emits a warning but does not error (exit 0). For fuzzy-brain we removed `statement_timeout` from the client guardrails for this reason. Use application-level timeouts (connect timeout, query cancellation) instead of relying on server `statement_timeout` through the pooler.

Current standing decisions for fuzzy-brain:

- Keep TypeScript as the application shell. Rust enters through the extensions, not a rewrite. See the language analysis in session history and the ADRs.
- pgGraph: do not run `graph.build()` yet. Revisit when the ratified graph is denser. When built, it becomes a candidate fourth lane in `scripts/recall.mjs` alongside the existing exact/OR full-text and vector cosine lanes.
- pgContext: do not adopt yet. It is incompatible with the pgvector foundation the retrieval layer is built on. Revisit only when their changelog reports pgvector coexistence support.
- Pocket: interesting as validation of the GraphRAG-on-Postgres direction, but do not put brain data in it. It lacks the ratification layer that is fuzzy-brain's whole point.

---

## Related in-repo docs

- `docs/research/2026-07-10-polygres-semantic-and-graph-capabilities.md` -- deeper point-in-time research on semantic and graph capabilities.
- `docs/research/2026-07-10-polygres-utilization-deep-dive.md` -- how to utilize Polygres, point-in-time.
- `docs/adr/0001-defer-the-retrieval-architecture.md` and `docs/adr/0002-digital-brain-phase-0-decisions.md` -- architecture decisions the above analysis rests on.

Those research files are dated snapshots.
This file is the living index that supersedes and points back to them.

---

## Change log for this doc

- 2026-07-22: Created. Captured the three-product family (pgGraph, pgContext, Pocket), the pgContext/pgvector incompatibility fact, the fuzzy-brain instance state (pgGraph pre-registered on live tables, projection unbuilt), the pooler statement_timeout quirk, and the standing decisions.
