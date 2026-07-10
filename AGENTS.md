# Fuzzy Brain: the ritual

This repo is Tony's brain map.
Full design: docs/superpowers/specs/2026-07-02-fuzzy-brain-design.md.

Rules for any session that touches the brain data:

1. A node is any atom of meaning: story, lesson, quote, event, person, anything.
2. Never auto-link.
   Connections are decided in conversation with Tony: discuss first, write only after he agrees.
3. Every edge must carry a "why" sentence explaining the connection.
   The database rejects blank whys; do not work around that.
4. There are two write paths: Claude inserting directly into Polygres (DATABASE_URL in .env.local), and the in-app add-node panel (POST /api/nodes).
   Both enforce the why rule; the database CHECK constraint is the final gate.
5. Do not delete or rewrite existing nodes without Tony's explicit ask.
   The brain is append-mostly; history is part of the story.
6. Every node is a raw and messy thought Tony wants to keep, not a polished artifact.
   It does not need to be a story, or have a type, or connect to anything, or come with a summary of what it "really means".
   Some things have depth we can only partly show or understand right now, and the rest becomes visible through other layers and nodes later, not by forcing an explanation now.
   The point is capture: it is better to store a half-formed thought than let it stay in his head and get forgotten.
7. Every node carries two layers: raw (Tony's verbatim words, stored exactly as he gave them, no edits of any kind, not even typos) and body (the readable layer).
   When Tony gives a thought, save his words as raw untouched and draft the readable per docs/writing-style.md; show him both layers before saving; save only after he agrees.
   The readable describes and quotes; it never interprets.
   No meaning enters the brain unless Tony said it or approved it: ratified meaning lives in edge whys, in his raw words, and in readable lines he explicitly approved.
   raw is immutable forever; the readable may be re-ratified later via set-readable, only with Tony's approval.
   If Tony corrects a readable pass, log the correction as a new rule in docs/writing-style.md so it doesn't recur.
8. Keep CHANGELOG.md up to date after any user-visible change, following the format defined in the global changelog rule (see ~/.codex/AGENTS.md).
   This repo's fixed categories are: Face, Map, Data, API, Tools, UI, Docs -- use whichever apply, in that order, and add a new one only if a change genuinely does not fit.
   Bump package.json's version to match the newest changelog entry: patch for small fixes or docs-only changes, minor for new features or visible behavior changes.
9. Never run destructive SQL (delete, truncate, drop, bulk update) against the real brain, which lives in the public schema.
   Destructive experiments, tests, and seeds live only in the brain_dev schema; npm run db:migrate rehearses every migration there before touching the real tables.
   Deleting real nodes happens only on Tony's explicit ask, per rule 5.
   scripts/brain.mjs deliberately has no delete, clear, or set-raw verbs; do not add them and do not work around their absence with raw SQL.
