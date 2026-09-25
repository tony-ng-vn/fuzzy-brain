# Explicit scope for ranked recall

## Need

Ranked recall previously accepted only a question.
Source and role restrictions required switching to lexical archive search, and date restrictions depended on a limited set of natural-language templates.
A phrase such as "September 2026" or a custom day range could silently carry no date constraint.

## Contract

Add optional `layer`, `source_id`, `role`, `from`, and `until` arguments to both memory servers and the recall CLI.
Return the effective non-default `scope` with the result.
Unfiltered retrieval retains its existing behavior and response shape.
Sources and roles describe evidence, so those filters select the evidence layer and conflict with a node-only request.
Known archive metadata and session parsers determine roles.
Unavailable role metadata must not widen the requested filter.

Explicit date arguments override inferred calendar constraints.
Both explicit bounds are inclusive, matching lexical archive search.
Evidence must have a message timestamp to match an explicit bound.
Node dates describe creation time, not the time of the event discussed in the node.
Normalize timezone offsets while preserving PostgreSQL's six fractional second digits.
Reject reversed bounds and unsupported precision before storage access.
Keep the existing half-open UTC bounds for natural-language calendar queries.

Apply filters inside each retrieval lane before candidate limits.
Evidence-only requests skip node and connection lanes.
Node-only requests skip evidence lanes.
Connection traversal retains the existing date restrictions for node results.
Per-lane fallback uses the same scope as the fused query.
Role-filtered calls may inspect archive availability; ordinary calls retain their current query budget.

## Verification

Use disposable database fixtures with competing sources, approved nodes, known and unknown dates, different roles, and archived messages.
Force a fused query failure and missing optional archive role metadata.
Exercise equivalent timestamp offsets and adjacent microsecond values.
Verify both real MCP transports and the CLI pass the filters into retrieval.
Check help, malformed flags, duplicate options, and contradictory scope before storage access.
Run the existing date-boundary, ordinary query-budget, provenance, and complete project checks.

## Deployment

Version 0.30.0 requires no schema migration or record rewrite.
Refresh the pinned runtime after CI and verify scoped readback through fresh connections.
