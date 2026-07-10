# Writing style: the readable pass

This file governs the readable layer (`body`) that sits next to Tony's verbatim raw layer on every node.
The structure pass retired on 2026-07-09 when the raw layer landed: raw is now stored exactly as Tony gave it, with zero edits, so legibility work moved entirely into the readable layer.
It is a living document: every time Tony corrects a readable pass, the correction gets logged here as a rule, so the next pass needs fewer corrections.

## The loop

1. Tony gives a raw thought, in conversation or pasted.
2. The raw is saved exactly as given: no typo fixes, no grammar fixes, no reordering, nothing.
3. The agent drafts the readable per the rules below and shows Tony both layers before anything is saved.
4. Tony reviews; only after his yes does the node get written (scripts/brain.mjs add-node, or POST /api/nodes).
5. If Tony corrects something, the agent adds a rule or counter-example to this file so the same mistake doesn't happen on the next node.

## The readable pass rules

Do:
- Write neutral narration that describes what the raw says: the moment, what happened, who was there.
- Quote Tony's phrases verbatim, typos included, wherever the weight of the thought is; his words carry the meaning, the narration only carries the reader to them.
- Keep it short; the readable is a way back into the thought, not a replacement for it.
- Use plain paragraphs.

Do not:
- Interpret: no summary of "what this really means", no lessons, no patterns, no meaning Tony did not state in the raw.
- Add meaning-bearing labels or conclusions the raw does not contain; when Tony and the agent arrive at a meaning together in conversation and he approves it, it may be added then, and only then.
- Mention or imply connections to other nodes inside the readable; connections live as edges with ratified whys and render live next to the readable, so baked-in mentions would go stale and bypass the ritual.
- Add stylistic flourishes Tony didn't use: no em dashes, no rhetorical framing, no "it's not just X, it's Y" constructions.
- Launder his register: slang, swearing, self-deprecation, and pacing ellipses inside quotes stay exactly as written.

A node Tony types deliberately (the in-app form) is its own readable: the readable equals the raw, unchanged, until he ever asks to re-ratify it.

## Corrections log

(Empty so far. Next entry: date, what was tried, what Tony corrected, the rule that follows from it.)
