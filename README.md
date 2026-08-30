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

Every agent config points at `~/.fuzzy-brain/bin/brain-run`, a small launcher, instead of a checkout path directly.
Run `npm run agents:install -- --dry-run` first to preview every change without writing anything, or `-- --only codex,cursor` to limit it to specific agents.

### The pinned runtime

Agents do not run this checkout.
They run `~/.fuzzy-brain/runtime`, a copy the installer maintains and keeps parked on `main`, and `~/.fuzzy-brain/home` points there.
The reason is that a working checkout sits on whatever branch you left it on.
Without the runtime, spending an afternoon on a feature branch silently hands every coding agent on the Mac a half-finished brain, and deleting or moving the directory breaks all of them at once.

The runtime is a `git clone --local`, so the git objects are hardlinks and cost almost nothing.
Its `node_modules` is a real second copy at roughly 1 GB, which is the whole price of the arrangement.
The installer also copies `.env.local` in, since the scripts read it from the repo root and the runtime would otherwise have no database to talk to.

The installer refuses to build a runtime from a checkout with uncommitted changes to tracked files, or from a `main` that is behind `origin/main`, and prints what is wrong and the command that fixes it.
Untracked files are only a warning, because they cannot end up in a clone anyway.
The drift check reads `origin/main` as it stands rather than fetching, so run `git fetch origin main` first if you want a fresh answer.

After landing a change on `main`, one command brings the agents up to date without touching any agent config:

```bash
npm run agents:install -- --runtime-only
```

That fetches from this checkout and hard-resets the runtime to `main`, then reinstalls dependencies only if `package-lock.json` actually changed.
The runtime's `origin` is the path of the checkout it was cloned from, so a refresh needs that checkout to still be there; a rerun from a new location repoints it.
Every install ends by printing the commit the runtime is on, so which version the agents are running is never a guess.

To debug against your live checkout instead:

```bash
npm run agents:install -- --dev
```

That points `~/.fuzzy-brain/home` back at the working checkout and says so loudly, twice.
While it is in effect, whatever branch this checkout is on is the brain every agent gets.
`npm run agents:install` with no flags puts them back on the pinned runtime.

Moving the checkout is a rerun of `npm run agents:install` from the new location.
Nothing else needs to change, since every agent config and the scheduled sync's launchd job point at `~/.fuzzy-brain/bin/brain-run`, not at the checkout.

## Verification

```bash
npm test
npm run lint
npm run build
```
