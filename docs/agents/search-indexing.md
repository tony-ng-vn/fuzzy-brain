# Checking search indexing

A committed receipt proves that Tbrain saved a source.
Semantic search also needs a stored vector for each passage.
Capture leaves those vectors for a separate local indexing pass so a slow or unavailable model cannot prevent a save.

Both memory connections offer `index_status`.
Call it with `receipt_id` to inspect one saved archive, or `source_id` to inspect all retained evidence for one source.
Use one filter at a time.
Without a filter, the check includes all stored evidence and approved nodes.
It returns counts, not memory text.

`semantic_index.state` has three values.

- `empty` means the selected records contain no passages or nodes.
- `pending` means at least one selected record has no vector yet.
- `complete` means every selected record has a stored vector.

These counts describe stored records, not a measure of answer quality.
A complete index does not guarantee that a particular search will find the right evidence.
The status check does not load the model or prove that the model is available for the next query.

If indexing is pending, use `search_archive` for text matches or read the saved source by receipt.
A failed semantic search does not mean the source was lost.
Report a concrete indexing problem with `report_outcome`, using `finding: "pending_index"` and the associated operation or workflow identifier.

## Inspect and repair an archive locally

The portable command can inspect indexing without starting a memory server.

```sh
node scripts/tbrain.mjs index-status --receipt-id RECEIPT_UUID
node scripts/tbrain.mjs index-status --source-id SOURCE_UUID
```

Repair missing vectors for one archive with an explicit row limit.

```sh
node scripts/embed-sweep.mjs --receipt-id RECEIPT_UUID --limit 32
```

Use `--source-id` instead to repair evidence across a source.
A source or receipt filter excludes approved nodes.
The command processes one passage at a time with the local model and refuses another simultaneous sweep.
It updates only missing vectors, preserves source text, and records its operation in the private trace journal.
Follow it with `index-status` to verify the remaining count.
Repeat the same bounded repair if more records remain.

An unfiltered sweep includes evidence and approved nodes.
Its row limit is shared across both groups.
An existing vector is never overwritten by this command.

The configured background sync also fills a bounded number of missing vectors after capture.
If counts remain pending across runs, inspect whether that job is loaded and whether its logs show a failure.
The index-status result reports database state; it does not claim that a background job is running.

## Background sync failures

The existing background job attempts session capture, pasted-transcript capture, and indexing in that order.
A failure in one step does not stop the later steps.
The result lists failed steps and retains the summaries of completed work.
A failed cycle exits with a nonzero status even when other steps succeeded.

Run one cycle with `node scripts/fusion-sync.mjs`.
Use `--help` to inspect its commands without starting capture.
Use `--print-plist` to inspect its background-job configuration without installing it.
Unknown options stop before capture begins.

On macOS, inspect the configured job with `launchctl print gui/$(id -u)/com.tony.fuzzy-brain.sync`.
A configuration file alone does not prove that the job is loaded or running.
The existing installer command is `npm run fusion:install`.
It installs the configured capture job and runs a cycle immediately.
Use it when restoring that intended background capture setup, rather than treating it as a read-only status check.

Every cycle has an operation trace, and controlled child commands carry its parent identifier.
The cycle trace records failed step names without source text or private error details.
The error log uses safe categories.
Older log entries retain their original content; this change does not rewrite them.

After a cycle, use `index_status` to check the source you care about.
A successful bounded pass can leave more records pending.
