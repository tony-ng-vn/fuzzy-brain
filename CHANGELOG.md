# Changelog

Changes to Fuzzy Brain.

---

## v0.45.1

2026-09-25

**Tools**

- The running Tbrain server now reads later pages of a long source without downloading the whole source again.
  It checks for changes on every read, returns current source details, and keeps only a limited local copy.
  If the database fails, the read fails instead of returning cached text.
- In one live six-page comparison, the five later pages took a median of 136 milliseconds instead of 654, with the same text.
  The first page took about as long as before.

---

## v0.45.0

2026-09-25

**Tools**

- Trace summaries now count successful, completed recall results by their returned label: supported, conflicting, evidence, partial, or missing.
  Calls with missing or unrecognized labels count as unknown, including older traces.
  Failed and unfinished calls keep separate totals.
  These counts appear in the overall summary and the recall-only breakdown.
- New trace records now keep the existing conflicting label, which earlier trace records omitted.

**Docs**

- The trace guide explains these counts and why a retrieval label does not judge whether an answer is correct.

---

## v0.44.1

2026-09-25

**Tools**

- Reading a long saved session no longer stops when a continuation passes five million characters.
  Whole-source reads now accept any nonnegative position the system can represent exactly, while each reply stays within 12,000 characters.
- Storage, the memory connection, the portable command, and offline source help now use the same position rule.

---

## v0.44.0

2026-09-25

**Data**

- A small title index supports exact title searches without changing saved memories.

**Tools**

- Recall now finds a complete approved node title even when ordinary text search drops every word in it as too common.
  Matching ignores letter case and accepts one outer pair of double quotes around the title.
- Exact title matches stay ahead of incidental body matches when choosing candidates and ordering the final results.
  Date and layer limits still apply.
- `recall:migrate` adds the title lookup after rehearsing the database change in `brain_dev`, before an authorized production run.

---

## v0.43.0

2026-09-25

**Tools**

- Both memory servers and the portable `report-outcome` command can now record which approved nodes a caller expected and which it used, separately from evidence passages.
  The `missing_expected_node` category lets a caller report that recall missed a known node.
- These reports remain unverified caller claims outside approved memory.
  Each list accepts up to 20 node IDs in UUID format, and older callers can leave the lists out so they default to empty.

---

## v0.42.0

2026-09-25

**Tools**

- Agents using the dedicated Tbrain connection can now open a recalled approved node with `get_node`.
  It returns Tony's full original words, readable text, deadline, and completion state without requiring a second memory connection.
- Node search previews now keep the exact spacing of the saved text and report its full length and whether the preview was shortened.
  Each preview includes the command to open the full node.

---

## v0.41.0

2026-09-25

**Tools**

- Both memory servers and the portable traces command can now filter calls by exact action name or by success, error, or incomplete status.
  They can also find calls whose recorded duration is at least a chosen number of milliseconds.
  These filters combine with workflow and parent filters to find failed or slow recall and background calls.
- Calls with no timing, including unfinished calls, do not match a time filter.
  Each page still inspects a bounded number of records, and an empty page may still lead to more results.
- Caller reports do not use these filters.

**Docs**

- The trace guide and command help explain how to use the filters and continue after an empty page.

---

## v0.40.0

2026-09-25

**Tools**

- Hourly indexing now tries up to 256 missing items, up from 32, within one 30-second allowance shared by saved nodes and archived evidence.
  It checks the time between passages and before another page, keeps completed search vectors from a partial page, and resumes missing work later.
- Indexing still handles one passage at a time at low CPU priority.
  A model or database call already in progress may carry the run past 30 seconds.
- Manual indexing now accepts `--max-seconds` alongside `--limit` and source or archive receipt filters.
  Traces show the chosen time allowance, how many items were filled, and whether the limit was reached.

**Docs**

- The indexing guide explains how to set these limits and what happens when a run reaches its time allowance.

---

## v0.39.0

2026-09-25

**Tools**

- Every portable Tbrain command now accepts `--help` or `-h`, and `help COMMAND` works too.
  Help explains arguments, limits, paging, and authorization without opening the database or reading an input file.
- Help for `validate` and `import` shows the accepted capture-file format.
  Help for `report-outcome` shows the accepted caller-report format.
  Both formats come from the same rules that check the input.
  Optional fields remain optional.
- Invalid arguments point to help without repeating private values.
  Traces label help requests as help rather than attempted saves.

**Docs**

- The Tbrain guide shows examples of command help.

---

## v0.38.0

2026-09-25

**API**

- Passage reads now accept valid positions beyond the old five-million-character limit, so a match deep in a long source can be opened.

**Tools**

- Recall now shows an exact excerpt near the matching words in a long saved passage instead of always showing its beginning.
  Its read instruction points to that position.
- The command keeps the full excerpt within its output limit, along with the evidence ID and position.
  Traces record the excerpt's position, length, and whether it was cut short without copying the text.
- Search ranking, source text, and approval status stay unchanged.

**Docs**

- The memory guide explains how to open the excerpt and what recall shows when it cannot find a matching part.

---

## v0.37.0

2026-09-25

**Tools**

- Trace summaries now separate timing and errors by action while keeping the overall totals.
  A slow background sync no longer hides how long recall takes.
- Diagnostic checks do not count as user work in the action breakdown.

**Docs**

- The trace guide explains how to read these timings and why they do not prove answer quality.

---

## v0.36.1

2026-09-25

**Tools**

- Large batches now keep their request and result traces even when evidence or node ID lists are long.
  Traces keep the main IDs for up to 100 items and the full batch counts and errors.
  They set `references_truncated` when list IDs are omitted.
  List IDs share a 1,000-ID allowance across the batch, with a 100-ID limit for each list.
- Client version text longer than 64 characters is now omitted so its request trace can still save.

**Docs**

- The trace guide explains these limits and how to read saved receipts or checkpoints for more detail.

---

## v0.36.0

2026-09-25

**Tools**

- Both memory servers and the portable command can list traces for one workflow ID.
  Operation listings can also find direct child calls by parent ID, and caller reports can filter by operation ID.
  Combined filters require every condition to match.
- Each request inspects at most 100 records and reports that number as `scanned_count`.
  A filtered page can have no matches and still return `next_after` for the next page.

**Docs**

- The trace guide explains how to follow related calls and continue past an empty page.
  It also explains why ID order can differ from execution time and why a workflow crossing UTC midnight needs a search on each day.

---

## v0.35.0

2026-09-25

**Tools**

- Each background run now tries up to 32 sessions from each source before moving on.
  Later runs use saved checkpoints to avoid duplicate messages.
- Manual capture accepts `--limit N` for each source.
  Without that option, it still scans all files.
  Failed preparation or save attempts count toward the limit.
  Unchanged, excluded, empty, and disallowed files do not.
- Command output and traces show how many files were attempted or left unexamined.
  A deferred file has not been examined yet, so its need for capture is unknown.

**Docs**

- The indexing guide explains the limit, later retries, and the difference between deferred files and unsaved sessions.
  It also explains that the limit caps work without promising a finish time.

---

## v0.34.1

2026-09-25

**Tools**

- An unfiltered indexing run now offers pending saved nodes half its places first, rounded up.
  Archived evidence gets the remaining places, and nodes can use any evidence places left empty.
  The total limit stays the same, and a run limited to one item gives a pending node first place.
- A live backlog check found 5,637 archived passages and three saved nodes waiting for indexing.
  The old evidence-first order could keep nodes waiting indefinitely.
- Repairs limited to one source or archive receipt still work only on archived evidence.
  Indexing leaves source text and existing search vectors unchanged.

**Docs**

- The indexing guide explains the shared limit and why an unfiltered run limited to one item prioritizes a saved node.

---

## v0.34.0

2026-09-25

**Tools**

- Recall now puts strong matches ahead of partial word or meaning matches when choosing candidates and again after ranking them.
  Partial matches fill remaining places and still appear when no strong match exists.
- Search results, command output, and trace records now label each match as strong or partial.
  The labels describe search relevance.
  They do not prove a claim or approve a memory.

**Docs**

- The memory guide explains match labels and why agents should use the returned order instead of sorting by score alone.
- A research note records the ranking failure and two read-only comparisons with reference searches.

---

## v0.33.0

2026-09-25

**Tools**

- Session capture now exits with a failure when some sessions cannot be saved.
  It keeps successful saves and still tries the other session source.
- Each capture run records counts for each source and links its record to the background run and individual save commands.
- Capture now catches private error output from its save commands before it can print, then logs only safe details.
- `--help` shows instructions without starting capture or reading configuration.
  Unknown options also fail before either step.

**Docs**

- The capture and trace guides explain partial saves, failures by source, and how to follow a background run to each save attempt.

---

## v0.32.6

2026-09-25

**Tools**

- A partly saved batch now records an unsuccessful memory operation instead of claiming the whole batch succeeded.
  The record keeps saved item IDs, session checkpoint IDs, evidence counts, and counts of rejected items by category without copying source or error text.
- A command that returns `ok: false` also records an unsuccessful memory operation, even if it does not throw an error.
  The record keeps memory operation failures separate from failures to save the trace.

**Docs**

- The trace guide explains how to check which items saved before retrying a partly saved batch.

---

## v0.32.5

2026-09-25

**Tools**

- Session capture and search indexing now claim the right to run in one step, so a background job and a manual command cannot do the same work at once.
- Each run writes a unique owner file inside its lock directory, and cleanup removes only that run's file.
  A late cleanup cannot unlock a newer process, while recovery after a crash still works.

**Docs**

- The search indexing guide explains how overlapping jobs and lock directories with unknown owners are handled.

---

## v0.32.4

2026-09-25

**Tools**

- The trace summary counts missing or failed replies only for finished MCP calls.
  Command-line work does not affect those reply counts.
- The summary also counts background runs that failed during agent session capture, pasted video capture, or search indexing.
  Each step counts at most once per run.

**Docs**

- The trace guide explains which calls have reply records and what the background failure counts mean.

---

## v0.32.3

2026-09-25

**Tools**

- The background job now prepares saved text for search even if it cannot capture agent sessions or pasted video transcripts.
  Its result names each failed step and still shows which steps finished.
- Each background run now records its steps and links them to the commands it started.
  The records name failed steps without copying private error text.
- Error logs from the background job no longer print command output, source text, or private error details.
- The sync command now shows help without starting capture.
  It rejects unknown options before starting work.

**Docs**

- The search indexing guide explains how to inspect a stopped background job, run one repair cycle, and check the result.

---

## v0.32.2

2026-09-25

**Tools**

- Recall now accounts for document length when ranking text matches.
  Repeated incidental words in a long paste no longer push a focused passage out of the search candidates as easily.
- Long sources remain searchable, and source text stays unchanged.

---

## v0.32.1

2026-09-25

**Tools**

- Large daily trace summaries now read a few records at a time, so they work when the process has a small file limit.
- If a trace read fails, the reader closes its other open records before reporting the failure.

---

## v0.32.0

2026-09-25

**Tools**

- Both memory connections can now report whether saved passages are still waiting for semantic indexing.
  The check can cover the whole brain, one source, or one archive receipt.
- The index repair command can target one source or archive and stop after a chosen number of records.
  It fills only missing vectors and leaves source text and existing vectors unchanged.
- Index checks and repairs leave operation traces.
  Callers can report pending indexing as the reason a search was incomplete.
- The repair command rejects misspelled flags, duplicate options, and invalid limits before database work.

**Docs**

- The index guide explains how to check a saved archive, use text search while indexing is pending, and repair its missing vectors.

---

## v0.31.0

2026-09-25

**Data**

- Memory operations now leave private local records of their requests, results, and reply delivery.
  These records keep identifiers and content fingerprints without copying memory text into another store.
- Caller feedback stays separate from server records and approved memories.

**Tools**

- Both memory connections return a trace identifier and offer tools to read traces, report outcomes, and inspect daily counts and operation times.
- Invalid arguments, unknown tools, and database failures now leave traces too.
- Direct commands record their operations and link child commands to the request that started them.
  Existing command output stays unchanged.
- A failed trace write does not turn a successful memory save into a failed save.
  Tracing stops waiting after one second if its storage does not respond.
- Server error logs now keep safe failure categories instead of private error details.
- Trace summaries distinguish failed operations, empty searches, unfinished calls, and problems reported by callers.

**Docs**

- The trace guide explains what is recorded, what remains unknown, how callers report outcomes, and how to inspect failures without a database connection.

---

## v0.30.0

2026-09-24

**Tools**

- Recall can limit results by source, speaker role, saved layer, and exact time.
  It applies those limits before choosing candidates, so unrelated records cannot crowd out the material you asked for.
- A date you provide takes priority over a date inferred from your question.
  Dated evidence must have a known message timestamp.
- Recall rejects invalid or conflicting filters before it opens storage or loads the search model.
  If its usual search fails, the backup search keeps your filters.
- Both memory servers accept the same recall filters and show which limits they applied.
- Exact time filters keep the requested instant and microsecond precision when converting to UTC.
- The recall command accepts the same filters and shows help without a connection.
  It rejects unknown or repeated options before connecting.

**Docs**

- The memory guide explains how to limit recall by source, speaker role, and exact time, including commands for callers without MCP.
- Older changelog entries now describe what changed in plainer language while keeping the release facts and measurements.

---

## v0.29.3

2026-09-24

**Tools**

- When you ask about a period, recall keeps connected memories within that period, even if its usual search fails.
- Connections outside the requested period no longer take slots from matching memories.
- Calendar boundaries now use UTC, regardless of the database connection timezone.
- Dated results show the time bounds used and which timestamps those bounds apply to.

**Docs**

- The memory guide explains UTC calendar dates, node creation dates, and when a connection outside the requested period may appear as context.

---

## v0.29.2

2026-09-23

**Tools**

- Recall, search, and passage reads identify fragments from the same conversation as one source.
  Repeated excerpts no longer look like independent support.
- Speaker roles come from recorded archive details or a parser that knows the session format.
  Passage context covers only the saved episode being read.
- Search reports speaker names and message dates as unknown when the archive did not record them.
- An undated passage still has an unknown message date.
  Recall separately shows the source date it used to narrow the search.
- Reading a node that does not exist now reports a missing record, not a storage outage.

**Docs**

- The retrieval guide explains shared sources, uncertain dates, and the limits of passage context.
  It also explains why a search match alone may not support an answer.

---

## v0.29.1

2026-09-23

**Data**

- Supplied conversations now keep spaces at the ends of messages, so saved quote positions still point to the exact words.

**Tools**

- Capturing many messages now sends them to the database in limited batches instead of one at a time.
  A failed capture still saves none of them.
- Evidence saved in batches keeps its original order and redaction behavior.
- Portable archives save evidence and its links to source messages in batches.
  Receipts keep their identifiers, reading returns the original order, and a failed archive saves nothing.

**Docs**

- The capture guides explain batch limits, what happens on failure, and the measured reduction in database calls.

---

## v0.29.0

2026-09-23

**Data**

- Session capture saves a permanent record of its progress together with new evidence.
  Interrupted or concurrent runs can then retry safely.

**Tools**

- Session sync compares each saved appearance of a message instead of counting turns.
  It keeps repeated messages and recovers gaps left by earlier parser changes.
- Before saving a session, capture checks the whole supplied conversation against source exclusions.
  It then removes sensitive text while keeping saved quote positions accurate.
- Automatic sync checks older sessions once.
  After that, it skips an unchanged file only when the parser and file details match its saved progress record.

**Docs**

- The sync guide explains how to recover earlier gaps, keep repeated messages, run the first comparison, and deploy saved progress records.

---

## v0.28.0

2026-09-23

**Data**

- An approved memory save or completion can include a permanent receipt, saved together with the change.

**Tools**

- Retrying a memory write with the same request ID returns its original result.
  Changing the request while reusing that ID reports a conflict instead of duplicating or overwriting a memory.
- If completion commands run at the same time, the brain records one completion per node, including for older callers that do not send request IDs.
- Memory tools accept request IDs and let callers read receipts after reconnecting.
  They report conflicts and missing records separately.

**Docs**

- The memory guide and companion instructions explain how to verify a save, retry safely, move to receipts, and include them in backups.

---

## v0.27.0

2026-09-23

**Data**

- Session capture no longer labels known machine observations as human speech.

**Tools**

- Refreshing the agent runtime no longer reinstalls dependencies when only the project version changed.
- Archive search can limit results by source and speaker role.
  The command can page through results, read passages, show help offline, and explain invalid input.
- Agents can prepare a partial capture from supplied messages and check a full transfer offline.
  The result says when it has not been saved and identifies fields that need repair.
- Both memory servers return data that programs can read along with the existing text result.
- Either memory server can read a matching passage and nearby passages.
  Long text can continue in another request, and each passage names its source.
- Conversational recall omits older machine observations from results without changing saved history.
  It reports a broken or limited search without showing internal errors.
- Recall results include passage IDs and say when text was cut short, so agents can check the source before answering.

**Docs**

- The agent memory guide explains how to read sources, prepare partial captures, retry failures, recover, and update installed clients.

---

## v0.26.3

Sep 11, 2026

**Tools**

- Tbrain tells conversation clients to find and reuse a registered source ID before saving a review.
  An authorization failure gives the same recovery step.

**Docs**

- The capture instructions distinguish a registered source ID from the conversation's own ID.

---

## v0.26.2

Sep 10, 2026

**Docs**

- The Tbrain runbook records the checked production migration, private ChatGPT connection, test database round trip, and production backup restore.

---

## v0.26.1

Sep 10, 2026

**Tools**

- Full backups now accept the tested `pgbouncer` and `uselibpqcompat` options in the managed database URL.
  They still reject unknown connection options.

---

## v0.26.0

Sep 9, 2026

**Data**

- A close-of-day capture keeps the supplied messages, what they cover, who wrote them, and later corrections separate from draft reflections and approved memories.
- Sending the same transfer again returns its original saved receipt.
  Changing the text while keeping the same revision is rejected.
- Private database backups include source evidence and capture receipts.
  The restore command works only with an empty local test database.

**Tools**

- Compatible clients can save an authorized day, read original passages, search older evidence, and check receipts through a private connection.
- When a conversation client cannot save directly, it can prepare a checked JSON file for import with one command.
- Local memory writes pass their input to the command that saves it.
  Failures stop within a set limit and do not reveal private output.
- The agent installer connects both memory servers through the same fixed agent runtime.
- The release updates browser, URL parsing, and archive packages that had reported security issues.
  Four issues in the local search model packages still have no published fix.

**UI**

- The app title is now Tbrain.
  Existing local configuration names and launch commands still work.

**Docs**

- The companion now reads memory relevant to the current question and keeps nightly source material.
  It does not treat draft meanings or commitments as approved.
- The operating guide separates local checks, account setup, and approval for a production database change.

---

## v0.25.0

Aug 31, 2026

**Tools**

- For ten minutes, recall reuses the word counts from an earlier question.
  A follow-up then needs two database round trips instead of three.
  Re-asking a question against the real brain fell from about 230 milliseconds to 145.
  For up to ten minutes, a newly saved word may still be treated as rare or unknown when ranking results.
  Search still reads current data, so the saved memory remains available.

---

## v0.24.0

Aug 31, 2026

**Tools**

- The first question after a short break no longer needs a fresh database connection.
  Previously, after 30 seconds idle, reconnecting added about 0.5 to 1.5 seconds.
  The server now checks its connection every 25 seconds for half an hour after the last real call.
  After half an hour idle, it stops those checks and the next question reconnects once.

---

## v0.23.1

Aug 31, 2026

**Tools**

- Updated Next.js from 16.2.10 to 16.3.3 to fix an authorization bypass and security issues in postcss and nanoid.
  Updates to brace-expansion and js-yaml fix two more issues.
  Together, these changes clear five of the nine high-severity issues reported by the audit.
- Four issues remain in the local search model packages.
  `@huggingface/transformers` still depends on an older `sharp`, and `onnxruntime-node` still depends on an older `adm-zip`; no fix has been released.
  Those packages process Tony's own local model files and do not receive untrusted input.

---

## v0.23.0

Aug 31, 2026

**Tools**

- Recall now combines its search work into one database request instead of sending ten to fifteen small requests in sequence.
  An ordinary question needs three round trips: count its words, search the memories, and read approved connections.
  Against the real brain on the same network, a first question fell from about 1.4 seconds to 0.7.
  Repeated questions fell from about 0.9 seconds to 0.23, with the same answers.
- If the combined database request fails, recall uses its older separate searches and says so in the answer note.
  A failure in one search path does not lose the whole answer.

---

## v0.22.0

Aug 30, 2026

**Tools**

- Questions from an agent now take about half as long after the first question.
  The memory server keeps the local search model loaded instead of starting a new process for every question.
  In ten questions against `brain_dev`, the first still took about 1.9 seconds.
  Later questions took a median of 898 milliseconds, down from 2.0 to 2.4 seconds each.
- Reading reminders or one node fell from about 900 milliseconds to about 85.
  The old path started a process and opened a database connection for every call.
  The 85 millisecond measurement assumes a recent call left the connection open.
  After 30 seconds idle, the next call reconnects.
- If the search model fails to load, the server tries again on the next question.
  Otherwise, a single failure could leave meaning-based search unavailable until the server restarted.
- Reusing a question saves about 80 milliseconds.
  Most of the speed gain comes from keeping the search model loaded.
- `remember` and `mark_complete` still save through `scripts/brain.mjs` as separate processes.
- Programs can now call `recall` as a function.
  The command output, including `--json`, stays byte for byte the same.

---

## v0.21.0

Aug 30, 2026

**Tools**

- Coding agents now use a fixed copy of the repository at `~/.fuzzy-brain/runtime`.
  Working on another branch no longer changes the version they run, and moving the working checkout no longer breaks them.
  The fixed copy uses `main` and shares Git data with the checkout, but its dependencies take roughly 1 GB of extra disk space.
- `npm run agents:install` stops if local `main` is missing or behind `origin/main` and prints a repair command.
  Uncommitted work does not block installation because the agent runtime reads committed `main`.
  The installer warns that those edits stay out of the runtime, and it warns if `main` has commits that have not been pushed.
  It prints the installed commit and subject.
- `--runtime-only` updates the fixed agent copy after a change lands on `main` without changing agent settings.
  It reinstalls dependencies only when the lockfile changes, and it works while the checkout has uncommitted edits.
  `--dev` points agents at the working checkout for debugging and prints a warning at the start and end.
  `--dry-run` writes nothing, including to the runtime directory.
- `npm run fusion:install` also uses the fixed runtime.
  Installing scheduled sync from another branch no longer switches agents to that branch.

**Docs**

- The README explains why agents use the fixed runtime, its disk cost, how to update it after a merge, and how to use `--dev`.

---

## v0.20.0

Aug 30, 2026

**API**

- The new `POST /api/companion` route lets the app talk to a local Claude Code session using the existing subscription.
  It sends the brain as text and gives the session no tools or slash commands, so the session can talk and propose but cannot run commands, read files, use the network, or save memories itself.
  The route accepts requests only on localhost and requires a custom header.
- The development and production servers now listen on `127.0.0.1`, so other devices cannot reach the app by default.
  Opening the brain from a phone on the same Wi-Fi no longer works without changing that setting.

**UI**

- The new "talk" button opens a chat with the brain companion in the app.
  When you want to keep a thought, it proposes a save card with your exact words and a readable draft.
  Nothing saves until you click, and the card uses the existing add-node path.
  The chat stays in one session across messages.
- When a node cannot save, the app explains why in plain words.
  A connection to a missing node now reports the missing node instead of showing a database error.

---

## v0.19.0

Aug 30, 2026

**Data**

- Search can now find the approved "why" sentence on a connection and tolerate misspellings through `pg_trgm` and two new text similarity indexes.
  The new indexes cover the first 2,000 characters of a quote and 4,000 of a node, limiting their size to about 36 MB.
  The database change adds to existing data and runs in `brain_dev` before touching the real tables.

**Tools**

- `recall` now uses the search design tested on a fixed set of 50,000 memories.
  In that test, the share of expected answers found in the first ten results rose from 0.697 to 0.977.
  The test and live command share the same search code in `scripts/lib/retrieval/`.
- Recall now searches exact text, text fragments, vector meaning, and misspellings for each saved layer.
  It weighs those methods for the question and then ranks the combined results.
- A question with typos can now find its answer.
  "securty vulnerabilites reviw" now returns the security review passage.
  Against the real store, real typos scored 0.44 to 0.69 on text similarity, while random letters reached at most 0.25.
  The cutoff is 0.40.
- When a question names a month with a year, recall limits every search method by date.
  "what happened to the brass lantern in march 2024" no longer returns the September passage.
  A month name alone does not trigger a date limit because words such as "may" and "march" also have other meanings.
- Recall can search approved connection reasons.
  A match in a reason returns both connected nodes.
  A node found in another way brings directly connected nodes and their reasons as context.
  Those connected nodes cannot, by themselves, make recall claim it found an answer.
- The five answer states keep their earlier meanings.
  All 20 random nonsense questions returned no results and the "missing" state.
  A meaning score alone counts as strong support only above 0.70; below that, a result also needs a match to actual words.
- The extra search work adds roughly 150 milliseconds to a question.
  A mistyped question takes about two seconds against the full evidence store because typo matching is expensive.
  Recall runs that search only for questions that look mistyped.
- The score needed for a strong meaning match rose from 0.65 to 0.70.
  In `brain_dev`, 150 random nonsense questions scored a median of 0.61 and a maximum of 0.651 against 451 real passages.
  The old cutoff made about one nonsense question in fifty look like evidence.
  Real answers and reworded questions scored 0.72 to 0.87 in that test.
- A passage with a meaning score from 0.65 to 0.70 now yields "partial" rather than "evidence".
  Recall may say "fragments surfaced but no direct answer is stored" for a question it previously treated as answered.
  The cutoff is defined near the top of `scripts/recall.mjs`.
- A caller that stays open can reuse the search model's result for up to 500 earlier questions, matched after trimming spaces and lowercasing the question.
  In a local measurement, a reused result took under 0.01 milliseconds instead of a model call of about 20 milliseconds.
  The one-shot `scripts/recall.mjs` command starts with an empty cache each time, so it does not yet gain this speedup.
- The recall load test now checks available memory, database connections, CPU cores, and existing swap use before it starts.
  It stops if the run begins using swap.
  A previous 10 million item test drove this laptop to 15.6 GB of swap and a load average of 72.
  `--force` overrides these limits.
- Added `scripts/bench-embed.mjs` to measure first model load, typical and slow question times for 5 to 30 word questions, and reuse of cached results.
  It prints system load before and after the test.
- Tested other ways to run the question search model on this Apple Silicon Mac.
  CoreML took about three times as long to load and four times as long for a typical question compared with the CPU setting.
  Smaller q8 model weights answered about 2.5 times faster after loading, but their lowest similarity to the current model across 20 questions was 0.964, below the required 0.99.
  Search therefore keeps the existing CPU model and full-precision weights.

**Docs**

- `experiments/recall-bench/PRODUCT-RECALL.md` records the shared search code, each setting that changed and why, and results for the same 18 real questions before and after.

---

## v0.18.0

Aug 30, 2026

**Tools**

- `npm run agents:install` connects the Fuzzy Brain server to Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop, and VS Code when each is set up for MCP.
  It skips and reports on any agent it does not find, and prints a plain JSON snippet at the end for anything else.
  `--dry-run` previews every change without writing, and `--only` limits it to specific agents.
- Agent settings and scheduled sync now point to `~/.fuzzy-brain/bin/brain-run`, which the installer updates to the current checkout.
  After moving or deleting a checkout, rerun the installer from the new location.
  The installer merges or backs up hand-edited settings before changing them.

**Docs**

- The fusion guide and README now use `npm run agents:install` instead of a manual command tied to the old checkout path.

---

## v0.17.1

Aug 12, 2026

**Tools**

- Notes shared into the brain now carry Tony's speaker label, so recall gives his words the intended weight.
  The earlier label used a capital T that recall did not recognize.
  Earlier notes keep their saved label; newly shared notes get the corrected one.

---

## v0.17.0

Aug 12, 2026

**Tools**

- Video transcripts pasted into the todo app now reach the brain as source material, with one record per video and its title, channel, link, and watched date.
- The brain splits each transcript at its timestamps, so a quote can lead back to its point in the video.
- Notes about a video keep Tony's speaker label, which recall uses when ranking results.
- The hourly sync now saves video transcripts after agent sessions and before preparing them for search, so a transcript pasted on the phone can be found by the next cycle.
  If the todo app cannot be reached, the video step is skipped and the rest of the sync still finishes.
- Running the video sync again does not duplicate a saved video.
  If it saves a transcript but cannot update the todo app, it finishes that step on the next run.
- `npm run watch:sweep` runs the sweep by hand, and `--dry-run` reports what would land without writing anything anywhere.

---

## v0.16.0

Aug 6, 2026

**Data**

- The brain now records deadlines and completions as new events, leaving older nodes and Tony's original words intact.
  It can show what is overdue, coming up, or finished.
- An automatic deadline requires clear deadline words and a date that is today or later.
  Another event can clear it, and the app shows the right Los Angeles calendar date.
- The two completed August goals are recorded as finished, and the Stripe Atlas offer remains active through August 5, 2027.

**API**

- A local memory server gives compatible agents five guarded actions: recall, reminders, node reads, explicit saves, and explicit completions.
- Agents can save or complete a memory only when the user explicitly asks and the call comes from a trusted local client.
- The app and command line now recognize clear deadline language and save its date together with the node.

**Tools**

- A macOS scheduled job can save settled Claude Code and Codex sessions as unapproved source material every hour.
  It then prepares a limited number of local search records.
  Fixed command paths and a shared lock keep scheduled and manual runs from colliding.
- A resumed session saves only new turns.
  Invalid project lists or settling periods stop capture before any cloud write.
- Search preparation handles one document at a time, releases model memory, and stops overlapping runs so unattended sync cannot exhaust the Mac.

**Docs**

- The companion ritual now distinguishes an explicit remember or completion command from ordinary conversation, and documents the fusion bridge's truth, privacy, reminder, and operating boundaries.
- The fusion guide now includes a reproducible Codex registration command for a stable checkout.

---

## v0.15.0

Jul 21, 2026

**Docs**

- The new `digest-article` skill saves an article from a URL as source material, then discusses it with you.
  You can save takeaways in your own words.
  The brain keeps your approved takeaway with a link to the article; it does not treat the article text as your belief.
  Zero takeaways is a normal outcome; the article just sits in evidence.

---

## v0.14.2

Jul 22, 2026

**Docs**

- `docs/reference/polygres.md` brings together research on Polygres, pgGraph, pgContext, and Pocket for later work.
  It records that pgGraph is registered on the live brain tables but has not been built, and that pgContext cannot yet run alongside pgvector.
  It also keeps the decisions about when to adopt each product.
- Added `BACKLOG.md` for rough thoughts to revisit later.
  They do not need a fixed format or polish.

---

## v0.14.1

Jul 21, 2026

**Tools**

- Database calls and sweep commands now have time limits instead of hanging without an end.
  Connecting has a 15 second limit, each query has a two minute limit, and each sweep call into `brain.mjs` has a five minute limit.
  A failed call appears in the run count and can retry on the next run.
- The embedding sweep now runs at the lowest CPU priority, so a long backfill can no longer starve the whole machine the way the first one did.
  It also stops itself if it detects it is making no progress (for example when a second sweep is filling the same rows), instead of looping.
- The session and clipping sweepers now share one helper for talking to brain.mjs, so their safety limits can never drift apart.

---

## v0.14.0

Jul 21, 2026

**Tools**

- Phone and Mac shares can now reach the brain without a terminal.
  Share or highlight anything, tap the "Brain" Shortcut, and it lands in the evidence store as a `clipping` episode.
  `npm run clippings:sweep` moves clips from an iCloud Drive inbox into the brain.
  It applies the existing sensitive text filter, source exclusions, and duplicate check.
  A clip is captured only when Tony shares it.
  Processed clips are archived, never deleted, and failed clips stay in the inbox and retry on the next run.

**Docs**

- Step-by-step guide for building the two share-sheet Shortcuts ("Brain" and "Brain + note"), the clip format, and scheduling the sweeper with launchd: docs/capture-shortcut.md.

---

## v0.13.2

Jul 16, 2026

**Docs**

- A new plan describes how source material may become approved memory.
  It starts with real cases reviewed with Tony, then source search, suggested memories, and typed claims only if needed.
  The plan is in `docs/superpowers/specs/2026-07-16-processing-layer-development.md`.
- The Phase 3 plan now starts by searching source material.
  The set of approved memories is still too small to need its own search system.
  Issues #4 and #10 record the change.

---

## v0.13.1

Jul 14, 2026

**API**

- The sync-sessions route no longer freezes the whole app while it runs.
  A click used to block other requests for up to ten minutes.
  Session import now runs without blocking them, and the app turns away a second click or a simultaneous terminal import so the two do not race to save the same data.
- Error messages shown after a failed sync are safe to display now.
  File paths, database details, and quoted session text used to be able to leak into the browser; the full detail goes to the server log instead, and the button shows a plain explanation of what went wrong.
- The route now requires a small custom header on its request, so another browser tab or page can't silently trigger a sync just by loading in the background.

**UI**

- Fixed the sync result panel hiding other panels underneath it.
  Opening "+ add node" or selecting a node/connection while a sync result was showing now closes the sync panel first, matching how those panels already behaved with each other.

---

## v0.13.0

Jul 14, 2026

**UI**

- Added a "sync sessions" button next to "+ add node" in the app header.
  One click runs the same session import as the terminal command, and a panel shows what was saved or skipped and why.
  The button, app route, and terminal command all use the same save script.

**Data**

- Corrected a wrong claim from earlier the same day: the ChatGPT desktop app's "Codex" tab and the Codex CLI read the same underlying session store (`~/.codex/`), confirmed by finding an identical session title in both.
  Sessions in the desktop app's Codex tab were already being captured.

---

## v0.12.1

Jul 14, 2026

**Docs**

- After Tony's first feedback session, the companion opens with a plain hello and keeps asking when he shares something heavy.
  Tony decides when to stop that conversation.
  Before drafting a memory, it proposes which thoughts to keep as separate nodes and reads needed files up front.
- The full correction is logged in FEEDBACK.md so the pattern is on record, same as the July 9 entry.

---

## v0.12.0

Jul 14, 2026

**Data**

- Claude Code and Codex sessions now enter the source material store automatically.
  Each saved session keeps the conversation, replaces tool activity with "[N tool calls omitted]", and records the speaker and time for each turn.
  The first real run saved 47 Claude Code sessions and 444 passages from the allowed project.
- When a session ends, a local hook copies its transcript to `~/.fuzzy-brain/session-archive` without parsing it or using the network.
  Parser errors and Claude Code's 30 day cleanup cannot remove this copy.
  The setup copied 1,088 existing transcripts and raised retention.
  Import reads both archived and live transcripts and can run again without duplicating them.
- Session capture first checks the local list of allowed projects; the first run skipped 937 sessions outside it.
  It then checks Tony's source exclusions and skips the whole session on a match.
  Finally, it removes sensitive text before building passages so quote positions stay accurate.
  Capture removes system reminders, command wrappers, tool results, and internal reasoning before labeling anything as Tony's words.
- A session and its passages save together, so an interrupted import cannot leave a session with missing passages.
  A timed-out run exposed this risk.

**Tools**

- `brain.mjs` gained `list-episodes` to browse saved source material and `add-evidence` to save several passages in one call.
  `add-episode` can save a session and its passages together, so a failed save leaves neither behind.
  These commands use the existing guarded save path.
  A code check still looks for writes outside that path.

**Docs**

- The companion can browse saved source material and read individual passages.
  It labels quotes as unapproved source material, ignores instructions inside that material, and discusses possible memories with Tony before saving.
  Machine-checked like every skill rule.
- Three new recall checks expect an "evidence" answer state.
  One checks that a record of Tony's words does not automatically become a claim about his beliefs.
- A short investigation found Cursor chats in separate SQLite databases for each workspace, with keys that Cursor has not documented.
  Issue #12 records the finding and leaves Cursor capture for later work.

---

## v0.11.0

Jul 13, 2026

**Data**

- Added a separate store for source material such as agent sessions, texts, meetings, and email.
  It records where material came from, each captured item, and exact passages within it.
  The brain treats this material as unapproved evidence until Tony approves a memory or connection in conversation.
- A local filter catches Social Security numbers and valid credit card numbers before saving, so those values do not leave the Mac or enter the permanent store.
  Deleted messages from other people are kept, never dropped, and always flagged, set once, never reversed.
  A passage with removed text shows a placeholder and reason when read.
  A message deleted by its sender stays visible with a deletion marker.
- Seven new `scripts/brain.mjs` verbs: `add-source`, `list-sources`, `set-exclusions`, `add-episode`, `add-evidence`, `mark-sender-deleted`, `show-evidence`.
  Saved source material cannot be edited or deleted, except to mark a message deleted by its sender.
  A test checks the code for forbidden database updates or deletes.
- Fable 5 drafted the design and served as the final reviewer.
  Its review found a copied database rule that could have deleted every saved quote after one delete command.
  The rule was removed before it reached the database.

---

## v0.10.2

Jul 13, 2026

**Docs**

- Tony approved the first decisions in the digital brain plan.
  He and the companion will decide in conversation when to split a message into multiple memories.
  The companion's own notes stay separate, and its guesses about Tony do not become approved truth unless he says them in his own words.
  Deleted messages from others remain visible with a deletion marker.
  A local filter catches Social Security and credit card numbers, while Tony names less predictable material to exclude.
- Recorded the three non-M4 decisions as ADR 0002; M4 is resolved directly in the node-structuring notebook.
  Phase 0 of the master plan is complete, so Phase 1 (the evidence store) can begin.

---

## v0.10.1

Jul 13, 2026

**Docs**

- Added `docs/superpowers/specs/2026-07-13-digital-brain-master-plan.md` with seven phases for Tony's broader brain.
  Source material can grow through automated capture, while approved memories grow through conversation with Tony.
- Added an audit of what the brain already has and research with 17 checked outside claims.
  Both records name gaps in coverage and work that was interrupted.
  The research cites a May 2026 paper with a similar raw, readable, and approved split.
  It found no product offering human-approved meaning and used lessons from Rewind, Roam, and Recall.
- Filed the overall plan as issue #10, the source material store as #11, initial agent session capture as #12, the memory server as #13, and the privacy plan as #14.
  The tracker also records dependencies on existing issues #3 through #9.

---

## v0.10.0

Jul 11, 2026

**Tools**

- When the companion offers an interpretation of a feeling or meaning, it now labels it as its own.
  It says "in your own words" only when quoting Tony exactly.
  Evaluation run 001 found that the companion added tidy themes even without memory records, so skill tests now check this rule.

**Docs**

- Tony's delegation approved four scoring changes from run 001.
  Each comparison uses only the material available to it, a precise "partial" label does not fail a stated fact, Q17 now expects "partial", and the interpretation label is part of the scoring guide.
  Sonnet 5 scored 5/5 after those corrections and pilots the daily companion role.
  Opus 4.8 keeps the roles that check boundaries and meaning.
- Filed an issue to retry broken evaluation output before scoring run 002, including a cut-off Q03 answer and a Q10 answer that only said "test".

---

## v0.9.0

Jul 11, 2026

**Docs**

- The first recall evaluation asked 24 questions of the live brain, compared three setups on five questions, and compared two Sonnet 5 companion runs under the roles set by PRD #8.
  In the review, 20 of 24 answers named the right support level, and two of 165 claims about Tony were judged invented.
- Without the brain, all 22 references to specific memories disappeared, while the companion's voice, caution, and capture behavior remained.
  It still added a tidy interpretation with no nodes, which located that behavior in the companion instructions.
- Added the run record at docs/evals/runs/ with machine-readable front matter naming the model in every seat, plus the run-log entry in the eval set.
  The record includes four proposed changes to earlier scoring decisions for Tony to approve.

**Data**

- A test checks that every evaluation record names each model, uses one model across comparison setups, lists expected and claimed results by question, and includes a skipped section even when nothing was skipped.
  This keeps later runs comparable and exposes a model change.

---

## v0.8.0

Jul 11, 2026

**Tools**

- The companion now says whether an answer has a saved memory behind it, is missing, has conflicting memories, or is blocked by a failed lookup.
  A failed search does not become "you never told me that".
  When a memory is missing, the companion asks Tony instead of guessing.
- A draft connection reason now says how the two memories relate, such as "learned from", "happened during", or "person in".
  It includes a date when time matters.

**Docs**

- Added 25 recall questions with the answer state expected today, so later checks can compare answers with saved evidence.
  The unanswerable ones double as the capture roadmap.
- ADR 0001 adopts clear answer states now and waits on typed connection fields, a recall controller, a claims layer, and Polygres activation.
  Issues #2 through #7 track the conditions for taking those steps.
- The node structuring notebook now includes M5, a rule for naming the kind of relationship in a draft connection reason.

---

## v0.7.0

Jul 10, 2026

**Face**

- Moved the "front" control to the left edge so it stays out of the way of the face while remaining easy to reach.

**Data**

- Added a Polygres search lab in `brain_dev` to test source passages, people and things, specific claims, time, source authority, search results, and the steps behind an answer.
  It does not change the real brain.
- Added made-up test cases for full text search, pgvector and HNSW meaning search, multi-step connections, and supported, missing, or conflicting answers.
- Added a temporary pgGraph 0.1.8 test that follows one claim connection and returns its reason and source.
  It does not add test tables to the real brain graph.
- Tests, sample data, and companion tables now name `brain_dev` directly, so a reused database connection cannot accidentally use the real brain.

**Tools**

- Fixed the space so "go to nearest portrait" actually resolves the face.
  Each portrait dot now lines up from the place the button reaches, so the face forms there and looks scattered from other positions.
  Before, the depth scatter only lined up in the studio preview, and the parked view stayed a jumbled cloud.
- Portraits already saved in the browser are upgraded automatically the next time the space loads; nothing needs to be re-added.
- Codex and Claude now read the same brain companion instructions for raw words, readable drafts, recaps, and save rules.
- Added reusable recall checks that explain missing or conflicting answers, choose allowed next steps, and repeat comparisons without code for one specific example.

**Docs**

- Added research on personal AI memory, Polygres search and operating limits, and companion identity.
  It separates ideas Fuzzy Brain can reuse from its proposed human approval rules across agents.
- Added a Recall Observatory guide with priorities, a current Polygres check, ways to recover from failures, and an animation that replays a path through nodes.

---

## v0.6.0

Jul 9, 2026

**Data**

- Every node now keeps Tony's exact words, including typos, and a separate readable version.
  No tool can change the original words.
  Existing nodes carried their stored text over as their raw.
- After a talking session, the companion can draft a short factual recap for Tony to approve.
  The next session can use that approved recap to pick up the conversation.
- Tests and experiments use the separate `brain_dev` database area.
  Each database change runs there before it reaches real nodes.

**API**

- Creating a node now requires the raw words and treats the readable as optional; a deliberately typed thought counts as its own readable.

**Tools**

- `brain.mjs` now supports both text layers and commands to approve a revised readable version, save an approved recap, and export a full JSON copy of the brain.
  It still has no delete, clear, or set-raw on purpose.
- The visual-QA seed script now refuses to run anywhere but the sandbox.

**UI**

- The node panel shows the readable first with a quiet "see the raw" toggle for the verbatim original.

**Docs**

- The writing rule now says that readable text may describe and quote but must not interpret Tony's words.
  Tony approves any meaning saved in the brain.
  The structure pass retired in favor of the readable pass, and a new rule bans destructive SQL against the real brain.

---

## v0.5.0

Jul 9, 2026

**Map**

- Pressing a node dot in the map could blank the view with "undefined is not an object (evaluating 'position.x')".
  The map no longer crashes when a press ends without a completed drag.
  The map's camera controls no longer trip over a pointer they never finished tracking.
- A node dot now brightens and grows while it moves, then returns to normal when it stops.
  The field moves gently while idle.
  All of this is turned off automatically if you have reduced motion enabled.

---

## v0.4.0

Jul 9, 2026

**Tools**

- Added the brain companion so Tony can talk through thoughts and save them as nodes without filling out a form.
  It loads your whole brain, opens by picking up where you left off, runs the structure pass on what you share, and offers connections for you to approve before anything is linked.
- Added `scripts/brain.mjs` with commands to list the brain, read a node, and save nodes or connections.
  The database still requires a reason for each connection.

---

## v0.3.0

Jul 8, 2026

**Tools**

- Added "the space" at `tools/space`, with a full-screen photo-to-portrait studio and a 3D room where portraits sit in a ring.
  It runs on its own, separate from the main brain map, so the brain stays the default.
- Fly with the arrow keys or WASD, and hold shift with up or down to rise and fall.
- "Go to nearest portrait" now carries you all the way to a crisp head-on view of the closest face; leaving that view eases you right up to the face instead of dropping you far away.
- Portraits can be deleted, each carries a numbered sign you can navigate to, and they are saved in the browser so they survive a reload.

---

## v0.2.0

Jul 8, 2026

**Face**

- Added a 3D face made of photo-derived points, where each memory node lights one point and the face forms from one viewing position.
- Strung faint connection lines between lit points, so existing whys stay visible in the face view too.
- Made the face view the default view on load; the map is one toggle away.

**Map**

- Rebuilt the map as a 3D force graph with drag-to-rotate orbit controls and scroll to zoom.
- Restored springy drag physics so pulling a node visibly drags its connections along.
- Eased the camera toward a clicked node while its detail panel opens.

**UI**

- Removed the animated galaxy background in favor of a solid night sky.
- Added movement when the camera returns to "front", gentle drift in the face view, fades on load, a halo around the selected node, and short descriptions on hover.
- Made all movement respect `prefers-reduced-motion`; buttons now acknowledge presses with a subtle scale.

**Tools**

- Added `tools/face-scatter.html`, an offline photo studio with a live 3D preview and controls for spacing, depth, brightness, and contrast.
- Committed the ratified portrait asset (3,809 points).

**Docs**

- Wrote the face-reveal design spec, covering the full path from MediaPipe face landmarks to the final anamorphic-scatter approach.

---

## v0.1.2

Jul 7, 2026

**Docs**

- Proposed "The Ratified Galaxy", where the program suggests connections and broader concepts and Tony decides what to approve.
  Not yet approved for build.

---

## v0.1.1

Jul 4, 2026

**Docs**

- Documented the ritual: nodes are raw capture, not polished artifacts.

---

## v0.1.0

Jul 2, 2026

**Data**

- Added Polygres database tables, reusable connections during development, and `GET /api/health` and `GET /api/graph`.
- Added integration tests that run against the real database inside rolled-back transactions.

**Map**

- Built the first 2D map with connected nodes, a glow effect, a detail panel, and a legend for node types.

**API**

- Added in-app node creation: an add-node panel and `POST /api/nodes`.
- Allowed `127.0.0.1` as a dev origin.
- A node no longer needs a type when it is created.

**UI**

- Added the animated galaxy background (removed in v0.2.0).
