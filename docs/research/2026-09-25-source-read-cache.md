# Repeated source page reads

## Observed cost

`read_source` returned at most 12,000 UTF-16 code units, but every page fetched the full episode and archive bundle from PostgreSQL.
A retained source with 7,779,283 UTF-16 code units transferred 7,780,128 bytes of source text for each page.
The initial five-page measurement took 1,723 ms for the first page and 591 to 869 ms for subsequent pages.

## Change

The resident Tbrain server now keeps up to eight source texts within a 32 MiB budget.
The budget counts two bytes per UTF-16 code unit, excluding the small keys and object overhead.
Least recently used entries leave first.
Text larger than the budget still works without retention.
Closing the service clears the cache.

Each read checks a SHA-256 fingerprint of the current database text in the same query that fetches its source details.
PostgreSQL returns the full text only when that fingerprint differs from the cached copy.
The query uses PostgreSQL's built-in [SHA-256 function](https://www.postgresql.org/docs/17/functions-binarystring.html).
Provided source exports take precedence over rendered episode text, as before.
Offsets still use JavaScript UTF-16 indexing.
A database failure remains a failed read, even when a cached copy exists.
This change adds no database writes or persisted cache files.

## Comparison

The installed release and candidate read six identical 12,000-character pages through separate MCP connections.
The order alternated after each page to reduce ordering bias.
The first page took 1,649 ms on the installed release and 1,702 ms on the candidate.
The median across the next five pages fell from 654 ms to 136 ms.
All six page texts, offsets, lengths, source details, coverage, and redaction information matched.
These measurements describe one source on this host, not a general latency guarantee.
The server still reads and hashes the full source inside PostgreSQL, so this change reduces network transfer rather than database text processing.

Regression tests check exact page slices, same-length source edits, fresh source labels, unavailable storage, provided exports, eviction, text budgets, and release on close.
