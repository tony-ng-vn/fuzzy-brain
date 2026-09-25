# Inspecting Tbrain operations

Tbrain keeps a private local record of memory requests so a later investigation can distinguish a failed save, a lost reply, and a poor search.
These records stay outside personal memory and never create approved nodes or connections.

## Follow an operation

Both memory servers add `trace` to normal JSON tool results.
The same value is available in the MCP result's `_meta["tbrain/trace"]` field.
A schema error with a plain-text result includes a separate text block containing its trace identifier.

```json
{
  "trace": {
    "id": "2026-09-25_11111111-1111-4111-8111-111111111111",
    "recorded": true
  }
}
```

Call `read_trace` with that identifier when you need to inspect the operation.
Ordinary successful calls do not need an extra trace read.
Use `trace_status` if a reply says its trace was not recorded or the connection appears to run an older release.
The status includes the server release and this process's recording counters.
Existing connections must reconnect after a runtime update to load new code and tools.

The start record names the operation, entry point, release, connection, and caller when it recognizes the client's reported name.
Unknown client names are fingerprinted.
Caller identity is reported by the client, not verified authentication.
The finish record contains a safe error category or result summary, timing, and available receipt, node, source, and evidence identifiers.
Batch records also retain up to 100 item identifiers, including session checkpoint IDs, along with saved-item states and evidence counts when returned.
They count failed items across the complete returned batch, even when the item list is truncated.
An explicit `ok: false` result or any rejected batch item marks the operation as an error.
For a partly saved batch, inspect the item records before retrying because other items may already be committed.
The operation's error category is the first reported item error, while `item_errors` counts every returned rejection category.
A separate delivery record says whether the transport accepted the reply.
It cannot prove that the caller read or used it.

A trace with no finish remains unknown or still running.
It is not evidence that a write failed.
A successful write with a failed reply delivery can still have a committed receipt.
Continue using the original memory request ID or archive identity when verifying or retrying that write.

## Connect a workflow

When the host supports MCP request metadata, generate one UUID for the workflow and pass it as `_meta["tbrain/workflow_id"]` on its calls.
Tbrain carries that identifier into controlled child commands.
Each child trace also names the parent operation.

Hosts that cannot send request metadata can still connect later feedback to an operation with `report_outcome`.
Give related reports the same `workflow_id`.
That association remains a caller report.
It does not rewrite the original server records.

## Report what worked or failed

Use `report_outcome` for a concrete outcome from capture, verification, retrieval, reasoning, request construction, or setup.
The report accepts structured categories and evidence identifiers.
It does not retain free-form notes, source quotations, or private internal reasoning.

Keep these checks separate.

- A save returned a committed receipt.
- A receipt and source read confirmed the expected data.
- A natural-language search returned useful evidence.
- The evidence supported the answer the agent produced.

A search can succeed as an operation while failing to find the evidence the caller expected.
For example, this synthetic report describes that distinction.

```json
{
  "operation_id": "2026-09-25_11111111-1111-4111-8111-111111111111",
  "workflow_id": "22222222-2222-4222-8222-222222222222",
  "stage": "retrieval",
  "outcome": "failed",
  "finding": "missing_expected_evidence",
  "expected_evidence_ids": ["33333333-3333-4333-8333-333333333333"],
  "used_evidence_ids": [],
  "observed_at": null
}
```

Use actual returned identifiers in a real report.
Unknown observation times stay null.
A failure before any Tbrain call can use `workflow_id` without `operation_id`, with `stage` set to `request` and `finding` set to `request_construction`.
Read a saved report with `read_trace` and `kind: "report"`.
Reports are append-only and each submission creates a separate record.
A repeated report is not independent evidence.

## Inspect recurring problems

`list_traces` reads one UTC day at a time and returns a bounded page.
Use `kind: "reports"` for caller feedback.
Use `workflow_id` to find records carrying the same workflow identifier.
For operation records, `parent_id` finds direct child calls under one operation.
For caller reports, `operation_id` finds feedback about one operation.
Filters combine with AND, so every supplied filter must match.
Reports do not inherit a workflow identifier from their associated operation; the reporting caller must supply it.

The limit caps inspected records before filtering, and `scanned_count` reports that number.
A filtered page may contain no matches even when later pages have them.
Follow `next_after` while `has_more` is true, including after an empty page.
Results use identifier order, not event-time order, and concurrent additions can require another read.
Use the recorded start and finish times to inspect execution order after collecting the relevant records.
A workflow crossing UTC midnight requires a separate listing for each day.

`trace_summary` reports operation counts, error categories, unfinished calls, empty or limited searches, delivery failures, failed background steps, caller findings, release counts, and duration percentiles.
Delivery counts cover finished MCP requests only.
A completed command-line call does not prove that another program read its output, and does not count as an unconfirmed MCP reply.
The `failed_stages` counts show how many background runs reported a failure in session capture, pasted video capture, or indexing.
Each run counts at most once per failed step.
Session capture records `capture_sources` with counts for each configured session format and `failed_sources` when saves fail.
Use its parent identifier to find the background cycle.
Find save attempts with `list_traces` and `parent_id` set to the capture trace ID.
Duration ends when the operation produces its result, before the finish record and reply delivery.
It inspects at most 1,000 operations and 1,000 reports per call.
When `exhaustive` is false, its counts and percentiles cover only the inspected records.
Diagnostic calls appear in a separate count, so asking for a summary does not look like an unfinished memory operation.

Use a reported failure to build a reproducible test before changing the system.
A caller's expected evidence is a claim to check, not an answer key to trust automatically.
Do not automatically change memory, search weights, or approval rules based on these reports.

## Commands and storage

The portable command supports the same inspection tasks without a database connection.

```sh
node scripts/tbrain.mjs trace-status
node scripts/tbrain.mjs traces --day 2026-09-25 --limit 20
node scripts/tbrain.mjs traces --day 2026-09-25 --workflow-id WORKFLOW_UUID --limit 100
node scripts/tbrain.mjs traces --day 2026-09-25 --parent-id TRACE_ID --limit 100
node scripts/tbrain.mjs traces --day 2026-09-25 --kind reports --operation-id TRACE_ID --limit 100
node scripts/tbrain.mjs trace TRACE_ID
node scripts/tbrain.mjs trace-summary --day 2026-09-25
node scripts/tbrain.mjs report-outcome /absolute/private/report.json
node scripts/tbrain.mjs trace REPORT_ID --kind report
```

Direct `brain.mjs`, `recall.mjs`, and `tbrain.mjs` calls also record their operations.
Their normal output stays unchanged.
Set `TBRAIN_TRACE_RECEIPT=1` to print a separate trace receipt to stderr after a direct command.
Set `TBRAIN_WORKFLOW_ID` to a workflow UUID when a command should belong to a known workflow.

The default journal is `~/.fuzzy-brain/operation-traces`, grouped by UTC day.
Directories require mode 0700 and files require mode 0600.
Existing directories with broader permissions or a symbolic link are rejected.
`TBRAIN_TRACE_DIR` selects a different private directory.
`TBRAIN_TRACE=0` disables recording.
Existing records remain readable when recording is disabled.
Development-schema processes require an explicit `TBRAIN_TRACE_DIR` to read or write traces, so ordinary tests do not access the real journal.

Tracing limits each storage attempt to one second.
If storage fails or remains unresponsive, the memory operation keeps its own result and the reply reports an unconfirmed trace.
A timed-out trace write may finish later.
Trace failure never proves that the memory operation failed.
The process's status keeps failed and unconfirmed recording counts until it restarts.

Automatic traces keep content fingerprints, sizes, selected filters, capture structure, result identifiers, and counts.
They omit query text, memory text, source exports, credentials, and private error messages.
They cannot replay an exact request by themselves.
Retain an explicitly supplied reproduction case separately when a fix needs its original wording.

There is no automatic deletion or upload of trace files.
Database backups do not contain this local journal.
Include the journal in private filesystem backups when its history needs to survive loss of the host.

## Measured cost

A local synthetic comparison used 100 calls with ten result passages each.
With tracing disabled, the median was 0.06 milliseconds and the 95th percentile was 0.15 milliseconds.
With durable tracing enabled, the median was 26.85 milliseconds and the 95th percentile was 30.59 milliseconds.
This measures tracing overhead without database or search-model work.
It is not a production recall latency measurement.
