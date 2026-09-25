# Opening the matching part of a long passage

## Problem observed

Recall always returned the first 700 characters of an evidence passage.
Several live results contained between 49,201 and 289,050 characters, so their opening text could hide the words that matched the question.
The text command shortened that excerpt again to 300 characters.
An agent then had to page through the source to discover why it appeared.

## Change

Recall now chooses an exact source slice near a group of distinct query words.
The comparison uses the existing word tokenizer and stemmer, with at most 32 query terms.
It keeps a moving window of matching positions rather than retaining every match in a long paste.
The best group contains the most distinct query words, with a shorter span breaking ties.
No matching words means the excerpt remains at the beginning.
This includes results found only through meaning, where the excerpt cannot locate the relevant idea reliably.

The result includes its position and a read instruction that starts there.
The text command shows the full bounded excerpt and its evidence ID.
Readback accepts safe integer offsets beyond the previous five-million-character cap.
The maximum read size remains 8,000 characters.
Traces retain position, full source length, and truncation status without copying source text.

This changes navigation, not ranking or the passage's authority.
A group of matching words is a reason to inspect a passage, not proof that it supports the answer.
Pasted reviews and transcripts remain supplied evidence with their existing provenance.

## Checks

A disposable-database test first reproduced the missing target sentence near the end of a long message.
It now follows the returned read instruction through both memory servers and compares the result with the original source slice.
The command-output test reproduced the second truncation before its fix.
A separate readback test reproduced rejection of a valid offset beyond five million characters.
Boundary checks cover short text, no lexical match, repeated words, and Unicode surrogate pairs.
Trace tests reject arbitrary text and invalid numeric positions.

A read-only check of four existing passages measured excerpt selection over 20 repetitions each.
The measurements exclude retrieval, database access, and model work.

| Passage length | Excerpt position | Excerpt length | Median selection time | 95th percentile |
| --- | --- | --- | --- | --- |
| 49,201 | 36,425 | 700 | 0.69 ms | 0.97 ms |
| 118,847 | 115,006 | 700 | 1.99 ms | 2.37 ms |
| 147,397 | 63,576 | 700 | 2.57 ms | 5.41 ms |
| 289,050 | 138,032 | 700 | 3.22 ms | 4.62 ms |

All four excerpts matched their source slices exactly.
These local timings show the cost on this machine, not a general performance guarantee or an answer-quality score.
