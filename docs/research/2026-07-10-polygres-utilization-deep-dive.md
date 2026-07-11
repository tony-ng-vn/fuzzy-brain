# Polygres utilization deep dive for Fuzzy Brain

Date: 2026-07-10

Status: verified against current first-party Polygres documentation, the official Polygres SDK, the official pgGraph source and releases, the official pgvector source, the Fuzzy Brain codebase, and read-only inspection of the live database.

## Executive verdict

Polygres is a strong architectural fit for Fuzzy Brain, but Fuzzy Brain is currently using it mostly as ordinary hosted PostgreSQL.

The product's real distinction is not that it stores unlimited data or reasons on behalf of an agent. Its distinction is that one PostgreSQL project can remain the authoritative operational database while also supporting:

- ordinary relational queries and transactions,
- PostgreSQL full-text and fuzzy search,
- pgvector semantic similarity and HNSW indexing,
- pgGraph bounded traversal and path finding over the same rows, and
- a managed Runtime API that combines graph and vector results.

This reduces the need to copy personal data into separate relational, graph, vector, and search systems and then keep those copies synchronized. [Polygres overview](https://docs.evokoa.com/polygres/getting-started/what-is-polygres) [Polygres documentation](https://docs.evokoa.com/polygres)

Fuzzy Brain has the right foundation: standard PostgreSQL tables, stable UUIDs, explicit human-approved edges, and both `graph` and `vector` extensions installed. It has not activated the retrieval stack:

- The app uses only `DATABASE_URL` and ordinary SQL.
- The managed Runtime API has zero graph, vector, and text configurations.
- There are no embedding or `tsvector` columns.
- The registered pgGraph projection has no successful base build or durable projection in the inspected state.
- The current registration turns each edge row into an intermediate node with generic `source` and `target` relationships.
- The live extension is pgGraph 0.1.7, while named graphs arrived in 0.1.8.

So the honest answer is: Fuzzy Brain is set up to begin using Polygres, but it is not yet set up to exploit what makes Polygres different.

## What actually makes Polygres different

### 1. One source of truth, several derived retrieval structures

Polygres keeps application tables authoritative. Vector columns, text indexes, and pgGraph artifacts are derived retrieval structures over those tables. Application writes still use PostgreSQL transactions, constraints, WAL, MVCC, backups, ACLs, and RLS. [Polygres key concepts](https://docs.evokoa.com/polygres/getting-started/key-concepts) [Official pgGraph repository](https://github.com/Evokoa/pgGraph)

This matters for a personal brain because a new message, claim, evidence span, or correction can be written once. The search systems can read the same record instead of requiring four separately operated databases and a change-data-capture pipeline between them.

It does not mean there is only one table or one index. A useful brain still needs separate relational shapes for sources, spans, entities, claims, relationships, approvals, and search projections. It means those shapes and their derived indexes can live in one PostgreSQL project.

### 2. pgGraph is an execution layer, not recursive SQL with a new name

pgGraph compiles registered relational relationships into forward and reverse compressed sparse row adjacency stores. A neighbor lookup becomes a scan over a compact array slice instead of rediscovering the same path through repeated joins. Persisted graph artifacts are rebuildable derived state; PostgreSQL remains responsible for durable source rows. pgGraph adds depth limits, visited-node tracking, frontier limits, pagination, and memory safeguards because unbounded traversal is unsafe inside an operational database. [pgGraph architecture](https://github.com/Evokoa/pgGraph#pggraph-high-speed-graph-execution-inside-postgresql)

That is useful for repeated Fuzzy Brain questions such as:

- expand one or two hops around a known person, event, or claim,
- find a supported path between two memories,
- filter traversal by approved relationship types,
- hydrate the original PostgreSQL rows behind a path, and
- explain the route an agent followed.

This design favors bounded, repeated traversal over known topology. It is not a distributed graph analytics system, a cross-database graph, or a complete Cypher, GQL, or SQL/PGQ implementation. [pgGraph fit and limitations](https://github.com/Evokoa/pgGraph/blob/v0.1.8/docs/user_guide/limitations-and-fit.mdx)

### 3. The managed Runtime API turns the database into an agent retrieval service

Polygres exposes a project-specific HTTPS Runtime API for graph, vector, text, and graph-plus-vector retrieval. The official SDK uses a project API key rather than a database password, returns stable result objects, supports cursors, and retries selected transient failures. [Polygres Runtime routes](https://docs.evokoa.com/polygres/reference/routes) [Official Polygres SDK](https://github.com/Evokoa/polygres-sdk)

The API currently exposes:

- `graph.related`, `graph.expand`, `graph.path`, and `graph.connection`,
- `vector.search` and `vector.similar_to`,
- `text.tsvector` and `text.fuzzy`,
- `hybrid.graph_first`, `hybrid.vector_first`, and `hybrid.joint`, and
- retrieval readiness and connection information.

This is the surface that any companion, agent, or universal-brain API should normally call. The database password can remain confined to migrations, writes, exact SQL, and background enrichment.

### 4. Graph and semantic retrieval can be fused without exporting data

Polygres provides three graph-plus-vector shapes:

- Graph-first: begin at a known record, traverse its neighborhood, then apply vector relevance.
- Vector-first: find semantic candidates, then add graph context.
- Joint: independently rank graph and vector results, then merge them using reciprocal rank fusion.

This is close to the Fuzzy Brain requirement: use language to find an entry point, then use approved structure to recover context. It is still a retrieval primitive, not an autonomous thinking loop. The agent must choose anchors, relationships, limits, evidence requirements, and the next action. [Polygres integration patterns](https://docs.evokoa.com/polygres/sdk/retrieval-integration-patterns)

Two current boundaries are important:

- The public API does not provide one text-plus-vector endpoint. The application must merge lexical and semantic result lists itself.
- Current `joint` retrieval accepts graph and vector weight fields but reports them as ignored; current ranking uses reciprocal rank fusion.

The public user-memory demo displays semantic, lexical, and graph channels together, but the documented SDK contract still requires application-side lexical fusion. The demo should be treated as a product direction or custom application composition, not proof that one public endpoint performs all three today. [Polygres memory demo](https://polygres.com/user-demo) [Polygres integration patterns](https://docs.evokoa.com/polygres/sdk/retrieval-integration-patterns)

### 5. pgGraph 0.1.8 adds multiple graph projections inside one database

The June 29, 2026 pgGraph 0.1.8 release added named graphs, graph-scoped registration, grants, quotas, residency, build and sync jobs, and runtime loading controls. Source tables still remain authoritative. [pgGraph 0.1.8 release](https://github.com/Evokoa/pgGraph/releases/tag/v0.1.8)

For Fuzzy Brain, named graphs could eventually provide separate retrieval projections such as:

- `tony_human_brain`,
- `companion_brain`, and
- `retrieval_experiments`.

They should not automatically become one graph per end user. A shared graph registered with a `brain_id` tenant column is likely a better default for many users, while named graphs separate trust domains, products, or experimental projections. pgGraph supports tenant columns and tenant-scoped traversal, and PostgreSQL RLS remains the authoritative row-access boundary. [pgGraph schema registration](https://github.com/Evokoa/pgGraph/blob/v0.1.8/docs/user_guide/schema-registration.mdx) [pgGraph 0.1.8 API](https://github.com/Evokoa/pgGraph/blob/v0.1.8/docs/user_guide/api-reference.mdx)

There are two current constraints:

- The live Fuzzy Brain database has pgGraph 0.1.7, so it does not have the named-graph catalog or APIs.
- The current Polygres SDK request models do not expose a graph-name selector. Named graph access through the managed Runtime API must be confirmed with Polygres before Fuzzy Brain depends on it. Direct SQL can select named graphs after the extension is upgraded, but that uses a database connection rather than the Runtime API.

## What "one database for a lot of data" does and does not mean

The intuition is directionally correct: Polygres can keep records, relationships, embeddings, and text-search data in one PostgreSQL project. This removes several operational systems and avoids stale cross-database copies.

It is not an unlimited store. Current managed documentation lists:

| Limit | Starter | Pro |
|---|---:|---:|
| Enforced storage | 1 GiB | 5 GiB |
| Graph memory | 512 MB | 1,024 MB |
| Graph edge buffer | 500,000 | 500,000 |
| Direct database connections | 10 | 10 |

Retrieval requests currently allow `limit` values up to 1,000, graph depth up to 20, connection requests over two to ten entities, and vector dimensions up to 2,000. Live tier responses remain authoritative. [Polygres limits](https://docs.evokoa.com/polygres/reference/limits)

The live Fuzzy Brain graph reports a 512 MB graph-memory limit, and the whole database is currently about 9 MB. Personal-brain scale is therefore not close to the current storage ceiling, but scale must be measured with realistic raw sources and embeddings, not only node counts.

The official pgGraph benchmark material demonstrates that the engine is not limited to tiny graphs. One documented Panama run used about 2.0 million source nodes, 5.8 million graph edges, 185.5 MB of graph memory, and a hot median of about 107 ms for its specific depth-two traversal. The pgGraph maintainers explicitly warn that these numbers are environment-specific and are not universal or cross-product performance claims. [pgGraph benchmark notes](https://github.com/Evokoa/pgGraph/blob/v0.1.8/docs/contributor_guide/benchmarking.mdx) [pgGraph release evidence](https://github.com/Evokoa/pgGraph/blob/v0.1.8/docs/release-notes.mdx)

The more important limit for Fuzzy Brain will probably be retrieval quality, tenant-filter recall, graph fan-out, and evidence hydration before it is raw PostgreSQL row capacity.

## Direct SQL pgGraph versus the Polygres Runtime API

They are complementary surfaces over the same project, not competing architectures.

| Surface | Best use in Fuzzy Brain | Important boundary |
|---|---|---|
| Standard PostgreSQL SQL | Writes, transactions, exact fact lookup, temporal resolution, migrations, imports, RLS, embedding jobs | Uses the database credential and application-specific SQL |
| Direct `graph.*` SQL | Graph registration, builds, maintenance, diagnostics, advanced GQL or named-graph features | Couples code to the extension SQL contract and may expose features the Runtime API does not |
| Polygres Runtime API | Stable agent-facing graph, vector, text, and hybrid retrieval | Requires saved configurations, a Runtime URL, and a project API key |
| Fuzzy Brain retrieval controller | Selects and sequences SQL, text, vector, graph, and external-tool actions | Fuzzy Brain must build this layer |

The managed product explicitly recommends standard PostgreSQL connections for application reads, writes, migrations, and imports, then the Runtime API for retrieval from trusted backend code. [Dashboard, API, and database access](https://docs.evokoa.com/polygres/platform/dashboard-api-database-access)

For the Next.js app, it is not necessary to run a Python service only because the official SDK is Python. The backend can call the documented HTTPS routes directly. The SDK remains the clearest executable reference for request and response shapes.

## Live Fuzzy Brain audit

No public brain rows, schemas, graph registrations, graph builds, Runtime configurations, or extension versions were intentionally changed during this audit. Catalog reads and direct graph probes were later guarded by `BEGIN READ ONLY` and rolled back.

There is one important audit caveat. `graph.status()` and `graph.sync_health()` were initially called as ordinary `SELECT` inspection functions outside an explicit read-only transaction. A later guarded call showed that pgGraph 0.1.7 can attempt an internal `DELETE` for derived-state housekeeping from these apparent status surfaces. PostgreSQL rejected that later call inside the read-only transaction, but the earlier unguarded status calls may have committed pgGraph-internal housekeeping. The audit did not capture whether any derived rows changed. They did not alter public brain data or graph registration, but these functions should not be treated as strictly read-only on 0.1.7 and should not be called unguarded again.

Observed on 2026-07-10:

| Area | Live state | Meaning |
|---|---|---|
| PostgreSQL | 17.10 | Current Polygres default major |
| pgGraph | 0.1.7 | Durable projection support, but no 0.1.8 named graphs |
| pgvector | 0.8.2 | Installed, but no application vector columns |
| Application tables | `nodes`, `edges`, `talks` | Ordinary relational source tables exist |
| Runtime configurations | graph 0, vector 0, text 0 | Managed Runtime retrieval is not configured |
| Embeddings | no vector-like columns in `public` or `brain_dev` | Semantic search cannot run over brain data |
| Full text | no `tsvector` columns | Saved TSVector retrieval is not configured |
| Repository credentials | only `DATABASE_URL` | No Runtime URL or project API key is wired into the app |
| App query path | ordinary SQL only | No graph, text, vector, or hybrid retrieval is called |

The code evidence is direct: the [database client](../../lib/db.ts) creates a PostgreSQL pool, the [graph route](../../app/api/graph/route.ts) returns every node and edge through ordinary SQL, and the [brain CLI](../../scripts/brain.mjs) selects and joins ordinary tables. The project does not include the Polygres SDK or an HTTP Runtime client.

### The graph is registered, but not operationally ready

The default graph currently registers:

- `public.nodes` with `type`, `title`, and `body`,
- `public.edges` with `why`,
- `edges.source -> nodes.id` as a bidirectional relationship labeled `source`, and
- `edges.target -> nodes.id` as a bidirectional relationship labeled `target`.

A fresh backend reported:

- zero active graph nodes and edges,
- no successful base-build timestamp,
- twelve pending sync rows,
- no durable projection manifest, and
- trigger sync mode with query-time catch-up enabled.

A direct SQL traversal probe can still return rows because pgGraph can apply pending trigger state into backend-local query state. That does not equal a durable, monitored graph build or Runtime API readiness. The correct production state is a successful base build, explicit readiness, scheduled sync and maintenance, and retrieval tests from the actual Runtime API. pgGraph documents build, sync, maintenance, and backend-local state as separate operational concerns. [pgGraph 0.1.7 release](https://github.com/Evokoa/pgGraph/releases/tag/v0.1.7) [pgGraph sync and maintenance](https://github.com/Evokoa/pgGraph/blob/v0.1.8/docs/user_guide/sync-and-maintenance.mdx)

### The current graph shape leaves pgGraph power unused

Today one approved connection is represented as:

```text
brain node -> edge row containing why -> brain node
```

This preserves the `why`, but it costs two graph hops and exposes only generic `source` and `target` labels. The current registration also omits `raw` from searchable graph properties.

pgGraph supports an edge-table registration where `edges.source` and `edges.target` become the two endpoints of one direct relationship. It also supports a dynamic label column and hydrated relationship rows. Fuzzy Brain can therefore preserve `why` on the source relationship row while traversing one direct typed edge. [pgGraph schema registration](https://github.com/Evokoa/pgGraph/blob/v0.1.8/docs/user_guide/schema-registration.mdx)

A better future relational edge shape is:

```text
source_node_id
target_node_id
predicate
why
evidence_id
valid_from
valid_to
ratification_status
```

Then pgGraph can register `source_node_id -> target_node_id` directly and use `predicate` as the dynamic relationship label. `why` remains the human explanation and can be hydrated from PostgreSQL.

Dynamic edge labels are limited to 254 user-facing labels in pgGraph 0.1.8, so Fuzzy Brain should not let a model invent an unlimited predicate vocabulary. Use a small ratified relation vocabulary plus a generic `connected_to` fallback when Tony has approved a connection but not a more specific type.

## The Polygres-native architecture Fuzzy Brain should target

### Authoritative relational layer

Keep all truth, evidence, time, and permissions in ordinary PostgreSQL tables:

- immutable source records and source spans,
- entities and aliases,
- claim records,
- direct typed relationship rows,
- Tony's ratification events,
- temporal validity and supersession,
- authorized resolution paths, and
- per-brain ownership and visibility.

Polygres retrieval should never become a second truth layer. It should return coordinates and scores that lead back to these rows.

### Search projection layer

Create a rebuildable `memory_search_units` projection rather than embedding every source table independently. Each row should represent one useful retrieval unit and include:

- stable ID and source coordinates,
- `brain_id`, kind, authority, and visibility,
- readable search text,
- generated `tsvector`,
- embedding vector,
- current or historical status, and
- timestamps needed for exact filtering.

This projection avoids duplicating truth while giving vector and text retrieval one consistent surface. It can represent a claim, episode, person summary, or source span without forcing all authoritative information into one giant node body.

### Direct relationship graph

Register the semantic nodes that an agent should traverse, then register the edge table as direct relationships with approved predicates. Use small graph depths by default. Polygres itself recommends depth one or two for request-time paths because larger neighborhoods become hard to reason about and can produce broad candidate sets. [Polygres integration patterns](https://docs.evokoa.com/polygres/sdk/retrieval-integration-patterns)

### Retrieval controller

The search controller should use Polygres as a toolbox:

1. Parse the question into exact constraints and possible anchors.
2. Run exact SQL, TSVector, fuzzy, and vector candidate retrieval as appropriate.
3. Merge lexical and vector candidates in the application.
4. Resolve stable row IDs for the best anchors.
5. Run graph-first, vector-first, direct expansion, or path queries with typed relationships and a strict budget.
6. Hydrate claims, evidence, time, and authority from PostgreSQL.
7. If the answer is missing or contradictory, classify the epistemic state and choose an authorized next action.
8. Return an evidence packet and traversal trace to the companion.

This is a reusable search system. It does not hard-code the Safford example or one edge case.

### Tenant and trust boundaries

For a future multi-user product, add `brain_id` before scale and enforce it in every layer:

- PostgreSQL RLS for authoritative row access,
- pgGraph tenant-column registration and tenant-scoped traversal,
- exact filters on vector and text configurations, and
- backend authorization before any Runtime request.

pgvector warns that sharing one approximate index across tenants can affect recall and speed because post-index filters may remove many candidates. At larger multi-tenant scale, test iterative scans, partitioning, or separate search tables for large tenants. [Official pgvector repository](https://github.com/pgvector/pgvector#multitenancy)

Named graphs can later separate Tony's brain, a companion brain, and experiments at the graph-projection level, but source-table RLS and ACLs remain the real security boundary.

## Concrete activation order

### Phase 0: verify managed capabilities

Before relying on new features, ask Polygres to confirm:

1. Whether the managed project can be upgraded from pgGraph 0.1.7 to 0.1.8.
2. Whether named graph selection is available through the managed Runtime API, direct SQL only, or not yet exposed.
3. Whether pgvector can be upgraded from 0.8.2 to the current 0.8.5 release.
4. The live project's tier, storage cap, Runtime URL, and graph system limits.

Do not run extension upgrades against the managed project without the provider's documented path.

### Phase 1: isolate the experiment correctly

The current `brain_dev` schema isolates relational rows, but pgGraph 0.1.7 has one compatibility/default graph catalog for the database. Registering and building experimental `brain_dev` tables would modify the same graph configuration used by the public brain.

Therefore, a truly non-touching experiment must use one of:

- a disposable local PostgreSQL 17 container with pgGraph 0.1.8 and pgvector,
- a separate managed Polygres project, or
- a separate named graph after the managed extension and access surface support 0.1.8.

Do not treat a separate PostgreSQL schema as a separate pgGraph runtime on 0.1.7.

### Phase 2: prove direct typed traversal

Build the synthetic entity, claim, source, and edge fixture. Register the edge table as one direct relationship, build the graph, and verify:

- related records,
- typed one-hop and two-hop expansion,
- shortest paths,
- relationship hydration including `why`,
- current versus historical filters, and
- graph sync after inserts and updates.

### Phase 3: activate text and vector retrieval

Add application-generated embeddings and a generated `tsvector` to the search projection. Configure HNSW, TSVector, and fuzzy retrieval. Measure exact, lexical, semantic, and combined candidate recall before adding the graph.

Polygres does not create embeddings. Fuzzy Brain must choose the model, version it, populate rows, and re-embed when the model or projection text changes. [Polygres retrieval configuration](https://docs.evokoa.com/polygres/sdk/configure-retrieval)

### Phase 4: activate Runtime hybrid retrieval

Create the project Runtime key and URL, validate readiness, then test:

- semantic-first retrieval when no entity anchor is known,
- graph-first retrieval when the current person or event is known,
- joint retrieval when both should affect rank, and
- application-side text plus vector fusion followed by graph expansion.

### Phase 5: test limits that matter to this product

Generate synthetic but structurally realistic brains at 1,000, 10,000, 100,000, and then 1,000,000 retrieval units. Measure:

- graph build time and memory,
- write-to-query freshness,
- depth-one through depth-four fan-out,
- exact, text, vector, graph, and hybrid latency,
- answer recall with tenant and authority filters,
- contradiction and missing-knowledge behavior,
- evidence hydration cost,
- token size of the returned context packet, and
- Runtime API rate-limit behavior.

The pass condition is not merely fast retrieval. It is that the correct supported personal knowledge reaches an agent with its evidence, authority, and time intact.

## Bottom line

Polygres is not a magical brain database. It is unusually well aligned with Fuzzy Brain because it can keep relational truth, text retrieval, vector similarity, and high-speed graph traversal next to each other without making four external systems authoritative.

The strongest Polygres-specific path is:

```text
PostgreSQL truth
-> text and vector anchor discovery
-> direct typed pgGraph traversal
-> evidence hydration
-> agent-controlled next action
```

Fuzzy Brain is currently at the first box. The next step is not to replace its node idea. It is to represent nodes and edges so pgGraph can execute them directly, activate the managed retrieval configurations, and put a bounded search controller in front of them.

The most important immediate discovery is operational: a `brain_dev` schema is not enough to isolate pgGraph experiments on the live 0.1.7 extension. Use a disposable database, a separate Polygres project, or a 0.1.8 named graph before testing builds or registrations.
