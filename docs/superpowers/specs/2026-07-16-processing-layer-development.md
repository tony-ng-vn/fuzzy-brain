# The processing layer: development ladder

Status: ratified direction from the 2026-07-15 conversation between Tony and the planner seat.
This is the development plan for the core open problem: how raw data becomes ratified node knowledge that retrieves well and is honest about what it knows and does not know.
It sits between the master plan's Phase 3 and Phase 4 and tells them what order to grow in.

## The problem, held by one example

The girlfriend case is the canonical test, and it already lives in the eval set failing three different ways:

- Q04 "Where does my girlfriend live?" -- the answer (Arizona) exists, but buried inside the raw of the moment node "here but not here"; the fact is present but not findable as a fact.
- Q15 "What is my girlfriend's name?" -- she appears in two nodes and is never named; the brain does not know, and nothing in its structure even shows there is a gap.
- Q13 "Who is Jason?" -- partial; he exists only as a phrase inside her story.

Behind these sits the 2026-07-09 feedback: asked about the long-distance situation, the agent filled its ignorance with generic advice instead of seeing how little it knew and asking.

## Three rules the example teaches

1. Stories cannot carry facts alone -- facts need their own small nodes.
   A moment node is perfect as evidence and texture, but a fact buried in a story is invisible to search and to reasoning.
   The fix is the shape node-structuring.md already names: a person node (M2) linked back to every moment the person appears in.
   Small typed atoms are also what embeds and retrieves cleanly; a 3,000-character diary entry embeds as mud.

2. The brain can only know what it does not know if there is a slot where the answer would go.
   Today "what is her name?" fails silently because nothing represents that there is a person whose name is missing.
   The moment a person node exists without a name, the absence becomes visible and honest: the agent can say what it holds, name the gap, and ask.
   This is what turns the four answer states from judgment calls into structure.

3. Extraction is a proposer, never a pipeline.
   Any script can pull "girlfriend, Arizona" out of raw text; what it cannot do is be right about Tony.
   The processing layer reads raw (moments plus the evidence store), notices fact-shaped atoms and visible gaps, and brings them to Tony in conversation, one at a time.
   He ratifies; the node is born through the same door every node is born through today.

The machine in one line: story stays story (immutable evidence), facts get cut into small ratified atoms (retrieval), typed slots make gaps visible (honest ignorance), and every atom points back at the raw it came from (proof).

## The ladder

Rung 1 -- hand-cut real cases (now, zero code).
Do the cases the eval already names: her node, then Quoc, then Jason.
Each cut forces the real questions: what becomes an atom, what stays in the moment, what the raw slice is (M4), which links carry what.
Every rule discovered lands in docs/node-structuring.md.
Then rerun the recall eval: if Q04/Q13/Q14/Q15 flip from missing/partial to supported, the shape works -- proven, not argued.

Rung 2 -- Phase 3, retrieval over evidence (issue #4, rescoped evidence-first).
Embeddings and full-text over the evidence store so the cutting can draw from everything Tony has said across sessions, not just what anyone remembers.
Retrieval must be speaker-aware from day one, because the corpus is mostly machine turns (see corpus honesty below).
Issue #9 (eval-runner hardening) lands before the next eval run, which is run 002.
The pgGraph named-graphs slice of issue #7 stays out of this phase; it is blocked by issue #6 and a managed extension upgrade, and the evidence slice does not need graph traversal.

Rung 3 -- Phase 4, the proposer (issue #5).
Automate the noticing, never the deciding: surface one candidate at a time in conversation, from evidence frequency and clustering.
The rules written by hand in rung 1 become its playbook, which is why rung 1 comes first.

Rung 4 -- typed claims (issue #3), only when reality demands it.
The day a ratified fact changes (she moves; the relationship changes), "lives in Arizona" needs valid-from and valid-to instead of an overwrite.
The migration is specced and deliberately parked until the first real contradiction appears.

## Corpus honesty

As of 2026-07-15 the evidence store holds 2,127 spans, and 1,813 of them (85 percent) are assistant-voice engineering text; only 314 are Tony's own words.
Phase 3 on this corpus proves plumbing, provenance, and the honesty contract -- not the intimate-text retrieval bet.
That bet is only tested when Phase 5 sources (Granola, iMessage) land.
A green run 002 must not be read as the bet paying off.

## Non-goals, restated

No auto-linking.
No machine-written meaning in the ratified core.
No ratification inbox or review dashboard.
Recall reads; it never writes.
