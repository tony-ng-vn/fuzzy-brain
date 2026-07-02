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
4. Claude is the write layer.
   Insert nodes and edges directly into Polygres (DATABASE_URL in .env.local); the app has no editing UI on purpose.
5. Do not delete or rewrite existing nodes without Tony's explicit ask.
   The brain is append-mostly; history is part of the story.
