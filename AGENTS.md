<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

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
7. When writing a node's body from something Tony said, keep his raw wording.
   Fix objective grammar and typos if he asks, but do not paraphrase, restructure, or add stylistic flourishes (like em dashes) he didn't use.
   His own words are the abstraction layer this brain exists to protect; do not launder them into Claude's voice.
