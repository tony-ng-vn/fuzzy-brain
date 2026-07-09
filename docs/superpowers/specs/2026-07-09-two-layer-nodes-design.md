# Two-layer nodes, brain safety, and the talk log

Date: 2026-07-09
Status: ratified in conversation with Tony; ready for an implementation plan.

## Goal

Make a node worth reading later, make the brain safe from destructive operations, and give the companion a memory of past talks.
Three themes, one build: the node gains a raw and a readable layer, the database gains a sandbox and hard protection rules, and the companion gains a ratified talk log.

## The meaning rule

This rule governs every layer below and amends the ritual.

- The agent never writes meaning into the brain on its own.
- Meaning enters the brain only when it went through Tony: he said it, or it came up in conversation and he approved it.
- Ratified meaning lives in edge whys, in Tony's own raw words, and in readable lines he explicitly approved.
- The readable layer describes and quotes; it never interprets.

## Data model

### nodes: the two layers

- `nodes` gains `raw text not null` with a CHECK rejecting blank raw, the same spirit as the why gate on edges.
- `raw` is Tony's verbatim words: no typo fixes, no grammar fixes, no edits of any kind.
- The old structure pass retires; fidelity beats cleanliness now that a readable layer exists.
- `body` becomes the readable layer: what this node is about, organized so future Tony re-enters the thought fast.
- The readable is built from Tony's sentences, quotes his phrases verbatim where the weight is (typos kept), and adds only neutral connective narration that describes what the raw says.
- Connections and their whys are never baked into readable text; they render live from the edges table so they cannot go stale.
- `raw` is immutable forever: no tool, command, or API path may update it.
- `body` may be re-ratified later via `set-readable`, only with Tony's approval.
- Backfill for the five existing nodes: `raw = body`; their true originals are gone and the stored text is the closest surviving version.
- Upgrading existing nodes' readables happens later, in conversation, node by node, only if Tony wants.
- `created_at` stays the only timestamp; a `happened_at` field was considered and rejected as fake precision.

### talks: the companion's memory

- New table `talks(id uuid pk, recap text not null check non-empty, created_at timestamptz)`.
- A recap is a short factual record of one talking session: what was shared, what got connected, what is still open.
- Recaps are ratified: the agent drafts, Tony approves, only then does it save; the meaning rule applies.
- Talks are not nodes: they are conversation records, not atoms of meaning, and they never appear in the face or map views.

## Write paths

All three doors write both layers.

- `POST /api/nodes` accepts `{type, title, raw, body, connections}`; `raw` is required non-empty; `body` defaults to `raw` when absent.
- `AddNodePanel` sends the typed text as `raw`; a deliberately written thought is already its own readable, so the server default covers it.
- The companion (any model, any harness) saves the dump as raw verbatim, drafts the readable under the meaning rule, shows both layers, and writes only after Tony's yes.
- `lib/validation.ts` enforces the same contract as the database CHECK.

## brain.mjs commands

- `index`: the whole brain gist plus the latest talk recap, so the greeting picks up the thread in one read.
- `show <id...>`: full node text with both layers clearly labeled, readable first, raw below.
- `add-node`: JSON on stdin `{type, title, raw, body}`; `raw` required; `body` defaults to raw.
- `add-edge`: unchanged; the database CHECK on why remains the final gate.
- `set-readable <id>`: updates one node's readable after Tony ratifies the new version.
- `add-talk`: JSON on stdin `{recap}`; saves a ratified recap.
- `dump`: prints the entire brain (nodes, edges, talks) as JSON for a local snapshot in Tony's hands.
- Deliberately absent, as protection by omission: no `set-raw`, no delete, no clear, no reset verbs of any kind.

## Dev sandbox and protection

Findings from the live database: the role cannot create databases (`CREATEDB` off) but can create schemas.

- A `brain_dev` schema mirrors the tables inside the same database.
- Tests and `seed-test.mjs` run only against `brain_dev`; `seed-test` hard-refuses to run when not pointed at the dev schema.
- Migrations rehearse on `brain_dev` first, then apply to the real tables.
- During the build, check whether the role can create sub-roles; if yes, dev connections get a restricted role with no privileges on the real tables, so destructive SQL fails at the permission level.
- New AGENTS.md rule: no agent runs destructive SQL (delete, truncate, drop, bulk update) against the real brain; deleting real nodes happens only on Tony's explicit ask; destructive experiments live in `brain_dev` only.

## Companion ritual updates

- End of a talk: the agent drafts a recap, Tony ratifies, `add-talk` saves it.
- The greeting reads the latest recap plus the index, and may resurface one old node now and then; serendipity inside a session Tony started, never automation that pings him.
- Keepers are not only heavy moments; the digital self also holds jokes, wins, and small textures.
- Documents amended so every agent behaves the same: AGENTS.md rule 7 (two layers, the meaning rule, raw verbatim), `docs/writing-style.md` (the readable pass defined, replacing the structure pass), and `.claude/skills/brain-companion/SKILL.md` (capture shows both layers; sessions end with a ratified recap).

## Read paths and UI

- `GET /api/graph` returns `raw` alongside `body`; the brain is small and the app is local, so the payload cost is fine.
- `NodeDetailPanel` shows the readable first, the node's connections with their whys, and a quiet "see the raw" toggle.
- Face hover briefs, the map, and the face reveal keep using the readable; no changes.

## Testing

- Test-first throughout: validation (raw required, body defaults), database CHECKs (blank raw rejected, blank recap rejected), formatter output (both layers labeled), `set-readable` behavior, `dump` shape, and the seed-test dev-schema guard.
- Full suite via `npm test`, plus `npm run lint` and `npx tsc --noEmit` before each commit that touches app code.

## Out of scope, kept on the roadmap

- Deploy, auth, and the MCP server (the everywhere unlock; auth becomes mandatory the day the brain leaves localhost).
- The friend-form in the app (an in-app model call producing both layers).
- Bring-me-there retrieval: the model as a guide to Tony's own nodes, never an oracle answering instead of him; waits for density.
- Layers (chapters discovered after the pages are written); waits for density.
- Voice: a transport swap on top of the same conversation core.
- A deep technical review of the codebase; a separate pass on its own day.

## Versioning

- Minor bump at ship time (0.6.0 if still unclaimed; parallel sessions also bump), with a changelog entry under the repo's fixed categories as they apply: Data, API, Tools, UI, Docs.
