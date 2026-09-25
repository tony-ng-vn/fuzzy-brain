# Catching up on missing search entries

## Observed backlog

The restored hourly job completed its second cycle in about 41 seconds.
Capture completed and indexing filled 32 evidence vectors.
The watch-items backend still failed, so the cycle correctly reported a partial failure.
The earlier cycle had reached its 20-minute capture timeout before indexing ran.
The second cycle used the separate 32-session-per-source capture limit added in v0.35.0.
These are two observed runs, not a controlled performance comparison.

After that cycle, 5,602 evidence passages still lacked vectors.
All 14 approved nodes had vectors.
At 32 entries per hourly run, the evidence backlog alone would require 176 successful indexing cycles if nothing new arrived.

## Bounded measurement

A controlled repair of 128 missing entries completed in 8.3 seconds of reported sweep time, or 8.7 seconds for the process.
It used one model call at a time at low CPU priority.
The process reported about 1.31 GB maximum resident memory and 1.63 GB peak memory footprint.
These are different measurements from the local operating system, not additional allocations to sum.

The repair filled all 128 selected entries.
A before-and-after digest check confirmed that every selected evidence field except its derived vector stayed unchanged.
The remaining evidence count was 5,474.
The operation trace recorded success and 128 filled evidence vectors.

This sample does not justify an unlimited background sweep.
Longer passages and slower database calls can change the cost.

## Change

The hourly indexing step now attempts at most 256 entries with a shared 30-second allowance.
The existing row limit still applies across nodes and evidence.
The model still processes one passage at a time.
The sweep checks elapsed time before another database page and before another passage.
If time expires during a page, it saves completed vectors from that page before stopping.
A later pass selects the remaining missing vectors.

The allowance does not interrupt an active model call or database request.
Saving completed vectors can also extend the elapsed time.
The separate child-process timeout remains a final limit for a stuck command.
Time-limit completion is successful bounded work, while actual model or database failures still fail the command.
The trace keeps the allowance, completed counts, and a stop flag without source text.

## Verification

Disposable-database tests use a controlled clock to make the allowance expire between passages.
They verify a single allowance across both layers, partial-page persistence, untouched source fields, resumable work, and the existing row cap.
Another test makes a database read consume the allowance and verifies that no model work starts afterward.
Fresh-process command tests verify parsed time limits and trace readback without requiring a model download.
