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
// Deviation from the literal text of DESIGN.md 4.2 rule 2, flagged here and
// in more detail on vectorLaneRank/computeLaneRanks below: rule 2 wants the
// vector lane's brute-force rank "by exact cosine over the whole corpus".
// At the real-vector tiers (smoke1k, quality50k) the real embeddings do not
// exist yet at generation time -- load.mjs computes them afterward. Rather
// than fabricate a number and call it exact, this module uses
// lib/synth-vectors.mjs as a *documented proxy* at every tier: the same
// proxy IS the real vector at the synthetic tiers (rehearsal1m, full10m),
// and is an honest stand-in elsewhere. Only paraphrase_nolex actually
// depends on the vector lane to certify (it has zero lexical overlap by
// construction), so this is where the proxy's honesty matters most; every
// other family certifies on lexical evidence computed exactly, with no
// model involved at all.
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
  PEOPLE, PLACES, TOPICS, topicById, DISTINGUISHER_PHRASES, DETAIL_WORDS,
  buildDateTemplate, makeRareToken,
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
import {
  memoryVector, queryVector, cosineSimilarity,
  DEFAULT_MEMORY_JITTER, DEFAULT_QUERY_DRIFT,
} from './lib/synth-vectors.mjs';

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

const STOPWORDS = new Set([
  'the', 'and', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'was',
  'we', 'i', 'it', 'that', 'this', 'is', 'did', 'what', 'our', 'from', 'by', 'or',
]);

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

function charTrigrams(s) {
  const t = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const padded = `  ${t}  `;
  const grams = new Set();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

// Containment, not Jaccard: what fraction of the QUERY's trigrams show up
// in the candidate. Postgres's word_similarity (what the real trigram lane
// uses, DESIGN.md 6.2) is asymmetric for exactly this reason -- it measures
// the best-matching substring of the longer text, so a short query is not
// diluted by an unrelated few hundred characters elsewhere in a long body.
// A plain Jaccard was tried first and undercounted real matches by 2x for
// this reason (see gen-corpus.mjs task summary).
function trigramSim(query, candidate) {
  const A = charTrigrams(query);
  const B = charTrigrams(candidate);
  if (A.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / A.size;
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

function corruptWord(word, r) {
  const chars = word.split('');
  const op = chars.length >= 3 ? r.pick(['swap', 'drop', 'dup']) : 'dup';
  if (op === 'swap') {
    const i = r.int(0, chars.length - 2);
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
  } else if (op === 'drop') {
    const i = r.int(1, chars.length - 2);
    chars.splice(i, 1);
  } else {
    const i = r.int(0, chars.length - 1);
    chars.splice(i, 0, chars[i]);
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
function buildStandaloneMemorySpec(r, topic, tier, extra = {}) {
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
    rare_token: extra.rareToken ?? null,
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

function buildParaphraseCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const spec = buildStandaloneMemorySpec(r, topic, tier);
  const targetContentId = helpers.addMemory(spec);

  const aNoun1 = r.pick(topic.abstractNouns);
  const aNoun2 = r.pick(topic.abstractNouns);
  const aVerb = r.pick(topic.abstractVerbs);
  const text = `what was that ${aNoun1} where we ${aVerb} the ${aNoun2}`;

  return {
    query: {
      text,
      targetContentIds: [targetContentId],
      distractorContentIds: [],
      difficulty: 3,
      declaredFilters: { date_from: null, date_to: null, people: [] },
    },
  };
}

function buildRareTokenCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const noun = r.pick(topic.concreteNouns);
  const rareToken = helpers.nextRareToken(r);
  const spec = buildStandaloneMemorySpec(r, topic, tier, { mustInclude: [noun], rareToken });
  const targetContentId = helpers.addMemory(spec);

  const text = `the ${noun} with reference code ${rareToken}`;

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

  const contentIds = [];
  for (let i = 0; i < groupSize; i++) {
    const memberR = r.fork(`member:${i}`);
    const person = swapPeople ? entities[i] : sharedPerson;
    const place = swapPeople ? sharedPlace : entities[i];
    const spec = buildStandaloneMemorySpec(memberR, topic, tier, {
      person, place, occurred_at: sharedDate, cluster_id: sharedCluster, mustInclude,
    });
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
    },
  };
}

function buildNearDupCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const [gMin, gMax] = tier.dupGroupSize;
  const groupSize = r.int(gMin, gMax);
  const mustInclude = r.sample(topic.concreteNouns, 3);
  const sharedCluster = randomClusterId(r, tier);
  const dupGroup = helpers.nextDupGroup();
  const distinguisher = r.pick(DISTINGUISHER_PHRASES);
  const targetIdx = r.int(0, groupSize - 1);

  const contentIds = [];
  for (let i = 0; i < groupSize; i++) {
    const memberR = r.fork(`member:${i}`);
    const spec = buildStandaloneMemorySpec(memberR, topic, tier, {
      cluster_id: sharedCluster,
      mustInclude,
      dup_group: dupGroup,
      distinguisher: i === targetIdx ? distinguisher : null,
    });
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
  const mustInclude = r.sample(topic.concreteNouns, 2);
  const sharedCluster = randomClusterId(r, tier);
  const sharedPerson = pickPerson(r);
  const sharedPlace = pickPlace(r);
  const groupSize = r.int(4, 6);
  const startYear = r.int(2016, 2023 - groupSize);
  const month = r.int(0, 11);
  const day = r.int(1, 28);

  const contentIds = [];
  const years = [];
  for (let i = 0; i < groupSize; i++) {
    const year = startYear + i;
    years.push(year);
    const occurred_at = new Date(Date.UTC(year, month, day, r.int(8, 21), r.int(0, 59))).toISOString();
    const memberR = r.fork(`member:${i}`);
    const spec = buildStandaloneMemorySpec(memberR, topic, tier, {
      person: sharedPerson, place: sharedPlace, occurred_at, cluster_id: sharedCluster, mustInclude,
    });
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
    dateTemplate = buildDateTemplate('seasonOfYear', { season: seasonForMonth(month), year: targetYear });
  }

  const text = `the ${mustInclude.join(' and the ')} ${dateTemplate.text}`;

  return {
    query: {
      text,
      targetContentIds: [contentIds[targetIdx]],
      distractorContentIds: contentIds.filter((_, i) => i !== targetIdx),
      difficulty: 2,
      declaredFilters: { date_from: dateTemplate.range.from, date_to: dateTemplate.range.to, people: [] },
    },
  };
}

const VAGUE_FILLER_WORDS = [
  'whichever', 'something', 'somehow', 'thingy', 'business', 'deal',
  'stuff', 'whatnot', 'situation', 'moment',
];

function buildPartialRefCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const noun = r.pick(topic.concreteNouns);
  const detail = r.pick(DETAIL_WORDS);
  const spec = buildStandaloneMemorySpec(r, topic, tier, { mustInclude: [noun, detail] });
  const targetContentId = helpers.addMemory(spec);

  const vague = r.sample(VAGUE_FILLER_WORDS, 3);
  const text = `${vague[0]} about the ${detail} ${noun} or ${vague[1]}, ${vague[2]} like that`;

  return {
    query: {
      text,
      targetContentIds: [targetContentId],
      distractorContentIds: [],
      difficulty: 3,
      declaredFilters: { date_from: null, date_to: null, people: [] },
    },
  };
}

function buildTypoNoisyCase(r, tier, helpers) {
  const topic = topicById(r.int(0, TOPICS.length - 1));
  const target = r.pick(topic.concreteNouns);
  const companion = r.pick(topic.concreteNouns.filter((w) => w !== target));
  const spec = buildStandaloneMemorySpec(r, topic, tier, { mustInclude: [target, companion] });
  const targetContentId = helpers.addMemory(spec);

  const corrupted = corruptWord(target, r);
  const text = `the ${corrupted} and the ${companion}`;

  return {
    query: {
      text,
      targetContentIds: [targetContentId],
      distractorContentIds: [],
      difficulty: 2,
      declaredFilters: { date_from: null, date_to: null, people: [] },
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
    const spec = buildStandaloneMemorySpec(memberR, topic, tier, { mustInclude, cluster_id: sharedCluster });
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
    helpers.addMemory(buildStandaloneMemorySpec(r, topic, tier));
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

  return { tier, memories: finalMemories, cases: finalCases, multiCases: finalMultiCases };
}

function getPlan(tier) {
  const key = planCacheKey(tier);
  if (!planCache.has(key)) planCache.set(key, buildPlan(tier));
  return planCache.get(key);
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

function andLaneRank(queryStems, index, targetId) {
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
  // ts_rank_cd ties are broken by id (DESIGN.md 6.1's SQL sketch); this proxy
  // has no term-frequency signal among AND-matching docs (they all match
  // every term by definition), so id order is the whole ranking.
  const ids = [...inter].sort((a, b) => a - b);
  return ids.indexOf(targetId) + 1;
}

function orLaneRank(queryStems, index, targetId, fragmentBar) {
  const uniqueStems = [...new Set(queryStems)];
  if (uniqueStems.length === 0) return null;
  const bar = Math.min(fragmentBar, uniqueStems.length);
  const counts = new Map();
  for (const s of uniqueStems) {
    const ids = index.postings.get(s);
    if (!ids) continue;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const candidates = [...counts.entries()].filter(([, c]) => c >= bar);
  if (!candidates.some(([id]) => id === targetId)) return null;
  candidates.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return candidates.findIndex(([id]) => id === targetId) + 1;
}

function trigramLaneRank(queryText, index, targetId, threshold) {
  const target = index.byId.get(targetId);
  const targetSim = trigramSim(queryText, `${target.title} ${target.body}`);
  if (targetSim < threshold) return null;
  let beatenBy = 0;
  for (const [id, m] of index.byId) {
    if (id === targetId) continue;
    const sim = trigramSim(queryText, `${m.title} ${m.body}`);
    if (sim >= threshold && (sim > targetSim || (sim === targetSim && id < targetId))) beatenBy++;
  }
  return beatenBy + 1;
}

function vectorLaneRank(targetId, index, tier) {
  const target = index.byId.get(targetId);
  const qVec = queryVector(targetId, target.cluster_id, tier.dims, DEFAULT_QUERY_DRIFT);
  const targetVec = memoryVector(targetId, target.cluster_id, tier.dims, DEFAULT_MEMORY_JITTER);
  const targetSim = cosineSimilarity(qVec, targetVec);
  let beatenBy = 0;
  for (const [id, m] of index.byId) {
    if (id === targetId) continue;
    const v = memoryVector(id, m.cluster_id, tier.dims, DEFAULT_MEMORY_JITTER);
    if (cosineSimilarity(qVec, v) > targetSim) beatenBy++;
  }
  return beatenBy + 1;
}

function computeLaneRanks(q, index, tier, targetId) {
  const rawStems = tokenizeStem(q.text);
  const andRank = andLaneRank(rawStems, index, targetId);
  const fragmentBar = Math.min(2, new Set(rawStems).size);
  const orRank = orLaneRank(rawStems, index, targetId, fragmentBar);
  // Trigram lane is quality-tier only (DESIGN.md 6.2): the scale tier has no
  // trigram index at all, so certifying against it there would credit a
  // lane the real engine never runs.
  const trigramRank = tier.vector === 'real' ? trigramLaneRank(q.text, index, targetId, config.lanes.trigramThreshold) : null;
  const lexicalCleared10 = [andRank, orRank, trigramRank].some((r) => r != null && r <= 10);
  const vectorRank = lexicalCleared10 ? null : vectorLaneRank(targetId, index, tier);
  return { and: andRank, or: orRank, trigram: trigramRank, vector: vectorRank };
}

// Shared by certifyQuery and oracleCeiling so a query is only brute-forced
// once even when both the certificate and the depth-reachability diagnostic
// are needed.
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

  const ranks = computeLaneRanks(q, index, tier, targetId);
  const signals = [];
  if (ranks.and != null && ranks.and <= 10) signals.push('and');
  if (ranks.or != null && ranks.or <= 10) signals.push('or');
  if (ranks.trigram != null && ranks.trigram <= 10) signals.push('trigram');
  if (ranks.vector != null && ranks.vector <= 10) signals.push('vector');

  const reachableAtDepth = Object.values(ranks).some((rk) => rk != null && rk <= tier.laneDepth);

  const dupGroup = target.dup_group;
  const dupSiblings = dupGroup != null ? Math.max(0, (index.dupGroups.get(dupGroup)?.length ?? 1) - 1) : 0;
  const plantedDistractors = q.diagnostics?.distractor_ids?.length ?? 0;

  let solvable = signals.length > 0;
  // Certificate rule 4 (DESIGN.md 4.2): paraphrase_nolex's entire claim is
  // zero lexical overlap with the target body. Nonzero overlap here would
  // mean the family is not testing what its name says, and that overrides
  // whatever the vector lane found.
  if (q.family === 'paraphrase_nolex' && lexicalOverlap !== 0) solvable = false;

  return {
    certificate: {
      solvable,
      signals,
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

export function generateQueries(tier, split, index) {
  if (split !== 'dev' && split !== 'test') throw new Error(`generateQueries: split must be "dev" or "test", got "${split}"`);
  const plan = getPlan(tier);
  const splitCases = plan.cases.filter((c) => c.split === split);
  const queries = [];
  const failures = [];
  splitCases.forEach((c, i) => {
    const draft = finalizeQuery(c, i + 1);
    draft.certificate = certifyQuery(draft, index, tier);
    if (!draft.certificate.solvable) failures.push({ qid: draft.qid, family: draft.family, certificate: draft.certificate });
    queries.push(draft);
  });
  if (failures.length > 0) {
    throw new Error(
      `generateQueries: ${failures.length}/${queries.length} ${split} queries failed the solvability certificate ` +
      `(DESIGN.md 4.2): ${JSON.stringify(failures.slice(0, 10))}${failures.length > 10 ? ' ...' : ''}`,
    );
  }
  return queries;
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
      const andRank = andLaneRank(rawStems, index, targetId);
      const orRank = orLaneRank(rawStems, index, targetId, fragmentBar);
      let reached = false;
      if (andRank != null && andRank <= 10) { signalSet.add('and'); reached = true; }
      if (orRank != null && orRank <= 10) { signalSet.add('or'); reached = true; }
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
// Known limitation, worth reading before trusting a 1.0000 here: this
// generator is constructive (query text is built FROM words force-injected
// into the target body, then certified against that same text), so the
// AND/OR lanes it certifies against are close to tautological -- they
// almost cannot fail. DESIGN.md 4.3 describes this gate as something that
// "can genuinely come in at 0.88 and stop the ladder"; as shipped, this
// module will report close to 1.0 at every tier regardless of how hard the
// corpus actually is for the real engine, because the brute-force check
// and the construction share the same planted evidence. A 1.0000 here is
// not proof the corpus is well-calibrated for claim A's 0.60-0.80 naive /
// 0.91 tuned bands (DESIGN.md 4.4) -- only bench-recall.mjs running the
// real engine against real embeddings can show that. Treat this gate as
// "did generation succeed at planting a findable signal", not as evidence
// about retrieval difficulty.
export function oracleCeiling(queries, index, tier) {
  const perFamily = {};
  let bestLaneHits = 0;
  let depthHits = 0;

  for (const q of queries) {
    const { certificate, reachableAtDepth } = computeCertificateAndReach(q, index, tier);
    perFamily[q.family] ??= { n: 0, bestLaneHits: 0, depthHits: 0 };
    perFamily[q.family].n++;
    if (certificate.solvable) { perFamily[q.family].bestLaneHits++; bestLaneHits++; }
    if (reachableAtDepth) { perFamily[q.family].depthHits++; depthHits++; }
  }

  const n = queries.length;
  return {
    tier: tier.name ?? null,
    generatedAt: new Date().toISOString(),
    overall: {
      n,
      bestLaneRankAt10: n ? bestLaneHits / n : 0,
      depth100ReachabilityAt: n ? depthHits / n : 0,
    },
    perFamily: Object.fromEntries(Object.entries(perFamily).map(([f, v]) => [f, {
      n: v.n,
      bestLaneRankAt10: v.n ? v.bestLaneHits / v.n : 0,
      depth100Reachability: v.n ? v.depthHits / v.n : 0,
    }])),
    gate: { threshold: 0.97, passed: (n ? bestLaneHits / n : 0) >= 0.97 },
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
    const lock = {
      tier: args.tier,
      generatedAt: new Date().toISOString(),
      seedMemories: tierCfg.seedMemories,
      familyMix: tierCfg.familyMix,
      configHash: createHash('sha256').update(JSON.stringify(config.corpus)).digest('hex'),
      memoriesSha256,
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
