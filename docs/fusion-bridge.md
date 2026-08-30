# Fusion bridge

The fusion bridge gives local AI clients one consistent way to use Fuzzy Brain and keeps new agent sessions flowing into its evidence layer.

## What becomes truth

Ratified nodes remain separate from automatically ingested evidence.

- `remember` writes a node only after Tony explicitly says to remember, save, or add something.
- The saved raw and initial readable are both Tony's exact message unless he approved a separate readable draft.
- Deadline language on an explicitly saved node creates a separate append-only temporal event.
- `mark_complete` appends a completion event only after Tony explicitly says the named work is finished.
- Session ingestion writes only to the unratified evidence store.
- No automatic path creates edges or turns evidence into a belief about Tony.

## MCP tools

Run the server directly with:

```bash
npm run mcp
```

Register it with Codex, Claude Code, and every other coding agent this Mac has installed by running the installer once from the repository root:

```bash
npm run agents:install
```

This points each agent's config at `~/.fuzzy-brain/bin/brain-run`, a stable launcher the installer keeps in sync with this checkout, rather than at a path inside the checkout itself.
Moving the checkout later, including deleting the worktree it lives in now, is a rerun of the same command from the new location.
See the "Connect a coding agent" section in the repository README for `--dry-run` and `--only`.

The MCP process trusts the local Codex client as its caller security boundary.
Write tools also require explicit save or completion language in the passed verbatim user text as defense in depth.

It exposes five tools:

- `recall`: search ratified nodes and unratified evidence with provenance.
- `list_reminders`: return active overdue and upcoming deadlines.
- `get_node`: read one node and its current temporal state.
- `remember`: append an explicitly requested memory and detect a deadline.
- `mark_complete`: append completion events without rewriting nodes.

The server communicates over stdio.
Its standard output is reserved for MCP JSON-RPC.

## Automatic session sync

Install the hourly macOS LaunchAgent from the stable repository checkout:

```bash
npm run fusion:install
```

Each run performs these steps in order:

1. Scan settled Claude Code and Codex sessions.
2. Apply the local allowlist, source exclusions, and deterministic sensitive-pattern scrub.
3. Append new episodes and evidence spans to the configured database.
4. Fill at most 32 missing embeddings with the local model.

Sessions must be older than `settledHours` in `~/.fuzzy-brain/ingest.json` before they ingest.
The exact string `"*"` in `allowlist` explicitly permits every project; a missing or empty allowlist permits nothing.
The database is cloud-hosted, so allowed session text leaves this Mac after the guards run.

Inspect the job and its logs with:

```bash
launchctl print gui/$(id -u)/com.tony.fuzzy-brain.sync
tail -n 100 ~/.fuzzy-brain/logs/fusion-sync.log
tail -n 100 ~/.fuzzy-brain/logs/fusion-sync.error.log
```

Run one foreground cycle with:

```bash
npm run fusion:sync
```

## Reminder behavior

Deadline inference requires deadline language such as `by`, `due`, `expires`, `through`, or `until` plus a current or future date.
An ordinary historical date does not become a reminder.
Historical deadline language is not inferred automatically; use an explicit deadline command when an old date should remain active.
Date-only deadlines are stored as the end of that local day in `America/Los_Angeles`.
Explicit ISO timestamps must include a timezone.

Inspect current active reminders with:

```bash
node scripts/brain.mjs list-reminders
```

Correct or remove a mistaken deadline through the append-only CLI:

```bash
node scripts/brain.mjs set-deadline <node-id> < deadline.json
node scripts/brain.mjs clear-deadline <node-id> < clear.json
```

Completed nodes remain in history but do not appear in the active reminder list.
