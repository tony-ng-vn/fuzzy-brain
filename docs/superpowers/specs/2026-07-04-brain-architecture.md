# The Ratified Galaxy: fuzzy-brain architecture

Date: 2026-07-04
Status: proposed (designed via 5-lens multi-agent design + adversarial critique + synthesis; not yet approved for build)

## The one principle everything hangs on

The machine does cheap, fuzzy recall.
The human does expensive, precise meaning.
That boundary is enforced in the schema and the database roles, not by good manners.

Every raw thought is frozen verbatim forever.
The machine may only ever SUGGEST connections and higher-order patterns, into a quarantine that graph traversal literally cannot see.
A connection becomes real only when Tony authors its "why" himself, from a blank page.
Because every abstraction stays wired down to the exact raw atoms that earned it, "diving through levels of abstraction" is a grounded graph walk that can never confabulate.

## How five independent architects converged

Five architects designed this from five lenses (cognitive-science, knowledge-systems, agent-harness, abstraction-reflection, pragmatic-evolution).
Each was scored by an adversarial critic.
They independently agreed on three things, which is why those three are the spine.

1. Suggestions live in a separate table BESIDE the real edges, never as a status column ON edges, so the graph extension is structurally incapable of ingesting a machine guess.
2. The machine writes EVIDENCE ONLY and a BLANK why. It never drafts the why. This was the single most-flagged flaw across all five designs: a drafted why anchors Tony into rubber-stamping and launders his voice while technically satisfying the not-null constraint.
3. The human-decides boundary must be enforced at the Postgres ROLE layer, not just the API, because Claude Code has Bash and could otherwise just run INSERT directly.

## The layers

L1 Intake: absorb any atom of meaning fast and losslessly, no required type, no required summary, in Tony's exact words. Already built (POST /api/nodes).

L2 Frozen substrate: one immutable row per dump, never merged, never overwritten. All derived state lives in side tables so the raw row stays pristine.

L3 Quarantine cortex: an `edge_suggestions` side table holding every machine guess as a reviewable candidate that graph.auto_discover and every traversal cannot see. Evidence only, blank why.

L4 Meaning organ: the `edges` table is the ONLY traversable structure. It contains exclusively human-decided, human-authored "why" edges. The agent's Postgres role has no INSERT on it; only a privileged UI server action promotes a suggestion.

L5 Candidate generator: at this scale, Claude reasoning over MEANING across the whole graph, not vector similarity. This matters: cosine similarity finds HORIZONTAL (topical) sameness, but Tony's dream is VERTICAL analogy ("rejection is redirection" and "founder split" as two instances of loss-reframed). Vector search structurally cannot find that; meaning-reasoning can.

L6 Abstraction ladder: a higher-order thought is an ordinary node parked higher that links DOWN to the raw atoms that earned it. The invariant is downward-traceability, NOT a rigid altitude number. Any abstract node walks straight down through every intermediate level to the original raw dump.

L7 Reflection engine: explicit, session-triggered passes (no background cron on a local-first app). Two products: generative reasoning that climbs and descends the ladder and returns a thought Tony reads, and persistent rung-nodes proposed into quarantine once real clusters exist.

L8 Context discipline: deferred until a reasoning pass actually gets fat. Window Claude's INPUT (scoped graph reads), never the UI's output. Trigger on candidate-set token size, not node count.

## The abstraction ladder (Tony's headline goal)

- L0 Raw atom: the verbatim dump, frozen forever in his exact words. Ground truth.
- L1 Theme: a recurring frame named across at least 3 atoms, linked down to each via evidence-of edges.
- L2 Tension: a first-class held contradiction or open question (two happinesses, purpose vs time), kept alive rather than resolved.
- L3 Belief: a stance he commits to. Revised append-only via a revises edge, so the old version is retained and dimmed, never deleted.
- L4 Worldview: the small, slow-moving set of organizing frames. The portable "him" a future serendipity platform would match people on.

Levels are soft bands realized by downward evidence edges, not a rigid scalar column.
A multi-level thought is a grounded graph WALK from L4 straight down to the L0 dump.

## What makes it human-like, and better

Human-like: two-speed memory (fast capture, slow belief-formation only after repeated evidence); thinks in tensions as first-class objects; connects by meaning and analogy; evolves in Tony's specific shape because only what HE decides becomes real; beliefs are revised, not overwritten.

Better than human: verbatim never degrades; every abstraction stays auditable to its source instead of being a confabulated self-narrative; no interference or blending of similar memories; forgetting is ranking not loss; reflection is summonable and steerable rather than involuntary; cross-domain analogy surfaces vertical connections human recall would never find.

## Roadmap

Phase 0 (ship now, ~6 nodes): the ghost-edge authoring loop. `edge_suggestions` side table; Claude reads the 6 nodes and proposes at most 3 candidate pairs with terse evidence and a blank why; dashed ghost edges on the map with accept / edit-why / reject; a DB-role-gated, UI-only accept endpoint that inserts a real edge with Tony's typed why; relax nodes.type to nullable; the generative abstract-up/ground-down reasoning loop (a thought, no persistent node). At 6 nodes the bottleneck is missing EDGES, not scale.

Phase 1 (a few dozen connected nodes): grounded abstraction ladder v1. Nullable edges.relation (evidence-of / crystallizes-from / in-tension-with / revises); reuse nullable nodes.type for kind (theme/tension/belief/worldview); a theme-synthesis pass that PROPOSES an L1 theme grounded in at least 3 atoms; every rung human-ratified with a typed why. Building abstraction before real clusters is fantasy structure.

Phase 2 (when a suggestion pass gets fat): context discipline. Scoped agent reads via graph.find/expand/traverse; ban GET /api/graph from the agent path while the UI keeps it to draw; a pgvector hnsw candidate PREFILTER that still only feeds Claude. This is the point where naming an embedding provider finally matters.

Phase 3 (dense corpus): evolving mind + platform seed. Append-only belief revision; first-class tension nodes; reflection-as-write compaction; L4 worldview roll-up. The by-product, a corpus of human-authored whys and a vertical self-model, is the seed for the far-future serendipity platform.

## What NOT to build yet

- pgvector as the candidate organ now: at N=6, Claude-in-context beats cosine, ivfflat cannot even train, vector recall is horizontal while the goal is vertical, and the embedding provider is an unresolved local-first dependency. Later, only as a prefilter that feeds Claude.
- Machine-drafted whys: the single most-flagged flaw. Machine emits evidence only; Tony authors from blank.
- Machine-scored emotion/salience: if the LLM cannot infer the human why, it cannot infer his inner state either. Same laundering, one layer down. Let Tony self-tag if he wants.
- A nightly replay / "sleep" serendipity engine: a noise-and-confabulation factory at small N, no scheduler on a local-first app, turns Tony into a triage bot.
- MemGPT paging/eviction, salience and altitude scalar columns, a core-state digest, a windowed graph API: memory-pressure machinery for a graph 50x bigger than today's.
- A rigid altitude 0-4 integer column: imposes a debatable linear ontology. The ladder is realized by downward evidence edges instead.
- edges.confidence on human-decided edges: re-imports machine uncertainty into the one layer whose whole point is that the human decided it is real.
- A cosine-floor taste loop that suppresses low-similarity links: kills exactly the surprising cross-domain connections serendipity depends on.
- Any multi-user / social-matching infrastructure: pure speculation today.

## Open questions for Tony

- Do you genuinely think in held contradictions (two happinesses, purpose vs time), or is the L2 tension rung us projecting a shape onto you?
- When you promote a suggested pair, is authoring the why from a blank page better for you, or do you want a terse evidence hint on screen? Default is blank, to protect your cognitive independence.
- Is "becoming a belief" (L3) a deliberate act you want a small ritual for, or should it emerge quietly from repeated themes?
- How many suggestions per session before reviewing them feels like a chore rather than a moment of insight? That cap is what keeps this from becoming the auto-linking-notes-app trap.
- Embedding provider, when Phase 2 arrives: local model (preserves local-first, weaker recall) vs hosted API (better recall, an API call on every write breaks local-first)?
- Emotional salience: self-tag, or leave untagged? We refuse to let the machine guess your inner state, so that dial is yours to turn or ignore.
