# ADR 0001: Adopt the epistemics, defer the retrieval architecture

Date: 2026-07-11
Status: accepted

## Context

A deep research pass (docs/research/, 2026-07-10) audited how far fuzzy-brain exploits Polygres and proposed a ten-phase production memory system: episodes, evidence spans, entities, atomic claims, typed relationships, hybrid retrieval, a recall controller, repair paths, and multi-agent APIs.
An isolated experiment (experiments/polygres-recall-lab/) proved the core mechanics work: typed multi-hop traversal in pgGraph, pgvector + full-text seeding, and an epistemic recall policy, all inside brain_dev with the real brain untouched.
The real brain at decision time holds 6 nodes and 3 edges.
The reframed goal the research produced is right: the brain should give the most personally useful answer supported by Tony's evidence, recognize when it cannot, and repair the gap safely.

## Decision

Adopt now, because they are cheap and shape behavior immediately:

- The four answer states (supported, missing, conflicting, broken lookup) live in the brain-companion skill and are machine-checked by tests/brain-companion-skill.test.mjs.
- An eval set (docs/evals/recall-questions.md) defines what a better brain means before any retrieval machinery exists.
- The typed-why drafting convention (M5 in docs/node-structuring.md) bakes relationship kinds into ratified whys with no schema change.

Defer, with explicit revisit triggers, tracked as GitHub issues #3 through #7:

- Typed edge column via additive migration (#3): when a retrieval trial fails for lack of a predicate.
- Recall controller, embeddings, and indexes (#4): at roughly 100+ nodes, or when loading the whole brain starts to strain.
- Claims layer with in-conversation-only ratification (#5): when facts buried in long raws fail trials at volume; never a review inbox.
- Companion-memory separation (#6): design conversation before any claims or multi-agent work.
- Polygres activation checklist (#7): only when the retrieval work needs it.

## Consequences

The bottleneck is named honestly: capture volume, not recall.
The next months are talking sessions that grow the brain, plus eval runs (#2) that measure whether answers stay grounded.
The heavy architecture stays proven-but-parked in brain_dev, so when a trigger fires the build starts from a working prototype instead of a blank page.
The risk accepted: some questions will keep failing trials (T-001, T-002) until their trigger fires; the eval set records those failures instead of hiding them.
