# Reliable session continuation

## Problem and evidence

The session importer decides what is new by subtracting a stored evidence count from the current parser's turn count.
Filtering two old machine observation envelopes reduces the current count, so two new real messages can appear already captured.
If a previous run skipped a gap and captured later messages, adjusting the count cannot identify the missing messages.
The current modification-time shortcut can also keep that gap hidden after a partial capture.

## Decision

Reconcile each changed session against the messages already stored for that source and session.
Match speaker, normalized timestamp, and the scrubbed text fingerprint.
Consume one stored occurrence for each matching input occurrence, so repeated identical undated messages retain their multiplicity.
Append only unmatched messages in their original source order.
Do not rewrite existing episodes or evidence.
An existing correction or a changed timestamp remains a distinct source observation.

Use an append-only session checkpoint table to record the parser version and observed file size and modification time after reconciliation.
Commit the checkpoint and new evidence together.
Legacy sessions without a checkpoint receive one reconciliation even if their files have not changed.
A new parser version invalidates the shortcut without rewriting prior checkpoints.
Serialize reconciliation for the same source and session to make simultaneous deliveries safe.
Return only persistence identifiers and counts, not the captured text.

Keep the controlled write path in scripts/brain.mjs.
Retain batching, local allowlists, source exclusions, deterministic redaction, and settled-file checks.
Check source exclusions again inside the transaction, including unchanged context that could contain an excluded subject.
Use a separate additive migration for checkpoints.
No new dependency is needed.

## Alternatives

Subtracting the number of filtered envelopes is smaller, but it cannot recover gaps before already captured later messages.
Using only a last timestamp loses undated messages and distinct messages with the same timestamp.
Reimporting the whole conversation would duplicate evidence and make recall noisier.
Content reconciliation costs a read of that session's existing evidence when the file changes, while durable checkpoints avoid repeating that work for unchanged files.

## Verification

Reproduce the skipped-tail and skipped-middle cases through the real ingestion CLI against a disposable database.
Verify repeated identical messages, null and equivalent timestamps, sensitive-pattern redaction, exact offsets, exclusion checks, transaction rollback, and concurrent delivery.
Verify one-time reconciliation of unchanged legacy files and skipping an unchanged verified file.
Verify that a later append still captures new messages and that retries create no duplicate episode or checkpoint.
Run the required tests, lint, type checking, and build before release.
Keep the improvement goal active until noon Pacific on September 24, 2026.
