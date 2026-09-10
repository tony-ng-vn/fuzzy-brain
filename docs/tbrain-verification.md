# Tbrain release evidence

Local verification date: September 9, 2026.
The database and all new fixtures were isolated, local and synthetic.
No production migration, production capture, tunnel registration or ChatGPT tool call is claimed.

## Required checks

Baseline commit 62989ffcde71b6b210df0b483004da7528e30eea passed 477 of 479 tests, with two existing optional corpus tests skipped.
Baseline lint and type checking passed; lint had six existing warnings in the recall benchmark files.

The integrated required suite passed 563 of 566 tests, with zero failures and three skips, in 41.95 seconds.
The skips were the two existing optional corpus tests and the explicit backup integration test that needs two empty local restore databases.
The backup integration was run separately and all six backup checks passed.
Lint and type checking passed, with the same six baseline warnings and no new warnings.
A subsequent one-line source-list whitespace fix passed all 17 relevant CLI and MCP checks, including its new regression.
The dedicated CI workflow verifies Node 22 and the actual transport against disposable PostgreSQL.

An earlier development suite failed because retained synthetic archive rows took the embedding sweep's limited batch ahead of its fixtures.
Each new archive integration suite now creates and removes its own local database.
The final shared test database had zero sources, episodes and evidence rows, and no disposable test database remained.
This was an integration defect fixed during development, not a baseline failure.

## Round trip and measured latency

Environment: macOS Mac16,8, Node 26.6.0, PostgreSQL 17.11 and pgvector 0.8.6 on localhost port 55439.
These measurements describe a small synthetic corpus on a local machine, not remote or production latency.

| Operation | Measured elapsed time |
| --- | --- |
| First capture through the real stdio server and controlled CLI | 113.79 ms |
| Older-history lexical search through stdio | 3.95 ms |
| Median of 100 real transport replays | 104.18 ms |
| Maximum of those 100 replays | 110.08 ms |
| Direct transaction capture | 6.95 ms |
| Direct lexical search before embedding | 1.07 ms |

The transport test terminates the first server process and verifies the same receipt, source messages and reflection through a fresh server process.
One hundred deliveries preserve one record and its evidence rows.
Five concurrent deliveries also commit one identity.
A conflicting payload under that identity fails and leaves the earlier source intact.
Source and receipt writes roll back together when an evidence insert fails, and the same transfer can then be retried.

## Backup proof

The final feature-schema backup restored to a separate empty local database.
Exact row JSON matched across all nine tables and 306 synthetic rows.
This includes 49 capture records and receipts, 94 message references, 49 episodes, 94 evidence rows and 20 sources.
All five source-protection trigger definitions also matched.

The private verification file has SHA256 `095b8d06f5e84cca420656aeb0a1d4983187d151c3b247eb4185038906fa6acf`.
Private backup archives and raw test logs remain outside this public repository.
This proof validates snapshot restoration of the implemented schema; it is not a backup of the real brain.

## Distinct scenario coverage

These are named scenarios exercised by the executable tests, not repeated deliveries counted as different scenarios.

| Scenario | Executable evidence |
| --- | --- |
| Ordinary authorized daily capture | tbrain-cli, tbrain-stdio-roundtrip |
| Offline preparation without database access | tbrain-cli |
| Missing explicit import authorization | tbrain-cli |
| Server defaults to read-only | tbrain-mcp |
| Wrong source identity rejected before database access | tbrain-mcp, tbrain-stdio-roundtrip |
| Capture flag and source allowlist are separate requirements | tbrain-mcp |
| Runtime consent cannot be supplied inside a packet | tbrain-mcp |
| Whitespace in source configuration is consistent across clients | tbrain-cli |
| Missing storage is reported as unavailable | tbrain-cli, tbrain-stdio-roundtrip |
| Failed lookup differs from an empty search | tbrain-store |
| Fresh process reads the committed receipt | tbrain-cli, tbrain-stdio-roundtrip |
| One hundred retries do not duplicate the source | tbrain-store, tbrain-stdio-roundtrip |
| Concurrent deliveries commit one logical identity | tbrain-stdio-roundtrip |
| Same identity with changed source content is a conflict | tbrain-store, tbrain-stdio-roundtrip |
| Failure after an episode insert rolls back the entire capture | tbrain-store |
| Retry after storage failure can commit | tbrain-store |
| A source from 1998 is searchable without a date default | tbrain-store, tbrain-stdio-roundtrip |
| One query retrieves separately recorded days | tbrain-store |
| Explicit date constraints narrow retrieval | tbrain-store |
| Unknown message timestamps remain null | tbrain-transfer, tbrain-store, recall-archive-provenance |
| Search works without embeddings | tbrain-store, recall-archive-provenance |
| Long source text and message pages have explicit continuation | tbrain-store |
| Partial model assembly stays partial | tbrain-transfer |
| Model assembly cannot claim a complete source export | tbrain-transfer, tbrain-mcp |
| Supplied source-export whitespace survives | tbrain-transfer, tbrain-store |
| Missing original bytes cannot be invented by a model packet | tbrain-transfer |
| Assistant reflection remains provisional and separate | tbrain-store, tbrain-stdio-roundtrip |
| A reflection cannot impersonate a confirmed user conclusion | tbrain-transfer |
| Archive capture creates no approved nodes or edges | tbrain-store |
| Prompt injection remains inert source text | tbrain-transfer |
| Corrected source keeps the earlier revision visible | tbrain-store, recall-archive-provenance |
| A new revision requires structural lineage | tbrain-store |
| An unknown parent receipt is rejected | tbrain-store |
| Repeated revisions share one observation group | recall-archive-provenance |
| Paraphrases retain fidelity through legacy recall | recall-archive-provenance |
| Metadata failure does not invent speaker or fidelity | recall-archive-provenance |
| Source exclusions apply to reflections and metadata | tbrain-store |
| Quotes and line breaks cannot bypass exclusions | tbrain-store |
| Sensitive redactions report reasons without removed values | tbrain-transfer |
| Redaction cannot silently change source identifiers | tbrain-transfer |
| A sanitized export replays without restoring secret values | tbrain-store |
| Source and receipt mutation fail at the database boundary | tbrain-store |
| Duplicate message IDs and invalid roles are rejected | tbrain-transfer |
| Invalid dates, reversed ranges and missing reflection references fail | tbrain-transfer |
| Child-process input is delivered exactly and closed | run-json |
| Child timeout, broken pipe and malformed output fail safely | run-json |
| Errors omit private child output and database details | run-json, tbrain-mcp |
| Backup files are private, exclusive and outside the repository | tbrain-backup |
| Failed backup removes its incomplete output | tbrain-backup |
| Restore rejects remote or nonempty targets | tbrain-backup |
| Exact text and extension data survive restore | tbrain-backup |
| Test setup rejects remote and redirected database targets | tbrain-store |

All test file names above have `.test.mjs` extensions under tests/.
The suite accepted no tested unauthorized capture, silent source replacement or automatic ratification.
This is evidence about the exercised cases, not proof against every possible failure.

## Account and release boundaries

A live read-only account inspection confirmed developer mode enabled and no existing Tbrain plugin or tunnel.
The production additive migration and private ChatGPT registration still require approval.
The source allowlist must identify the actual authorized production source.
There is no measured ChatGPT capture latency or successful ChatGPT round trip yet.
The local path depends on a running Mac; no paid or always-on host has been provisioned.
