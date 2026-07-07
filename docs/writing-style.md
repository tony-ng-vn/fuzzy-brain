# Writing style: the structure pass

This file governs the one thing Claude is allowed to touch about Tony's raw node
text: legibility. It is a living document. Every time Tony corrects a structured
pass, the correction gets logged here as a rule, so the next pass needs fewer
corrections. The goal is to approach zero corrections over time, not to get it
right by guessing harder.

## The loop

1. Tony pastes a raw thought as a new node.
2. Claude applies the structure pass below automatically and shows Tony the
   result before saving anything to Polygres. The raw original is never lost --
   it exists in the chat transcript even if not stored as a separate DB field.
3. Tony reviews. If it's right, it gets saved as the node body.
4. If Tony corrects something, Claude does not just fix that one instance --
   it adds a rule (or a counter-example) to this file so the same mistake
   doesn't happen on the next node.

## Baseline rules (calibrated 2026-07-04)

Do:
- Fix spelling typos (peole -> people, cnanot -> cannot, iamge -> image).
- Fix grammar: verb tense, subject-verb agreement, capitalization, apostrophes,
  pronoun typos (he/she mix-ups that are clearly typos).
- Break the wall of text into paragraphs at natural topic shifts. No headers,
  no bullets, no bold labels.
- Keep every sentence in its original order and its original words. A
  structure pass reformats; it does not rewrite.

Do not:
- Paraphrase, reword, or "smooth" a sentence into different phrasing, even if
  it's a run-on or hard to follow. If a sentence is confusing, it stays
  confusing -- that confusion may be part of what Tony was actually feeling.
- Add stylistic flourishes Tony didn't use: no em dashes, no rhetorical
  question framing, no "it's not just X, it's Y" constructions invented to
  sound polished.
- Remove slang, swearing, self-deprecation, or emotional register (e.g. "pussy
  ass", "tbh", ellipses used for pacing). These are voice, not noise.
- Add a summary, interpretation, or "what this really means" framing anywhere
  in the body. See AGENTS.md rule 6 -- nodes don't need to resolve their own
  meaning.
- Invent connections to other nodes during a structure pass. That's a
  separate, explicit conversation (AGENTS.md rule 2).

## Corrections log

(Empty so far. Next entry: date, what was tried, what Tony corrected, the rule
that follows from it.)
