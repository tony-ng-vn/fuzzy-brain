# Reduce capture database round trips

## Evidence

Version 0.29.0 reconciles a synthetic 500-message session with 508 database calls.
That measurement used real disposable PostgreSQL and counted calls through the connection while verifying that all 500 evidence rows committed.
The local capture took 66.38 milliseconds.
Five read-only production SELECT round trips measured 87.35, 79.67, 80.49, 77.98, and 80.42 milliseconds.
The local elapsed time is not a production capture benchmark.
The call count shows why one evidence insert per message makes large captures sensitive to network latency.

## Change

Batch evidence insertion inside the existing episode transaction.
Bound batches by record count and serialized bytes so a large conversation does not become one oversized SQL argument.
A single oversized message remains one intact evidence span.
Keep the existing sensitive-pattern behavior, raw text rules, exact offsets, result shapes, and checkpoint transaction.
A failed batch must roll back the entire episode and its checkpoint, including earlier successful batches.
Do not add dependencies or modify existing stored evidence.

## Verification

Add a regression test through session reconciliation that requires 500 messages to use fewer than 20 database calls.
Confirm it fails against the current implementation.
Test a database failure in a later batch and verify that no partial episode, evidence, or checkpoint remains.
Verify large messages, redaction, mixed speakers, known and unknown dates, and readback offsets through the controlled CLI.
Measure the same synthetic capture again and report both call counts.
Run the required suite, lint, type checking, and production build before shipping.
Continue the broader improvement goal until noon Pacific on September 24, 2026.

## Verified results

The regression fixture with mixed known and unknown timestamps measured 508 database calls and 65.78 milliseconds before batching.
The same fixture measured nine calls and 14.82 milliseconds after batching.
These are single local measurements; the regression gate checks call count and persisted content rather than a fragile elapsed-time threshold.
The later-batch failure test confirms that successful earlier writes leave no episode, evidence, or checkpoint behind after rollback.
Encoded-byte tests cover escaped characters, multibyte text, and one message larger than the normal batch limit.
Direct CLI tests preserve input order, redaction markers, timestamps, and the single-object response shape.

The large-message fixture also exposed final whitespace loss in the renderer.
The renderer now removes only its own final separator, preserving supplied message whitespace and exact span offsets.

The portable archive path previously made two inserts per message, one for evidence and one for its source association.
Its 500-message regression fixture measured 1,009 calls and 86.09 milliseconds before batching, then 11 calls and 20.89 milliseconds afterward.
It now uses the shared bounded evidence writer and one ordered association insert for the transfer's bounded message list.
Receipt evidence IDs retain message order, and a failure in the association insert rolls back all earlier evidence batches and the receipt.
