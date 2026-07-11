# Polygres semantic search and graph capabilities for Fuzzy Brain

Date: 2026-07-10

Status: verified against current official Polygres and pgGraph documentation, the official pgGraph source repository, the Fuzzy Brain source, and a read-only inspection of the live database.

## Executive answer

Polygres supplies the storage and retrieval machinery Fuzzy Brain needs, but it does not define what Tony's knowledge means or decide how an agent should reason with it.

The clean boundary is:

- Polygres stores rows, embeddings, and registered relationships, then executes relational, vector, text, graph, and graph-plus-vector queries.
- Fuzzy Brain must define claims, evidence, time, authority, contradiction, unknowns, permissions, and which paths count as useful personal knowledge.
- The companion harness must turn a question into anchors and search actions, inspect returned evidence, decide whether another hop or external source is needed, and stop or abstain.

Therefore, the question "What should happen when knowledge is missing or contradictory?" still matters, but it is not primarily a Polygres product question. It is a Fuzzy Brain semantic and policy question that Polygres can store and enforce once the application expresses the rules in schema, constraints, status fields, temporal fields, and queries.

The current Fuzzy Brain application is not yet calling Polygres semantic search or pgGraph traversal. The extensions and direct-SQL pgGraph registration exist, and query-time traversal can return rows, but no durable base build was observed. There are also no embedding columns or Polygres Runtime retrieval configurations. The current companion uses ordinary SQL reads and joins.

## What Polygres semantic search actually does

Polygres semantic search is vector similarity search.

1. The application chooses an embedding model.
2. The application converts a node, span, or query into a numeric vector.
3. The application stores document vectors in a `vector(n)` column.
4. At query time, the application supplies a query vector produced by the same model and with the same dimensions.
5. Polygres ranks stored rows by cosine, inner-product, or L2 proximity, optionally using an HNSW index and exact filters.

Polygres does not generate embeddings for the application. Its documentation says that `embed_text` belongs to the application, and its configuration guide says that adding a vector column does not populate it. It also explicitly says Polygres does not infer that a non-null vector is semantically correct for the application. [Polygres retrieval integration patterns](https://docs.evokoa.com/polygres/sdk/retrieval-integration-patterns) [Polygres retrieval configuration](https://docs.evokoa.com/polygres/sdk/configure-retrieval)

This means "semantic" has a narrow technical meaning here: the embedding model placed two inputs near each other in vector space. It does not mean Polygres proved a fact, understood Tony, detected a causal chain, or verified that two memories should be connected.

Semantic search is valuable for Fuzzy Brain as an entry-point generator. A query such as "where does my girlfriend live?" might retrieve material about Doan, Arizona, Safford, an address, or a delivery receipt even when those records use different wording. Whether it succeeds depends on what was embedded, the chosen chunk or node boundaries, the embedding model, filters, and thresholds.

## What Polygres graph traversal does

pgGraph builds a derived graph index over ordinary PostgreSQL tables. PostgreSQL tables remain authoritative; pgGraph registers node tables and meaningful relationships, compiles them into a graph projection, and exposes bounded traversal and path operations. The official source describes the graph as a rebuildable index rather than a separate source of truth. [Official pgGraph repository](https://github.com/Evokoa/pgGraph)

The current APIs include:

- `graph.related` for direct neighbors.
- `graph.expand` or `graph.traverse` for bounded multi-hop neighborhoods.
- `graph.path` and `graph.shortest_path` for a path between known nodes.
- `graph.connection` for finding endpoints and returning a reachable path.
- Breadth-first and depth-first traversal, edge-label filtering, direction, node filters, depth limits, and result limits.

The traversal result can include hop depth, node coordinates, an edge-label path, and hydrated source rows. [Polygres retrieval integration patterns](https://docs.evokoa.com/polygres/sdk/retrieval-integration-patterns) [pgGraph querying guide](https://docs.evokoa.com/pggraph/user_guide/querying)

If Tony has already approved the relevant nodes and connections, the database does not need a model to rediscover that topology. Given a starting node and traversal rules, pgGraph can mechanically follow the stored edges and return the path.

However, the graph does not eliminate all model or controller decisions. Something still has to decide:

- Which record or records are the starting anchors.
- Which relationship labels and directions are relevant.
- How many hops to explore.
- Which returned paths answer the present question.
- Whether an edge's `why` supports association, identity, causation, or only a weaker relationship.
- Whether the evidence is sufficient or another search or external tool is needed.
- When to stop.

The official Polygres guide makes this boundary explicit: retrieval setup does not replace data modeling, and it recommends registering an edge only when the hop helps answer a retrieval question. It warns that technically connected hubs can produce unhelpful paths. [Polygres retrieval configuration](https://docs.evokoa.com/polygres/sdk/configure-retrieval)

Therefore, a human-ratified edge greatly reduces search uncertainty, but it is not automatically a proof of every conclusion that an agent could draw from the connected nodes. The `why` must remain available as evidence, and the agent must use it only for the meaning Tony approved.

## Semantic search is not sequential or associative graph search

They are different operations.

| Operation | Input | What it returns | What it cannot do alone |
|---|---|---|---|
| Semantic vector search | A query embedding | Rows whose embeddings are nearby | Follow explicit life relationships or prove a multi-hop chain |
| Graph traversal | One or more known graph anchors plus traversal rules | Explicitly connected neighbors or paths | Find a good anchor when wording does not match, or judge which path matters |
| Hybrid retrieval | A vector query, a graph anchor, or both | Candidates ranked using vector and graph signals | Perform an open-ended, evidence-dependent investigation by itself |
| Sequential associative recall | A question plus an evolving working state | A series of searches where each result determines the next action | This is an application or harness process, not one database primitive |

Polygres currently offers fixed hybrid patterns:

- `graph_first`: expand from a known anchor, then apply semantic scoring.
- `vector_first`: find semantic candidates, then add graph context.
- `joint`: combine independent graph and vector rankings with reciprocal rank fusion.

These are useful building blocks, but they are not the same as the Safford process:

`girlfriend -> Arizona -> city unknown -> prior Uber Eats delivery -> receipt -> Safford`

That process is iterative. The discovery that the city is missing changes the next action from graph traversal to receipt lookup. The receipt then supplies new evidence that may create or update a proposed claim. Polygres can execute the vector and graph steps and store the evidence and path, but the harness or a deterministic application workflow must decide the sequence. [Polygres retrieval integration patterns](https://docs.evokoa.com/polygres/sdk/retrieval-integration-patterns)

## Missing and contradictory knowledge

Polygres can handle structural database conditions when Fuzzy Brain tells it what they mean:

- `NOT NULL`, `CHECK`, foreign keys, unique indexes, and transactions can reject structurally invalid writes.
- An absent row or empty search result can show that a particular query found no stored record.
- Temporal columns and statuses can preserve older and current claims.
- SQL can surface multiple claims about the same subject and predicate.
- Graph paths can preserve provenance links from a claim to the evidence supporting it.

Polygres does not automatically know that knowledge is missing in the human sense. An empty result could mean the fact is unknown, not captured, expressed differently, hidden by permissions, outside the search boundary, or absent because retrieval failed.

It also does not automatically know that two rows contradict. "Doan lives in Safford" and "Doan lives in Phoenix" are only conflicting if the application models them as claims about the same person, predicate, relevant time, and scope. The database can then enforce or query the policy, but Fuzzy Brain must supply that representation.

For Fuzzy Brain, a safe default is:

- Missing: return `unknown from the current brain`, preserve the attempted evidence path, and optionally expose authorized sources that could resolve it.
- Contradictory: preserve both claims and their provenance, time, and ratification state; do not silently overwrite either; prefer a current claim only when an explicit application rule justifies it.
- Uncertain: distinguish a proposed claim from a Tony-ratified fact or meaning.

This is application behavior, not a limitation that the database should guess around. Polygres itself says PostgreSQL remains the source of truth and retrieval configuration only selects existing tables, relationships, embeddings, and text columns for retrieval. [Polygres documentation](https://docs.evokoa.com/polygres) [Polygres retrieval configuration](https://docs.evokoa.com/polygres/sdk/configure-retrieval)

## What Fuzzy Brain must still define

Polygres can execute the system, but Fuzzy Brain must define these semantics:

1. Identity: whether two names or mentions refer to the same person, place, event, or concept.
2. Claim shape: subject, predicate, object or value, scope, time, and source.
3. Authority: Tony's raw words, Tony-ratified fact, Tony-ratified meaning, third-party evidence, or model hypothesis.
4. Provenance: the exact source node, span, external record, and approval event supporting a claim or connection.
5. Time and revision: when a fact was true, whether it is current, and what superseded it.
6. Contradiction policy: which claims can coexist, which require review, and which may become current.
7. Missingness policy: when to say unknown, when to search again, and which external sources an agent may inspect.
8. Connection semantics: typed, directed relationships and a ratified `why` that says exactly what the hop means.
9. Traversal policy: anchor selection, allowed edge types, depth, ranking, stopping, and evidence sufficiency.
10. Access policy: which agents may read which parts of Tony's brain and which may propose or ratify writes.

Without these definitions, Polygres can return fast and technically correct rows while the companion still forms a personally wrong conclusion.

## Read-only audit of the live Fuzzy Brain database

The live inspection used a read-only PostgreSQL transaction and did not mutate schemas, configuration, or brain data.

Observed on 2026-07-10:

- PostgreSQL server: 17.10.
- Installed extensions: `graph` 0.1.7 and `vector` 0.8.2.
- Public application tables: `nodes`, `edges`, and `talks`.
- Vector state: no `vector`, `halfvec`, or `sparsevec` columns exist in the public schema.
- Full-text state: no `tsvector` columns exist in the public schema.
- Registered pgGraph node tables: `public.nodes` and `public.edges`.
- Registered properties: `type`, `title`, and `body` on nodes; `why` on edges. `raw` is not a registered graph property.
- Registered graph relationships: `edges.source -> nodes.id` and `edges.target -> nodes.id`, both bidirectional.
- Direct-SQL graph state: the registration exists and guarded `search`, `traverse`, `find_related`, `shortest_path`, `connection`, GQL, and Cypher probes returned rows through query-time catch-up; that is not the same as a durable, monitored base build.
- Runtime API state: its graph, vector, and text configuration tables are empty, so the SDK/runtime retrieval layer is not configured even though direct-SQL pgGraph works.

The current registration models each Fuzzy Brain connection row as an intermediate graph node:

`brain node -> edge row containing why -> brain node`

That can preserve the `why`, but each conceptual connection takes two pgGraph hops and the labels are the generic `source` and `target`. If Fuzzy Brain later needs selective traversal such as `partner`, `lives_in`, or `located_in`, it will need explicit typed connection semantics in the relational model or a deliberate dynamic-label mapping.

The current [companion CLI](../../scripts/brain.mjs) selects nodes and joins edges with ordinary SQL. The current [graph API](../../app/api/graph/route.ts) also returns whole tables with ordinary SQL. Neither invokes pgGraph, vector search, text search, or Polygres hybrid retrieval.

## Bottom line

Polygres is a good substrate for the proposed universal digital brain because it can keep relational truth, vector similarity, and bounded graph traversal in one PostgreSQL system.

It already provides the primitives for:

- Finding a likely memory by meaning.
- Following Tony-approved connections from a known memory.
- Returning readable paths between known records.
- Combining a semantic candidate set with a local graph neighborhood.
- Enforcing application-defined data constraints and permissions.

It does not provide the personal epistemology:

- What is true about Tony.
- What Tony approved.
- What a connection proves.
- Which of two conflicting claims is current.
- Whether an absent result means unknown or retrieval failure.
- Which memory or external source to investigate next.
- When an agent has enough evidence to personalize an answer.

The right architecture is not "let Polygres reason for the companion." It is:

`Fuzzy Brain semantics -> Polygres storage and retrieval -> companion recall controller -> evidence-grounded personalized response`

Polygres can make the graph fast and queryable. Fuzzy Brain must make the graph faithful.
