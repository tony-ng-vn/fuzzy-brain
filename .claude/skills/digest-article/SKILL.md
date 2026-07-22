---
name: digest-article
description: Read an article from a URL and digest it -- land the article whole in the evidence store, teach it back to Tony live so he learns, and let takeaways precipitate into the brain in his own words. Invoke by name with a URL.
disable-model-invocation: true
---

# Digest article

Tony hands you a URL; you metabolize it with him. The spine of the whole routine,
one sentence to hold: **the brain should not store what you read; it should store
what reading did to Tony, with a pointer back to what you read.**

So an article is **evidence, not brain truth** -- what a source said, not what Tony
means (see the evidence-store section of the brain-companion skill). Reading it does
not put its knowledge into the brain. The article lands whole in the evidence store;
the brain gets only the takeaways Tony states in his own words, each pointing back at
the article. Zero takeaways is a normal, common outcome -- an article that moved
nothing just sits in evidence, and that is the system working.

AGENTS.md rules 1-9 are the law for anything that touches brain data; this skill
never works around them. When this skill and AGENTS.md seem to conflict, AGENTS.md
wins.

## The routine

1. **Fetch and read the whole article.**
   Pull the URL's full text (WebFetch). If it is paywalled, blocked, or comes back
   thin, ask Tony to paste the text rather than digesting a headline. Read all of it
   before you write a line.
   Done when you hold the article's actual argument, not its summary.

2. **Land the article in evidence, whole.**
   The article is a clipping-kind evidence item: what the source said, stored for
   later, never brain truth. No brain writes happen in this step, ever.
   - Find or make the source (configuration, once): `node scripts/brain.mjs
     list-sources`; if none has kind `clipping` and label `digest`, create it with
     `node scripts/brain.mjs add-source < source.json` where source.json is
     `{"kind": "clipping", "label": "digest"}`. Reuse its id after.
   - Ingest the article: write the payload to a scratch file first (the body is
     multi-paragraph, so do not fight shell quoting), then
     `node scripts/brain.mjs add-episode < episode.json` where episode.json is
     `{"source_id": "<id>", "source_locator": "<url>", "raw": "<full article text>", "occurred_at": "<article date or null>"}`.
     `raw` is the article's whole text; brain.mjs scrubs it and dedupes on
     (source_id, source_locator), so re-running the same URL is safe. Keep the
     returned episode id -- the takeaways cite it.
   Chunking the article into retrievable spans is the ingest pipeline's job
   (lib/ingest, the clippings sweep), not this skill's; capturing the episode whole
   is enough, and the takeaways carry the quotes that matter.
   If brain.mjs or the database fails, say the write broke and stop -- never pretend
   the article landed when it did not (the broken-lookup honesty from brain-companion).
   Done when the article is one stored evidence episode and you hold its id.

3. **Teach it back, live.**
   This is the part Tony is here for: talk him through the article in plain language
   so he actually learns it, and find with him where it could improve the system.
   Not a report he reads -- a conversation. Lead with the one thing it is really
   saying, then the few ideas that matter, each explained as if teaching him, with
   the article's own verbatim line quoted where the weight sits. Keep the footing
   visible the brain-companion way: what is the article's claim, and what is your
   plain-language read ("my read, not the article's words"). Never blur the two, so
   Tony always knows whose thought he is holding.
   As you talk, two things precipitate on their own -- takeaways (step 4) and system
   ideas (step 5). Let them surface from the conversation; do not harvest.
   Done when Tony has been taught the article and the talk has run its course.

4. **Let takeaways precipitate into the brain.**
   A takeaway is what reading did to Tony, said in his own words -- "reading this, I
   realized ..." Only his words become a node: raw is his verbatim reaction, never an
   agent-drafted line and never the article's sentence dressed as his (rule 7). If an
   idea gets no reaction from Tony in his own words, it is not a node -- it stays in
   evidence, where it is already safe, to precipitate later if it ever earns its place.
   Capture each the brain-companion way: raw is his words; the readable is drafted per
   docs/writing-style.md and cites the article as its source (the URL, and the evidence
   episode id from step 2) so the pointer back is recorded. A graph edge from a node to
   an evidence item does not exist yet, so the article link lives in the readable as an
   attributed source, not as a why-edge; do not add a schema change to build one.
   Offer connections to existing brain nodes one at a time, with a typed why (M5,
   docs/node-structuring.md); Tony decides; never auto-link (rules 2, 3).
   Expect 0-5 takeaways. Zero is fine.
   Done when every node written carries Tony's verbatim raw and a readable he
   approved, and every edge a why he approved -- or nothing precipitated and that is fine.

5. **Park system ideas, if any.**
   When the article points at a concrete improvement to the harness, a skill, or the
   system, write it as a short dated note in `docs/research/<YYYY-MM-DD>-<slug>.md`:
   what the article prompts, and the change it points at. A proposal for Tony, not a
   decision and not a brain node. How hard you push is read from the conversation --
   most articles carry no system idea, and a stretch is worth less than silence.
   Done when a real system idea is parked in docs/research, or there was none to park.

## Closing

Update CHANGELOG.md and bump package.json per AGENTS.md rule 8 only when the run
changed something tracked (a new skill, a new script). An ordinary digest -- an
evidence episode, some takeaway nodes, maybe a research note -- is Tony's own
knowledge work, not a repo change, and needs no version bump.
