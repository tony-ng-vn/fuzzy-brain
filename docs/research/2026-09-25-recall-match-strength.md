# Strong matches and partial overlap

After the restored background job indexed another 32 archive passages, one of the two reference passages fell outside the first ten recall results again.
It still ranked third in the semantic lane with a cosine similarity of 0.7545.
The final list included a greeting and short incidental word matches instead.

The combined lane score could reward a weak result for appearing in both the word and semantic lanes.
A stronger meaning match that appeared only in the semantic lane could then lose its place before or after reranking.
The existing state classifier already distinguished strong matches from partial matches, but result ordering did not preserve that distinction.

Recall now puts strong matches first when selecting the reranking candidates and when returning the final list.
The existing ranking still orders results within each group.
The semantic threshold, word matching, source filters, result limit, and approval rules are unchanged.
Each result and its trace identify whether the match is strong or partial.

A database regression test contains 64 weak overlapping fragments across nodes and evidence.
Both strong semantic matches were absent from the leading results before the fix.
They now appear first, while fragments fill the remaining places.
With semantic search disabled, the fragments still return as partial matches.

A read-only comparison against the same stored data moved the writing reference passage from rank 9 to rank 6.
The engineering-learning reference passage moved from outside the first ten to rank 5.
These two cases do not measure general answer quality.
A long paste can still match all the query words without supporting an answer, so the caller must inspect the passage and its provenance.
