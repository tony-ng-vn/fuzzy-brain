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

## Connect a coding agent

```bash
npm run agents:install
```

This registers the `fuzzy-brain` MCP server with every coding agent it finds on the Mac: Claude Code (user scope), Codex, Cursor, Gemini CLI, Claude Desktop, and VS Code if its user `mcp.json` already exists.
It skips and reports on any agent it does not find installed, and prints a generic JSON snippet at the end for anything else.

It writes `~/.fuzzy-brain/home` with this checkout's absolute path and installs `~/.fuzzy-brain/bin/brain-run`, a small launcher every agent config points at instead of a checkout path directly.
Run `npm run agents:install -- --dry-run` first to preview every change without writing anything, or `-- --only codex,cursor` to limit it to specific agents.

Moving the checkout, including deleting the git worktree it currently lives in, is a rerun of the same command from the new location: `npm run agents:install`.
Nothing else needs to change, since every agent config and the scheduled sync's launchd job point at `~/.fuzzy-brain/bin/brain-run`, not at the checkout.

## Verification

```bash
npm test
npm run lint
npm run build
```
