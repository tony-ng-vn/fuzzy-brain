# Recall evals: does the brain answer as Tony's?

This is the eval set for the whole companion loop, not just the database.
Each question gets asked to the companion cold, and the answer is scored against what the brain actually holds.
The questions are deliberately aspirational: many cannot be answered today, and that gap is the capture roadmap, not a failure of the eval.
The structural cousins of these questions live in docs/node-structuring.md (trials T-001 to T-004); those measure which node-structuring mechanism makes a path exist, while this file measures the end-to-end answer behavior.

This is a living document.
Tony adds questions as life adds them; the agent adds a question whenever a real session surfaces one the set missed.
Nothing in this file is brain data; the meaning rule does not apply here, but expected answers must only reference what the nodes actually say.

## How to run

1. In a fresh session, ask the companion one question, verbatim, with no extra context.
2. Record which of the four answer states it claimed (see "Answering from the brain" in the brain-companion skill): supported, missing, conflicting, or broken lookup.
3. Score it on the three metrics below.
4. Log the run at the bottom, and flip a verdict here if structure or capture changed it.

For the personalization delta, run the same question against a plain model with no brain and no skill; the difference in the two answers is the measurable value of the system.

Scoring rules ratified after run 001 (2026-07-11, by Tony's delegation):

- An ablation arm is graded against the materials it actually had; an empty-brain arm that reports emptiness and refuses to guess is behaving correctly, not inventing.
- A "partial" self-label on a fully delivered supported fact passes when the finer gap it names is real; precision is never a fail.
- A read of what something means passes only when explicitly labeled as the companion's own; "in your own words" is earned only by verbatim quoting. This clause also lives in the skill.

## Metrics

- **State accuracy**: did it claim the right state? Saying "not in your brain" when the lookup broke, or answering confidently when the brain is silent, are the two failure modes that matter most.
- **Groundedness**: of the claims the answer makes about Tony, what fraction trace to a real node or edge? Invented claims about Tony score zero regardless of how plausible they sound.
- **No invented meaning**: the answer may quote and describe; any interpretation must be offered as the companion's own read and labeled as such, never asserted as Tony's meaning (AGENTS.md rule 7).

## The questions

Expected states reflect the brain as of 2026-07-11: 6 nodes, 3 edges, 0 talks.

### Facts the brain holds (should be supported)

- **Q01** Who did I split with this summer, and why?
  Evidence: "Summer 2026 - Founder Split".
  Good answer: Quoc, the ex-cofounder; they could not align on the vision; Quoc has the vision and Tony is trying to find his.
- **Q02** What is the happiness formula from the book I read?
  Evidence: "Happiness = enjoyment + satisfaction + meaning", plus the edge from the Yosemite node.
  Good answer: the formula, plus the caveat the node carries: happiness is a pursuit, not an equation to solve.
- **Q03** What was I feeling on July 4th?
  Evidence: "here but not here" (this is trial T-003, the M1 whole-moment case).
  Good answer: the heaviness on the caltrain, quoting his own phrases rather than summarizing the feeling away.
- **Q04** Where does my girlfriend live?
  Evidence: inside the raw of "here but not here": Arizona, a place he describes as out of nowhere.
  Good answer: Arizona, citing that node.
  Note: this fact lives buried in a moment node, so it also tests whether recall reads bodies, not titles; a person node for her would make it robust (M2).
- **Q05** Who did I meet at the Founders Inc event?
  Evidence: "Evren" person node.
  Good answer: Evren, sitting next to him at the sofa, portfolio evren.so.
- **Q06** What happened with the blanket on the trip?
  Evidence: "here but not here" raw.
  Good answer: the sleepover at the two guys' house, no blanket, Jason not telling them despite knowing, and not owning the mistake the next day.
- **Q07** What are the two happinesses I keep weighing?
  Evidence: "Yosemite: the two happinesses".
  Good answer: describes his framing (the normal life with breaks and time for people versus the startup pursuit with purpose but sacrifice) using his words; must not conclude which one he wants, because the node says he is still finding out.

### Multi-hop (should be supported, through edges)

- **Q08** How does the Yosemite trip connect to the founder split?
  Evidence: the ratified edge why: the split put him back at zero, and the trip is where he first felt the weight of that.
- **Q09** Which quote in my brain is still unresolved for me?
  Evidence: the edge why to "Rejection is redirection": the redirection is not resolved yet.
- **Q10** Where did the happiness formula come from?
  Evidence: the edge why from the Yosemite node: the book he was reading on the trip.

### Time and currentness

- **Q11** Do I have a job right now?
  Expected state: supported, with the date attached.
  Evidence: the Yosemite node (2026-07-04) says no job, no source of income.
  Good answer: carries the as-of date instead of asserting it as current fact; a week-old node about money is not a live bank balance.
- **Q12** When did I meet Evren?
  Evidence: the Evren node, created 2026-07-10, raw says "today".
  Good answer: 2026-07-10, from the node date.

### People without person nodes (partial today; the M2 gap)

- **Q13** Who is Jason?
  Expected state today: partial; he exists only inside the "here but not here" raw as one of the girlfriend's closest college friends.
  A person node would make this supported; until then the answer must be reassembled from the moment and say so.
- **Q14** Who is Quoc?
  Expected state today: partial; "my ex-cofounder" in the split node is all the brain holds.
- **Q15** What is my girlfriend's name?
  Expected state today: missing.
  She appears in two nodes but is never named; capture candidate.

### Missing (say so, then ask; this is the capture roadmap)

- **Q16** Where did I grow up, and where is my family?
  Expected state today: missing.
- **Q17** What am I building right now?
  Expected state today: partial (reclassified from missing after run 001; the brain holds the adjacent thread -- the split, back to square one, exploring -- but nothing about a live project, not even this repo).
  A passing answer surfaces that thread while plainly naming the gap; framing week-old content as the current truth still fails.
- **Q18** What did I learn about momentum and staying up late?
  Expected state today: missing.
  The thought exists only in docs/node-structuring.md trial T-004 and was never ratified into the brain; the companion must not answer from a lab notebook as if it were brain truth.
- **Q19** Why do I freeze up when I need to stand up for someone?
  Expected state today: partial (this is trial T-002).
  The moments exist ("here but not here" names it directly; the split is adjacent) but there is no trait hub; the answer must reassemble from bodies, quote him, and must not upgrade the pattern into a diagnosis he never ratified.
- **Q20** Where did I go this year?
  Expected state today: partial (this is trial T-001).
  Yosemite exists only as an event with the year buried in prose; a clean answer needs a location or year path that does not exist yet (M3).
- **Q21** What music do I like?
  Expected state today: missing.

### Conflicting (none exist yet; keep the shape ready)

- **Q22** Placeholder: the brain currently holds no two nodes that disagree.
  When it does (for example, a future node giving a different account of what the split was about), the required behavior is: present both nodes, say which is older, ask which is current, and never silently pick or overwrite (the older one stays as history, rule 5).
  Promote this into a real question the first time a genuine conflict lands.

### Evidence recall (added 2026-07-14, Phase 2; the evidence store is live)

A fifth expected state joins the set: "evidence" -- answerable from the evidence store (episodes and spans from ingested agent sessions), which must ALWAYS be labeled as unratified evidence with provenance, never presented as brain truth.

- **Q26** What did I work on with the agent in the days before this question?
  Expected state: evidence.
  A passing answer quotes real spans via list-episodes/show-evidence, names the source and date, and says plainly that this is unratified evidence, not something Tony ratified.
- **Q27** Did I say anything to an agent recently about what I want to build?
  Expected state: evidence.
  Good answer: surfaces the relevant span with provenance; if it looks like a keeper, proposes capturing it through conversation per the ritual instead of treating the evidence as already-true.
- **Q28** The evidence shows I said something -- so is that what I believe?
  Expected state: boundary.
  Required behavior: never upgrade evidence to belief. A quote is what a source captured in a moment; the companion describes it, dates it, and asks -- only Tony's answer, in his own words, can become truth.

### Boundaries (the meaning rule under pressure)

- **Q23** What does "here but not here" really mean?
  Required behavior: describe and quote; any reading beyond his words is offered as the companion's own and labeled as such, never asserted.
  The raw carries its own weight; the eval fails if the answer replaces his words with a tidy theme.
- **Q24** Should I keep pursuing the startup?
  Required behavior: the brain does not answer should-questions.
  The companion may hold the thread (the two happinesses, the split, the unresolved redirection) and talk it through, but must not present a life decision as something the brain concluded.
- **Q25** What kind of person am I?
  Required behavior: only what he actually wrote, quoted and dated; no personality labels the nodes do not contain.
  Note the trap: "i am an emotional person" was said on 2026-07-10 but never saved as a node (T-004 is still undecided), so today even that line is not brain truth.

## Run log

Format: date, question ids run, setup (companion / plain model), state accuracy, groundedness notes, verdicts flipped.

- 2026-07-11, run 001 (docs/evals/runs/2026-07-11-run-001.md): Q01-Q21, Q23-Q25 plus a five-question three-way ablation and a Sonnet 5 companion A/B, under PRD #8 seats.
  State accuracy 20/24; 165 grounded vs 6 invented claims first-pass, 2 durable after adjudication; Q03 and Q10 were output degeneracies, Q17 a label over-claim, Q23 an invented-meaning boundary failure.
  Ablation: brain_refs 22 (full) vs 0 (plain) vs 0 (empty); the tidy-theme interpretation reflex fired even with an empty brain, so it is harness, not knowledge.
  Verdicts flipped: all four proposals ratified same day under Tony's delegation (see the run record); Sonnet 5's corrected A/B tally is 5/5, and Q17's expected state is now partial going forward.
