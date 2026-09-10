# Tbrain operation and transfer

Tbrain keeps source evidence in the existing PostgreSQL database and keeps assistant reflections separate from approved memories.
The dedicated MCP server uses private stdio.
It can run locally or behind an authorized Secure MCP Tunnel.
It does not start a public web listener, and the existing local web app is not a remote authentication boundary.

## Current capability status

Implemented and locally tested: file validation, authorized import, source exclusions, atomic receipts, replay/conflict handling, source revision history, bounded source reads, lexical search before embeddings, shared recall provenance, private stdio capture and backup/restore.
The tests use synthetic records in isolated local PostgreSQL databases.
They do not prove a production deployment or a ChatGPT call.

Live account inspection on September 9, 2026 found developer mode enabled in ChatGPT.
The create-connection form offered Server URL and Tunnel.
The installed list had no Tbrain connection, and both the form and the Platform tunnel page showed no existing tunnels.
No resource or registration was created during that inspection.
Actual archive tool permissions still require a harmless staging call through the registered connection.

The [current developer-mode guide](https://developers.openai.com/api/docs/guides/developer-mode) describes read/write access.
The [tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) requires a registered tunnel, runtime credentials and the correct workspace association.
Documentation establishes a supported path, not this account's successful round trip.

## One-time local setup

Use Node 22.18 or later and the existing dependencies from `npm ci`.
Keep `DATABASE_URL`, `BRAIN_SCHEMA`, `TBRAIN_ALLOWED_SOURCE_IDS` and optional `TBRAIN_ALLOW_CAPTURE` in the private `.env.local` beside package.json or in the process environment.
Never paste credentials into a conversation or commit them.
Protect that file with mode 0600.
No new model API subscription is required for capture or lexical search.

The existing database schema must already exist.
For a disposable local database only, `node scripts/migrate.mjs` initializes it.
That older command also applies historical changes to public; do not use it as a production capture migration shortcut.
The separate capture migration adds two tables, indexes and source-protection triggers:

```sh
BRAIN_SCHEMA=brain_dev node scripts/tbrain-migrate.mjs
```

Production requires explicit approval of this exact migration:

```sh
BRAIN_SCHEMA=public node scripts/tbrain-migrate.mjs --authorize-production
```

The production command rehearses in brain_dev first.
It does not copy development records into production.
This release has not run that command against the real brain.
A schema-scoped runtime role must have SELECT on the existing source/evidence and brain tables, INSERT on episodes, evidence, archive_records and archive_messages, and no routine UPDATE or DELETE access to source content.
Capture does not need to insert approved nodes, edges or temporal events.
Use the existing trusted database administration process to grant access; a database owner credential is not a public-client credential.

Register a source once through the existing controlled source command, or select an already configured source with the appropriate exclusions:

```sh
node scripts/brain.mjs list-sources
node scripts/brain.mjs add-source < /absolute/private/source-config.json
```

A source-config file can contain `{"kind":"chatgpt_conversation","label":"daily-progress","exclusions":[]}`.
Configure relevant source exclusions before capture, including confidential employer topics or excluded people/threads.
Copy the returned real source UUID into `TBRAIN_ALLOWED_SOURCE_IDS`.
Separate multiple approved source IDs with commas.
An empty list permits no capture.
Do not invent a source ID or create a new source to evade existing exclusions.

## Daily file path

A conversation that cannot write directly produces one JSON file in the transfer format below.
Keep that same file for retries.
The importer calculates fingerprints; the model does not supply hashes.

```sh
node scripts/tbrain.mjs validate /absolute/private/day.json
node scripts/tbrain.mjs import /absolute/private/day.json --authorize
```

Validation reports `prepared` and `saved:false` without database access.
Import requires the source allowlist and the explicit authorization flag.
It returns `committed`, a receipt `id`, an `episode_id`, message evidence IDs and content fingerprints.
An identical retry returns the original receipt with `replayed:true`.
A timeout is ambiguous until retry or readback resolves it.
Reusing the same source identity and revision for different content fails with `conflict`.

Use the returned receipt ID in a fresh process or another authorized client:

```sh
node scripts/tbrain.mjs verify RECEIPT_ID
node scripts/tbrain.mjs read RECEIPT_ID
node scripts/tbrain.mjs source RECEIPT_ID 0 8000
node scripts/tbrain.mjs search 'distinctive words from the day'
```

`verify` compares stored source fingerprints and all evidence messages, rather than merely testing the connection.
`read` returns messages with their speaker, fidelity, coverage and correction history.
`source` returns bounded chunks of provided source text when present, or the explicitly labeled rendering of supplied messages otherwise.
Follow returned continuation offsets for long material.
A receipt describes a committed import; search results describe retrieved evidence.
They do not certify that the source system exported every conversation turn.

## Private MCP path

Start the server from a trusted client configuration with an absolute command path:

```sh
TBRAIN_ALLOW_CAPTURE=1 node /absolute/checkout/scripts/tbrain-mcp.mjs
```

The server reads private configuration from that checkout's `.env.local`.
The source allowlist still applies when capture is enabled.
Omit `TBRAIN_ALLOW_CAPTURE=1` for a read-only connection.
The read-only connection still exposes `transfer_format`, so the client can prepare a compatible file.
Use `status` to inspect storage readiness, configured source IDs and whether the write tool is enabled.

The tools are `recall`, `search_archive`, `read_archive`, `read_source`, `read_receipt`, `transfer_format`, `status`, and, when enabled, `archive_day`.
The write tool is correctly declared as a write.
It cannot create approved memories, semantic edges or commitments.
The old `scripts/fuzzy-brain-mcp.mjs`, package name, installed identities and `~/.fuzzy-brain` launchers remain compatible.
Those launchers use a pinned runtime; a new checkout alone does not update an already installed client.
Do not point an existing production launcher at an unfinished development branch.

For ChatGPT, create an authorized Secure MCP Tunnel and associate it with the actual ChatGPT workspace.
Use the official tunnel-client setup command for the installed version, with the private stdio command above as the target.
Keep its control-plane credential outside prompts and source control.
Then create the private ChatGPT connection and inspect the discovered tools.
Use a development-schema connection and synthetic transfer for the first write/readback test.
If the account exposes reads only, preserve that boundary and use the daily file path.
Do not rename writes as reads.

A tunnel still needs a running process and database access.
The verified local runtime depends on this Mac being awake.
An always-available runtime needs a separately approved host and operating budget; this release makes no such deployment claim.
Stop the runtime or remove the tunnel/workspace association to revoke remote access, and revoke its runtime credential through the provider's credential controls.

## Transfer format

The authoritative machine schema is `transferSchema` in scripts/lib/tbrain-transfer.mjs, also returned by `transfer_format` in both read-only and capture modes.
The file is one JSON object with these fields:

| Field | Meaning |
| --- | --- |
| `format` | Exactly `tbrain.transfer.v1`. |
| `source_id` | Real configured source UUID, authorized by the importer. |
| `source_key` | Stable logical conversation identity reused across deliveries and revisions. |
| `revision` | Stable identity for this supplied snapshot, reused on retry. |
| `source` | Platform, known conversation ID or null, title or null, project or null. |
| `coverage` | Source export or model assembly, completeness, known date bounds, limitations and omissions. |
| `messages` | Ordered messages with known ID or null, role, speaker or null, exact supplied text, known time or null, and fidelity. |
| `reflection` | Null, or a separate assistant-authored provisional note with source message ordinals. |
| `relation` | Null for the first snapshot; otherwise the prior receipt ID, relation kind and explanation. |
| `original` | Optional genuinely provided UTF-8 source text and media type, only for source-export coverage. |

A model assembly must disclose limitations and cannot claim complete coverage.
Allowed message roles are user, assistant, system, tool, other and unknown.
Fidelity is verbatim, paraphrase or unknown, and is always a claim about the supplied material rather than independent proof.
Use null for unknown source IDs and event timestamps.
Import time is separate and generated by the store.
A date bound does not assign that date to otherwise undated messages.

The transfer is limited to 4 MiB, 2,000 messages and 200,000 characters per message.
These limits bound validation and requests; they do not impose a historical search window.
Preserve exact text including whitespace when genuinely available.
The retained original text preserves supplied UTF-8 text; arbitrary binary attachments are not supported by this format.
Do not embed a fabricated transcript in `original`.
If supplied original export text and message selections have not been mechanically reconciled, say so in coverage limitations.

The deterministic sensitive-pattern filter preserves the existing SSN and Luhn-valid card redaction rules.
The receipt records redaction paths and reasons, not removed values.
This filter does not detect every secret or confidential passage; source exclusions and authorized selection remain necessary.
Exclusions reject the entire packet before any source record is committed.
Omissions in a partial handoff are explicit source claims with a reason and known count or null.

Corrections and later exports append a new revision with `relation.kind` equal to `correction`, `supplements` or `source_export` and the previous receipt ID.
A source_key may be assigned locally when the platform identity is unknown; it is a transfer identity, never a fabricated platform message or conversation ID.
Keep the same source_key even if a later export supplies previously unknown platform IDs.
The prior revision remains inspectable and retrieval identifies related revisions as one observation group.
Cross-platform material with unknown shared identity is not automatically deduplicated or treated as corroboration.

## Backups and recovery

The old `brain.mjs dump` contains the approved graph, talks and temporal events only.
Use the full backup command for evidence and capture receipts:

```sh
node scripts/tbrain-backup.mjs backup --output /absolute/private/tbrain.dump
```

It captures every table in BRAIN_SCHEMA, public by default, and required extensions through pg_dump custom format.
It creates a new file with mode 0600 outside the repository and never overwrites an existing backup.
The archive contains personal data and belongs in private storage.
Use PostgreSQL 17 or later client tools compatible with the server, with the required extensions installed for restore.

The automated restore path accepts only an explicitly named, empty loopback database whose name starts with `tbrain_restore_`:

```sh
TBRAIN_RESTORE_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/tbrain_restore_CHECK \
  node scripts/tbrain-backup.mjs restore --input /absolute/private/tbrain.dump
```

It restores in one transaction without destructive cleanup, original ownership or access grants.
Restore only trusted backups because database archives contain executable schema definitions.
Production restoration requires a separate explicitly authorized operator procedure.
After restoring, run `verify` on a known receipt and inspect its original source from a fresh client.

## Verification and remaining gates

Run `npm run test:tbrain` with DATABASE_URL_DEV pointing to an isolated local PostgreSQL instance with pgvector installed.
Run the repository's required `npm test`, `npm run lint` and `npm run typecheck` before release.
The dedicated CI workflow provisions a disposable PostgreSQL instance and exercises the actual CLI and stdio boundaries.
See docs/tbrain-verification.md for measured results and scenario coverage.

The remaining human gates are approval to apply the additive production migration and configure its source allowlist, and creation/authorization of the private tunnel and ChatGPT connection.
A synthetic ChatGPT capture followed by retrieval in a fresh ChatGPT conversation must be observed before claiming that client verified.
No reminders, paid-host commitments, public personal-data endpoint or production experiment is part of this release.
