# Digital brain: external landscape research

Date: 2026-07-13.
Companion to docs/research/2026-07-12-digital-brain-internal-audit.md; the master plan in docs/superpowers/specs/ stands on both.

Method and verification status: a fan-out research harness extracted 104 claims from 22 sources across six dimensions, then adversarially verified them with 3-vote panels.
A usage limit interrupted the run after 25 claims were verified, so every claim below carries one of four statuses:
VERIFIED (survived 3-0 or 2-0 adversarial votes), LOCAL (confirmed by direct observation on this machine, 2026-07-13), REPORTED (extracted from the named source but never adversarially verified), and GAP (dimension not covered; noted explicitly).
Source quality is tagged where it matters: primary (vendor docs, papers) versus blog/secondary.

## 1. Personal AI memory systems: what the field learned

### The big survey

A 47-author survey (Fudan/RUC/PKU/NUS/Oxford et al., arXiv 2512.13564) is the current reference frame. VERIFIED claims:

- The long/short-term memory taxonomy is declared obsolete; the replacement lenses are forms (token-level, parametric, latent), functions (factual, experiential, working), and dynamics (formation, evolution, retrieval).
- Contradiction handling evolved away from destruction: first-generation systems (MemGPT, D-SMART, Mem0g) let the LLM replace or delete conflicting memories, which erased history; Zep's fix -- temporal annotation, marking facts invalid with timestamps instead of deleting -- is presented as the corrective.
  This independently validates fuzzy-brain's append-mostly rule and the typed-edge design (validity dates, status) already parked as issue #3.
- Unsupervised LLM consolidation is a documented failure mode: MemGPT and Mem0 merging new content into summaries by pure LLM summarization produced inconsistency and semantic drift, and later systems added external verifiers.
  This is the academic case for the human-ratified readable layer.
- Trustworthy, user-governed memory is treated as an UNSOLVED future direction, not current practice, with demonstrated private-data leakage from memory modules via indirect prompt injection.
  Read plainly: the thing fuzzy-brain already enforces (owner-ratified meaning) is where the field says it needs to go.

### The two papers the earlier research cited (both real)

- MemIR (arXiv 2605.25869, May 2026) VERIFIED: names the failure mode of flat-text memory "provenance-role collapse" (agents lose track of where a memory came from and what epistemic role it plays), and fixes it by typing memory into raw evidence, retrieval cues, and truth-bearing claims, with factual authority restricted to supported claims only.
  That is fuzzy-brain's raw / readable / ratified split arrived at independently by academia; author-reported gains are largest on source tracking and temporal grounding.
- MRAgent (arXiv 2606.06036) VERIFIED: graph memory (Cue-Tag-Content) with "active reconstruction" -- LLM reasoning inside the retrieval loop, iteratively exploring and pruning paths, with traversal explicitly constrained to avoid combinatorial explosion; reports up to 23% over baselines on LoCoMo and LongMemEval.
  Relevant to issue #4's recall controller: retrieval as reconstruction, bounded.

### Zep / Graphiti and the benchmark wars

- VERIFIED (arXiv 2501.13956): Zep is built on Graphiti, a temporally-aware knowledge graph with a bi-temporal model (occurrence time vs ingestion time); on LongMemEval it reports up to 18.5% accuracy gains with 90% lower latency than full-context stuffing.
  The episodic-subgraph-under-semantic-graph shape matches the evidence-store-under-ratified-core architecture this plan adopts.
- REPORTED (Zep blog, adversarial party): LoCoMo is a weak benchmark (conversations fit in context; a full-context baseline beats Mem0's own memory configurations on Mem0's own numbers), Mem0's evaluation of Zep was allegedly misconfigured, and LongMemEval (~115k-token conversations, temporal questions) is the better test.
  Lesson regardless of who is right: vendor benchmarks are marketing terrain; fuzzy-brain's own eval set (25 questions, run 001) is the only score that matters here, and extending it per ingestion source is the real QA.

## 2. The any-model access layer: MCP won

- VERIFIED: in December 2025 Anthropic donated MCP to the Linux Foundation's new Agentic AI Foundation (co-founded by Anthropic, Block, and OpenAI); as of that date MCP is adopted by ChatGPT, Cursor, Gemini, Microsoft Copilot, and VS Code.
  Every surface Tony uses can consume one MCP server: the "any model out there" transport question is settled.
- VERIFIED: ChatGPT connects only to REMOTE MCP servers (local servers need OpenAI's Secure MCP Tunnel); Codex has first-party MCP client support across ChatGPT desktop, Codex CLI, and IDE extension with one shared config per host; Codex supports exactly two transports (local STDIO subprocess, remote streamable HTTP).
- REPORTED (primary vendor pages, unverified by panel): ChatGPT write-shaped MCP tools are gated to Business/Enterprise/Edu plans (Pro gets read-only via developer mode); ChatGPT dropped the old requirement that connectors expose search/fetch tool names, so custom verbs like recall/propose are allowed; OAuth servers need refresh-token support or connections silently degrade; claude.ai's Free plan gained one custom remote connector in April 2026; Codex authenticates to remote servers via OAuth flow or bearer token, configured in ~/.codex/config.toml; the protocol itself mandates no audit logging and no per-tool access control, so those are application-layer responsibilities.
- REPORTED: prior art exists and is instructive -- Mem0 shipped OpenMemory MCP (May 2025), a personal memory server shared across MCP clients, but its whole tool surface is CRUD (add_memories, search_memory, list_memories, delete_all_memories) plus a management dashboard.
  No propose/ratify or human-approval verbs exist in the wild.
  The ratification loop is the genuinely novel part of a fuzzy-brain MCP server.

## 3. Ingestion, per chosen source

### Agent sessions (Claude Code, Codex, Cursor)

- LOCAL: Claude Code writes one JSONL transcript per session at ~/.claude/projects/<hyphenated-cwd>/<session-id>.jsonl (confirmed by listing this machine; this very session's file is there).
- LOCAL: Codex CLI keeps sessions on disk under ~/.codex/sessions/ (year-partitioned) plus history.jsonl and session_index.jsonl (confirmed by listing).
- LOCAL: this machine already runs at least four fragmented agent memories -- claude-mem (sqlite + chroma at ~/.claude-mem), Codex's memories_1.sqlite, Codex's goals sqlite, and vendor cloud memories -- which is the fragmentation the digital brain exists to unify.
- REPORTED (vendor docs, primary): the JSONL entry format is explicitly internal and version-unstable, so pipelines should prefer the hook surface -- hooks and status lines receive a transcript_path field, and a SessionEnd hook can archive the transcript; default transcript retention is 30 days via cleanupPeriodDays (unset on this machine, so the default applies); transcripts are written continuously during the session, enabling live incremental reads.
- REPORTED (claude-mem docs, primary): claude-mem captures via a 5-hook lifecycle (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd), compresses observations with an LLM call asynchronously, injects the 50 most recent observations at SessionStart (recency, not semantic), stores in SQLite with FTS5 plus Chroma, and strips <private> tags client-side before anything leaves the hook process.
  Two design notes for the plan: its compression is machine-meaning with no ratification (useful, but it is exactly the layer fuzzy-brain refuses to call truth), and its injection is recency-based (a known limitation to beat).
- Cursor transcript locations: GAP (not covered before the interruption; needs a short local spike -- likely a similar on-disk store).

### iMessage

All REPORTED (imessage-exporter FAQ is primary; the deep-dive is a blog):

- Everything lives in one SQLite database, ~/Library/Messages/chat.db (often hundreds of MB to over 1 GB); reading it requires Full Disk Access for the reading process; contacts need a separate permission.
- Text splits across message.text (plain) and message.attributedBody (serialized NSAttributedString, binary plist) -- parsing the second is the fiddly part.
- The db runs in WAL mode and the main file can lag the WAL by seconds to minutes; live capture patterns poll read-only every ~2s and must handle WAL.
- Timestamps use Apple's 2001 epoch in nanoseconds.
- imessage-exporter (mature open-source) has no built-in incremental sync (date-window workarounds); but text-only export throughput exceeds 145k messages/second on an M1 Max, so periodic full re-exports are a perfectly viable sync strategy at personal scale.
- iCloud-only messages are invisible to local reads; deleted messages linger in a recovery collection up to 30 days; chat_message_join rows can be inconsistent.

### WhatsApp

REPORTED (exporter repo, primary): on iOS the working path is a local device backup (~/Library/Application Support/MobileSync/Backup/...) parsed by whatsapp-chat-exporter (pip, MIT, actively maintained, v0.13.0 January 2026) into JSON; incremental sync is merge-of-exports (each refresh needs a fresh backup); Android is materially higher friction (encrypted msgstore.db needs a key extractable only with root-level tricks).
Practical read: iPhone backup path is fine for a monthly batch; do not promise live WhatsApp.

### Granola

REPORTED (Granola docs, primary): an official REST API exists (public-api.granola.ai/v1, bearer auth, grn_ keys) exposing meetings WITH generated summaries/transcripts; rate limits are far above personal volume; speaker attribution is coarse (microphone vs speaker).
The catch: API key creation is documented only for Business/Enterprise plans -- no documented path for individual plans.
For a solo builder the practical surface is the Granola MCP connection already wired into Claude sessions; the API is the upgrade path if the plan tier allows.

### Email + calendar

GAP: the Gmail/Google Calendar angle produced no verified or extracted claims before the interruption.
The master plan schedules this as its own research spike rather than pretending coverage.

## 4. Processing and ratification patterns

Partially GAP (the dedicated best-practices angle did not complete), but three well-sourced anti-patterns landed:

- Machine-only consolidation drifts (survey, VERIFIED) -- see dimension 1.
- The dashboard is the anti-pattern: OpenMemory's human-in-the-loop surface is a browse/add/delete management dashboard (REPORTED) -- exactly the review-queue inbox issue #5 forbids.
- The Roam lesson (every.to, blog, REPORTED): capture structurally exceeds review; the promise that linking would replace organizing broke when users noticed they never revisited notes; once that promise broke, filing anxiety returned and users fled to simpler tools.
  The prescription that essay reached for (pre-LLM) was automation at capture time.
  Fuzzy-brain's answer is sharper: value lands in conversation (the companion answers and proposes in the flow), and ratification IS conversation, never homework.

Cost modeling: GAP in the research; the master plan carries a clearly-labeled back-of-envelope instead.

## 5. Privacy and security for intimate raw text

The strongest material is the Microsoft Recall security analysis (doublepulsar, blog, REPORTED) -- a live case study of an aggregated personal-capture store done wrong:

- Automated sensitive-data filtering is unreliable in practice: Recall's filter captured and indexed a full credit card number with CVV in testing.
- Ambient capture retains what others deleted: Recall kept disappearing/deleted Signal and WhatsApp messages.
  This lands directly on fuzzy-brain's chosen sources: ingesting iMessage/WhatsApp means keeping things other people un-sent.
  That is an ethics decision Tony must make explicitly, not a default.
- Encryption at rest does not protect against a user-level or brief-physical-access attacker (Recall's store was readable from AppData; unlockable with a 4-digit PIN).
- The realistic threat model for aggregated intimate data includes coercion, discovery (legal), and domestic situations, not just network attackers.

Plus one VERIFIED survey claim: private-data leakage from memory modules via indirect prompt injection has been demonstrated in the literature.
Implication carried into the plan: the brain's MCP surface needs app-layer scoping and audit logging (the protocol mandates neither), and capture-time filters must be treated as best-effort, with exclusion rules and a real threat-model doc.

## 6. The graveyard, and whether ratified meaning is differentiated

- Rewind/Limitless (TechCrunch secondary + REPORTED claims; note rewind.ai domain is now third-party squatted): launched Nov 2022 as local capture-everything search; pivoted April 2024 to the Limitless pendant despite $33M+ raised (not a funding death); original product put in maintenance mode; Meta acquired Limitless in 2025; recording was permanently disabled December 19, 2025.
  The best-funded pure auto-capture personal memory product did not survive as a product.
- Roam (blog): see dimension 4 -- the review-time value promise broke.
- Microsoft Recall (blog): auto-capture at OS level became a security scandal twice.
- Mem0/OpenMemory: alive, but local-first CRUD memory with a dashboard; no ratification concept.
- Tana, Reflect, Khoj, personal CRMs (Monica, Charlie): GAP -- not covered before the interruption.

The differentiation question the research was sent to answer comes back clean so far: across everything covered, no product or open-source system ships human-ratified meaning as the authority layer; the academic frontier (survey's "user-governed memory", MemIR's authority-restricted claims) points at it but calls it unsolved.
The moat is not the graph, the vectors, or the capture -- all commodities now.
It is the ratification loop and the evals around it.

## Coverage gaps, stated plainly

Interrupted before completion: email/calendar ingestion, Cursor transcript specifics, processing-layer best practices beyond anti-patterns, cost modeling, encryption implementation comparisons (pgcrypto vs app-layer), and the Tana/Reflect/Khoj/CRM corner of the landscape.
Eight claims sit at REPORTED-with-primary-source awaiting adversarial votes (listed in the run output); two of those were upgraded to LOCAL by direct observation on this machine.
The verification run can be resumed cheaply after the usage window resets; the master plan does not block on it.
