// gen-corpus.mjs -- deterministic corpus generator (DESIGN.md sections 3.3,
// 3.6, 4). Builds memories.jsonl, queries-dev.jsonl, queries-test.jsonl,
// queries-multi.jsonl, and (with --verify) oracle.json + CORPUS.lock.
//
// Construction is CONSTRUCTIVE, not rejective (DESIGN.md 4.2): every query
// is built backward from a target memory whose content already carries the
// planted signal the family needs (a rare token, a distinguisher phrase, a
// resolvable date range, a swapped entity). certifyQuery is then run as a
// *check* against the fully assembled corpus, not as a filter over guesses.
//
// Deviation from the literal text of DESIGN.md 4.2 rule 2, and the reason
// this module no longer certifies the vector lane at all: rule 2 wants the
// vector lane's brute-force rank "by exact cosine over the whole corpus". At
// the real-vector tiers (smoke1k, quality50k) the real embeddings do not
// exist yet at generation time -- load.mjs computes them afterward. An
// earlier version of this file used lib/synth-vectors.mjs as a documented
// proxy instead. Measured against the real embedder that proxy was not just
// imprecise, it was wrong in the direction that mattered: it certified every
// paraphrase_nolex query at rank 1 while nomic-embed-text-v1.5 ranked those
// same targets ~500th, so the harness reported an oracle ceiling of 1.0 for a
// corpus whose real ceiling was 0.765.
//
// So the split is now: this module certifies the LEXICAL lanes offline, with
// bounds that are provable rather than guessed (see the lane-ceiling
// functions below), and load.mjs --verify-oracle certifies the vector lane
// post-load with exact cosine in SQL against the corpus that was actually
// embedded. oracle.json written here carries vector.verified=false; the
// authoritative file is the one the verify step rewrites.
//
// Second deviation: DESIGN.md's directory listing (section 10) assigns this
// track tests/rng.test.mjs and tests/gen-corpus.test.mjs. The orchestrating
// task for this module asked for a fast self-check mode in their place
// ("generate 100 records, validate schema, print stats") and scoped this
// module to gen-corpus.mjs plus its lib/ helpers -- so those two test files
// were not written here. --self-check below is that self-check mode.

import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, resolveTier } from './config.mjs';
import { makeRng } from './lib/rng.mjs';
import { readJsonl, writeJsonl } from './lib/jsonl.mjs';
import {
  PEOPLE, PLACES, TOPICS, topicById, DISTINGUISHER_PHRASES, DETAIL_WORDS, CONCRETE_NOUNS,
  buildDateTemplate, makeRareToken, makeRareWord, PG_ENGLISH_STOPWORDS,
  PARAPHRASE_DOMAINS, PARAPHRASE_AFTERMATHS, PARAPHRASE_REFLECTIONS,
  PARAPHRASE_FILLERS_A, PARAPHRASE_TIME_WORDS_B,
  PARAPHRASE_QUERY_TEMPLATES_B,
} from './lib/lexicon.mjs';

const PEOPLE_BY_SLUG = new Map(PEOPLE.map((p) => [p.slug, p]));
const PLACES_BY_SLUG = new Map(PLACES.map((p) => [p.slug, p]));

// Alias forms for one entity slug, for engine.mjs's regex-based entity
// extraction (see buildMemoryIndex below): the display name as embedded in
// query text (e.g. "dobson road", space-separated) plus the raw slug form
// (e.g. "dobson-road" -> "dobson road" again, deduped) as a fallback.
function entityAliases(entry) {
  const aliases = new Set([entry.name.toLowerCase(), entry.slug.replace(/-/g, ' ')]);
  return [...aliases];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Tokenizing / approximate stemming
//
// Postgres's 'english' tsvector config runs a real Snowball stemmer; this is
// a small, documented approximation used only so gen-corpus.mjs's own
// brute-force certification has *some* consistent notion of "same lexeme"
// without a database connection. engine.mjs (Track 3) talks to the real
// Postgres tsvector and does not need to agree with this function -- what
// matters is that THIS file's postings and THIS file's query-stem lookups
// use the same function, so its own AND/OR brute force is internally
// consistent.
// ---------------------------------------------------------------------------

// Postgres's own english.stop, imported rather than hand-trimmed: a lexeme
// Postgres drops never reaches any tsvector, so two texts sharing one are not
// sharing content, and a certification that counts them is predicting lanes
// that do not exist.
const STOPWORDS = PG_ENGLISH_STOPWORDS;

function approxStem(word) {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('ly')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenizeStem(text) {
  const raw = text.toLowerCase().match(/[a-z0-9']+/g) || [];
  return raw.filter((w) => !STOPWORDS.has(w) && w.length > 1).map(approxStem);
}

// pg_trgm splits on non-alphanumerics and pads EACH WORD with two leading
// and one trailing space, so "the cat" yields {"  t"," th","the","he ","  c",
// " ca","cat","at "} and never a trigram spanning the gap. Verified against
// the running cluster with `select show_trgm('the skilet and garlic')`; the
// earlier implementation padded the whole string once and kept interior
// spaces, which invented cross-word trigrams pg never produces and made every
// bound computed from it unsound.
function trigramWords(s) {
  return (String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function trigramsOfWord(word) {
  const padded = `  ${word} `;
  const grams = [];
  for (let i = 0; i <= padded.length - 3; i++) grams.push(padded.slice(i, i + 3));
  return grams;
}

export function charTrigrams(s) {
  const grams = new Set();
  for (const w of trigramWords(s)) for (const g of trigramsOfWord(w)) grams.add(g);
  return grams;
}

// DESIGN.md 4.2 rule 2 wants a true statement about a lane, not a guess.
// Reimplementing pg's word_similarity extent search faithfully is a losing
// bet (its exact extent rule is an implementation detail this file cannot
// pin down offline), so the trigram lane is certified with BOUNDS instead,
// which are provable from the definition alone:
//
//   word_similarity(A, doc) = max over word-aligned extents E of
//                             |A n trg(E)| / (|A| + |trg(E)| - |A n trg(E)|)
//
//   LOWER bound: the value at any single extent is a lower bound on the max,
//     so enumerating a family of extents and taking the best gives a number
//     the real lane is guaranteed to meet or beat.
//   UPPER bound: trg(E) subset of trg(doc) and |trg(E)| >= |A n trg(E)|, so
//     the whole expression is at most |A n trg(doc)| / |A| -- computable from
//     a trigram containment count alone, with no extent search at all.
//
// "Target's lower bound beats every other document's upper bound" is then a
// sufficient condition for the target being top-1 in the lane, and counting
// how many documents can possibly outrank it gives a sound rank ceiling.

const WORD_SIMILARITY_EXTENT_SLACK = 4;

// One window scan, both bounds:
//   lower = max sim over the scanned extents (a value the real lane meets)
//   upper = max |A n trg(E)| / |A| over the same extents (dropping the
//           |E| - inter penalty, which only ever lowers the true value)
// The upper bound is far tighter than whole-document containment, which is
// what a short query full of stopwords needs: every document in the corpus
// contains "the" and "and", so containment alone calls them all contenders.
export function wordSimilarityBounds(query, doc) {
  const qWords = trigramWords(query);
  const A = charTrigrams(query);
  if (A.size === 0) return { lower: 0, upper: 0 };
  const docWords = trigramWords(doc);
  if (docWords.length === 0) return { lower: 0, upper: 0 };
  const perWord = docWords.map((w) => trigramsOfWord(w));
  const maxLen = Math.min(docWords.length, qWords.length + WORD_SIMILARITY_EXTENT_SLACK);
  let lower = 0;
  let bestInter = 0;
  for (let start = 0; start < docWords.length; start++) {
    const extent = new Set();
    for (let len = 1; len <= maxLen && start + len <= docWords.length; len++) {
      for (const g of perWord[start + len - 1]) extent.add(g);
      let inter = 0;
      for (const g of extent) if (A.has(g)) inter++;
      if (inter > bestInter) bestInter = inter;
      const sim = inter / (A.size + extent.size - inter);
      if (sim > lower) lower = sim;
    }
  }
  return { lower, upper: bestInter / A.size };
}

export function wordSimilarityLowerBound(query, doc) {
  return wordSimilarityBounds(query, doc).lower;
}

// Whole-document containment: the cheapest sound upper bound, used only to
// shortlist which documents are worth the window scan above.
export function wordSimilarityContainmentBound(queryTrigrams, docTrigramHits) {
  return queryTrigrams === 0 ? 0 : docTrigramHits / queryTrigrams;
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

// resolveTier now lives in config.mjs, next to the two halves it composes, so
// load.mjs and both benches can reach it without importing this generator.
// Re-exported here because DESIGN.md 3.6 lists it on this module's surface.
export { resolveTier };

// ---------------------------------------------------------------------------
// Small deterministic helpers shared by every family builder
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function humanDate(iso) {
  const d = new Date(iso);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function seasonForMonth(monthIndex0) {
  if ([11, 0, 1].includes(monthIndex0)) return 'winter';
  if ([2, 3, 4].includes(monthIndex0)) return 'spring';
  if ([5, 6, 7].includes(monthIndex0)) return 'summer';
  return 'fall';
}

function pickPerson(r) {
  return r.pick(PEOPLE);
}

function pickPlace(r) {
  return r.pick(PLACES);
}

function randomOccurredAt(r, minYear = 2018, maxYear = 2025) {
  const year = r.int(minYear, maxYear);
  const month = r.int(0, 11);
  const day = r.int(1, 28);
  const hour = r.int(8, 21);
  const minute = r.int(0, 59);
  return new Date(Date.UTC(year, month, day, hour, minute)).toISOString();
}

function randomClusterId(r, tier) {
  return r.int(0, tier.clusters - 1);
}

// `dup` is deliberately absent. Doubling a character adds a trigram that
// exists nowhere in the target ("skilllet" contributes "lll") AND inflates
// the query's own trigram count, which lowers word_similarity from both
// sides at once -- the exact lane this family depends on. Transposition and
// deletion keep the corrupted token's trigram overlap with the original high,
// which is what lets the trigram lane still find the target.
const TYPO_OPS = ['swap', 'drop'];

function corruptWord(word, r, op = null) {
  const chars = word.split('');
  const chosen = op ?? r.pick(TYPO_OPS);
  if (chosen === 'swap') {
    const i = r.int(0, chars.length - 2);
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  } else {
    const i = r.int(1, chars.length - 2);
    chars.splice(i, 1);
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Memory content: a template layer, not literary prose. Realism is
// secondary to the property that actually matters here -- every planted
// signal (mustInclude terms, a distinguisher, a rare token, a date) lands
// verbatim in the rendered text, because certifyQuery checks that fact
// later rather than assuming it.
// ---------------------------------------------------------------------------

function buildTitle(r, topic) {
  const noun = r.pick(topic.concreteNouns);
  const cap = noun[0].toUpperCase() + noun.slice(1);
  const templates = [
    `The Day of the ${cap}`,
    `A Note About the ${cap}`,
    `Remembering the ${cap}`,
    `The ${cap} Afternoon`,
    `That Time With the ${cap}`,
  ];
  return r.pick(templates);
}

function sentence(r, ctx) {
  const n1 = r.pick(ctx.topic.concreteNouns);
  const n2 = r.pick(ctx.topic.concreteNouns);
  const v = r.pick(ctx.topic.concreteVerbs);
  const templates = [
    `We spent time with the ${n1} and the ${n2}, and it took a while to get right.`,
    `${ctx.person.name} ${v} the ${n1} while I watched.`,
    `It took longer than expected, mostly because of the ${n1}.`,
    `By the end, the ${n2} was finally sorted out and we were both relieved.`,
    `We talked about the ${n1} again on the way back from ${ctx.place.name}.`,
    // Short templates, deliberately under ~45 chars: give the bin-packer in
    // buildBody a chance to land inside a narrow window (the synthetic
    // tiers' bodyChars is only 180-220 wide) without overshooting maxLen.
    `${ctx.person.name} ${v} the ${n1}.`,
    `It was about the ${n1} again.`,
    `The ${n2} needed more work.`,
  ];
  return r.pick(templates);
}

// Sentences that carry a planted signal (mustInclude / distinguisher /
// rare_token / date) are built first and never trimmed away; padding
// sentences are appended afterward and are the only thing cut if `body`
// would otherwise exceed bodyChars[1].
function buildBody(r, ctx, tier) {
  const [minLen, maxLen] = tier.bodyChars;
  const loadBearing = [`On ${ctx.dateText}, ${ctx.person.name} and I were at ${ctx.place.name}.`];
  if (ctx.mustInclude.length) loadBearing.push(`It centered on the ${ctx.mustInclude.join(' and the ')}.`);
  if (ctx.distinguisher) loadBearing.push(`I remember it because of ${ctx.distinguisher}.`);
  if (ctx.rareToken) loadBearing.push(`The reference code on it was ${ctx.rareToken}.`);

  let acc = loadBearing.join(' ');
  // Greedy bin-pack a pool of candidate padding sentences into the
  // [minLen, maxLen] window: a single fixed sequence can straddle the
  // window (a sentence that would push acc from under minLen to over
  // maxLen in one step) and earlier versions of this function did exactly
  // that. Trying a larger pool and skipping any candidate that would
  // overshoot -- rather than committing to the first one drawn -- gives the
  // packing many more chances to land inside a window as narrow as the
  // synthetic tiers' 180-220 range.
  if (acc.length < maxLen) {
    for (let i = 0; i < 30 && acc.length < minLen; i++) {
      const candidate = sentence(r, ctx);
      const next = `${acc} ${candidate}`;
      if (next.length <= maxLen) acc = next;
    }
  }
  return acc;
}

// "a lowercased, compressed restatement, never a copy" (DESIGN.md 3.1).
// Different template, same load-bearing content, so the tsvector weight-B
// layer still carries every planted signal without being body's text again.
function buildRaw(r, ctx) {
  const noun = r.pick(ctx.topic.concreteNouns);
  const verb = r.pick(ctx.topic.concreteVerbs);
  const parts = [`${ctx.person.name} ${verb} ${noun} at ${ctx.place.name} ${ctx.dateText}`];
  if (ctx.mustInclude.length) parts.push(ctx.mustInclude.join(' '));
  if (ctx.distinguisher) parts.push(ctx.distinguisher);
  if (ctx.rareToken) parts.push(ctx.rareToken);
  return parts.join(' ').toLowerCase();
}

const KIND_POOL = ['event', 'event', 'event', 'note', 'preference', 'quote'];

// Builds one memory's content (everything but `id`), given a render context
// assembled from `extra`. This is the one function every family builder
// calls to actually produce a MemoryRecord-shaped object.
function buildStandaloneMemorySpec(r, topic, tier, extra = {}, helpers = null) {
  const person = extra.person ?? pickPerson(r);
  const place = extra.place ?? pickPlace(r);
  const occurred_at = extra.occurred_at ?? randomOccurredAt(r);
  const cluster_id = extra.cluster_id ?? randomClusterId(r, tier);
  const ctx = {
    topic,
    person,
    place,
    dateText: humanDate(occurred_at),
    distinguisher: extra.distinguisher ?? null,
    rareToken: extra.rareToken ?? null,
    mustInclude: extra.mustInclude ?? [],
  };
  const title = buildTitle(r, topic);
  const body = buildBody(r, ctx, tier);
  const raw = buildRaw(r, ctx);
  return {
    kind: r.pick(KIND_POOL),
    title,
    body,
    raw,
    people: [person.slug],
    places: [place.slug],
    tags: [topic.slug],
    occurred_at,
    cluster_id,
    dup_group: extra.dup_group ?? null,
    // Non-null exactly when the token is in the body: the rare_hit rerank
    // feature and the AND lane both read text, so a column value the body
    // never mentions would be a signal nothing can find.
    rare_token: ctx.rareToken && body.includes(ctx.rareToken) ? ctx.rareToken : null,
    distinguisher: extra.distinguisher ?? null,
  };
}

// ---------------------------------------------------------------------------
// Family builders. Each returns { query: { text, targetContentIds,
// distractorContentIds, difficulty, declaredFilters } } and registers one or
// more memories via helpers.addMemory. Difficulty is this module's own
// coarse 1-3 heuristic (DESIGN.md documents diagnostics.difficulty's
// existence but not its scale): 1 for a single clean planted signal
// (rare_token, entity_swap), 2 for signals requiring crowding/parsing to
// resolve (near_dup, date_filter, typo_noisy), 3 for the weakest lexical
// footing (paraphrase_nolex, partial_ref).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// paraphrase_nolex: one semantic frame, verbalized twice
//
// The memory renders the frame's A column, the query renders the SAME frame's
// B column. Same event, same participants, same salient details, disjoint
// vocabulary -- which is what makes the family a paraphrase test rather than
// (as the previous implementation was) an unrelated-text test that happened
// to satisfy the zero-overlap rule. Measured under the real embedder, a
// frame-rendered query ranks its frame-rendered target at mean rank 2.0 over
// the 1K corpus; the previous abstract-register queries ranked theirs ~500th.
// ---------------------------------------------------------------------------

const cap = (s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));

// Which frame slots each lexicon query template needs. A template is only
// eligible when every slot it names actually survived into the body -- a
// query must not describe a detail the memory never wrote down.
const PARAPHRASE_QUERY_TEMPLATE_SLOTS = [
  ['action', 'mishap'],
  ['mishap', 'action'],
  ['action', 'detail', 'mishap'],
  ['time', 'prop', 'action', 'mishap'],
];

function drawFrame(r) {
  const domainIdx = r.int(0, PARAPHRASE_DOMAINS.length - 1);
  const domain = PARAPHRASE_DOMAINS[domainIdx];
  return {
    domainIdx,
    actionIdx: r.int(0, domain.actions.length - 1),
    propIdx: r.int(0, domain.props.length - 1),
    mishapIdx: r.int(0, domain.mishaps.length - 1),
    detailIdx: r.int(0, domain.details.length - 1),
    aftermathIdx: r.int(0, PARAPHRASE_AFTERMATHS.length - 1),
    reflectionIdx: r.int(0, PARAPHRASE_REFLECTIONS.length - 1),
    headIdx: r.int(0, 2),
  };
}

function frameSlots(frame) {
  const domain = PARAPHRASE_DOMAINS[frame.domainIdx];
  return {
    domain,
    action: domain.actions[frame.actionIdx],
    prop: domain.props[frame.propIdx],
    mishap: domain.mishaps[frame.mishapIdx],
    detail: domain.details[frame.detailIdx],
    aftermath: PARAPHRASE_AFTERMATHS[frame.aftermathIdx],
    reflection: PARAPHRASE_REFLECTIONS[frame.reflectionIdx],
  };
}

// Every word outside a slot here is a Postgres stopword (or a person/place
// name, which the zero-overlap check covers), so the disjointness question
// stays entirely about the frame table's two columns.
function paraphraseHead(frame, slots, person, place, dateText) {
  const { action, prop } = slots;
  if (frame.headIdx === 1) return `On ${dateText}, at ${place.name}, ${person.name} and I ${action.a}. The ${prop.a} was there too.`;
  if (frame.headIdx === 2) return `${person.name} and I ${action.a} on ${dateText}, and the ${prop.a} was there too.`;
  return `On ${dateText}, ${person.name} and I ${action.a}, and the ${prop.a} was there too.`;
}

// Slots are appended while they fit, so the same frame renders a 340-400
// char body at the real-vector tiers and a 180-220 char one at the synthetic
// tiers without a second frame table. `present` records what actually landed,
// because the query may only mention what the memory wrote down.
function renderParaphraseBody(r, frame, slots, person, place, dateText, tier) {
  const [minLen, maxLen] = tier.bodyChars;
  const present = new Set(['action', 'prop', 'time']);
  let body = paraphraseHead(frame, slots, person, place, dateText);
  for (const [name, pair] of [['mishap', slots.mishap], ['detail', slots.detail],
    ['aftermath', slots.aftermath], ['reflection', slots.reflection]]) {
    const next = `${body} ${cap(pair.a)}.`;
    if (next.length <= maxLen) { body = next; present.add(name); }
  }
  const fillers = r.shuffle([...PARAPHRASE_FILLERS_A]);
  for (const filler of fillers) {
    if (body.length >= minLen) break;
    const next = `${body} ${filler}`;
    if (next.length <= maxLen) body = next;
  }
  return { body, present };
}

export function renderParaphraseQuery(r, frame, present) {
  const slots = frameSlots(frame);
  const eligible = PARAPHRASE_QUERY_TEMPLATE_SLOTS
    .map((needed, i) => ({ i, needed }))
    .filter(({ needed }) => needed.every((s) => present.has(s)));
  if (eligible.length === 0) {
    throw new Error('renderParaphraseQuery: no query template fits the slots the body kept');
  }
  const choice = r.pick(eligible);
  const time = r.pick(PARAPHRASE_TIME_WORDS_B);
  const filled = PARAPHRASE_QUERY_TEMPLATES_B[choice.i]
    .replace('{time}', time)
    .replace('{action}', slots.action.b)
    .replace('{prop}', slots.prop.b)
    .replace('{mishap}', slots.mishap.b)
    .replace('{detail}', slots.detail.b);
  return { text: filled, templateIdx: choice.i, timeWord: time };
}

// The honesty rule, measured rather than assumed (DESIGN.md 4.2 rule 4).
// Checked against title + raw + body, not body alone: the tsvector is
// title-A + raw-B + body-C, so a stem shared with the title would revive the
// very lexical lanes this family exists to switch off.
export function paraphraseOverlapStems(queryText, memory) {
  const queryStems = new Set(tokenizeStem(queryText));
  const targetStems = new Set(tokenizeStem(`${memory.title} ${memory.raw} ${memory.body}`));
  return [...queryStems].filter((s) => targetStems.has(s));
}

function buildParaphraseCase(r, tier, helpers) {
  const frame = drawFrame(r);
  const slots = frameSlots(frame);
  const person = pickPerson(r);
  const place = pickPlace(r);
  const occurred_at = randomOccurredAt(r);
  const dateText = humanDate(occurred_at);

  const { body, present } = renderParaphraseBody(r, frame, slots, person, place, dateText, tier);
  const title = `The ${slots.prop.a.split(' ').map(cap).join(' ')}`;
  const raw = `${person.name} ${slots.action.a} ${slots.prop.a} ${slots.mishap.a}`.toLowerCase();
  const spec = {
    kind: r.pick(KIND_POOL),
    title,
    body,
    raw,
    people: [person.slug],
    places: [place.slug],
    tags: [slots.domain.slug],
    occurred_at,
    cluster_id: randomClusterId(r, tier),
    dup_group: null,
    rare_token: null,
    distinguisher: null,
  };

  const { text, templateIdx, timeWord } = renderParaphraseQuery(r, frame, present);
  const overlap = paraphraseOverlapStems(text, spec);
  if (overlap.length > 0) {
    // Regeneration, not repair-in-place: the static register assertion in
    // lexicon.mjs keeps this rare, and a case that trips it is a frame/person/
    // place combination whose names collide, so a fresh draw is the fix.
    throw new Error(`paraphrase_nolex: query shares stems with its target (${overlap.join(', ')})`);
  }

  const targetContentId = helpers.addMemory(spec);
  return {
    query: {
      text,
      targetContentIds: [targetContentId],
      distractorContentIds: [],
      difficulty: 3,
      declaredFilters: { date_from: null, date_to: null, people: [] },
      frame: { ...frame, templateIdx, timeWord, present: [...present] },
    },
  };
}

function buildRareTokenCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const noun = r.pick(topic.concreteNouns);
  const rareToken = helpers.nextRareToken(r);
  const spec = buildStandaloneMemorySpec(r, topic, tier, { mustInclude: [noun], rareToken });
  const targetContentId = helpers.addMemory(spec);

  // Deliberately NOT "the {noun} with reference code {token}". DESIGN.md 4.1
  // says this family breaks the vector lane because "a rare token barely
  // moves a 768-dim sentence embedding" -- but naming the target's topic noun
  // alongside the token hands the vector lane the topical anchor the family
  // exists to withhold, and measured naive recall for the family came in at
  // 1.000 against a projection of 0.35. The token alone is what the family
  // claims to test. The AND lane still reaches the target at rank 1, because
  // the token is globally unique, so the ceiling is untouched.
  const text = `the reference code ${rareToken}`;

  return {
    query: {
      text,
      targetContentIds: [targetContentId],
      distractorContentIds: [],
      difficulty: 1,
      declaredFilters: { date_from: null, date_to: null, people: [] },
    },
  };
}

function buildEntitySwapCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const swapPeople = r.float() < 0.5;
  const groupSize = r.int(2, 4);
  const mustInclude = r.sample(topic.concreteNouns, 2);

  const sharedPlace = pickPlace(r);
  const sharedPerson = pickPerson(r);
  const sharedDate = randomOccurredAt(r);
  const sharedCluster = randomClusterId(r, tier);
  const entities = swapPeople ? r.sample(PEOPLE, groupSize) : r.sample(PLACES, groupSize);

  // DESIGN.md 4.1 calls this family "2-4 memories identical in topic and phrasing,
  // differing only in the person or place". A per-member
  // fork made each member draw its own padding sentences, so the members
  // were near-identical in metadata and visibly different in prose -- and
  // the vector lane, which this family exists to break, separated them
  // easily (measured naive recall 1.000 against a projection of 0.50). One
  // shared fork label makes every member render the SAME sentences, so the
  // planted difference really is the only difference.
  const contentIds = [];
  for (let i = 0; i < groupSize; i++) {
    const person = swapPeople ? entities[i] : sharedPerson;
    const place = swapPeople ? sharedPlace : entities[i];
    const spec = buildStandaloneMemorySpec(r.fork('member-shared'), topic, tier, {
      person, place, occurred_at: sharedDate, cluster_id: sharedCluster, mustInclude,
    }, helpers);
    contentIds.push(helpers.addMemory(spec));
  }

  const targetIdx = r.int(0, groupSize - 1);
  const targetEntity = entities[targetIdx];
  const text = `the ${mustInclude.join(' and the ')} with ${targetEntity.name.toLowerCase()}`;

  return {
    query: {
      text,
      targetContentIds: [contentIds[targetIdx]],
      distractorContentIds: contentIds.filter((_, i) => i !== targetIdx),
      difficulty: 1,
      declaredFilters: {
        date_from: null,
        date_to: null,
        people: swapPeople ? [targetEntity.slug] : [],
      },
      // Everything the post-load re-target loop needs to rebuild this query
      // against a DIFFERENT member of the same confusion set. The per-member
      // entity is not stored: it is read back off each member's own
      // people/places array through the memory index.
      entitySwap: { mustInclude, swapPeople },
    },
  };
}

// The planted terms a confusion-set family's query is built out of, drawn per
// config.corpus.mustIncludeVocab. A topic's own 7-noun pool is shared by every
// same-topic filler memory, so a phrase built out of it addresses thousands of
// documents at 50K; DETAIL_WORDS is planted only where a family asks for it.
// See that config entry for the measured before/after.
function drawMustInclude(r, topic, family) {
  const recipe = config.corpus.mustIncludeVocab[family];
  if (!recipe) throw new Error(`drawMustInclude: no mustIncludeVocab recipe for family "${family}"`);
  return [
    ...(recipe.topicNouns > 0 ? r.sample(topic.concreteNouns, recipe.topicNouns) : []),
    ...(recipe.crossTopicNouns > 0 ? r.sample(CONCRETE_NOUNS, recipe.crossTopicNouns) : []),
    ...(recipe.detailWords > 0 ? r.sample(DETAIL_WORDS, recipe.detailWords) : []),
  ];
}

function buildNearDupCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const [gMin, gMax] = tier.dupGroupSize;
  const groupSize = r.int(gMin, gMax);
  const mustInclude = drawMustInclude(r, topic, 'near_dup');
  const sharedCluster = randomClusterId(r, tier);
  const dupGroup = helpers.nextDupGroup();
  const distinguisher = r.pick(DISTINGUISHER_PHRASES);
  const targetIdx = r.int(0, groupSize - 1);

  // DESIGN.md 4.1 calls this family "a dup_group of near-identical memories; only
  // one carries the distinguisher the query mentions". A per-member
  // fork made each member draw its own padding sentences, so the members
  // were near-identical in metadata and visibly different in prose -- and
  // the vector lane, which this family exists to break, separated them
  // easily (measured naive recall 1.000 against a projection of 0.50). One
  // shared fork label makes every member render the SAME sentences, so the
  // planted difference really is the only difference.
  const contentIds = [];
  for (let i = 0; i < groupSize; i++) {
    const spec = buildStandaloneMemorySpec(r.fork('member-shared'), topic, tier, {
      cluster_id: sharedCluster,
      mustInclude,
      dup_group: dupGroup,
      distinguisher: i === targetIdx ? distinguisher : null,
    }, helpers);
    contentIds.push(helpers.addMemory(spec));
  }

  const text = `the ${mustInclude.join(' and the ')} with ${distinguisher}`;

  return {
    query: {
      text,
      targetContentIds: [contentIds[targetIdx]],
      distractorContentIds: contentIds.filter((_, i) => i !== targetIdx),
      difficulty: 2,
      declaredFilters: { date_from: null, date_to: null, people: [] },
    },
  };
}

function buildDateFilterCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const mustInclude = drawMustInclude(r, topic, 'date_filter');
  const sharedCluster = randomClusterId(r, tier);
  const sharedPerson = pickPerson(r);
  const sharedPlace = pickPlace(r);
  const groupSize = r.int(4, 6);
  const startYear = r.int(2016, 2023 - groupSize);
  const month = r.int(0, 11);
  const day = r.int(1, 28);

  // The same recurring event across several years (DESIGN.md 4.1): one shared
  // fork label so every year renders identical prose and the date really is
  // the only thing separating them, which is the whole point of the family.
  const contentIds = [];
  const years = [];
  for (let i = 0; i < groupSize; i++) {
    const year = startYear + i;
    years.push(year);
    const occurred_at = new Date(Date.UTC(year, month, day, r.int(8, 21), r.int(0, 59))).toISOString();
    const spec = buildStandaloneMemorySpec(r.fork('member-shared'), topic, tier, {
      person: sharedPerson, place: sharedPlace, occurred_at, cluster_id: sharedCluster, mustInclude,
    }, helpers);
    contentIds.push(helpers.addMemory(spec));
  }

  const targetIdx = r.int(0, groupSize - 1);
  const targetYear = years[targetIdx];
  const templateKind = r.pick(['inMonthYear', 'inYear', 'seasonOfYear']);
  let dateTemplate;
  if (templateKind === 'inMonthYear') {
    dateTemplate = buildDateTemplate('inMonthYear', { year: targetYear, monthIndex0: month });
  } else if (templateKind === 'inYear') {
    dateTemplate = buildDateTemplate('inYear', { year: targetYear });
  } else {
    // "that winter of Y" means the winter that STARTS in Y: Dec Y through Feb
    // Y+1 (lib/lexicon.mjs's seasonRange, matched by engine.mjs's). So a
    // January or February event belongs to the winter of the year before, and
    // naming targetYear puts the target outside the range its own query
    // declares -- which makes every range-filtered lane miss it.
    const season = seasonForMonth(month);
    const seasonYear = season === 'winter' && month <= 1 ? targetYear - 1 : targetYear;
    dateTemplate = buildDateTemplate('seasonOfYear', { season, year: seasonYear });
  }

  const text = `the ${mustInclude.join(' and the ')} ${dateTemplate.text}`;

  return {
    query: {
      text,
      targetContentIds: [contentIds[targetIdx]],
      distractorContentIds: contentIds.filter((_, i) => i !== targetIdx),
      difficulty: 2,
      declaredFilters: { date_from: dateTemplate.range.from, date_to: dateTemplate.range.to, people: [] },
      // Enough to rebuild this query against a DIFFERENT year of the same
      // recurring event post-load: the member's year is read back off its own
      // occurred_at through the memory index.
      dateFilter: { mustInclude, month, templateKind },
    },
  };
}

const VAGUE_FILLER_WORDS = [
  'whichever', 'something', 'somehow', 'thingy', 'business', 'deal',
  'stuff', 'whatnot', 'situation', 'moment',
];

// Every vague word is corpus-wide noise diluting the (detail, noun) pair that
// carries the family's whole signal, so the count is a calibration dial
// (config.corpus.partialRef.vagueWords) rather than a fixed three.
export function renderPartialRefQuery(r, detail, noun) {
  const n = config.corpus.partialRef.vagueWords;
  const vague = r.sample(VAGUE_FILLER_WORDS, Math.max(n, 1));
  if (n <= 0) return `the ${detail} ${noun}`;
  if (n === 1) return `${vague[0]} about the ${detail} ${noun}`;
  if (n === 2) return `${vague[0]} about the ${detail} ${noun} or ${vague[1]}`;
  return `${vague[0]} about the ${detail} ${noun} or ${vague[1]}, ${vague[2]} like that`;
}

function buildPartialRefCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const noun = r.pick(topic.concreteNouns);
  const detail = r.pick(DETAIL_WORDS);
  const spec = buildStandaloneMemorySpec(r, topic, tier, { mustInclude: [noun, detail] }, helpers);
  const targetContentId = helpers.addMemory(spec);

  return {
    query: {
      text: renderPartialRefQuery(r, detail, noun),
      targetContentIds: [targetContentId],
      distractorContentIds: [],
      difficulty: 3,
      declaredFilters: { date_from: null, date_to: null, people: [] },
      partialRef: { detail, noun },
    },
  };
}

// A short query is what makes the trigram lane work: word_similarity divides
// by the query's own trigram count, so every extra clean term the target
// happens to match still costs the corrupted term its share of the score. One
// corrupted term plus at most one clean companion is the shape that keeps the
// target's best extent tight, and the companion is what stops the query from
// being a bare misspelling with no topical anchor at all.
export function renderTypoQuery(r, target, companion, op = null) {
  const corrupted = corruptWord(target, r, op);
  return { text: companion ? `the ${corrupted} and the ${companion}` : `the ${corrupted}`, corrupted };
}

function buildTypoNoisyCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  // The corrupted term is a planted one-off name, not a topic noun. See
  // makeRareWord in lib/lexicon.mjs: a corrupted topic noun is shared by
  // hundreds of memories, so no extent of the target's body scores higher
  // than every other memory containing the same noun, and the trigram lane
  // -- the only lane this family leaves standing -- cannot separate it.
  const target = makeRareWord(r.fork('typo-term'));
  if (target.length < config.corpus.typo.minTermLength) throw new Error(`typo_noisy: planted term "${target}" shorter than ${config.corpus.typo.minTermLength} characters`);
  const companions = topic.concreteNouns.filter((w) => w.length >= config.corpus.typo.minTermLength);
  const companion = companions.length && config.corpus.typo.maxCleanTerms > 0 ? r.pick(companions) : null;
  const spec = buildStandaloneMemorySpec(r, topic, tier, { mustInclude: [target, companion].filter(Boolean) }, helpers);
  const targetContentId = helpers.addMemory(spec);

  const { text } = renderTypoQuery(r, target, companion);

  return {
    query: {
      text,
      targetContentIds: [targetContentId],
      distractorContentIds: [],
      difficulty: 2,
      declaredFilters: { date_from: null, date_to: null, people: [] },
      typo: { term: target, companion },
    },
  };
}

const FAMILY_BUILDERS = {
  paraphrase_nolex: buildParaphraseCase,
  rare_token: buildRareTokenCase,
  entity_swap: buildEntitySwapCase,
  near_dup: buildNearDupCase,
  date_filter: buildDateFilterCase,
  partial_ref: buildPartialRefCase,
  typo_noisy: buildTypoNoisyCase,
};
const FAMILIES = Object.keys(FAMILY_BUILDERS);

function buildMultiTargetCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const k = r.pick([2, 3]);
  // Detail words, not topic nouns: a topic's own concreteNouns pool is only
  // 7 words, and filler memories of the same topic draw repeatedly from
  // that same small pool across several sentences, so a 3-word combination
  // out of a topic's own pool collides with unrelated same-topic filler
  // often enough to rank a target past 10 by coincidence (self-check
  // surfaced this at andRank=11). DETAIL_WORDS is a 40-word pool sampled
  // just twice per memory, so a specific pair is combinatorially far rarer.
  const mustInclude = [r.pick(topic.concreteNouns), ...r.sample(DETAIL_WORDS, 2)];
  const sharedCluster = randomClusterId(r, tier);

  const contentIds = [];
  for (let i = 0; i < k; i++) {
    const memberR = r.fork(`member:${i}`);
    const spec = buildStandaloneMemorySpec(memberR, topic, tier, { mustInclude, cluster_id: sharedCluster }, helpers);
    contentIds.push(helpers.addMemory(spec));
  }

  const text = `the ${mustInclude.join(' and the ')}`;

  return {
    query: {
      text,
      targetContentIds: contentIds,
      distractorContentIds: [],
      difficulty: 2,
      declaredFilters: { date_from: null, date_to: null, people: [] },
    },
  };
}

// ---------------------------------------------------------------------------
// Family mix -> exact integer counts (largest-remainder method, so the
// counts always sum to exactly queriesPerSplit regardless of rounding).
// ---------------------------------------------------------------------------

function familyCounts(total, mix) {
  const families = Object.keys(mix);
  const raw = families.map((f) => total * mix[f]);
  const floors = raw.map(Math.floor);
  const assigned = floors.reduce((a, b) => a + b, 0);
  const remainder = total - assigned;
  const fractional = families
    .map((f, i) => ({ f, frac: raw[i] - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  const counts = Object.fromEntries(families.map((f, i) => [f, floors[i]]));
  for (let k = 0; k < remainder; k++) counts[fractional[k % fractional.length].f]++;
  return counts;
}

function runBuilderWithRetry(builderFn, caseSeed, tier, rootRng, helpers, maxAttempts = 5) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = rootRng.fork(`case:${caseSeed}:attempt:${attempt}`);
    try {
      return builderFn(r, tier, helpers);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`gen-corpus: case "${caseSeed}" failed to construct after ${maxAttempts} attempts: ${lastErr?.message ?? lastErr}`);
}

// ---------------------------------------------------------------------------
// The plan: every memory and every case, deterministically, in one pass.
// Memoized by content (not object identity) so generateMemories(tier) and
// generateQueries(tier, split, index) -- plausibly called with separately
// constructed but equal tier objects -- always agree on the same corpus.
// ---------------------------------------------------------------------------

const planCache = new Map();

function planCacheKey(tier) {
  return JSON.stringify({
    memories: tier.memories,
    seedMemories: tier.seedMemories,
    familyMix: tier.familyMix,
    dupGroupSize: tier.dupGroupSize,
    clusters: tier.clusters,
    vector: tier.vector,
    dims: tier.dims,
    bodyChars: tier.bodyChars,
    queriesPerSplit: tier.queriesPerSplit,
    multiTargetCount: tier.multiTargetCount,
  });
}

function buildPlan(tier) {
  const rootRng = makeRng(`${tier.seedMemories ?? config.corpus.seedMemories}::${tier.name ?? 'adhoc'}::n:${tier.memories}`);
  const memoryPlans = [];
  const cases = [];
  const multiCases = [];
  const usedRareTokens = new Set();
  let dupGroupCounter = 1;

  const helpers = {
    addMemory(spec) {
      const contentId = memoryPlans.length;
      memoryPlans.push(spec);
      return contentId;
    },
    nextRareToken(r) {
      let token;
      let guard = 0;
      do {
        token = makeRareToken(r.fork(`rare-attempt:${guard}`));
        guard++;
      } while (usedRareTokens.has(token) && guard < 50);
      usedRareTokens.add(token);
      return token;
    },
    nextDupGroup() {
      return dupGroupCounter++;
    },
  };

  for (const split of ['dev', 'test']) {
    const counts = familyCounts(tier.queriesPerSplit, tier.familyMix);
    for (const family of FAMILIES) {
      const n = counts[family] ?? 0;
      for (let i = 0; i < n; i++) {
        const caseSeed = `${split}:${family}:${i}`;
        const built = runBuilderWithRetry(FAMILY_BUILDERS[family], caseSeed, tier, rootRng, helpers);
        cases.push({ split, family, ...built.query });
      }
    }
  }

  // dev+test structured content (near_dup and date_filter's group sizes
  // especially) is the headline claim's memory cost and cannot be shrunk
  // silently. config.corpus.multiTargetCount (300) is a single number
  // shared by every tier, though, and at the smoke1k tier (1,000 memories
  // total) 300 cases averaging ~2.5 members each would alone need ~750 of
  // them -- config.mjs does not scale this knob per tier, and DESIGN.md
  // does not say to. Rather than throw on a config combination the design
  // itself did not size for a small tier, multiTargetCount is capped here
  // to whatever fits in the memory budget left after dev+test, and the cap
  // is reported (never silently): queries-multi.jsonl ends up smaller than
  // config.corpus.multiTargetCount at tiers too small to afford it, with
  // the actual count always stated by the CLI / self-check output rather
  // than a fabricated 300.
  const structuredCount = memoryPlans.length;
  const remainingForMulti = tier.memories - structuredCount;
  if (remainingForMulti <= 0) {
    throw new Error(
      `gen-corpus: dev+test structured families for ${tier.queriesPerSplit}x2 queries already need ` +
      `${structuredCount} memories, at or over tier.memories (${tier.memories}); raise tier.memories, or ` +
      `shrink the family mix / dup group size for this tier -- this is the headline claim's own memory cost ` +
      `and is not something this module reduces on its own`,
    );
  }

  let multiBudget = remainingForMulti;
  let multiBuilt = 0;
  for (let i = 0; i < tier.multiTargetCount && multiBudget > 0; i++) {
    const caseSeed = `multi:${i}`;
    const before = memoryPlans.length;
    const built = runBuilderWithRetry(buildMultiTargetCase, caseSeed, tier, rootRng, helpers);
    const used = memoryPlans.length - before;
    if (used > multiBudget) {
      // Undo: this case does not fit. memoryPlans only grows via
      // helpers.addMemory, so the cases just added are always its tail.
      memoryPlans.length = before;
      break;
    }
    multiCases.push({ split: 'multi', family: 'multi_target', ...built.query });
    multiBudget -= used;
    multiBuilt++;
  }
  if (multiBuilt < tier.multiTargetCount) {
    console.warn(
      `gen-corpus: tier "${tier.name ?? '(adhoc)'}" only fit ${multiBuilt}/${tier.multiTargetCount} multi-target cases ` +
      `in its ${tier.memories}-memory budget (${structuredCount} already spent on dev+test); ` +
      `queries-multi.jsonl will report ${multiBuilt}, not config.corpus.multiTargetCount`,
    );
  }

  const fillerRng = rootRng.fork('filler');
  let fillerIndex = 0;
  while (memoryPlans.length < tier.memories) {
    const r = fillerRng.fork(`memory:${fillerIndex}`);
    const topic = topicById(r.int(0, TOPICS.length - 1));
    helpers.addMemory(buildStandaloneMemorySpec(r, topic, tier, {}, helpers));
    fillerIndex++;
  }

  // Deterministic shuffle so structured and filler content interleave --
  // otherwise every AND/OR tie-break (which falls back to id order) would
  // systematically favor whichever kind of memory happened to be planned
  // first.
  const order = rootRng.fork('shuffle-order').shuffle(memoryPlans.map((_, i) => i));
  const contentIdToFinalId = new Map();
  order.forEach((contentId, idx) => contentIdToFinalId.set(contentId, idx + 1));

  const finalMemories = order.map((contentId, idx) => ({ id: idx + 1, ...memoryPlans[contentId] }));
  const remap = (ids) => ids.map((cid) => contentIdToFinalId.get(cid));

  const finalCases = cases.map((c) => ({
    split: c.split,
    family: c.family,
    text: c.text,
    difficulty: c.difficulty,
    declaredFilters: c.declaredFilters,
    targets: remap(c.targetContentIds),
    distractorIds: remap(c.distractorContentIds ?? []),
    // Everything load.mjs --verify-oracle's POST-load repair loop needs to
    // re-verbalize this query WITHOUT touching the memory it points at: by
    // then the memories are already in the database and already embedded, so
    // a repair that regenerated the target would invalidate the corpus.
    // repairAnchors below runs PRE-load, while the corpus is still plain
    // objects in memory, so it is the one place a doomed target's content is
    // allowed to change (DESIGN.md 4.3.1's text-only boundary is about the
    // post-load loop specifically, not this one).
    regen: c.frame ? { frame: c.frame }
      : c.typo ? { typo: c.typo }
      : c.partialRef ? { partialRef: c.partialRef }
      : c.entitySwap ? { entitySwap: c.entitySwap }
      : c.dateFilter ? { dateFilter: c.dateFilter }
      : null,
  }));
  const finalMultiCases = multiCases.map((c) => ({
    split: c.split,
    family: c.family,
    text: c.text,
    difficulty: c.difficulty,
    declaredFilters: c.declaredFilters,
    targets: remap(c.targetContentIds),
    distractorIds: [],
  }));

  // Repairs finalMemories / finalCases in place -- see repairAnchors' own
  // comment for why this has to run here (once, both splits together,
  // before any caller sees the plan) rather than inside generateQueries.
  const repairStats = repairAnchors(tier, finalMemories, finalCases);

  return { tier, memories: finalMemories, cases: finalCases, multiCases: finalMultiCases, repairStats };
}

// ---------------------------------------------------------------------------
// Anchor resampling (calibration decision, 2026-08-23): at 50K, a handful of
// partial_ref and typo_noisy queries fail the offline certificate even after
// every re-verbalize round, because re-verbalizing only rephrases the query
// around content the target memory ALREADY carries -- for partial_ref that is
// whichever (detail, noun) pair happens to already sit in the target's body
// (reverbalizeQuery searches at most its 12 rarest words), and for typo_noisy
// it is the same planted word under a different corruption. Neither can fix a
// target whose planted anchor was doomed from the start.
//
// These two functions instead draw a BRAND NEW candidate anchor -- a fresh
// (topic, noun, detail) triple, or a fresh rare word -- from a forked
// sub-stream, and verify it against the real, already-built corpus index
// BEFORE it is ever planted: partial_ref checks the exact co-occurrence count
// certifyQuery itself will measure, typo_noisy checks the exact trigram
// ceiling. So certification here CONFIRMS a candidate rather than discovering
// a failure after the fact (evaluator's calibration item 2). Bounded by
// config.oracle.anchorResampleAttempts, deterministic, called only from
// repairAnchors below, and never touching thresholds or familyMix.
// ---------------------------------------------------------------------------

function coOccurrenceCount(index, wordA, wordB) {
  const pa = index.postings.get(approxStem(wordA));
  const pb = index.postings.get(approxStem(wordB));
  if (!pa || !pb) return 0;
  let co = 0;
  for (const id of pa) if (pb.has(id)) co++;
  return co;
}

function resamplePartialRefAnchor(q, index, tier) {
  const r = makeRng(`${config.oracle.repairSeed}::anchor::${tier.name ?? 'adhoc'}::${q.qid}`);
  for (let attempt = 0; attempt < config.oracle.anchorResampleAttempts; attempt++) {
    const ar = r.fork(`attempt:${attempt}`);
    const topic = topicById(ar.int(0, TOPICS.length - 1));
    const noun = ar.pick(topic.concreteNouns);
    const detail = ar.pick(DETAIL_WORDS);
    // Verify BEFORE planting: this IS the OR-lane ceiling certifyQuery will
    // measure (DESIGN.md 4.2 rule 2), computed against the corpus that
    // already exists rather than guessed at.
    if (coOccurrenceCount(index, detail, noun) > config.corpus.partialRef.maxPairCoOccurrence) continue;
    const spec = buildStandaloneMemorySpec(ar.fork('spec'), topic, tier, { mustInclude: [noun, detail] });
    const text = renderPartialRefQuery(ar.fork('render'), detail, noun);
    return { spec, text, meta: { detail, noun }, attempt };
  }
  return null;
}

function resampleTypoNoisyAnchor(q, index, tier) {
  const r = makeRng(`${config.oracle.repairSeed}::anchor::${tier.name ?? 'adhoc'}::${q.qid}`);
  for (let attempt = 0; attempt < config.oracle.anchorResampleAttempts; attempt++) {
    const ar = r.fork(`attempt:${attempt}`);
    const topic = topicById(ar.int(0, TOPICS.length - 1));
    const word = makeRareWord(ar.fork('typo-term'));
    if (word.length < config.corpus.typo.minTermLength) continue;
    // Global uniqueness, verified rather than assumed: makeRareWord draws
    // from a small phonetic alphabet that can and does repeat at 50K density,
    // and a token already sitting elsewhere in the corpus does not
    // distinguish the target (DESIGN.md 4.2 rule 1).
    if (index.postings.has(approxStem(word))) continue;
    const companions = topic.concreteNouns.filter((w) => w.length >= config.corpus.typo.minTermLength);
    const companion = companions.length && config.corpus.typo.maxCleanTerms > 0 ? ar.pick(companions) : null;
    const spec = buildStandaloneMemorySpec(ar.fork('spec'), topic, tier, { mustInclude: [word, companion].filter(Boolean) });
    const { text } = renderTypoQuery(ar.fork('render'), word, companion);
    // Verify BEFORE planting: the exact trigram-ceiling function the
    // certificate uses, scored against the candidate's own would-be content
    // and the rest of the already-built corpus (targetId is excluded from
    // the ceiling regardless of what content currently sits under it).
    const ceiling = trigramLaneCeiling(text, index, q.targets[0], config.lanes.trigramThreshold, `${spec.title} ${spec.body}`);
    if (ceiling == null || ceiling > config.oracle.bestLaneRankAt) continue;
    return { spec, text, meta: { term: word, companion }, attempt };
  }
  return null;
}

// Mutates memoryId's content in place (Object.assign onto the existing
// object, never a replacement object) because finalMemories, index.byId, and
// any query that already targets this id all hold the SAME reference; a
// spread-into-a-new-object would desync them silently. Keeps
// index.postings / index.df / index.trigramPostings / index.dupGroups
// consistent with the new content so a certifyQuery call made against this
// index immediately afterward measures the corpus that was actually planted.
function replaceMemoryContent(index, memoryId, newFields) {
  const target = index.byId.get(memoryId);
  if (!target) throw new Error(`replaceMemoryContent: memory ${memoryId} not found in index`);
  const oldStems = new Set(tokenizeStem(`${target.title} ${target.raw} ${target.body}`));
  const oldTrigrams = index.trigramPostings ? charTrigrams(`${target.title} ${target.body}`) : null;
  const oldDupGroup = target.dup_group;

  Object.assign(target, newFields);

  const newStems = new Set(tokenizeStem(`${target.title} ${target.raw} ${target.body}`));
  for (const stem of oldStems) {
    if (newStems.has(stem)) continue;
    const bucket = index.postings.get(stem);
    if (bucket) { bucket.delete(memoryId); if (bucket.size === 0) index.postings.delete(stem); }
    const df = index.df.get(stem);
    if (df != null) { if (df <= 1) index.df.delete(stem); else index.df.set(stem, df - 1); }
  }
  for (const stem of newStems) {
    if (oldStems.has(stem)) continue;
    if (!index.postings.has(stem)) index.postings.set(stem, new Set());
    index.postings.get(stem).add(memoryId);
    index.df.set(stem, (index.df.get(stem) ?? 0) + 1);
  }

  if (index.trigramPostings) {
    const newTrigrams = charTrigrams(`${target.title} ${target.body}`);
    for (const g of oldTrigrams) {
      if (newTrigrams.has(g)) continue;
      const bucket = index.trigramPostings.get(g);
      if (bucket) {
        const i = bucket.indexOf(memoryId);
        if (i !== -1) bucket.splice(i, 1);
        if (bucket.length === 0) index.trigramPostings.delete(g);
      }
    }
    for (const g of newTrigrams) {
      if (oldTrigrams.has(g)) continue;
      let bucket = index.trigramPostings.get(g);
      if (!bucket) { bucket = []; index.trigramPostings.set(g, bucket); }
      bucket.push(memoryId);
    }
  }

  if (oldDupGroup !== target.dup_group) {
    if (oldDupGroup != null) {
      const arr = index.dupGroups.get(oldDupGroup);
      if (arr) index.dupGroups.set(oldDupGroup, arr.filter((id) => id !== memoryId));
    }
    if (target.dup_group != null) {
      if (!index.dupGroups.has(target.dup_group)) index.dupGroups.set(target.dup_group, []);
      index.dupGroups.get(target.dup_group).push(memoryId);
    }
  }

  return target;
}

// Runs once per plan, over dev+test cases TOGETHER in a fixed order, before
// any caller (generateMemories, generateQueries for either split, in either
// order) ever sees the memories -- so "gen-corpus --split test" alone and
// "--split both" repair the exact same failures the exact same way, and
// memories.jsonl is never written with content a later call would still
// change (DESIGN.md section 1: "same seeds in, same corpus out"). Mutates
// finalMemories / finalCases in place; returns stats for the CLI to report.
function repairAnchors(tier, finalMemories, finalCases) {
  const index = buildMemoryIndex(finalMemories);
  const stats = { reverbalized: [], anchorResampled: [], failures: [] };

  // qid mirrors finalizeQuery's own scheme exactly, so reverbalizeQuery's
  // existing seed (keyed by qid) draws identically to what generateQueries
  // used to produce before repair moved here: no seed shift for the existing
  // mechanism, only a new fork label (above) for the new one.
  const splitCounters = {};
  const qidByCase = new Map();
  for (const c of finalCases) {
    splitCounters[c.split] = (splitCounters[c.split] ?? 0) + 1;
    qidByCase.set(c, `${c.split}-${String(splitCounters[c.split]).padStart(6, '0')}`);
  }

  // Patching a memory's content can shift ANOTHER query's AND/OR ceiling by
  // +/-1, but only for a query whose own stems intersect a stem the patch
  // added or removed -- that is the only way a postings count the
  // certificate reads can change. Tracking that touched-stem set is what
  // lets the second pass below re-check exactly the queries a patch could
  // have affected, instead of re-running the full certify pass (every
  // query's trigram-lane ceiling is O(corpus) at the real-vector tiers) a
  // second and third time over all 2,000 queries for a handful of patches.
  const touchedStems = new Set();

  // Stores the final certificate on `c` either way, so generateQueries can
  // reuse it instead of re-certifying (see generateQueries's own comment).
  function checkAndRepair(c) {
    const qid = qidByCase.get(c);
    const checkObj = {
      qid, family: c.family, text: c.text, targets: c.targets,
      diagnostics: { distractor_ids: c.distractorIds ?? [], regen: c.regen },
    };
    let certificate = certifyQuery(checkObj, index, tier);
    if (certificate.solvable) { c.certificate = certificate; return true; }

    let fixed = false;
    for (let round = 1; round <= config.oracle.repairRounds && !fixed; round++) {
      const text = reverbalizeQuery(checkObj, index, tier, round);
      if (!text) break;
      checkObj.text = text;
      certificate = certifyQuery(checkObj, index, tier);
      if (certificate.solvable) {
        c.text = text;
        stats.reverbalized.push(qid);
        fixed = true;
      }
    }

    if (!fixed && (c.family === 'partial_ref' || c.family === 'typo_noisy')) {
      const resampled = c.family === 'partial_ref'
        ? resamplePartialRefAnchor(checkObj, index, tier)
        : resampleTypoNoisyAnchor(checkObj, index, tier);
      if (resampled) {
        const targetId = checkObj.targets[0];
        const before = index.byId.get(targetId);
        const oldStems = new Set(tokenizeStem(`${before.title} ${before.raw} ${before.body}`));
        replaceMemoryContent(index, targetId, resampled.spec);
        const after = index.byId.get(targetId);
        const newStems = new Set(tokenizeStem(`${after.title} ${after.raw} ${after.body}`));
        // A stem's posting count moving by 1 can only flip a ceiling that
        // currently sits within a few of the gate -- for a stem that already
        // sits in hundreds of documents (most of a body's ordinary filler
        // vocabulary), +/-1 changes nothing a threshold of 10 will ever see.
        // Filtering to low-df stems keeps pass 2 targeted at the handful of
        // OTHER queries a patch could plausibly have affected, instead of
        // re-certifying (O(corpus) trigram lane included) most of the split
        // just because a patch's filler sentences happened to share common
        // words with them.
        const DF_RISK_CEILING = 500;
        for (const s of oldStems) {
          if (newStems.has(s)) continue;
          if ((index.df.get(s) ?? 0) <= DF_RISK_CEILING) touchedStems.add(s);
        }
        for (const s of newStems) {
          if (oldStems.has(s)) continue;
          if ((index.df.get(s) ?? 0) <= DF_RISK_CEILING) touchedStems.add(s);
        }

        c.text = resampled.text;
        c.regen = c.family === 'typo_noisy' ? { typo: resampled.meta } : { partialRef: resampled.meta };
        c.anchor_resample_attempts = resampled.attempt + 1;
        checkObj.text = resampled.text;
        certificate = certifyQuery(checkObj, index, tier);
        if (certificate.solvable) {
          fixed = true;
          stats.anchorResampled.push({ qid, family: c.family, attempts: resampled.attempt + 1 });
        }
      }
    }

    c.certificate = certificate;
    return fixed;
  }

  // Pass 1: the one unavoidable full certify pass -- same total work the old
  // per-split generateQueries calls already did, just done once instead of
  // once per split. Repairs whatever fails on first measurement.
  const failing = new Set();
  for (const c of finalCases) {
    if (!checkAndRepair(c)) failing.add(c);
  }

  // Pass 2: targeted, not another full sweep. Only cases whose own stems
  // overlap something pass 1's patches touched could have flipped from
  // solvable to not; re-measure exactly those (a small set in practice --
  // partial_ref's fresh (detail, noun) pairs draw from shared pools,
  // typo_noisy's fresh rare word never collides with anything real by
  // construction) and repair anything that did flip.
  if (touchedStems.size > 0) {
    for (const c of finalCases) {
      if (failing.has(c) || !c.certificate.solvable) continue;
      const stems = tokenizeStem(c.text);
      if (!stems.some((s) => touchedStems.has(s))) continue;
      if (!checkAndRepair(c)) failing.add(c);
    }
  }

  stats.failures = [...failing].map((c) => ({
    qid: qidByCase.get(c), family: c.family, text: c.text, certificate: c.certificate,
  }));
  if (stats.failures.length === 0) return stats;

  const byFamily = {};
  for (const f of stats.failures) byFamily[f.family] = (byFamily[f.family] ?? 0) + 1;
  const message =
    `gen-corpus: ${stats.failures.length} queries failed the offline solvability certificate after ` +
    `re-verbalize (${config.oracle.repairRounds} rounds) and anchor resampling (${config.oracle.anchorResampleAttempts} attempts) ` +
    `(DESIGN.md 4.2). By family: ${JSON.stringify(byFamily)}. First failures: ${JSON.stringify(stats.failures.slice(0, 5))}`;

  // Synthetic (scale) tiers do not throw here (rung-3 finding, 2026-08-23,
  // found generating rehearsal1m for the first time): certifyQuery's
  // trigram-lane ceiling is tier-blind, but DESIGN.md 6.2 says the scale
  // tiers have no trigram index and no trigram lane at all, and 8.3 already
  // documents the consequence in plain words -- "typo_noisy queries still
  // run, they just have no trigram lane to fall into at this tier". A
  // family whose only planted solving mechanism is a lane that structurally
  // does not exist at this tier is not a generator bug, and section 7's
  // rung 3/4 gates never include a solvability-certificate gate (only the
  // real-vector tiers, smoke1k and quality50k, carry the 4.3 oracle gate
  // this throw exists to protect). Real-vector tiers keep the hard throw
  // unchanged, since that is what 4.2 and the claim-A freeze process (4.4)
  // actually depend on.
  if (tier.vector === 'synthetic') {
    console.warn(message);
    console.warn('gen-corpus: not throwing (synthetic tier: no oracle-solvability gate applies, DESIGN.md section 7)');
    return stats;
  }
  throw new Error(message);
}

function getPlan(tier) {
  const key = planCacheKey(tier);
  if (!planCache.has(key)) planCache.set(key, buildPlan(tier));
  return planCache.get(key);
}

// Generation-time retry statistics (evaluator's report requirement): how many
// queries needed re-verbalization vs. full anchor resampling, and how many
// resample attempts each one took. Empty arrays mean the corpus certified
// clean on the first pass.
export function getRepairStats(tier) {
  return getPlan(tier).repairStats;
}

// ---------------------------------------------------------------------------
// Exported generation API (DESIGN.md 3.6)
// ---------------------------------------------------------------------------

export function* generateMemories(tier) {
  const plan = getPlan(tier);
  for (const m of plan.memories) yield m;
}

function finalizeQuery(caseObj, indexInSplit) {
  const qid = `${caseObj.split}-${String(indexInSplit).padStart(6, '0')}`;
  return {
    qid,
    split: caseObj.split,
    family: caseObj.family,
    text: caseObj.text,
    targets: caseObj.targets,
    declared_filters: caseObj.declaredFilters,
    certificate: null,
    diagnostics: {
      distractor_ids: caseObj.distractorIds ?? [],
      difficulty: caseObj.difficulty,
      regen: caseObj.regen ?? null,
      repair_round: 0,
      // Set by repairAnchors (pre-load, buildPlan) when re-verbalizing alone
      // could not clear the certificate and the underlying memory's planted
      // anchor had to be resampled instead. 0 means the first draft (or a
      // plain re-verbalize) already certified solvable.
      anchor_resample_attempts: caseObj.anchor_resample_attempts ?? 0,
    },
  };
}

// MemoryIndex ("vocab"): the corpus-wide structure this module's own
// certification (certifyQuery/oracleCeiling) uses, AND -- since
// bench-recall.mjs (a landed sibling file) already imports buildMemoryIndex
// and passes its return value straight through as engine.mjs's
// parseQueryFeatures "vocab" argument -- the shape this function returns IS
// the vocab contract for Track 3's engine.mjs, not just an internal detail.
// DESIGN.md names buildMemoryIndex's existence (3.6) but not this shape.
//
// { totalDocs, df } deliberately matches the shape bench-load.mjs (also
// landed) already committed to independently for its own ts_stat()-based
// vocab builder, so engine.mjs can treat both sources the same way.
export function buildMemoryIndex(memories) {
  const df = new Map();
  const postings = new Map();
  // people/places: Map<slug, string[]> (alias forms), not a flat Set --
  // this is the shape engine.mjs (a landed sibling file) already committed
  // to for its own regex-based entity extraction (extractOneKind's
  // entriesOf/aliases-array walk). A flat Set of slugs would silently
  // extract zero entities, since Set has no `.entries()` shape matching
  // what that code expects.
  const people = new Map();
  const places = new Map();
  const tags = new Set();
  const byId = new Map();
  const dupGroups = new Map();

  for (const m of memories) {
    byId.set(m.id, m);
    for (const p of m.people) {
      if (!people.has(p)) {
        const entry = PEOPLE_BY_SLUG.get(p);
        people.set(p, entry ? entityAliases(entry) : [p]);
      }
    }
    for (const pl of m.places) {
      if (!places.has(pl)) {
        const entry = PLACES_BY_SLUG.get(pl);
        places.set(pl, entry ? entityAliases(entry) : [pl]);
      }
    }
    for (const t of m.tags) tags.add(t);
    if (m.dup_group != null) {
      if (!dupGroups.has(m.dup_group)) dupGroups.set(m.dup_group, []);
      dupGroups.get(m.dup_group).push(m.id);
    }
    const stems = new Set(tokenizeStem(`${m.title} ${m.raw} ${m.body}`));
    for (const stem of stems) {
      if (!postings.has(stem)) postings.set(stem, new Set());
      postings.get(stem).add(m.id);
      df.set(stem, (df.get(stem) ?? 0) + 1);
    }
  }

  return { totalDocs: memories.length, df, postings, people, places, tags, byId, dupGroups, stem: approxStem };
}

// ---------------------------------------------------------------------------
// Brute-force lane ranks, used only by certification (never by any bench
// script -- engine.mjs owns the real SQL lanes). AND/OR use the postings
// index so they cost roughly O(matching docs), not O(corpus); trigram and
// vector are true O(corpus) scans, so certifyQuery only pays for them when
// the cheap lanes did not already clear the bar.
// ---------------------------------------------------------------------------

// Every lexical bound below returns a RANK CEILING, not a rank: the largest
// position the target can occupy in that lane under any tie-break Postgres
// might apply. That is what makes the offline certificate a true statement
// about the lane rather than a guess about ts_rank_cd -- if the ceiling is
// <= 10 then the target IS top-10, whatever the ranking function does inside
// the candidate set. The previous implementation guessed the ordering
// (id-ascending for AND, match-count for OR) and could not be sound.
//
// null means the lane does not hold the target at all.

function andLaneCeiling(queryStems, index, targetId) {
  const uniqueStems = [...new Set(queryStems)];
  if (uniqueStems.length === 0) return null;
  let inter = null;
  for (const s of uniqueStems) {
    const ids = index.postings.get(s);
    if (!ids || ids.size === 0) return null; // a required term with zero postings -> AND lane is empty
    inter = inter === null ? new Set(ids) : new Set([...inter].filter((id) => ids.has(id)));
    if (inter.size === 0) return null;
  }
  if (!inter.has(targetId)) return null;
  return inter.size;
}

function orLaneCeiling(queryStems, index, targetId, fragmentBar) {
  const uniqueStems = [...new Set(queryStems)];
  if (uniqueStems.length === 0) return null;
  const bar = Math.min(fragmentBar, uniqueStems.length);
  const counts = new Map();
  for (const s of uniqueStems) {
    const ids = index.postings.get(s);
    if (!ids) continue;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const targetCount = counts.get(targetId) ?? 0;
  if (targetCount < bar) return null;
  // Only a row matching at least as many of the query's lexemes can outrank
  // the target under ts_rank_cd's coverage-density score; rows matching
  // strictly fewer cannot. Counting those is a sound ceiling.
  let couldOutrank = 0;
  for (const [id, c] of counts) {
    if (id !== targetId && c >= bar && c >= targetCount) couldOutrank++;
  }
  return couldOutrank + 1;
}

// Lazily built and cached on the index: trigram -> ids of documents whose
// `title || ' ' || body` (the exact expression engine.mjs's trigram lane
// scores) contains it. Only paid for when a query actually needs the lane.
function trigramPostings(index) {
  if (index.trigramPostings) return index.trigramPostings;
  const postings = new Map();
  for (const [id, m] of index.byId) {
    for (const g of charTrigrams(`${m.title} ${m.body}`)) {
      let bucket = postings.get(g);
      if (!bucket) { bucket = []; postings.set(g, bucket); }
      bucket.push(id);
    }
  }
  index.trigramPostings = postings;
  return postings;
}

// targetTextOverride lets a caller ask "what would this lane's ceiling be if
// targetId's content were REPLACED by this text?" without mutating the index
// first -- everything past the targetLower check already excludes targetId
// from the shortlist/count, so the rest of the corpus's postings are still
// the right thing to check a hypothetical replacement against. This is what
// makes anchor resampling (below) a verify-before-plant check rather than a
// guess: the candidate is scored against the real, already-built corpus.
function trigramLaneCeiling(queryText, index, targetId, threshold, targetTextOverride = null) {
  const target = index.byId.get(targetId);
  const A = charTrigrams(queryText);
  if (A.size === 0) return null;
  const targetText = targetTextOverride ?? `${target.title} ${target.body}`;
  const targetLower = wordSimilarityLowerBound(queryText, targetText);
  if (targetLower < threshold) return null;

  const postings = trigramPostings(index);
  const hits = new Map();
  for (const g of A) {
    const bucket = postings.get(g);
    if (!bucket) continue;
    for (const id of bucket) hits.set(id, (hits.get(id) ?? 0) + 1);
  }
  const bar = Math.max(threshold, targetLower);
  const shortlist = [];
  for (const [id, c] of hits) {
    if (id === targetId) continue;
    if (wordSimilarityContainmentBound(A.size, c) >= bar) shortlist.push(id);
  }
  // Escape hatch, deliberately conservative: if the cheap prefilter did not
  // narrow the field, report the shortlist size itself as the ceiling rather
  // than paying a window scan per document. A query that lands here is one
  // whose trigrams the whole corpus shares, which is not a query this lane
  // was going to rank anyway.
  if (shortlist.length > TRIGRAM_WINDOW_SCAN_LIMIT) return shortlist.length + 1;

  let couldOutrank = 0;
  for (const id of shortlist) {
    const m = index.byId.get(id);
    if (wordSimilarityBounds(queryText, `${m.title} ${m.body}`).upper >= bar) couldOutrank++;
  }
  return couldOutrank + 1;
}

const TRIGRAM_WINDOW_SCAN_LIMIT = 2000;

// The vector lane is deliberately absent. At the real-vector tiers the
// embeddings do not exist until load.mjs has run, and the synthetic proxy
// this function used to consult is not the vector the engine searches: under
// the real embedder the proxy-certified paraphrase queries ranked their
// targets ~500th while the certificate claimed rank 1. Certifying the vector
// lane is now load.mjs --verify-oracle's job, against the loaded corpus with
// exact cosine in SQL (DESIGN.md section 4, post-load verification note).
function computeLaneCeilings(q, index, tier) {
  const targetId = q.targets[0];
  const rawStems = tokenizeStem(q.text);
  const fragmentBar = Math.min(2, new Set(rawStems).size);
  return {
    and: andLaneCeiling(rawStems, index, targetId),
    or: orLaneCeiling(rawStems, index, targetId, fragmentBar),
    // Trigram lane is quality-tier only (DESIGN.md 6.2): the scale tier has
    // no trigram index at all, so certifying against it there would credit a
    // lane the real engine never runs.
    trigram: tier.vector === 'real'
      ? trigramLaneCeiling(q.text, index, targetId, config.lanes.trigramThreshold)
      : null,
  };
}

// Shared by certifyQuery and oracleCeiling so a query is only brute-forced
// once even when both the certificate and the depth-reachability diagnostic
// are needed.
// paraphrase_nolex is the one family whose designated solving lane is the
// vector lane (DESIGN.md 4.1), which cannot be certified without the loaded
// corpus. Its offline verdict is therefore "pending", not "solvable": the
// number that reaches oracle.json comes from load.mjs --verify-oracle.
const VECTOR_ONLY_FAMILIES = new Set(['paraphrase_nolex']);

function computeCertificateAndReach(q, index, tier) {
  const targetId = q.targets[0];
  const target = index.byId.get(targetId);
  if (!target) throw new Error(`certifyQuery: target id ${targetId} not found in index (qid=${q.qid ?? '?'})`);

  const rawStems = tokenizeStem(q.text);
  const targetStems = new Set(tokenizeStem(`${target.title} ${target.raw} ${target.body}`));
  const queryStemSet = new Set(rawStems);
  const overlap = [...queryStemSet].filter((s) => targetStems.has(s)).length;
  const union = new Set([...queryStemSet, ...targetStems]).size;
  const lexicalOverlap = union === 0 ? 0 : overlap / union;

  const ceilings = computeLaneCeilings(q, index, tier);
  const k = config.oracle.bestLaneRankAt;
  const signals = [];
  for (const lane of ['and', 'or', 'trigram']) {
    if (ceilings[lane] != null && ceilings[lane] <= k) signals.push(lane);
  }
  const reachableAtDepth = Object.values(ceilings).some((c) => c != null && c <= tier.laneDepth);
  const pendingLanes = VECTOR_ONLY_FAMILIES.has(q.family) || signals.length === 0 ? ['vector'] : [];

  const dupGroup = target.dup_group;
  const dupSiblings = dupGroup != null ? Math.max(0, (index.dupGroups.get(dupGroup)?.length ?? 1) - 1) : 0;
  const plantedDistractors = q.diagnostics?.distractor_ids?.length ?? 0;

  let solvable = signals.length > 0 || pendingLanes.length > 0;
  // Certificate rule 4 (DESIGN.md 4.2): paraphrase_nolex's entire claim is
  // zero lexical overlap with the target. Nonzero overlap means the family is
  // not testing what its name says, and no lane result overrides that.
  if (q.family === 'paraphrase_nolex' && lexicalOverlap !== 0) solvable = false;
  // A partial_ref query whose (detail, noun) pair is shared by more documents
  // than the OR lane can rank is unsolvable rather than hard: the vague
  // filler words carry no postings, so nothing else can separate it.
  if (q.family === 'partial_ref' && (ceilings.or == null || ceilings.or > config.corpus.partialRef.maxPairCoOccurrence)) solvable = false;
  // typo_noisy leaves only the trigram lane standing (AND is empty, and the
  // OR fragment bar rejects a row matching one clean term out of two).
  if (q.family === 'typo_noisy' && !signals.includes('trigram')) solvable = false;

  return {
    certificate: {
      solvable,
      signals,
      // Set to a measured lane list by load.mjs --verify-oracle. Offline this
      // is honestly "not yet known", never a proxy-vector guess.
      pending_lanes: pendingLanes,
      vector_verified: false,
      lane_ceilings: ceilings,
      dup_siblings: dupSiblings,
      planted_distractors: plantedDistractors,
      lexical_overlap: Number(lexicalOverlap.toFixed(4)),
    },
    reachableAtDepth,
  };
}

export function certifyQuery(q, index, tier) {
  return computeCertificateAndReach(q, index, tier).certificate;
}

// ---------------------------------------------------------------------------
// Re-verbalization: a NEW query text for the SAME target, from a fresh seeded
// sub-stream. Used twice -- by generateQueries when the offline certificate
// rejects a first draft, and by load.mjs --verify-oracle's repair loop when
// the post-load measurement rejects one. The second caller is why this never
// touches the memory: by then the corpus is loaded and embedded, so a repair
// that regenerated the target would invalidate everything downstream of it.
// ---------------------------------------------------------------------------

function contentWordsOf(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => !STOPWORDS.has(w) && w.length > 1);
}

// Rarest first: a term the whole corpus shares cannot separate the target
// from anything, and both typo_noisy and partial_ref are ranked by exactly
// the terms the query keeps.
function rareContentWords(memory, index, minLength = 1) {
  const seen = new Set();
  const words = [];
  for (const w of contentWordsOf(`${memory.title} ${memory.body}`)) {
    if (w.length < minLength || seen.has(w)) continue;
    seen.add(w);
    words.push({ word: w, df: index.df.get(approxStem(w)) ?? index.totalDocs });
  }
  words.sort((a, b) => a.df - b.df || (a.word < b.word ? -1 : 1));
  return words;
}

export function reverbalizeQuery(q, index, tier, round) {
  const r = makeRng(`${config.oracle.repairSeed}::${tier.name ?? 'adhoc'}::${q.qid}::round:${round}`);
  const target = index.byId.get(q.targets[0]);
  if (!target) throw new Error(`reverbalizeQuery: target ${q.targets[0]} missing from index (qid=${q.qid})`);

  if (q.family === 'paraphrase_nolex') {
    const frame = q.diagnostics?.regen?.frame;
    if (!frame) return null;
    const present = new Set(frame.present ?? ['action', 'prop', 'mishap', 'time']);
    for (let attempt = 0; attempt < 8; attempt++) {
      const drawn = renderParaphraseQuery(r.fork(`attempt:${attempt}`), frame, present);
      if (paraphraseOverlapStems(drawn.text, target).length === 0 && drawn.text !== q.text) return drawn.text;
    }
    return null;
  }

  if (q.family === 'typo_noisy') {
    // word_similarity scores the best CONTIGUOUS word-aligned extent of the
    // body, so the two terms the query keeps have to be adjacent in the body
    // or no single extent covers both and the lane's score collapses. The
    // planted pair is adjacent by construction ("It centered on the X and the
    // Y"), so repair varies the corruption and drops the companion rather
    // than reaching for two arbitrary rare words from opposite ends of the
    // body -- which is what an earlier version did, and why it could not
    // converge.
    const planted = q.diagnostics?.regen?.typo;
    if (!planted?.term) return null;
    const variants = [
      { term: planted.term, companion: planted.companion, op: 'swap' },
      { term: planted.term, companion: planted.companion, op: 'drop' },
      { term: planted.term, companion: null, op: 'drop' },
      { term: planted.term, companion: null, op: 'swap' },
    ];
    for (let attempt = 0; attempt < variants.length * 3; attempt++) {
      const v = variants[attempt % variants.length];
      const { text } = renderTypoQuery(r.fork(`attempt:${attempt}`), v.term, v.companion, v.op);
      if (text !== q.text) return text;
    }
    return null;
  }

  if (q.family === 'partial_ref') {
    // Pick the (detail, noun) pair present in the target that co-occurs in the
    // fewest documents: that pair IS the OR lane's whole ranking signal, so
    // minimizing its co-occurrence is exactly minimizing the lane's ceiling.
    const words = rareContentWords(target, index).slice(0, 12);
    const details = words.filter((w) => DETAIL_WORDS.includes(w.word));
    const nouns = words.filter((w) => !DETAIL_WORDS.includes(w.word));
    if (details.length === 0 || nouns.length === 0) return null;
    let best = null;
    for (const d of details) {
      for (const n of nouns) {
        const dp = index.postings.get(approxStem(d.word));
        const np = index.postings.get(approxStem(n.word));
        if (!dp || !np) continue;
        let co = 0;
        for (const id of dp) if (np.has(id)) co++;
        if (best === null || co < best.co) best = { detail: d.word, noun: n.word, co };
      }
    }
    if (!best) return null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const text = renderPartialRefQuery(r.fork(`attempt:${attempt}`), best.detail, best.noun);
      if (text !== q.text) return text;
    }
    return null;
  }

  return null;
}

// Re-targeting: the escalation above re-verbalizing (DESIGN.md 4.3.1's repair
// loop, evaluator calibration decision 2, 2026-08-24).
//
// Re-verbalizing only rephrases a query around the SAME target, so a query
// whose target is unreachable however it is worded cannot converge -- measured
// at 50K, re-verbalize left 54 paraphrase_nolex and 8 entity_swap queries
// still failing after every round. Re-targeting instead picks a DIFFERENT
// memory for the query to be about and regenerates the query against it, from
// a forked seeded sub-stream so the choice is reproducible.
//
// The post-load boundary still holds: this changes the QUERY (its text, its
// target, its declared filters), never a memory. Memories are already embedded
// and in the database by the time this runs.
//
// `attempt` selects deterministically from a shuffled candidate list, so
// attempt 0..n-1 walk distinct candidates rather than re-drawing the same one.
// Returns null when the family has no honest re-target (near_dup's
// distinguisher sits in the target's body, so re-targeting it would mean
// rewriting a memory) or when no candidate is left.
export function retargetQuery(q, index, tier, attempt, opts = {}) {
  const r = makeRng(`${config.oracle.repairSeed}::retarget::${tier.name ?? 'adhoc'}::${q.qid}::attempt:${attempt}`);
  const pickNth = (list) => (list.length === 0 ? null : r.shuffle([...list])[attempt % list.length]);

  if (q.family === 'entity_swap') {
    const planted = q.diagnostics?.regen?.entitySwap;
    if (!planted) return null;
    const candidate = pickNth(q.diagnostics.distractor_ids ?? []);
    if (candidate == null) return null;
    const member = index.byId.get(candidate);
    if (!member) return null;
    const slug = planted.swapPeople ? member.people[0] : member.places[0];
    const entry = (planted.swapPeople ? PEOPLE_BY_SLUG : PLACES_BY_SLUG).get(slug);
    if (!entry) return null;
    return {
      text: `the ${planted.mustInclude.join(' and the ')} with ${entry.name.toLowerCase()}`,
      target: candidate,
      declaredFilters: { date_from: null, date_to: null, people: planted.swapPeople ? [slug] : [] },
    };
  }

  if (q.family === 'date_filter') {
    const planted = q.diagnostics?.regen?.dateFilter;
    if (!planted) return null;
    const candidate = pickNth(q.diagnostics.distractor_ids ?? []);
    if (candidate == null) return null;
    const member = index.byId.get(candidate);
    if (!member) return null;
    const year = new Date(member.occurred_at).getUTCFullYear();
    const { month, templateKind, mustInclude } = planted;
    let tpl;
    if (templateKind === 'inMonthYear') tpl = buildDateTemplate('inMonthYear', { year, monthIndex0: month });
    else if (templateKind === 'inYear') tpl = buildDateTemplate('inYear', { year });
    else {
      const season = seasonForMonth(month);
      const seasonYear = season === 'winter' && month <= 1 ? year - 1 : year;
      tpl = buildDateTemplate('seasonOfYear', { season, year: seasonYear });
    }
    return {
      text: `the ${mustInclude.join(' and the ')} ${tpl.text}`,
      target: candidate,
      declaredFilters: { date_from: tpl.range.from, date_to: tpl.range.to, people: [] },
    };
  }

  if (q.family === 'paraphrase_nolex') {
    // This family plants one memory per query, so there is no confusion set to
    // move inside. The candidate pool is instead other paraphrase_nolex
    // targets whose OWN query the oracle already reaches -- a memory a
    // paraphrase query of that frame demonstrably ranks is the strongest
    // available evidence that a fresh query off the same frame will rank it
    // too. The caller supplies the pool (it is the only party that knows which
    // queries currently pass) and claims each memory at most once, so repair
    // does not pile several rewritten queries onto one memory.
    const pool = opts.paraphrasePool ?? [];
    const candidate = pickNth(pool);
    if (!candidate) return null;
    const target = index.byId.get(candidate.memoryId);
    if (!target) return null;
    const present = new Set(candidate.frame.present ?? ['action', 'prop', 'mishap', 'time']);
    for (let i = 0; i < 8; i++) {
      const drawn = renderParaphraseQuery(r.fork(`verbalize:${i}`), candidate.frame, present);
      // DESIGN.md 4.2 rule 4 has to keep holding for the NEW pairing, not just
      // the old one, or re-targeting would quietly turn the query lexical.
      if (paraphraseOverlapStems(drawn.text, target).length > 0) continue;
      if (drawn.text === q.text) continue;
      return {
        text: drawn.text,
        target: candidate.memoryId,
        declaredFilters: { date_from: null, date_to: null, people: [] },
        frame: { ...candidate.frame, templateIdx: drawn.templateIdx, timeWord: drawn.timeWord, present: [...present] },
      };
    }
    return null;
  }

  return null;
}

export function generateQueries(tier, split, index) {
  if (split !== 'dev' && split !== 'test') throw new Error(`generateQueries: split must be "dev" or "test", got "${split}"`);
  const plan = getPlan(tier);
  const splitCases = plan.cases.filter((c) => c.split === split);
  // getPlan(tier) already ran repairAnchors (re-verbalize, then anchor
  // resampling for partial_ref / typo_noisy) over dev+test together, and it
  // throws if anything is still unsolvable -- so by the time this line runs
  // every case in the plan IS solvable. Recomputing certifyQuery here would
  // be a second full-corpus certification pass (expensive at the real-vector
  // tiers, where every query's trigram-lane ceiling is O(corpus)) for a
  // result that is already known; certifyQuery is still exported and callers
  // that want a fresh, independent measurement can call it directly (e.g.
  // load.mjs --verify-oracle does, against the loaded corpus, which is a
  // different index entirely).
  return splitCases.map((c, i) => {
    const draft = finalizeQuery(c, i + 1);
    draft.certificate = c.certificate ?? certifyQuery(draft, index, tier);
    return draft;
  });
}

// Additive: DESIGN.md 3.3 assigns this module writing queries-multi.jsonl,
// but the frozen 3.6 signature list only names generateQueries(dev|test).
// Exported separately since a 2-3-target query needs every target
// individually reachable, which the single-target certifyQuery signature
// cannot express.
export function generateMultiTargetQueries(tier, index) {
  const plan = getPlan(tier);
  const queries = [];
  const failures = [];
  plan.multiCases.forEach((c, i) => {
    const draft = finalizeQuery(c, i + 1);
    const rawStems = tokenizeStem(draft.text);
    const fragmentBar = Math.min(2, new Set(rawStems).size);
    const signalSet = new Set();
    let allReachable = true;
    for (const targetId of draft.targets) {
      const k = config.oracle.bestLaneRankAt;
      const andCeiling = andLaneCeiling(rawStems, index, targetId);
      const orCeiling = orLaneCeiling(rawStems, index, targetId, fragmentBar);
      let reached = false;
      if (andCeiling != null && andCeiling <= k) { signalSet.add('and'); reached = true; }
      if (orCeiling != null && orCeiling <= k) { signalSet.add('or'); reached = true; }
      if (!reached) allReachable = false;
    }
    draft.certificate = {
      solvable: allReachable,
      signals: [...signalSet],
      dup_siblings: 0,
      planted_distractors: 0,
      lexical_overlap: 0,
    };
    if (!allReachable) failures.push(draft.qid);
    queries.push(draft);
  });
  if (failures.length > 0) {
    throw new Error(`generateMultiTargetQueries: ${failures.length}/${queries.length} multi-target queries had an unreachable target: ${failures.slice(0, 10).join(', ')}`);
  }
  return queries;
}

// oracle.json's gate number (DESIGN.md 4.3): the fraction of queries whose
// target is ranked <=10 by at least one lane in isolation, overall and per
// family, plus the weaker depth-100 reachability diagnostic.
//
// This is the PROVISIONAL oracle. It counts a query as solvable when a
// lexical lane's rank ceiling clears k, or when the query's only remaining
// hope is the vector lane, which this module cannot see. `vector.verified` is
// false in what it writes, and load.mjs --verify-oracle overwrites the file
// with measured per-lane ranks including exact cosine.
//
// Reading a 1.0000 here as "the corpus is solvable" is exactly the mistake
// the smoke run made: the lexical checks are near-tautological by
// construction (the query text is built FROM words planted in the target),
// and the family whose solving lane is the vector lane contributes an
// unverified "pending" to the same number. Only the verified file is a
// statement about retrieval difficulty.
export function oracleCeiling(queries, index, tier) {
  const perFamily = {};
  let bestLaneHits = 0;
  let depthHits = 0;
  let pending = 0;

  for (const q of queries) {
    const { certificate, reachableAtDepth } = computeCertificateAndReach(q, index, tier);
    perFamily[q.family] ??= { n: 0, bestLaneHits: 0, depthHits: 0, pending: 0 };
    perFamily[q.family].n++;
    if (certificate.solvable) { perFamily[q.family].bestLaneHits++; bestLaneHits++; }
    if (reachableAtDepth) { perFamily[q.family].depthHits++; depthHits++; }
    if (certificate.pending_lanes.length > 0) { perFamily[q.family].pending++; pending++; }
  }

  const n = queries.length;
  return {
    tier: tier.name ?? null,
    generatedAt: new Date().toISOString(),
    vector: {
      verified: false,
      note: 'lexical lanes certified offline by rank ceiling; the vector lane needs the loaded corpus -- run load.mjs --verify-oracle',
    },
    overall: {
      n,
      bestLaneRankAt10: n ? bestLaneHits / n : 0,
      depth100ReachabilityAt: n ? depthHits / n : 0,
      pendingVectorVerification: pending,
    },
    perFamily: Object.fromEntries(Object.entries(perFamily).map(([f, v]) => [f, {
      n: v.n,
      bestLaneRankAt10: v.n ? v.bestLaneHits / v.n : 0,
      depth100Reachability: v.n ? v.depthHits / v.n : 0,
      pendingVectorVerification: v.pending,
    }])),
    gate: { threshold: config.oracle.gate, passed: (n ? bestLaneHits / n : 0) >= config.oracle.gate, provisional: true },
  };
}

// ---------------------------------------------------------------------------
// Inline shape checks for --self-check. schemas.mjs (Track 0) had not
// landed when this module was written; these mirror DESIGN.md 3.1/3.2
// exactly and exist only so --self-check can validate without it.
// ---------------------------------------------------------------------------

function validateMemoryShape(m) {
  const errors = [];
  if (typeof m.id !== 'number') errors.push('id not a number');
  if (typeof m.kind !== 'string') errors.push('kind not a string');
  if (typeof m.title !== 'string') errors.push('title not a string');
  if (typeof m.body !== 'string') errors.push('body not a string');
  if (typeof m.raw !== 'string') errors.push('raw not a string');
  if (!Array.isArray(m.people)) errors.push('people not an array');
  if (!Array.isArray(m.places)) errors.push('places not an array');
  if (!Array.isArray(m.tags)) errors.push('tags not an array');
  if (typeof m.occurred_at !== 'string' || Number.isNaN(Date.parse(m.occurred_at))) errors.push('occurred_at not a valid ISO string');
  if (typeof m.cluster_id !== 'number') errors.push('cluster_id not a number');
  if (m.dup_group !== null && typeof m.dup_group !== 'number') errors.push('dup_group not int|null');
  if (m.rare_token !== null && typeof m.rare_token !== 'string') errors.push('rare_token not string|null');
  if (m.distinguisher !== null && typeof m.distinguisher !== 'string') errors.push('distinguisher not string|null');
  return errors;
}

function validateQueryShape(q) {
  const errors = [];
  if (typeof q.qid !== 'string') errors.push('qid not a string');
  if (!['dev', 'test', 'multi'].includes(q.split)) errors.push('split not dev|test|multi');
  if (typeof q.family !== 'string') errors.push('family not a string');
  if (typeof q.text !== 'string' || q.text.length === 0) errors.push('text not a non-empty string');
  if (!Array.isArray(q.targets) || q.targets.length === 0) errors.push('targets not a non-empty array');
  if (typeof q.declared_filters !== 'object' || q.declared_filters === null) errors.push('declared_filters not an object');
  if (typeof q.certificate !== 'object' || q.certificate === null) errors.push('certificate not an object');
  if (typeof q.diagnostics !== 'object' || q.diagnostics === null) errors.push('diagnostics not an object');
  return errors;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function buildSelfCheckTier() {
  return {
    name: 'selfcheck',
    memories: 160,
    queriesPerSplit: 20,
    vector: 'real',
    dims: 768,
    bodyChars: [340, 400],
    schema: 'bench_selfcheck',
    clusters: 10,
    familyMix: config.corpus.familyMix,
    dupGroupSize: [3, 5],
    multiTargetShare: 0,
    multiTargetCount: 6,
    seedMemories: config.corpus.seedMemories,
    seedDev: config.corpus.seedDev,
    seedTest: config.corpus.seedTest,
    laneDepth: config.lanes.quality.depth,
  };
}

function runSelfCheck() {
  console.log('gen-corpus --self-check: memories=100 (approx), queriesPerSplit=20, in-memory only, nothing written to disk');
  const tier = buildSelfCheckTier();

  const memories = [...generateMemories(tier)];
  const index = buildMemoryIndex(memories);
  const dev = generateQueries(tier, 'dev', index);
  const test = generateQueries(tier, 'test', index);
  const multi = generateMultiTargetQueries(tier, index);
  const allQueries = [...dev, ...test];

  let shapeErrors = 0;
  for (const m of memories) {
    const errs = validateMemoryShape(m);
    if (errs.length) { shapeErrors++; console.error(`  memory ${m.id} shape errors: ${errs.join('; ')}`); }
  }
  for (const q of [...allQueries, ...multi]) {
    const errs = validateQueryShape(q);
    if (errs.length) { shapeErrors++; console.error(`  query ${q.qid} shape errors: ${errs.join('; ')}`); }
  }

  const bodyLens = memories.map((m) => m.body.length).sort((a, b) => a - b);
  const dupGroupSizes = [...index.dupGroups.values()].map((ids) => ids.length);
  const rareTokenCount = memories.filter((m) => m.rare_token != null).length;

  const familyTotals = {};
  for (const q of allQueries) familyTotals[q.family] = (familyTotals[q.family] ?? 0) + 1;
  const achievedMix = Object.fromEntries(
    Object.entries(familyTotals).map(([f, n]) => [f, Number((n / allQueries.length).toFixed(3))]),
  );

  const paraphraseOverlaps = allQueries
    .filter((q) => q.family === 'paraphrase_nolex')
    .map((q) => q.certificate.lexical_overlap);
  const certPassCount = allQueries.filter((q) => q.certificate.solvable).length;

  console.log(`memories generated: ${memories.length}`);
  console.log(`queries generated: dev=${dev.length} test=${test.length} multi=${multi.length}`);
  console.log(`schema errors: ${shapeErrors}`);
  console.log(`body length min/median/max: ${bodyLens[0]}/${percentile(bodyLens, 0.5)}/${bodyLens[bodyLens.length - 1]} (target ${tier.bodyChars[0]}-${tier.bodyChars[1]})`);
  console.log(`achieved family mix: ${JSON.stringify(achievedMix)}`);
  console.log(`configured family mix: ${JSON.stringify(tier.familyMix)}`);
  console.log(`dup groups: ${dupGroupSizes.length}, sizes: ${JSON.stringify(dupGroupSizes)} (configured range ${JSON.stringify(tier.dupGroupSize)})`);
  console.log(`rare_token coverage: ${rareTokenCount} memories carry a rare_token`);
  console.log(`certificate pass rate: ${certPassCount}/${allQueries.length}`);
  console.log(`paraphrase_nolex lexical_overlap values (must all be exactly 0): ${JSON.stringify(paraphraseOverlaps)}`);

  const oracle = oracleCeiling(allQueries, index, tier);
  console.log(`oracle best-lane-rank@10: ${oracle.overall.bestLaneRankAt10.toFixed(4)} (gate 0.97, ${oracle.gate.passed ? 'PASSED' : 'FAILED'})`);
  console.log(`oracle depth-${tier.laneDepth} reachability: ${oracle.overall.depth100ReachabilityAt.toFixed(4)}`);
  console.log(`per-family best-lane-rank@10: ${JSON.stringify(Object.fromEntries(Object.entries(oracle.perFamily).map(([f, v]) => [f, Number(v.bestLaneRankAt10.toFixed(3))])))}`);

  const paraphraseOk = paraphraseOverlaps.every((v) => v === 0);
  const ok = shapeErrors === 0 && paraphraseOk;
  console.log(ok ? 'SELF-CHECK: PASS' : 'SELF-CHECK: FAIL');
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// CLI (DESIGN.md 3.7)
// ---------------------------------------------------------------------------

async function loadJsonlArray(filePath) {
  const out = [];
  for await (const record of readJsonl(filePath)) out.push(record);
  return out;
}

async function sha256OfFile(filePath) {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      tier: { type: 'string' },
      split: { type: 'string', default: 'both' },
      out: { type: 'string' },
      verify: { type: 'boolean', default: false },
      'self-check': { type: 'boolean', default: false },
    },
  });

  if (args['self-check']) {
    runSelfCheck();
    return;
  }

  if (!args.tier) throw new Error('gen-corpus.mjs requires --tier <name> (or --self-check)');
  const tierCfg = resolveTier(args.tier);
  const outDir = args.out ?? path.join(HERE, '.out', args.tier);

  // Section 3.7: every script prints its resolved target before anything
  // else runs. gen-corpus.mjs touches no database, so "target" here is the
  // output directory and tier shape instead.
  console.log(`gen-corpus: out=${outDir} tier=${args.tier} schema=${tierCfg.schema} memories=${tierCfg.memories} queriesPerSplit=${tierCfg.queriesPerSplit} vector=${tierCfg.vector}`);

  await mkdir(outDir, { recursive: true });

  const memoriesPath = path.join(outDir, 'memories.jsonl');
  const memCount = await writeJsonl(memoriesPath, generateMemories(tierCfg));
  console.log(`wrote ${memCount} memories -> ${memoriesPath}`);

  // generateMemories(tierCfg) above already ran the full repair pass (see
  // repairAnchors): re-verbalization and, where that alone cannot converge,
  // anchor resampling for partial_ref / typo_noisy. Report what it did.
  const repairStats = getRepairStats(tierCfg);
  console.log(
    `repair: ${repairStats.reverbalized.length} re-verbalized, ${repairStats.anchorResampled.length} anchor-resampled, ` +
    `${repairStats.failures.length} unresolved`,
  );
  if (repairStats.anchorResampled.length > 0) {
    const maxAttempts = Math.max(...repairStats.anchorResampled.map((r) => r.attempts));
    const byFamily = {};
    for (const r of repairStats.anchorResampled) byFamily[r.family] = (byFamily[r.family] ?? 0) + 1;
    console.log(`  anchor-resampled by family: ${JSON.stringify(byFamily)}, max attempts used: ${maxAttempts}`);
  }

  const memories = await loadJsonlArray(memoriesPath);
  const index = buildMemoryIndex(memories);

  const splits = args.split === 'both' ? ['dev', 'test'] : [args.split];
  for (const split of splits) {
    const queries = generateQueries(tierCfg, split, index);
    const qPath = path.join(outDir, `queries-${split}.jsonl`);
    await writeJsonl(qPath, queries);
    console.log(`wrote ${queries.length} ${split} queries -> ${qPath}`);
  }

  const multi = generateMultiTargetQueries(tierCfg, index);
  const multiPath = path.join(outDir, 'queries-multi.jsonl');
  await writeJsonl(multiPath, multi);
  console.log(`wrote ${multi.length} multi-target queries -> ${multiPath}`);

  if (args.verify) {
    const dev = await loadJsonlArray(path.join(outDir, 'queries-dev.jsonl'));
    const test = await loadJsonlArray(path.join(outDir, 'queries-test.jsonl'));
    const oracle = oracleCeiling([...dev, ...test], index, tierCfg);
    const oraclePath = path.join(outDir, 'oracle.json');
    await writeFile(oraclePath, JSON.stringify(oracle, null, 2));
    console.log(`oracle written -> ${oraclePath} (bestLaneRankAt10=${oracle.overall.bestLaneRankAt10.toFixed(4)}, gate ${oracle.gate.passed ? 'PASSED' : 'FAILED'})`);

    const memoriesSha256 = await sha256OfFile(memoriesPath);
    // The query files are hashed too, not just memories.jsonl. load.mjs
    // --verify-oracle can rewrite query TEXT during repair, so a lock that
    // pinned only the memories would claim to freeze a corpus whose questions
    // had since changed. Repair belongs before the freeze (DESIGN.md 4.4 step
    // 6), and hashing the query files is what makes that ordering checkable
    // rather than a convention.
    const lock = {
      tier: args.tier,
      generatedAt: new Date().toISOString(),
      seedMemories: tierCfg.seedMemories,
      familyMix: tierCfg.familyMix,
      configHash: createHash('sha256').update(JSON.stringify(config.corpus)).digest('hex'),
      memoriesSha256,
      queriesDevSha256: await sha256OfFile(path.join(outDir, 'queries-dev.jsonl')),
      queriesTestSha256: await sha256OfFile(path.join(outDir, 'queries-test.jsonl')),
    };
    const lockPath = path.join(outDir, 'CORPUS.lock');
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    console.log(`lock written -> ${lockPath}`);

    if (!oracle.gate.passed) {
      console.error(`GATE FAILED: best-lane-rank@10 = ${oracle.overall.bestLaneRankAt10.toFixed(4)}, below the 0.97 threshold (DESIGN.md 4.3)`);
      process.exitCode = 1;
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
  });
}
