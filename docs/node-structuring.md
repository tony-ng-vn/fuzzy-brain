# Node structuring: an experiment log

This file exists because Tony named the hard, unsolved problem of the whole brain:
turning a raw messy thought into structured nodes and edges is the thing that
decides whether the brain can answer a question later, and he has not figured out
the right way to do it yet. So instead of guessing once, we track the mechanisms we
try and measure them against real questions, so the companion can see over time
which structuring choice actually paid off.

This is a lab notebook, not a spec. It is meant to be read and updated every talking
session, right after the brain index loads. If it drifts out of the ritual it is
dead weight, so keep it wired in (see "Staying wired in" below).

## The open question

There is no single correct way to break a raw thought into nodes, because the best
structure depends on the question you will ask later, and you cannot know every
future question in advance. The same raw ("the Yosemite trip") wants to be a
location node for "where did I go this year", a moment node for "what was I feeling
that week", and a pointer to a trait for "why do I freeze up". One decomposition is
perfect for one query and useless for another.

The working hypothesis: do not pick one decomposition. Layer several over the same
raw and connect them with why-edges, so each query can find its own path in.
Redundancy is a feature. The discipline that keeps this from becoming spaghetti is
the one already in the ritual: every edge carries a why, and capture beats polish.

## Mechanisms we are trying

Each mechanism is a way of turning raw into structure. Status is one of: proposed,
testing, adopted, retired.

- **M1 whole-moment node** (testing). Keep an episode intact in one node: one time,
  one story, all the texture together. Hypothesis: best for "what happened / what
  was I feeling" queries; bad as a connection hub because the reusable idea inside
  it is invisible to search. Examples so far: "Yosemite: the two happinesses",
  "here but not here".

- **M2 atomic trait node as hub** (proposed). Pull a durable fact about Tony ("Tony
  is an emotional person") into its own small node, so many moments can edge into it.
  Hypothesis: best for "why do I keep doing X" queries that cut across many moments;
  the trait becomes the anchor those moments point at. Not yet written.

- **M3 multi-type node** (proposed, needs schema change). Let one node carry more
  than one type (e.g. Yosemite as both `location` and `event`) so two query-paths
  hit the same node without duplicating it. Current schema has a single `type text`
  column (scripts/schema.sql), so this needs a tags/labels table or a type array
  before it can be tested.

- **M4 raw slicing** (resolved 2026-07-13, no mechanism adopted). When one flowing
  message from Tony contains several atoms, there is no fixed rule for whether it
  becomes one node or several. Tony's answer: handle it the same way edges already
  work (rule 2) -- discuss it live, case by case, whenever it comes up. If a piece is
  worth its own node later, it can be pulled out with a verbatim excerpt as its raw
  (a real substring of what he said, never a paraphrase); nothing is decided in
  advance. See ADR docs/adr/0002-digital-brain-phase-0-decisions.md and trial T-004.

- **M5 typed why** (adopted as a drafting convention, 2026-07-11). When drafting a
  why for Tony to ratify, make the kind of connection explicit inside the sentence
  (learned-from, happened-during, contradicts, person-in) and date it when time
  matters. Hypothesis: whys written this way become traversable predicates for free
  if a typed-edge column ever lands (an additive migration, tracked in the deferred
  issues), so the graph gains structure now without any schema change. The three
  existing whys already read close to this shape. Convention only: it guides how the
  agent drafts, never what Tony ratifies.

## Retrieval trials

The real measure. Each trial is a concrete question posed against the current graph:
does the structure answer it, and which mechanism made the path exist or fail. Re-run
these as the graph grows; a mechanism earns "adopted" by making trials pass.

Format: id, date, query, what structure the query needs, verdict against the current
graph, note.

- **T-001** 2026-07-10. Query: "where did I go this year?" Needs a location node
  (Yosemite) tied to a year (2026). Verdict: FAILS. Yosemite exists only as an
  `event` node with the year buried in prose; there is no location node and no year
  node to connect to. This is the case that would justify M3 (multi-type) or a
  dedicated location node.

- **T-002** 2026-07-10. Query: "why do I freeze up / not stand up for people?" Needs
  a trait hub connected to the moments where it showed up. Verdict: PARTIAL. The
  moments exist ("here but not here" names it directly; the founder split is
  adjacent), but there is no "emotional person" or "can't stand up" trait node for
  them to edge into, so the answer has to be reassembled by reading full bodies. This
  is the case M2 is meant to fix.

- **T-003** 2026-07-10. Query: "what was I feeling the week of July 4th?" Needs the
  moment intact. Verdict: PASSES. "here but not here" holds the whole feeling in one
  node. Evidence for M1.

- **T-004** 2026-07-10. Meta-trial for M4. Tony's message on 2026-07-10 held at least
  two atoms in one breath: the trait ("i am an emotional person, and my feeling and
  thought change alot based on my emotion") and last night's momentum lesson (stayed
  up to 2am, woke with no drive, learned it is "a long game"). Verdict: RESOLVED
  2026-07-13 -- no fixed mechanism; this specific message was never itself captured
  as a node, and whether to capture it now (as one node or several) is exactly the
  kind of thing to raise live with Tony next time it is relevant, per M4's
  resolution.

## Effectiveness reflection log

Dated notes on which mechanism is proving out, written when a trial flips verdict or
a new mechanism gets tried. Keep it honest: a mechanism that sounded good but never
made a trial pass gets retired here.

- 2026-07-10. File created. M1 has one passing trial (T-003). M2 and M3 are proposed
  with failing trials waiting on them (T-002, T-001). M4 is the live decision.

- 2026-07-13. M4 resolved: no fixed slicing mechanism. Decided in conversation as
  part of the digital-brain Phase 0 decisions (docs/adr/0002); the notebook's job for
  M4 was never to pick a rule, it turns out, but to notice that the ritual's own
  discipline (discuss live, never auto-anything) already covers node structuring too.

## Staying wired in

This file only helps if it is read every session. The brain-companion routine (step
1) loads the brain index, recent node bodies, and the talk log, and nothing else.
For this tracker to matter, that step needs one added line: also read this file, run
the retrieval trials against the current graph, and log any verdict that changed.
That is a change to the ritual, so it is proposed here and applied only with Tony's
yes, not silently.
