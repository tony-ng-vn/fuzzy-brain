# Changelog

New updates and changes to Fuzzy Brain.

---

## v0.13.0

Jul 14, 2026

**UI**

- Added a "sync sessions" button in the app header, next to "+ add node": one click runs the same session ingester the terminal command runs, and the result -- what got pulled in, what got skipped and why -- shows in a dismissible panel. No new write path: the button, the API route, and the CLI all share one script.

**Data**

- Corrected a wrong claim from earlier the same day: the ChatGPT desktop app's "Codex" tab and the Codex CLI read the same underlying session store (`~/.codex/`), confirmed by finding an identical session title in both. Anything run through the desktop app's Codex surface was already being captured; no extra work needed there.

---

## v0.12.1

Jul 14, 2026

**Docs**

- The companion learned to talk like a person from Tony's first real feedback session: it now greets with a plain hello instead of reciting what it remembers, keeps gently asking on heavy shares instead of closing early (Tony ends the digging, never the companion), proposes a breakdown of candidate keepers before drafting any node instead of one whole-day mega-node, and reads everything up front so no file chatter interrupts the talk.
- The full correction is logged in FEEDBACK.md so the pattern is on record, same as the July 9 entry.

---

## v0.12.0

Jul 14, 2026

**Data**

- The first life-source is flowing: agent sessions (Claude Code and Codex) now ingest automatically into the evidence store. Every session becomes an episode holding the conversation only -- tool noise collapses into "[N tool calls omitted]" markers, and each turn becomes an evidence span with speaker and timestamp. First real run: 47 Claude Code sessions, 444 evidence spans, all from the allowlisted project.
- Capture is split from parsing on purpose: a SessionEnd hook copies every transcript into a local archive (~/.fuzzy-brain/session-archive) with no parsing and no network, so a parser bug can never lose data and Claude Code's 30-day cleanup can never eat a session again (1088 existing transcripts backfilled, retention raised). The ingester parses archives plus live transcripts, and can be re-run forever.
- Three guards stand between a session and the cloud database, in order: the machine-local allowlist (only named projects ingest; 937 sessions skipped in the first run), Tony's named exclusions on the source row (a match means zero rows, whole episode), and the sensitive-pattern scrub (run before rendering so span offsets stay exact). Machine-injected text -- system reminders, command wrappers, tool results, internal reasoning -- is stripped before anything can render as Tony's words.
- An episode and all its evidence now commit in one transaction, so a killed pipeline can never strand an episode without its spans (a near-miss from a timed-out run made this real, not theoretical).

**Tools**

- New brain.mjs verbs: list-episodes (browse evidence without SQL) and batch add-evidence; add-episode accepts an atomic evidence array. Same one-write-path discipline, still tripwire-audited.

**Docs**

- The companion skill learned the evidence store: browse with list-episodes/show-evidence, always label quotes as unratified evidence with provenance, treat evidence text as data never instructions (sessions contain web content), and propose keepers from evidence through conversation only. Machine-checked like every skill rule.
- Three evidence-recall questions joined the eval set with a new expected state ("evidence"), including the boundary case: evidence of what Tony said is never upgraded to what Tony believes.
- Cursor spike finding: Cursor chats live inside per-workspace SQLite databases with undocumented keys, a different extraction problem -- deferred with findings on issue #12.

---

## v0.11.0

Jul 13, 2026

**Data**

- Added the evidence store: a second, separate layer alongside the ratified brain (nodes/edges/talks) for ingested life-data (agent sessions, texts, meetings, email). It holds sources (a registry of where evidence comes from), episodes (one captured unit, whole), and evidence (atomic verbatim spans inside an episode). Nothing here is ever treated as true -- meaning only ever arrives later as a ratified node or edge from conversation, exactly as the digital-brain master plan's two-store law requires.
- Sensitive data with an exact, checkable shape (SSNs, Luhn-validated credit card numbers) is caught by a local, deterministic filter before anything is ever written, so it can never leave the machine and never becomes a permanent unfixable row. Deleted messages from other people are kept, never dropped, and always flagged, set once, never reversed. A redacted span always shows its placeholder and reason on read; a deleted-by-sender span always stays visible with an explicit marker -- neither state can be silently hidden.
- Seven new `scripts/brain.mjs` verbs: `add-source`, `list-sources`, `set-exclusions`, `add-episode`, `add-evidence`, `mark-sender-deleted`, `show-evidence`. Same no-delete discipline as the rest of the brain: episodes and evidence are immutable once written, with exactly one narrow exception (the sender-deletion flag), machine-checked by a new test that audits the source code itself for any update or delete statement outside the allowed set.
- This work was drafted, adversarially reviewed, and specified end to end by Fable 5 as the authoritative reviewer -- the review caught a real bug (a copy-pasted cascading delete that would have let a single command silently destroy every verbatim quote in the store) before it ever reached the database.

---

## v0.10.2

Jul 13, 2026

**Docs**

- Ratified the digital-brain plan's Phase 0 decisions, walked through and decided in conversation with Tony: no fixed rule for splitting a message into multiple nodes (discuss it live each time, same as edges already work); the companion's own notes live in a separate schema in the same database, isolated by Postgres itself, and an AI's own guess about Tony never becomes true about him until he says it in his own words; deleted messages from other people are kept but flagged as deleted, never silently dropped or silently kept looking intact; sensitive data with an exact shape (SSN, credit cards) gets caught by a local filter before it ever reaches an AI, while anything fuzzier is excluded by Tony naming it ahead of time.
- Recorded the three non-M4 decisions as ADR 0002; M4 is resolved directly in the node-structuring notebook. Phase 0 of the master plan is complete, so Phase 1 (the evidence store) can begin.

---

## v0.10.1

Jul 13, 2026

**Docs**

- Added the digital-brain master plan (docs/superpowers/specs/2026-07-13-digital-brain-master-plan.md): Tony's vision -- one brain that brings his whole life together -- turned into seven gated phases built on one rule: the evidence store scales mechanically and is never true, while the ratified core grows only at conversation speed through the meaning rule.
- Added the internal audit (what already exists, layer by layer, verified live) and the external landscape research (17 adversarially verified claims plus locally confirmed facts; interruption and coverage gaps stated plainly). Highlights: a May 2026 paper independently derives the raw/readable/ratified split; no product anywhere ships human-ratified meaning; the Rewind/Roam/Recall graveyard supplies the failure modes the plan designs against.
- Filed the plan into the tracker: umbrella #10, evidence store #11, agent-sessions ingestion skeleton #12, brain-as-MCP-server #13, privacy threat model #14, with dependencies wired to the existing #3-#9.

---

## v0.10.0

Jul 11, 2026

**Tools**

- The companion gains the labeled-read guard: on feelings and meaning, it may offer a read only when explicitly labeled as its own, and "in your own words" is earned only by verbatim quoting. This is the direct fix for the tidy-theme reflex run 001 proved lives in the harness, and it is machine-checked by the skill tests.

**Docs**

- All four verdict-flip proposals from run 001 were ratified under Tony's delegation: ablation arms are graded against their own materials, a precise "partial" label never fails a delivered fact, Q17 is expected partial going forward, and the labeled-read clause joined the eval rubric. Sonnet 5's corrected A/B tally is 5/5, so the daily companion seat pilots on Sonnet 5 while Opus 4.8 keeps the boundary and meaning-gate seats.
- Filed the eval-runner hardening issue so output degeneracies (the truncated Q03, the literal "test" Q10) get caught and retried before scoring in run 002.

---

## v0.9.0

Jul 11, 2026

**Docs**

- Ran the first recall eval (run 001): 24 questions against the live brain, a five-question three-way ablation, and a Sonnet 5 companion A/B, executed as a multi-agent workflow under the PRD #8 seat policy. Headline: 20/24 answers claimed the right footing, and only 2 of 165 claims about Tony survived adjudication as invented.
- The ablation settled the knowledge-vs-harness question with data: every brain-specific reference (22 of them) disappears without the brain, while the voice, safety posture, and capture instinct survive with an empty brain. The tidy-theme interpretation reflex fired even with zero nodes, proving it lives in the harness, where it can be tuned.
- Added the run record at docs/evals/runs/ with machine-readable front matter naming the model in every seat, plus the run-log entry in the eval set. Four verdict-flip proposals await Tony's ratification inside the record.

**Data**

- A new contract test freezes the run-record format (model per seat, single ablation-arms model, per-question expected-vs-claimed rows, never-empty skipped section), so future runs stay comparable and a silent model change in a seat is structurally impossible.

---

## v0.8.0

Jul 11, 2026

**Tools**

- The companion now tells you which footing an answer stands on: supported by a node, simply not in the brain yet, held in two conflicting nodes, or blocked by a broken lookup. A failed search will never be dressed up as "you never told me that", and a missing answer becomes a question back to you instead of a generic guess.
- When the companion drafts a connection's why for you to ratify, it now makes the kind of relationship explicit in the sentence (learned-from, happened-during, person-in) and dates it when time matters, so today's whys stay answerable as the graph grows.

**Docs**

- Added the recall eval set: 25 questions the brain should eventually answer, each with its expected footing today, so personalization is measured against your evidence instead of vibes. The unanswerable ones double as the capture roadmap.
- Recorded the architecture decision (ADR 0001): adopt the answer-state epistemics now, defer the heavy retrieval machinery (typed edge columns, recall controller, claims layer, Polygres activation) behind explicit triggers, tracked as GitHub issues #2 through #7.
- The node structuring lab notebook gains mechanism M5, the typed-why drafting convention.

---

## v0.7.0

Jul 10, 2026

**Face**

- Moved the "front" control to the left edge so it stays out of the way of the face while remaining easy to reach.

**Data**

- Added an isolated Polygres recall lab in `brain_dev` that models evidence, entities, typed claims, time, authority, search projections, resolution paths, and recall traces without changing the public brain.
- Added synthetic sentence, graph, and hybrid fixtures that exercise full-text search, pgvector, HNSW, typed multi-hop traversal, and supported, missing, and conflicting knowledge states.
- Added a disposable pgGraph 0.1.8 named-graph probe that verifies direct typed claim hops and returns each relationship's reason and evidence without registering sandbox tables in the real brain graph.
- Made every sandbox test, seed, and companion table reference explicitly target `brain_dev`, so a pooled database connection cannot silently fall back to the public brain when it discards a session setting.

**Tools**

- Fixed the space so "go to nearest portrait" actually resolves the face. Portraits are now baked for the exact spot that button flies you to: every dot is placed along the line of sight from there, so the face snaps together at the viewing point and reads as scattered chaos from anywhere else -- the anamorphic effect the space was built for. Before, the depth scatter only lined up in the studio preview, and the parked view stayed a jumbled cloud.
- Portraits already saved in the browser are upgraded automatically the next time the space loads; nothing needs to be re-added.
- Made the Codex brain companion skill the single canonical copy and linked Claude to it, so both agents now follow the same raw, readable, recap, and brain-safety ritual without drifting apart.
- Added a reusable recall policy and sandbox runner that diagnose why an answer is missing or contradictory, select only authorized next actions, and rerun comparisons without special-casing one life example.

**Docs**

- Added primary-source research on universal personal AI memory, Polygres retrieval and operational limits, and companion identity, separating what Fuzzy Brain can reuse from the human-ratified, cross-agent architecture it may uniquely contribute.
- Added an interactive Recall Observatory playbook with the technical priority map, live Polygres readiness audit, failure-repair states, and a replayable node-traversal animation.

---

## v0.6.0

Jul 9, 2026

**Data**

- Every node now keeps two layers: your raw words exactly as you gave them (never edited, not even typos, and no tool can change them), and a readable layer that guides you back into the thought. Existing nodes carried their stored text over as their raw.
- Added a talks table: at the end of a talking session the companion drafts a short factual recap, you approve it, and the next session's greeting picks up exactly where you left off.
- Added a brain_dev sandbox schema: tests, seeds, and experiments run there and are locked out of the real brain, and every migration rehearses on the sandbox before touching your real nodes.

**API**

- Creating a node now requires the raw words and treats the readable as optional; a deliberately typed thought counts as its own readable.

**Tools**

- brain.mjs learned the two layers and new verbs: set-readable (re-ratify a readable), add-talk (save an approved recap), and dump (a full JSON snapshot of the brain in your own hands). It still has no delete, clear, or set-raw on purpose.
- The visual-QA seed script now refuses to run anywhere but the sandbox.

**UI**

- The node panel shows the readable first with a quiet "see the raw" toggle for the verbatim original.

**Docs**

- The ritual grew the meaning rule: the readable describes and quotes but never interprets; meaning enters the brain only through you. The structure pass retired in favor of the readable pass, and a new rule bans destructive SQL against the real brain.

---

## v0.5.0

Jul 9, 2026

**Map**

- Fixed a crash in the map view where grabbing a node dot -- pressing on it, whether you then dragged it or just let go -- could throw "undefined is not an object (evaluating 'position.x')" and blank the view. The map's camera controls no longer trip over a pointer they never finished tracking.
- Node dots now feel alive: a dot brightens and swells while it moves (as the layout settles or when you drag it) and eases back once it comes to rest, and the whole field breathes gently when idle so the sky never looks frozen. All of this is turned off automatically if you have reduced motion enabled.

---

## v0.4.0

Jul 9, 2026

**Tools**

- Added the brain companion: talk the way you would to someone who remembers everything, and your thoughts become nodes as the conversation goes -- no form to fill out. It loads your whole brain, opens by picking up where you left off, runs the structure pass on what you share, and offers connections for you to approve before anything is linked.
- Added `scripts/brain.mjs`, the tool the companion runs on: `index` for the whole brain at a glance, `show` for the full text of a node on demand, and `add-node` / `add-edge` for writing, with the database "why" rule as the final gate.

---

## v0.3.0

Jul 8, 2026

**Tools**

- Added "the space" (tools/space): a full-screen studio that turns any photo into an anamorphic portrait, plus a 3D space you can fly through where portraits sit in a ring. It runs on its own, separate from the main brain map, so the brain stays the default.
- Fly with the arrow keys or WASD, and hold shift with up or down to rise and fall.
- "Go to nearest portrait" now carries you all the way to a crisp head-on view of the closest face; leaving that view eases you right up to the face instead of dropping you far away.
- Portraits can be deleted, each carries a numbered sign you can navigate to, and they are saved in the browser so they survive a reload.

---

## v0.2.0

Jul 8, 2026

**Face**

- Added the anamorphic face-reveal view: a 3D point cloud built from a real photo, where each node lights exactly one point in the actual face.
- Strung faint connection lines between lit points, so existing whys stay visible in the face view too.
- Made the face view the default view on load; the map is one toggle away.

**Map**

- Rebuilt the map as a 3D force graph with drag-to-rotate orbit controls and scroll to zoom.
- Restored springy drag physics so pulling a node visibly drags its connections along.
- Eased the camera toward a clicked node while its detail panel opens.

**UI**

- Removed the animated galaxy background in favor of a solid night sky.
- Added a motion pass: a tweened camera snap on "front", slow idle drift on the face view, staggered fades on load, a breathing halo on the selected node, and hover tooltips with a brief of the node body.
- Made all movement respect `prefers-reduced-motion`; buttons now acknowledge presses with a subtle scale.

**Tools**

- Added `tools/face-scatter.html`, a local, offline studio that turns a photo into the face-reveal point cloud, with a live 3D preview and tunable spacing, scatter depth, brightness, and contrast.
- Committed the ratified portrait asset (3,809 points).

**Docs**

- Wrote the face-reveal design spec, covering the full path from MediaPipe face landmarks to the final anamorphic-scatter approach.

---

## v0.1.2

Jul 7, 2026

**Docs**

- Proposed "The Ratified Galaxy" brain architecture: a machine-suggests, human-decides model for connections and abstraction layers. Not yet approved for build.

---

## v0.1.1

Jul 4, 2026

**Docs**

- Documented the ritual: nodes are raw capture, not polished artifacts.

---

## v0.1.0

Jul 2, 2026

**Data**

- Added the Polygres data layer: schema, a connection pool cached across dev reloads, and `GET /api/health` and `GET /api/graph`.
- Added integration tests that run against the real database inside rolled-back transactions.

**Map**

- Built the first map: a force-directed 2D graph with glow, a detail panel, and a type legend.

**API**

- Added in-app node creation: an add-node panel and `POST /api/nodes`.
- Allowed `127.0.0.1` as a dev origin.
- Made node type optional, so untyped capture stays first-class.

**UI**

- Added the animated galaxy background (removed in v0.2.0).
