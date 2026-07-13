# Digital brain: internal audit (what we already have)

Date: 2026-07-12.
Companion document to the external landscape research of the same date; the master plan in docs/superpowers/specs/ stands on both.
Method: every claim here was verified against the live repo, tracker, or machine on 2026-07-12, not recalled from memory.

## The vision, in Tony's words

"create a digital brain that brings everything in my life together. that's the vision, and to do that, we need to be able to have multiple sources of ingesting data in, then we need a very very smart and once in a life time way to process that data and turns it into a format that makes its the best ever place to store information for any model out there to process with those info and brings them together." (2026-07-12)

Scope decisions ratified the same day: personal-first with productizing kept possible; cloud storage accepted (status quo Polygres); priority sources are (1) agent-session transcripts from Claude Code, Cursor, and Codex including direct in-session capture, (2) iMessage and WhatsApp, (3) Granola meetings, (4) email and calendar.

## Layer-by-layer: have versus gap

The vision decomposes into ten layers.
For each: what exists today, and what is missing.

### 1. Ingestion (multi-source)

Have: exactly one working source -- live conversation with the companion, manual, ratified in the flow (the brain-companion skill, steps 3-4).
Granola is already connected as MCP tools in Claude sessions, so meeting transcripts are reachable today without new auth.
claude-mem is installed and running on this machine (~/.claude-mem with a sqlite db and a chroma store), passively capturing Claude Code session observations; it is working prior art for the agent-sessions source, not just an idea.
Claude Code full transcripts also exist on disk as JSONL under ~/.claude/projects/, per session.

Gap: no pipeline exists for any source; nothing is automated; iMessage/WhatsApp, email+calendar, and Cursor/Codex transcripts are untouched; there is no incremental-sync state, no source registry, no ingestion eval.

### 2. Staging / evidence store

Have: nothing in production.
The shape is prototyped and proven in the sandbox: experiments/polygres-recall-lab/schema.sql models episodes, evidence spans, entities, typed claims with temporal validity, and epistemic states, all exercised in brain_dev with tests.

Gap: the production evidence layer -- where raw ingested life-data lands BEFORE any ratification -- does not exist.
This is the single largest structural gap, because every ingestion source needs somewhere to put data that is not yet (and mostly never will be) brain truth.

### 3. Processing (raw streams to structured memory)

Have: the readable pass for conversational capture (docs/writing-style.md); the node-structuring lab notebook (docs/node-structuring.md) with mechanisms M1-M5, of which M1 (whole-moment) has a passing trial and M5 (typed why) is an adopted drafting convention; the recall lab proved entity/claim extraction shapes traverse and answer questions.

Gap: M4 (raw slicing -- what happens when one raw stream contains many atoms) is explicitly undecided, and it is THE processing question once ingestion starts, because every ingested email or chat thread is a multi-atom raw.
No entity resolution across sources, no dedup, no automated claim proposal exists outside the sandbox.
The "once in a lifetime" processing layer Tony wants is exactly this layer; today it is a lab notebook and a sandbox prototype.

### 4. Ratification UX (the meaning rule at scale)

Have: in-conversation ratification that works and is pleasant at conversation scale (show both layers, save on yes); the standing design constraint from issue #5 that claim proposals happen in conversation and there is never a review-queue inbox; the labeled-read guard in the skill, machine-checked by tests.

Gap: nothing that scales ratification to ingestion volume.
This is the hardest open design problem in the whole plan and the one the external research was pointed at (dimension 4): how thousands of evidence items per month coexist with a meaning rule that demands human approval for anything that becomes brain truth.

### 5. Ratified core (the sacred layer)

Have: the strongest layer, essentially complete for its size.
Two-layer nodes (immutable verbatim raw, ratified readable) enforced by CHECK constraints; why-edges only with human-decided connections; append-mostly with no delete/set-raw verbs anywhere in tooling (scripts/brain.mjs); the meaning rule as constitution (AGENTS.md rules 1-9); brain_dev sandbox with rehearsed migrations; 67 passing tests; v0.10.0.
Current contents: 6 nodes, 3 edges, 0 talks (verified 2026-07-12).

Gap: none structural at current scale; typed edge columns (predicate, validity, status) are designed and parked as issue #3 with the M5 convention already writing whys in a backfill-ready shape.

### 6. Retrieval

Have: load-the-whole-brain, correct at 6 nodes; a working hybrid prototype (lexical + pgvector + typed graph traversal + epistemic policy) in the sandbox; ADR 0001 deferring production retrieval behind an explicit trigger (~100+ nodes, or when whole-brain loading strains); issue #4 holds the build plan.

Gap: production embeddings, indexes, and the recall controller -- deliberately unbuilt until the trigger fires.
See "load-bearing insight 2": ingestion fires this trigger almost immediately, so the master plan must treat retrieval as phase-gated by ingestion, not indefinitely deferred.

### 7. Any-model access

Have: almost nothing productionized, and one meaningful seed: the brain-companion skill is a single canonical file shared by Claude and Codex via symlink, tested for identity -- harness portability in miniature.
The write path is a local CLI (scripts/brain.mjs) plus a Next.js API; both are machine-local.

Gap: the "any model out there" promise has no transport.
The obvious 2026-shaped answer is exposing the brain as an MCP server (recall / propose / ratify tool surface) so Claude, Codex, Cursor, and anything else can mount it; the external research verifies the standard's actual adoption state.
Companion-memory separation (issue #6) is a prerequisite decision so foreign models can use the brain without contaminating it.

### 8. Evals

Have: a real eval culture, not aspiration.
25-question recall set with expected states (docs/evals/recall-questions.md); run 001 completed with a knowledge-vs-harness ablation (brain_refs 22/0/0) and a Sonnet-vs-Opus A/B; contract-tested run records (tests/eval-run-record.test.mjs); a ratified scoring rubric; PRD #8 model-seat policy; runner hardening queued as issue #9.

Gap: no per-source ingestion evals (extraction fidelity, entity-resolution accuracy, proposal precision), and groundedness scoring has only been exercised at 6-node scale.

### 9. Privacy and security

Have: cloud Postgres with provider encryption at rest; secrets in .env.local; destructive-SQL prohibition (rule 9) with sandbox-only experiments; pooled-connection sandbox routing hardened and tested; no delete verbs in tooling.
Decision on record (2026-07-12): cloud is acceptable for this data class.

Gap: no application-layer encryption, no key management story, no threat model written down; ingestion multiplies the sensitivity (verbatim texts with his girlfriend are a different class than six curated nodes).
The external research (dimension 5) informs how far to go given the cloud-is-fine decision.

### 10. Companion / harness

Have: the brain-companion skill with the four answer states and the labeled-read guard, all machine-checked; FEEDBACK.md as a live corrections log; the talks table for session continuity; a proven multi-agent execution pattern (PRD #8 seats, the run-001 workflow).

Gap: the companion's own memory (opinions, lessons about Tony, open questions) has no home separate from Tony's brain -- issue #6, flagged as a prerequisite design conversation before any multi-agent or claims-layer work.

## Live assets outside the repo

- Granola MCP: connected in Claude sessions today; transcript access needs no new integration work to prototype.
- claude-mem: installed at ~/.claude-mem (sqlite + chroma), capturing Claude Code observations continuously; both prior art and a possible first-source shortcut.
- Claude Code transcripts: complete JSONL session logs under ~/.claude/projects/, one file per session, locally readable.
- The issue tracker: #2 closed (run 001 delivered); #3-#9 open with wired blocked-by dependencies; #8 is the model-seat PRD.
- The teaching workspace (.teach/, gitignored): four lessons, glossary, and learning records aimed at Tony driving the project himself.
- Four prior research docs (docs/research/2026-07-10-*): personal-AI-memory landscape, Polygres capabilities and utilization, agent identity; the 2026-07-12 external research supersedes where they conflict, and verifies two arXiv citations they left unverified.

## Two load-bearing insights the master plan must carry

### Insight 1: evidence scale is not ratified scale

Realistic volume for the chosen sources is roughly 50 texts/day, 20 emails/day, 3 agent sessions/day, 5 meetings/week -- order of 25,000 raw items a year.
The meaning rule makes mass node creation impossible BY DESIGN: nothing becomes brain truth without Tony.
So the architecture must split hard: an evidence layer that scales mechanically (ingested, indexed, searchable, never "true"), and the ratified core that grows only at the speed of conversation.
The brain stays small and sacred; the evidence store gets big and useful.
Every failure mode the second-brain product graveyard exhibits (auto-summarization sludge, trust collapse, review-queue fatigue) comes from collapsing these two layers into one.

### Insight 2: ingestion fires the ADR 0001 triggers, on purpose

ADR 0001 deferred retrieval behind "~100+ nodes or whole-brain loading strains."
The moment even one ingestion source goes live, the evidence layer blows past any such threshold, and retrieval-over-evidence becomes mandatory (you cannot load 25,000 items into context).
This does not contradict the ADR; it completes it: the deferral was "until the data demands it," and ingestion is precisely the data demanding it.
The master plan should sequence retrieval activation (issue #4) and Polygres activation (issue #7) as gated consequences of the first ingestion source, not as speculative infrastructure.

## What this audit hands the master plan

- The ratified core and eval layers are strong and must not be rebuilt -- they are the differentiator the external research checks against the product graveyard.
- The two genuinely missing structures are the evidence store (layer 2) and ingestion pipelines (layer 1); everything else is either done, prototyped, or parked with a trigger.
- The hardest design problem is ratification at volume (layer 4) -- the research's dimension 4 exists to inform it, and issue #5's no-inbox constraint is non-negotiable.
- The cheapest first win is the source already flowing on this machine: agent sessions (claude-mem prior art plus on-disk JSONL), with Granola second (MCP already connected).
- M4 (raw slicing) must be decided with Tony before the first ingestion source lands, because every ingested item is a multi-atom raw.
