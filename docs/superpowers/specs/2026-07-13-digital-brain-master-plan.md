# The digital brain: master plan

Date: 2026-07-13.
Stands on: the vision (Tony, 2026-07-12), the internal audit (docs/research/2026-07-12-digital-brain-internal-audit.md), the external landscape (docs/research/2026-07-13-digital-brain-landscape.md), ADR 0001, and the open issues #3-#9.
This is a compass with gates, not a gantt chart: each phase has an entry condition, a definition of done, and an explicit bet that could fail.

## The vision, verbatim

"create a digital brain that brings everything in my life together. that's the vision, and to do that, we need to be able to have multiple sources of ingesting data in, then we need a very very smart and once in a life time way to process that data and turns it into a format that makes its the best ever place to store information for any model out there to process with those info and brings them together."

Ratified scope: personal-first (product door open), cloud storage accepted, sources in priority order: agent sessions (Claude Code, Cursor, Codex), iMessage/WhatsApp, Granola meetings, email+calendar.

## Why this plan believes in itself

Three findings, from research that tried to kill the idea:

1. The field converged on Tony's architecture after he built it.
   MemIR (May 2026) types memory into raw evidence, retrieval cues, and truth-bearing claims, restricting factual authority to supported claims -- raw/readable/ratified, independently derived.
   Zep won the contradiction problem with temporal invalidation instead of deletion -- append-mostly, independently derived.
   The 47-author survey calls user-governed memory the unsolved frontier.
2. Nothing in the wild ships ratification.
   OpenMemory MCP (the closest prior art) exposes add/search/list/delete_all and a dashboard.
   No propose, no ratify, no human authority layer, anywhere.
3. The graveyard died of exactly the diseases this design refuses.
   Rewind: auto-capture without a meaning layer, dead despite $33M.
   Roam: value promised at review time never arrived; capture always exceeds review.
   Recall: aggregation without a threat model, twice a scandal.
   MemGPT/Mem0 consolidation: machine-written meaning drifts.

The moat is not the graph, the vectors, or the capture -- those are commodities in 2026.
The moat is the ratification loop plus the evals that prove groundedness, which is precisely what already exists at small scale in this repo.

## The two-store law (the architecture in one rule)

Everything below follows from one split:

- The EVIDENCE STORE scales mechanically: every ingested item (a message, a meeting segment, a session excerpt, an email) lands here -- immutable, source-stamped, indexed, searchable, and NEVER true.
  Target volume: order 25,000 items/year.
  Nothing here carries meaning; it carries provenance.
- The RATIFIED CORE grows at conversation speed: nodes, why-edges, talks -- exactly the brain that exists today, unchanged in its constitution (AGENTS.md rules 1-9).
  Evidence becomes brain truth only through Tony, in conversation, per the meaning rule.

Collapsing these two layers is how every graveyard product died; keeping them separate is what makes "ingest everything" compatible with "nothing means anything unless I said so."
Corollary: the ADR 0001 triggers fire the moment ingestion goes live -- but they fire for the EVIDENCE store (retrieval over 25k items), while the ratified core stays small, curated, and loadable whole for a long time.
The deferral was "until the data demands it"; ingestion is the data demanding it, on purpose.

## Phases

### Phase 0: decisions only Tony can make (entry: now)

Four decisions gate everything; each is a conversation, not code:

1. M4 raw slicing (docs/node-structuring.md): when one raw stream holds many atoms, does each proposed node get its own sliced verbatim raw, or does the whole item stay one raw with structure in the readable and edges?
   Every ingested item is multi-atom, so this precedent must exist before source #1 lands.
2. Companion-memory separation (#6): where the companion's own opinions and lessons live, so foreign models can mount the brain without contaminating it.
3. The deleted-content ethic: ingesting texts means keeping messages other people un-sent or deleted (the Recall finding).
   Does the brain honor other people's deletions, keep everything, or keep-with-flag?
   This is a values call with real relationship consequences; it must be Tony's, explicitly.
4. Evidence retention and exclusion: what never enters the evidence store at all (people, threads, tags), accepting that capture-time filters are provably unreliable (Recall's CVV failure) and exclusion rules are the honest tool.

Done when: all four are ratified and written down (M4 in the lab notebook; the rest as short ADRs).

### Phase 1: the evidence store (entry: Phase 0 done)

Additive schema, rehearsed in brain_dev first (rule 9), shapes lifted from the proven recall lab:

- sources: the registry (kind, location, auth, sync state, exclusion rules).
- episodes: one ingested unit (a session, a thread window, a meeting) with source pointer and time span.
- evidence: atomic spans inside episodes -- verbatim text, source offsets, occurrence time and ingestion time (bi-temporal, the Zep lesson).
- Zero coupling to nodes: no foreign keys from evidence into the ratified core; connections only ever arrive later as ratified edges/whys from conversation.

Plus the ingestion eval contract BEFORE the first pipeline: per-source fidelity checks (counts reconcile, verbatim intact, timestamps correct, exclusions honored), run-record format extended from the run-001 pattern.

Done when: schema live in public after brain_dev rehearsal; a hand-inserted episode round-trips; the fidelity eval exists and passes on the hand-inserted sample.
Bet that could fail: none serious -- this is the well-understood part.

### Phase 2: walking skeleton, source #1 = agent sessions (entry: Phase 1 done)

Why agent sessions first: the data is already on this machine (LOCAL-verified transcript paths for Claude Code and ~/.codex/sessions for Codex), zero new permissions, claude-mem proves the hook surface works, and it is the source where Tony already thinks out loud.

- Capture via the vendor-supported hook surface (SessionEnd archiving with transcript_path), NOT by parsing JSONL layouts directly (vendor-warned unstable); raise cleanupPeriodDays so retention outlives the pipeline's lag.
- Codex: read session files from ~/.codex/sessions plus history.jsonl; Cursor needs a short local spike (research gap).
- Every captured episode lands in the evidence store untouched; an extraction pass proposes evidence spans only (no meaning, no nodes, no links).
- Run the fidelity eval; add 5 evidence-recall questions to the eval set ("what did I tell the agent about X last week" -> supported BY EVIDENCE, clearly labeled as evidence, not brain truth).

Done when: a week of real sessions flows in automatically; fidelity eval green; the companion can quote evidence with provenance and explicitly distinguishes evidence from ratified truth in its answer states.
Bet that could fail: hook-based capture may be lossy for interrupted sessions; the eval will show it.

### Phase 3: retrieval over evidence (entry: evidence store has real volume)

This deliberately executes issues #4 and the relevant slice of #7:

- Embeddings + FTS over evidence (and the handful of nodes); HNSW index; hybrid recall controller from the recall-lab prototype: find (lexical+vector) -> traverse (typed, bounded -- the MRAgent lesson) -> prove (epistemic state).
- The four answer states gain a fifth footing: "supported by unratified evidence" -- distinct from brain-truth supported, and always labeled.
- Eval run 003: the 25 questions plus evidence questions, measuring whether retrieval finds the right spans (precision/recall now meaningful for the first time).

Done when: the companion answers from 10k+ evidence items with provenance, within the same honesty contract; eval run recorded.
Bet that could fail: retrieval quality at intimate-personal-text granularity is unproven; the eval set is the detector.

### Phase 4: the ratification loop at volume (entry: Phase 3 done) -- the once-in-a-lifetime part

The bet: ratification can stay conversational at 25k items/year because the funnel is steep -- most evidence is never surfaced, surfaced evidence is mostly answered-with (which needs no ratification), and only the rare durable atom gets proposed as a node or claim.

- The companion proposes in the flow, exactly like edge proposals today: "this shows up three times this month -- keep it as a node?"
  One proposal at a time; ignoring it means it evaporates (the raw evidence is already safe).
- Spaced resurfacing instead of queues: an unanswered good candidate may return once, later, in a natural moment; never a backlog, never a dashboard (issue #5's law; OpenMemory's dashboard is the named anti-pattern).
- Typed claims land here if and only if needed: the #3 typed-edge migration (predicate, validity dates, status) activates when the first temporal contradiction actually appears in proposals.
- Measure the loop itself: proposal acceptance rate, proposals-per-session, time-to-ratify.
  Kill criterion, honestly stated: if acceptance collapses or proposals feel like homework (the Roam signal), the bet is failing and the design must change rather than push harder.

Done when: a month of real use where the brain grows through conversation from ingested evidence, and the loop metrics are healthy.

### Phase 5: the rest of the sources (entry: skeleton proven; order by friction)

1. Granola: already reachable via the connected MCP; pull summarized meetings as episodes; the official API (grn_ keys) is the upgrade path but is documented Business-plan-only -- do not block on it.
2. iMessage: Full Disk Access to the reading process; periodic full re-export via imessage-exporter (145k msgs/sec makes nightly full exports trivial) diffed into the evidence store; parse attributedBody; Apple-epoch conversion; accept iCloud-only invisibility.
3. WhatsApp: monthly iPhone-backup batch through whatsapp-chat-exporter; explicitly not live.
4. Email + calendar: BLOCKED on its own research spike (the landscape gap); scope OAuth, quotas, and whether calendar becomes episodes or a timeline spine.

Each source ships only with: registry entry, exclusion rules honored, fidelity eval green.
Done when: the chosen sources flow on their natural cadences with green fidelity runs.

### Phase 6: the brain as an MCP server (entry: Phase 4 healthy; #6 decided)

The any-model layer, informed by verified adoption facts:

- One server, two transports: STDIO for local clients (Claude Code, Codex CLI, Cursor), streamable HTTP + OAuth (with refresh tokens) for remote clients (claude.ai -- one free custom connector; ChatGPT -- remote-only, write-tools plan-gated, so the ChatGPT surface is read/recall-first by design).
- Tool surface: recall (with epistemic state and provenance in every answer), propose (queues nothing; hands the proposal to the live conversation), get_node/get_evidence, explain (trace).
  ratify is deliberately NOT a remote tool: ratification happens with Tony in conversation, whatever the client.
- App-layer scoping and audit logging (the protocol mandates neither): per-client capability grants, every invocation logged.
- The companion's own memory (per #6) mounts separately; foreign models never write to Tony's brain.

Done when: the same brain answers with identical honesty from Claude Code, Codex, Cursor, and one remote surface, and the eval's ablation re-run shows the harness fingerprint surviving client changes.
Bet that could fail: remote-client UX (auth, tunnels) may be too janky for daily use; local-first STDIO alone still delivers most of the value.

### Phase 7: privacy hardening (runs alongside 5-6, gated before any remote exposure)

- A written threat model that takes the Recall lessons seriously: user-level and physical access, coercion and discovery, prompt-injection exfiltration via the MCP surface (demonstrated in the literature), not just network TLS.
- Exclusion rules as the primary control (filters are provably unreliable); app-layer encryption for evidence at rest as a decision point with pgcrypto vs application-layer tradeoffs documented; secrets and key story for a solo operator.
- No remote transport ships before this phase's review passes.

## What we will NOT build (constitutional, from the graveyard)

- No ambient screen or audio capture; chosen sources only.
- No machine-written meaning in the ratified core, ever; auto-summaries live as evidence-layer conveniences, clearly labeled.
- No review dashboards, queues, or inboxes for memories.
- No destructive updates anywhere: evidence is immutable; ratified history supersedes, never deletes (rule 5, Zep-validated).
- No new node types, tags, or taxonomies imposed at capture time (rule 6 survives ingestion).

## Cost, order-of-magnitude (own estimate; the research gap is flagged)

At chosen volumes (~50 texts/day, 20 emails/day, 3 agent sessions/day, 5 meetings/week), raw inflow is on the order of 5M tokens/month, dominated by agent sessions.
Embedding everything: cents per month.
A cheap-model extraction/proposal pass over everything plus a strong-model pass over the surfaced slice: single-digit to low-tens of dollars per month.
Cost is not the constraint; Tony's attention is -- which is why Phase 4's metrics are the ones that decide the project's fate.

## Sequencing against the tracker

- Phase 0 -> #6 plus three short new decision records; M4 in the lab notebook.
- Phase 1 -> new issue: evidence store + source registry + fidelity eval contract.
- Phase 2 -> new issue: agent-sessions ingestion skeleton (supersedes nothing; claude-mem stays untouched as reference).
- Phase 3 -> executes #4 and part of #7 (Polygres activation), closing them when green; #9 (runner hardening) lands with the next eval run.
- Phase 4 -> executes #5; activates #3 when its trigger fires.
- Phase 5 -> new issue per source, opened when its predecessor ships.
- Phase 6 -> new issue: brain MCP server; depends on #6.
- Phase 7 -> new issue: threat model + privacy review gate.
- One umbrella issue tracks the whole plan and links everything.

## The first hour of work, when Tony says go

Phase 0, decision 1 (M4) and decision 3 (deleted-content ethic) -- both are conversations that need nothing but him.
Everything else in this plan is waiting behind those two talks.
