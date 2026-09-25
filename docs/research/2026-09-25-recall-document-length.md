# Recall and document length

Two caller-reported searches missed known archive passages in the first ten results.
The archive had no vectors at first.
After a bounded repair filled its 18 missing vectors, both expected passages ranked second in the semantic candidate list, but neither reached the final ten results.

The text candidates included code-review pastes and meeting transcripts with more than 100,000 characters.
Repeated incidental words gave those documents high text scores and filled the candidate limit before shorter relevant passages could enter it.

PostgreSQL's default text ranking ignores document length.
Its normalization option 2 divides the rank by document length.
See [PostgreSQL 17 text-search ranking](https://www.postgresql.org/docs/17/textsearch-controls.html#TEXTSEARCH-RANKING).

A read-only comparison tested the documented length options against the same two searches.
Logarithmic length normalization did not recover either expected passage.
Normalization by total document length recovered them at ranks 8 and 7.
Normalization by unique-word count recovered them at ranks 9 and 7.
The implementation uses total document length for the full-text lanes, including approved connection explanations.
It keeps the existing semantic thresholds, result cap, source filters, and approval rules.

Synthetic regression cases contain 32 long repeated-word distractors for both evidence and approved nodes.
The focused passage ranks first after the fix.
A separate long passage remains findable by its unique term.
Existing checks cover semantic paraphrases, typos, date filters, source filters, and approved connections.

The two live cases show improved retrieval, not a general claim about answer quality.
Their expected passages remain unratified archive evidence.
The changes do not rewrite any source or approve its contents.
