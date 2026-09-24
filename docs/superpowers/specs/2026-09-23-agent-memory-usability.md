# Agent memory usability

## Objective

An agent must be able to capture authorized material, find a relevant clue, read its source in context, and recover from errors without guessing identities or claiming an unsaved memory exists.
Tony requested improvements across all these steps and asked us to use the brain ourselves to find concrete complaints.
The analogy to human memory guides cue-based retrieval and contextual reading, not automatic beliefs or inferred commitments.

## Findings and acceptance checks

The live recall probe returned observer-tool wrappers attributed to Tony and legacy evidence without passage identifiers.
The archive interface exposes a schema but no offline preflight tool or ready-to-fill example.
Both MCP servers return JSON as text only.
Some recall failures become empty results, and internal exception messages enter retrieval notes.

1. Every evidence hit supplies a stable passage identifier, explicit trust, truncation metadata, and a callable route to its source.
2. Both MCP servers expose bounded evidence reads with adjacent passages, original attribution, and text continuation.
3. Known machine observation envelopes stay out of conversational recall and future conversation ingestion, without changing existing stored history.
4. A failed lookup never claims that no relevant memory exists, and degraded retrieval remains explicit without leaking internal errors.
5. Agents can validate a transfer without writing or connecting to storage, get actionable field errors, and distinguish preparation from persistence.
6. Capture discovery explains identity, retry, readback, permissions, and limitations using machine-readable fields and an example.
7. Existing clients keep their text results while capable clients receive structured results.
8. Agent setup and the CLI document and expose the resulting workflow.
9. CLI help and argument errors work offline; search and reads support continuation and source or role filters.
10. A project version bump alone does not reinstall unchanged runtime dependencies.

## Implementation order

Write failing behavior tests before each implementation stage and commit each verified stage separately.
Start with passage readback, then ingestion and retrieval quality, then capture preparation and client usability.
Keep additional findings in this document and implement those supported by a reproducible failure.

## Structure and conventions

Production code lives in `scripts/`, shared functions in `scripts/lib/`, and executable Node tests in `tests/`.
Use named ESM exports, parameterized SQL, explicit schema qualification, and existing Zod validation.
Return additive JSON fields rather than renaming existing client fields.
For example, `return { state: "prepared", saved: false };` must never imply a committed record.
No new dependency or database schema is needed for the first stages.

## Verification

Run focused Node tests for each stage and the required `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` before release.
All database tests use a disposable loopback database and `brain_dev` fixtures.
Exercise the actual MCP transport for discovery, capture, retry, search, passage readback, and restart.
Compare baseline and final results and record skips or unrelated failures honestly.

## Boundaries

Preserve verbatim raw, explicit approval, source exclusions, revisions, and existing committed identities.
Do not rewrite old records, create semantic edges, infer beliefs, or create reminder automations.
Keep the unrelated untracked files in the canonical checkout untouched.
Deploy through the existing pinned runtime only after review and required checks.
No claim about general human cognition or retrieval-quality improvement rests on analogy alone.

## Verification observations

Baseline `npm test` passed 565 of 568 tests, with three existing optional skips and no failures.
The final required suite passed 585 of 588 tests in 48.27 seconds, with the same three skips and zero failures.
The app production build passed with real local dependencies.
An initial worktree build rejected the shared `node_modules` symlink; a local dependency copy resolved that setup issue without changing application code.
The initial full run after implementation exposed old exact-shape assertions for the tool catalog and recall fields; those contracts now include the additive fields.
Lint and type checking passed with six existing benchmark warnings and no new warnings.

A read-only production comparison used the same question and a shared warm embedding model against the baseline and updated retrieval code.
The question was "What requirements and past problems have been recorded about agents saving and retrieving information in Fuzzy Brain or Tbrain?"
The baseline returned eight observer envelopes among ten hits and zero evidence IDs.
The updated code returned zero observer envelopes among ten hits and ten evidence IDs, with no degraded retrieval flag.
Observed elapsed times were 1378 ms and 1106 ms respectively; one query is not a latency benchmark or evidence of general recall quality.
No production record was written or rewritten for this comparison.

The real stdio round trip verified preparation, validation, capture, passage context, source-role filtering, restart, one hundred retries, concurrent delivery, conflicts, unauthorized sources and unavailable storage.
Synthetic database tests run only against disposable loopback databases.

## Deliberate limits

The work preserves the existing retrieval weights and semantic approval model.
It does not infer a human identity from an unknown speaker, deduplicate unrelated conversations, or promote reflections into memories.
Archive writes retain their transactional replay guarantee; approved-node writes still require checking state before retry after an ambiguous failure.
Remote availability still depends on the existing host and private tunnel.
