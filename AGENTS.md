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
7. When Tony pastes a raw thought as a new node, run the structure pass described in docs/writing-style.md automatically: fix typos and grammar, add paragraph breaks, nothing else.
   Show Tony the result before saving it. Never paraphrase, restructure sentences, or add stylistic flourishes (like em dashes) he didn't use.
   His own words are the abstraction layer this brain exists to protect; do not launder them into Claude's voice.
   If Tony corrects the pass, log the correction as a new rule in docs/writing-style.md so it doesn't recur -- the guide should need fewer corrections over time, not the same ones repeated.
