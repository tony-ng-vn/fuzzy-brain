# Tbrain operation traces

## Purpose

Every memory request should leave enough evidence to diagnose a failed save, a poor search, a failed readback, or an outdated caller.
Operational records stay separate from personal memories and source evidence.
A trace does not approve a belief, create a connection, or prove that an answer was useful.

The first implementation must answer these questions.

- Which operation ran, through which entry point and release, and how long did it take?
- Did it finish, return a tool error, reject the request before execution, or lose its reply?
- Which receipt, source, node, or evidence identifiers did it return?
- Did the caller report useful results, missing evidence, or a problem outside Tbrain?

## Storage and coverage

Use a private local journal so database outages do not also erase their diagnostic record.
Each operation has a UTC date and generated UUID in its identifier, with separate durable start, finish, and delivery records.
Files must have mode 0600 inside directories with mode 0700.
Writes must not overwrite earlier events or interleave when several processes run.
A missing finish record means the outcome is unknown, not that the operation failed.

Record requests at the protocol boundary, including argument validation failures and unknown tool names.
Keep the protocol request ID separate from the generated operation ID and the memory write request ID.
Record the connection ID, entry point, release, and recognized caller-provided client name and numeric version.
Fingerprint unknown client names rather than copying arbitrary caller text.
Client identity is reported by the client and is not verified authentication.

Do not copy memory text, source exports, credentials, or arbitrary tool output into automatic traces.
Allowlist operational fields, retain content fingerprints and byte counts, and reference existing saved records by identifier.
Mark omitted and truncated material explicitly.
A metadata trace is not an exact transcript of every input and output byte.

A failed journal write must not change a committed memory result into a failed memory result.
Report trace persistence separately and expose a diagnostic status that can distinguish disabled tracing, healthy tracing, and write failures.
Never claim a trace is durable before its journal write completes.

## Caller reports

Let callers attach a structured outcome, failure category, and evidence identifiers to an operation or workflow.
The first version does not retain free-form caller notes or query text.
A reported local request-construction error can precede any Tbrain operation.
Reported steps must remain labeled as caller reports.
Do not infer missing timestamps, invent server events, or solicit private internal reasoning.

Reports should name expected and returned evidence identifiers where available.
Keep successful persistence, exact readback, and useful retrieval as separate outcomes.
An agent's report of usefulness is feedback, not verified ground truth.

## Improvement loop

Provide bounded journal inspection and an aggregate report with request counts, error categories, incomplete operations, duration percentiles, empty results, limited searches, and caller feedback.
Group by release and operation so behavior from an old running process remains distinguishable.
Do not automatically change memories or search weights from feedback.
Use reproducible cases to justify a change and measure its effect before deployment.

## Verification

Use temporary local journals and synthetic data.
Verify success, service failure, schema rejection, unknown tools, overlapping calls, restart readback, interrupted operations, unavailable storage, and trace-write failure after a successful memory write.
Verify file permissions and that private input values do not appear in journal files or errors.
Inspect both memory servers through real protocol connections.
Measure the tracing cost before enabling it in the installed runtime.

## Implementation notes

The implementation wraps the public MCP transport contract so schema rejections and unknown tools are visible before a handler runs.
It carries workflow and parent-operation identifiers into controlled child commands without changing normal command output.
Recording failures are separate from memory failures, and each recording attempt has a one-second limit.
Graceful shutdown drains pending delivery records within that bound.

Private local files make database outages diagnosable without a second online service.
This replaces the observability skill's usual hosted tracing setup for this local application.
The tradeoff is local retention and filesystem backup management instead of centralized search and dashboards.
The journal remains an operational record, not a source of approved beliefs.

The operating guide is [Inspecting Tbrain operations](../../agents/operation-traces.md).
