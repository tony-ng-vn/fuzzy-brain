# Fuzzy Brain

Fuzzy Brain is Tony's append-mostly personal memory: ratified nodes and human-approved why-edges beside a larger, explicitly unratified evidence store.

The local app renders the brain.
The command-line tools and local MCP server let Codex and other agents recall it, save explicit memories, understand deadlines, and append completion events without rewriting history.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run dev
```

Open [http://localhost:3010](http://localhost:3010).

## Brain tools

```bash
node scripts/brain.mjs index
node scripts/brain.mjs show <node-id>
node scripts/brain.mjs list-reminders
node scripts/recall.mjs "<question>" --json
```

Write commands accept JSON on stdin.
There are deliberately no node-delete or set-raw commands.

## Fusion bridge

The local MCP server exposes `recall`, `list_reminders`, `get_node`, `remember`, and `mark_complete`.
Its instructions tell compatible agents to query Fuzzy Brain automatically for questions about Tony's past, people, preferences, goals, deadlines, and unfinished work.

The scheduled sync ingests settled Claude Code and Codex sessions into the unratified evidence store, then fills a bounded number of missing local embeddings.
It does not promote session text into ratified nodes.

Setup, privacy boundaries, operations, and verification are documented in [docs/fusion-bridge.md](docs/fusion-bridge.md).

That guide also includes the durable `codex mcp add fuzzy-brain` registration command for a stable checkout.

## Verification

```bash
npm test
npm run lint
npm run build
```
