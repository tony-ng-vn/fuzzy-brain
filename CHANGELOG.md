# Changelog

New updates and changes to Fuzzy Brain.

---

## v0.23.1

Aug 31, 2026

**Tools**

- Security update: Next.js moves from 16.2.10 to 16.3.3, which closes a middleware authorization bypass and the postcss and nanoid advisories that came in through it, and `npm audit fix` takes the brace-expansion and js-yaml patches. That clears five of the nine high-severity advisories the audit reported.
- The four that remain all live under the local embedding stack (`@huggingface/transformers` pulling old `sharp`, `onnxruntime-node` pulling old `adm-zip`) and have no released fix. They only process Tony's own local model files, never untrusted input, so the practical risk is low; they will clear when the upstream packages update.

---

## v0.23.0

Aug 31, 2026

**Tools**

- Asking the brain a question is about twice as fast, and re-asking one is about four times as fast. A recall used to send ten to fifteen small queries to the database one after another, and with the brain living behind a managed Postgres, each of them paid the network's round trip before doing any work. All the search lanes, the matching edges, and the node rows behind them now travel in one statement, so an ordinary question costs three round trips: one to weigh the question's words against the brain's vocabulary, one to search, one to walk the ratified edges out of the hits. Measured back to back on the same network against the real brain: first asks fell from about 1.4 seconds to 0.7, repeated asks from about 0.9 to 0.23, with identical answers.
- If the combined statement ever fails, recall falls back to the old one-query-per-lane path and says so in the answer's note, so a broken extension still costs one lane instead of the whole answer.

---

## v0.22.0

Aug 30, 2026

**Tools**

- Asking the brain a question from an agent is now about twice as fast. The MCP server used to start a whole new Node process for every question, and each one loaded the local embedding model from scratch before it could search anything. It now does the work in its own process, so the model loads once and stays loaded. Measured against `brain_dev` over ten questions in one server: the first question still costs about 1.9 seconds, every question after it takes a median of 898 milliseconds, against a flat 2.0 to 2.4 seconds per question before.
- Reminders and single nodes come back almost instantly: about 85 milliseconds instead of about 900. Nothing about those two was slow; they were paying for a process start and a fresh database handshake every time. That 85 milliseconds assumes a connection left open by a recent question. Connections are dropped after 30 seconds idle, so the first question after a quiet stretch reconnects before it can answer.
- A failed model load no longer sticks. Because the server now stays up, one bad load would have left the meaning-based search dead for the life of the server, with every answer quietly falling back to text search. It retries on the next question instead, which is what the old one-process-per-question setup did by accident.
- Honest note on the query cache. It caches now that the server lives long enough for it to matter, but re-asking the same question only saves about 80 milliseconds. Once the model is loaded, embedding a question is cheap. Nearly all of the win is the model staying put.
- Writing to the brain is unchanged. `remember` and `mark_complete` still go through `scripts/brain.mjs` as separate processes, so the one ratified write path stays exactly where it was.
- `recall` is now importable as a function as well as a command. The command prints exactly what it printed before, byte for byte, so anything parsing its `--json` output keeps working.

---

## v0.21.0

Aug 30, 2026

**Tools**

- Coding agents now run a pinned copy of the repo at `~/.fuzzy-brain/runtime` instead of whatever branch your working checkout happens to be sitting on. Before this, an afternoon spent on a feature branch quietly made that half-finished branch every agent's brain, and moving or deleting the checkout broke all of them at once. The runtime is a local clone parked on `main`, so the git objects are hardlinks and cost almost nothing; its `node_modules` is a real second copy at roughly 1 GB.
- `npm run agents:install` refuses to build the runtime from a checkout with no local `main`, or from a `main` that is behind `origin/main`, and prints the exact command that fixes it. Both mean the runtime would pin a state nobody has agreed is good. Your working tree never blocks it, because the clone reads committed `main` and your edits cannot reach the runtime anyway; you get a warning saying they stay behind, plus one if `main` is ahead of `origin/main` and the agents would be running unpushed code. Every install ends by printing the runtime's commit and subject, so which version the agents are on is never a guess.
- New `--runtime-only` flag refreshes the runtime after you land something on `main` without touching a single agent config, and only reinstalls dependencies when the lockfile actually changed. It works mid-change, so you do not have to stash whatever you are in the middle of. New `--dev` flag points the agents back at your working checkout for debugging, with a warning at the top and bottom of the output saying what that costs. `--dry-run` still writes nothing at all, the runtime directory included.
- `npm run fusion:install` follows the pinned runtime too. Installing the scheduled sync from a feature branch used to drag every agent onto that branch through the same launcher.

**Docs**

- The README's "Connect a coding agent" section explains the runtime: why the agents no longer follow your checkout, what it costs in disk, how to refresh it after a merge, and what `--dev` does.

---

## v0.20.0

Aug 30, 2026

**API**

- New POST /api/companion route: a bridge to the brain companion that runs a local Claude Code session on your subscription, so talking to the brain from the app costs nothing beyond the subscription you already have. The route feeds the whole brain to the session as text and gives it an empty tool set with slash commands turned off, so the session can only talk and propose; it cannot run commands, read files, reach the network, or write to the database on its own. It answers on localhost only and needs a custom header, matching the sync route's guards.
- The dev and start servers now bind to 127.0.0.1 (localhost only) instead of every network interface, so nothing off your machine can reach the app. If you used to open the brain from your phone on the same wifi, that no longer works by default; this is the real boundary that keeps the companion bridge from being driven by another device.

**UI**

- New "talk" button opens a chat panel where you can think out loud and the companion picks up the thread, the same core loop that used to live only in the terminal. When something is worth keeping it proposes a node as a save card showing both layers (your verbatim words and the readable draft); nothing is saved until you click, and saving goes through the same add-node path the form already uses. The conversation stays one continuous session across messages, which also keeps each turn cheap.
- A node that will not save now says why in plain words. A connection pointing at a node that no longer exists comes back as exactly that, instead of the raw database error the page used to print, which named tables and constraints.

---

## v0.19.0

Aug 30, 2026

**Data**

- Edge why sentences are indexed for full-text search, and `pg_trgm` plus two trigram indexes back the new typo lane. All additive; the migration rehearses on `brain_dev` before touching the real tables, as always. The trigram indexes cover the first 2,000 characters of a quote and the first 4,000 of a node, which bounds them at about 36MB instead of letting the corpus decide.

**Tools**

- `recall` now runs the retrieval design the recall bench proved, instead of the two-lane sketch it grew from. On the bench's frozen 50,000-memory corpus that design took Recall@10 from 0.697 to 0.977, and the whole schema-independent half of it now lives in `scripts/lib/retrieval/`, imported by both the bench harness and `scripts/recall.mjs`, so the two cannot drift apart.
- Four lanes per layer instead of two: exact full text, fragments, vector meaning, and trigram similarity for a question you mistyped. Which lanes matter is decided per question -- a short question whose words are not in the brain at all leans on trigrams, a long reworded one leans on meaning -- and the lanes are fused and then reranked rather than simply added up.
- A mistyped question finds its answer. "securty vulnerabilites reviw" used to come back with nothing at all; it now returns the security-review span it was asking for. Measured against the real store, real typos score 0.44 to 0.69 on trigram similarity against their own answer and letter soup tops out at 0.25, so the cutoff sits at 0.40, in the gap.
- A question that names a month or a year filters every lane by date. "what happened to the brass lantern in march 2024" now excludes the September span instead of ranking it. Bare month names are deliberately not a date signal, because "may" and "march" are ordinary words.
- Ratified edge whys are searchable, and hits walk one hop. Ask about the words in a why sentence and both nodes it joins come back. Find a node any other way and its ratified neighbours come with it, each carrying the why that surfaced it, so an answer can always say why something is in front of you. A node that arrived through an edge never counts as a strong hit, so it can never make a question look answered when it is not.
- The five answer states mean exactly what they meant before, and letter soup still answers "missing": twenty randomized nonsense questions returned zero hits each. The rule that keeps them out is unchanged in substance -- a vector score on its own is only trusted above 0.70, and below that a row has to have been matched by something that reads actual words.
- The trade-off worth knowing: a question now costs roughly 150ms more, and a mistyped one costs about two seconds against the full evidence store, because trigram matching is expensive. That lane only runs when a question looks mistyped, so ordinary questions do not pay for it.
- That 0.70 is itself a change. The cosine score that counts as a strong vector hit moved from 0.65, because 0.65 sat right on top of the noise rather than above it. Measured against brain_dev (451 embedded spans of real session text), 150 random letter-soup questions scored a median of 0.61 and a maximum of 0.651 against their nearest neighbour: a nonsense question never scores near zero, it just lands somewhere in the middle of the corpus. So about one junk question in fifty came back labelled "evidence" when the honest answer was "missing". Real answers and paraphrases score 0.72 to 0.87, so nothing at all lives in the gap the new threshold sits in.
- That threshold move is a real answer-state change, not only a nonsense filter. A span that scores between 0.65 and 0.70 against your question used to come back as "evidence"; now it comes back as "partial". If a recall that used to answer starts saying "fragments surfaced but no direct answer is stored", that band is why, and the threshold is one named constant near the top of `scripts/recall.mjs`.
- Query embeddings now run through a small bounded LRU cache (500 entries, keyed by trimmed/lowercased text): a cache hit skips the ~20ms model call and measured under 0.01ms on this machine. `scripts/recall.mjs` is wired to it, but that script is a one-shot CLI process (it embeds one question, then exits), so its cache is empty on every run and this does not yet speed up that command. The win lands whenever a caller of `embedQueryCached` stays resident across questions -- a long-lived server process, not this CLI.
- The recall benchmark refuses to run itself into the ground. A load run now checks the working set against available RAM, the connection count against the core count, and whether the machine is already swapping, and it stops mid-run if the run itself starts swapping. This follows a 10M benchmark that took this laptop to 15.6GB of swap and load average 72 and made the desktop unusable; `--force` overrides it on a machine that can take it.
- Added `scripts/bench-embed.mjs`, a rerunnable benchmark for query-embedding latency (cold model load, warm p50/p95 over realistic 5-30 word questions, and the cache-hit path), printing load average before and after since this machine is shared and often under heavy contention.
- Looked into whether a faster ONNX backend exists for the query-embedding model on this Apple Silicon Mac. CoreML execution (`device: "coreml"`) was clearly slower, not faster (cold model load roughly 3x, warm p50 roughly 4x versus plain CPU), likely from unsupported-op fallback overhead on a small encoder at batch size 1. The q8-quantized weights were about 2.5x faster warm, but the minimum cosine similarity against the fp32 embeddings across 20 sample questions came out to 0.964, under the 0.99 bar needed to trust it as the same retrieval signal, so it stays out. The query path keeps the default CPU/fp32 backend.

**Docs**

- `experiments/recall-bench/PRODUCT-RECALL.md` records the port: what is shared, every tunable that had to change and the measurement behind it, and the same eighteen real questions run before and after.

---

## v0.18.0

Aug 30, 2026

**Tools**

- `npm run agents:install` registers the fuzzy-brain MCP server with every coding agent on this Mac in one step: Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop, and VS Code if it is already set up for MCP.
  It skips and reports on any agent it does not find, and prints a plain JSON snippet at the end for anything else.
  `--dry-run` previews every change without writing, and `--only` limits it to specific agents.
- Every agent config, and the scheduled sync's launchd job, now points at `~/.fuzzy-brain/bin/brain-run`, a small launcher the repo ships and the installer keeps pointed at the current checkout, rather than at a path inside a git worktree.
  Moving the checkout, including deleting the worktree it used to live in, is a rerun of the installer from the new location; nothing else needs to change by hand.
  Existing hand-edited agent configs and the sync launch agent are safe to rewrite: each config is merged or backed up before being touched, never wholesale replaced.

**Docs**

- The fusion bridge guide and the README now point at `npm run agents:install` instead of the old by-hand `codex mcp add ... "$PWD/..."` command, which broke the moment the checkout it was run from moved or was deleted.

---

## v0.17.1

Aug 12, 2026

**Tools**

- Notes captured through the share sheet are now attributed the same way notes from every other source are, so recall treats them as Tony's own words and weighs them accordingly.
  They were labelled with a capital T, which recall did not recognise, so those notes had been quietly missing the boost since the clippings sweep was written.
  Notes already stored keep their old label, since evidence is never rewritten; anything captured from now on gets the boost.

---

## v0.17.0

Aug 12, 2026

**Tools**

- Video transcripts pasted into the todo app now land in the brain's evidence store on their own, one episode per video, with the title, channel, link, and the date it was watched kept alongside them.
- Each transcript is stored in pieces cut at its own timestamps, so every piece opens with the moment it was said and a quote can be traced straight back to that point in the video.
- Notes written about a video are stored as Tony's own words, which is the attribution recall leans on when it decides what is worth bringing up.
- The hourly sync now runs this sweep between session ingest and embeddings, so a transcript pasted on the phone is searchable by the next cycle.
  If the todo app's backend cannot be reached, that step is skipped and the rest of the sync still finishes.
- Re-running is always safe: a video already captured is never stored twice, and a run that landed a transcript but never got to tell the app about it finishes that half on its next pass.
- `npm run watch:sweep` runs the sweep by hand, and `--dry-run` reports what would land without writing anything anywhere.

---

## v0.16.0

Aug 6, 2026

**Data**

- Deadlines and completion status now live in an append-only temporal event ledger, so the brain can know what is overdue, upcoming, or finished without rewriting old nodes or their raw words.
- Automatic deadlines now require explicit deadline language and a current or future date, can be cleared through another append-only event, and render with the correct Los Angeles calendar date.
- The two completed August goals are recorded as finished, and the Stripe Atlas offer remains active through August 5, 2027.

**API**

- A local MCP server now gives Codex and other compatible agents five guarded tools for recall, reminders, node reads, explicit memory capture, and explicit completion.
- MCP writes now require matching explicit user command language in addition to the trusted local-client boundary.
- The in-app and command-line node paths now recognize clear deadline language and create temporal metadata in the same transaction as the node.

**Tools**

- A macOS LaunchAgent can now ingest settled Claude Code and Codex sessions every hour into the unratified evidence store, then fill a bounded number of local embeddings; absolute executable paths and a cross-process lock keep scheduled and manual runs reliable.
- Resumed sessions now append only their unseen turns, and malformed allowlists or settlement windows fail closed before any cloud write.
- Embedding sweeps now process one document at a time, release native tensors, and refuse overlapping runs so unattended sync cannot exhaust the Mac.

**Docs**

- The companion ritual now distinguishes an explicit remember or completion command from ordinary conversation, and documents the fusion bridge's truth, privacy, reminder, and operating boundaries.
- The fusion guide now includes a reproducible Codex registration command for a stable checkout.

---

## v0.15.0

Jul 21, 2026

**Docs**

- New `digest-article` skill: hand it a URL and it lands the article whole in the evidence store, teaches it back to you live so you actually learn it, and lets takeaways precipitate into the brain in your own words. The brain stores what reading did to you, with a pointer back to what you read -- never the article's text as brain truth. Zero takeaways is a normal outcome; the article just sits in evidence.

---

## v0.14.2

Jul 22, 2026

**Docs**

- There is now a single living Polygres knowledge base at docs/reference/polygres.md. It gathers what we know about the Polygres platform and the Evokoa extensions (pgGraph, pgContext, and the new Pocket product) into one place that other AI sessions and other projects can reference, records that pgGraph is already pre-registered on the live brain tables but not yet built, notes that pgContext cannot yet coexist with pgvector, and holds the standing decisions about when to adopt each.
- Added a BACKLOG.md at the repo root for capturing fuzzy, half-formed thoughts before they get lost -- things to come back to later, no structure or polish required.

---

## v0.14.1

Jul 21, 2026

**Tools**

- No script can silently run forever anymore. Every database connection now gives up loudly instead of hanging on a bad link (15s to connect, 2 minutes per query), and every sweeper's call into brain.mjs now has a 5-minute cap. This closes the class of failure where an ingest run once stalled for hours with no output; a failed call now lands in the run's counters and retries safely on the next run.
- The embedding sweep now runs at the lowest CPU priority, so a long backfill can no longer starve the whole machine the way the first one did. It also stops itself if it detects it is making no progress (for example when a second sweep is filling the same rows), instead of looping.
- The session and clipping sweepers now share one helper for talking to brain.mjs, so their safety limits can never drift apart.

---

## v0.14.0

Jul 21, 2026

**Tools**

- New capture path from phone and Mac, no terminal needed. Share or highlight anything, tap the "Brain" Shortcut, and it lands in the evidence store as a `clipping` episode. A new sweeper (`npm run clippings:sweep`) moves clips from an iCloud Drive inbox folder into the brain through the existing `add-episode` verb, so the sensitive-pattern scrub, source exclusions, and dedupe-by-content guards all apply automatically. Nothing captures on its own: a clip exists only because Tony shared it. Processed clips are archived, never deleted, and failed clips stay in the inbox and retry on the next run.

**Docs**

- Step-by-step guide for building the two share-sheet Shortcuts ("Brain" and "Brain + note"), the clip format, and scheduling the sweeper with launchd: docs/capture-shortcut.md.

---

## v0.13.2

Jul 16, 2026

**Docs**

- The core open question -- how raw data becomes ratified node knowledge -- now has a written development plan: hand-cut real cases with Tony first, then retrieval over evidence, then the proposer, then typed claims once reality actually needs them. Full ladder: docs/superpowers/specs/2026-07-16-processing-layer-development.md.
- Phase 3 was reviewed and rescoped to evidence-first retrieval, since the ratified brain is still far too small to need its own retrieval yet; the corrections are recorded on issues #4 and #10.

---

## v0.13.1

Jul 14, 2026

**API**

- The sync-sessions route no longer freezes the whole app while it runs. It used to block every other request for up to ten minutes per click; it now runs the ingest without blocking, and a second click (or a terminal import running at the same time) is safely turned away instead of racing the database.
- Error messages shown after a failed sync are safe to display now. File paths, database details, and quoted session text used to be able to leak into the browser; the full detail goes to the server log instead, and the button shows a plain explanation of what went wrong.
- The route now requires a small custom header on its request, so another browser tab or page can't silently trigger a sync just by loading in the background.

**UI**

- Fixed the sync result panel hiding other panels underneath it. Opening "+ add node" or selecting a node/connection while a sync result was showing now closes the sync panel first, matching how those panels already behaved with each other.

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
