# Date bounds throughout recall

## Reproduced problems

A September query returned an August node through an approved connection.
The direct node and evidence lanes applied the calendar restriction, while connection lookup, endpoint hydration, and one-hop expansion did not.
Out-of-range connections could also occupy every candidate slot before valid dated nodes were considered.

Boundary tests exposed a separate mismatch.
The date parser and reranker interpreted calendar days as UTC, but PostgreSQL interpreted the date-only parameters in its current connection timezone.
A node exactly at midnight could therefore qualify on one connection and disappear on another.

## Behavior

Apply one half-open UTC calendar range to all candidate node fetches.
Connection discovery admits an edge when either endpoint meets the date range, before applying its candidate limit.
Fetch only eligible endpoint nodes and eligible one-hop arrivals.
Keep the same constraints in the fused query and per-lane fallback.
Keep approved connection explanations as context, even when they refer to a node outside the period.
No semantic connections are created or changed.

Report recognized calendar constraints in `date_filter`, with actual UTC bounds and the timestamp basis for nodes and evidence.
Node timestamps mean creation time.
Evidence uses its message timestamp or the existing source-context fallback.
The lower bound is inclusive and the upper bound is exclusive.
An open bound stays null.
Unrestricted recall retains its previous connections and response shape.

## Verification

Use disposable database fixtures for connection matches, one-hop arrivals, and candidate-limit starvation.
Force a fused-query failure to exercise real per-lane SQL.
Check the exact lower and upper month boundaries under UTC, Los Angeles, and Tokyo database timezones.
Check open-ended year ranges and unrestricted retrieval.
Run the existing ordinary-recall database round-trip test to prevent extra queries for this correction.

## Deployment

This is a read-only correction with no schema migration or data rewrite.
Refresh the pinned runtime after the required tests and CI pass.
Verify the applied filter metadata through fresh server connections.
