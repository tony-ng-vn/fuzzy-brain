# Fuzzy Brain: design (v1)

Date: 2026-07-02

## Vision (long term, not v1)

Tony's eventual vision is a serendipity platform: people find the right people through the vertical, abstract layer of their lives (stories, whys, purpose), not through horizontal goals and titles.
That layer is human-made by design; an LLM should read it, not invent it.
V1 exists because you cannot design that platform without at least one fully mapped brain to study.
Tony's brain is the prototype dataset.

## What v1 is

A web app showing a living map of Tony's brain: a force-directed graph of nodes and connections, grown over time through conversation with Claude Code.
The aesthetic target is the classic internet-map visualization: glowing nodes on black, clusters like galaxies, a simulation that feels alive.
It starts empty and gets more beautiful as it grows; it does not fake density.

## Core rules (load-bearing, agreed with Tony)

1. A node is any atom of meaning: story, lesson, quote, event, person, anything.
2. Connections are never automatic.
   Tony and Claude discuss, then decide.
   The discussion is the product; the graph is the residue.
3. Every edge carries a "why" sentence.
   No naked connections.
   This is enforced by a database CHECK constraint, not by convention.
4. Claude Code is the primary write layer.
   Tony later asked for an in-app add-node panel as well (added same day); it creates a node plus optional connections via POST /api/nodes, and it cannot create a connection without a why.

## Architecture

- Next.js (App Router, TypeScript), one page: the map.
- Database: Polygres (managed Postgres), connected via DATABASE_URL in .env.local (gitignored).
- Data access: node-postgres (pg) with a pool cached on globalThis to survive dev hot reloads.
- API: GET /api/health (connection check), GET /api/graph (entire brain in one response; the graph is human-curated and therefore small).
- Map rendering (next step): react-force-graph in 2D, black background, nodes colored by type, glow, warm simulation.
  Hover shows title; clicking a node opens a panel with the full body and its connections, each with its why; clicking an edge shows its why.

## Schema

- nodes: id (uuid), type (free text), title, body, created_at.
- edges: id (uuid), source -> nodes, target -> nodes, why (text, CHECK non-blank), created_at.
- Migration is scripts/schema.sql applied by scripts/migrate.mjs (idempotent).

## TLS note

Polygres serves a certificate from its own private CA (issued for the direct.db hostname) and does not include the CA in the chain, so full verification is impossible from the client.
The connection string therefore uses uselibpqcompat=true&sslmode=require: traffic is encrypted, the server cert is not verified.
Revisit if Polygres publishes a CA bundle.

## Testing

Light by design.
Integration tests (node --test) run against the real database inside rolled-back transactions: connection health, node/edge round-trip, and the why constraint rejecting blank reasons.
No tests on visuals; the visual test is Tony looking at it.

## Future directions (parked, not v1)

- Polygres graph/semantic features (pgGraph) when queries become multi-hop or semantic ("stories that rhyme").
- Abstraction layers above nodes; weights on edges; multiple brains; the platform itself.
- Search, filtering, timeline views.

## Status

- 2026-07-02: repo scaffolded, schema applied to Polygres, health and graph endpoints verified end to end, tests green.
  Next: build the map page, then seed the first real nodes live with Tony.
