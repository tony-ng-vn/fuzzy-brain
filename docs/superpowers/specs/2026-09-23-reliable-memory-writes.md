# Reliable memory writes

## Objective

An agent that loses a save reply must be able to retry the same approved instruction without creating another memory or changing its deadline.
Concurrent completion requests must append at most one completion event for a node.
This is part of the user-directed improvement run ending at noon Pacific on September 24, 2026.
The previous run shipped version 0.27.0 through PR 41.

## Current evidence

`remember` delegates to `brain.mjs add-node`, which generates a new node ID on every call.
`mark-complete` reads a derived status and then inserts events without locking the target nodes.
The archive importer already demonstrates the desired transactional receipt and retry behavior.
The changes below extend that reliability to approved memories without altering what counts as approved meaning.

## Contract

The existing commands continue to work without a request ID.
An optional UUID `request_id` identifies one approved operation across retries and clients.
The caller creates it before the first attempt and preserves it if the reply is lost.
The same ID, operation and normalized input returns the original result.
The same ID with changed input or a different operation returns a conflict.
The receipt and all resulting nodes or events commit or roll back together.
Relative deadlines are derived only on the first successful attempt.
Readback by request ID returns the committed result even after the server restarts.
Replay does not depend on a node's current readable text or current deadline, which can evolve through later approved actions.

Completion commands lock all requested nodes in ID order before reading current temporal state.
This protects concurrent callers even when they do not supply a request ID.
The operation remains all-or-nothing when a target is missing.

## Storage and implementation

Add a separate append-only `memory_write_receipts` table containing a UUID request ID, operation, request digest, immutable JSON result, and commit timestamp.
This is structural provenance, not a ratified memory, belief, or semantic edge.
Use a separate additive migration with a sandbox rehearsal before production.
The migration must not rerun historical raw backfills or replace existing data.
Keep writes in `scripts/brain.mjs` and expose receipt reads through the existing local memory server.
No new dependency is required.

## Verification

Use disposable loopback PostgreSQL and synthetic text only.
Reproduce duplicate saves and concurrent completion events through real subprocess or MCP boundaries before implementing the fix.
Test retry, restart, changed-payload conflict, cross-operation conflict, transaction rollback, raw byte preservation, relative deadlines, missing targets, and unkeyed compatibility.
Test migration replay and append-only receipt protection.
Run focused tests before each commit, then the required full suite, lint, type checking and production build before shipping.
Use a fresh connection to verify the installed tool catalog and receipt-read behavior after release.

## Boundaries

No existing node, raw text, source archive, or temporal event is rewritten.
No automatic semantic links or commitments are created.
No synthetic record is written to production.
Preserve unrelated untracked files in the canonical checkout.
