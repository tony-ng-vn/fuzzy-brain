// lib/lexicon.mjs -- people, places, topics, disjoint vocabularies, and date
// templates (DESIGN.md section 3.6, section 2's file listing).
//
// The load-bearing property of this file is the split between two word
// registers used to write memory content:
//
//   CONCRETE_* -- specific, Anglo-Saxon-leaning household/activity words.
//     Used for the memory's own body/raw/title text, and for every query
//     family except paraphrase_nolex.
//   ABSTRACT_* -- vague, Latinate-leaning words describing the same kind of
//     scene without naming any of its specifics. Used only for
//     paraphrase_nolex query text.
//
// `paraphrase_nolex`'s certificate rule (DESIGN.md 4.2 rule 4) requires the
// measured stem Jaccard between query and target body to be exactly 0. This
// file cannot reproduce Postgres's snowball stemmer, so instead of measuring
// stemming and hoping, it enforces a *stronger* static invariant at module
// load: no word in ABSTRACT_* shares its first 4 characters with any word in
// CONCRETE_* (assertDisjointRegisters, called below). Two words sharing a
// 4-character prefix is a superset of "share a stem" for every English
// suffix pattern the Snowball stemmer actually strips (-ing, -ed, -s, -es,
// -ly, -ion, ...), so zero prefix collisions implies zero stem collisions.
// The reverse is not tested and is not needed: the guarantee runs one
// direction only, and that direction is the one the certificate depends on.

// ---------------------------------------------------------------------------
// Word registers
// ---------------------------------------------------------------------------

export const CONCRETE_NOUNS = [
  'skillet', 'garlic', 'stove', 'kitchen', 'faucet', 'wrench', 'sink', 'modem',
  'bookshelf', 'screwdriver', 'tarp', 'ladder', 'gravel', 'tomato', 'trowel',
  'backpack', 'altimeter', 'ridge', 'trailhead', 'guitar', 'amplifier', 'microphone',
  'cardboard', 'van', 'thermostat', 'furnace', 'chimney', 'gutter', 'shingle',
  'basement', 'pump', 'puppy', 'leash', 'kibble', 'vet', 'stroller', 'diaper',
  'blanket', 'quilt', 'mattress', 'headboard', 'curtain', 'doorbell', 'porch',
  'driveway', 'mailbox', 'sprinkler', 'hedge', 'fence', 'mower', 'rake',
  'wheelbarrow', 'cider', 'pumpkin', 'lantern', 'candle', 'sled', 'mitten',
  'scarf', 'umbrella', 'raincoat', 'thermos', 'cooler', 'grill', 'charcoal',
  'marinade', 'spatula', 'whisk', 'casserole', 'dumpling', 'noodle', 'kettle',
  'teapot', 'mug', 'saucer', 'napkin', 'laptop', 'charger', 'keyboard', 'monitor',
  'printer', 'stapler', 'binder', 'envelope', 'stamp', 'suitcase', 'passport',
  'boarding', 'terminal', 'luggage', 'escalator', 'staircase', 'balcony',
  'terrace', 'greenhouse', 'seedling', 'fertilizer', 'hammock', 'firewood',
  'kayak', 'paddle', 'tent', 'canteen', 'flashlight', 'toolbox', 'sandpaper',
];

export const CONCRETE_VERBS = [
  'cooked', 'simmered', 'seasoned', 'scrubbed', 'tightened', 'mounted', 'wired',
  'planted', 'watered', 'packed', 'hauled', 'tuned', 'strummed', 'hammered',
  'sanded', 'patched', 'mowed', 'raked', 'walked', 'fed', 'bathed', 'folded',
  'ironed', 'chopped', 'diced', 'roasted', 'grilled', 'whisked', 'kneaded',
  'brewed', 'poured', 'wrapped', 'taped', 'labeled', 'stacked', 'hiked',
  'camped', 'pitched', 'paddled', 'swept', 'mopped', 'vacuumed', 'dusted',
  'oiled', 'bolted', 'glued', 'sawed', 'drilled', 'stapled', 'mailed',
];

export const ABSTRACT_NOUNS = [
  'undertaking', 'preparation', 'occasion', 'gathering', 'dwelling',
  'arrangement', 'deliberation', 'negotiation', 'restoration', 'acquisition',
  'observation', 'cultivation', 'fabrication', 'renovation', 'consultation',
  'transportation', 'examination', 'celebration', 'retrieval', 'expedition',
  'endeavor', 'ceremony', 'proceeding', 'transition', 'adjustment',
  'disruption', 'obligation', 'commitment', 'engagement', 'reflection',
  'anticipation', 'contemplation', 'settlement', 'transaction', 'provision',
  'sustenance', 'nourishment', 'companionship', 'affection', 'devotion',
  'remembrance', 'sentiment', 'disposition', 'temperament', 'atmosphere',
  'ambiance', 'circumstance', 'predicament', 'situation', 'development',
  'milestone', 'achievement', 'accomplishment', 'aspiration', 'motivation',
  'inclination', 'preference', 'tendency', 'routine', 'custom', 'tradition',
  'ritual', 'practice', 'episode', 'incident', 'encounter', 'interlude',
  'occurrence', 'venture', 'pursuit', 'activity', 'errand', 'duty',
  'assignment', 'initiative', 'scheme', 'strategy', 'approach', 'technique',
  'procedure', 'process', 'mechanism',
];

export const ABSTRACT_VERBS = [
  'undertook', 'arranged', 'coordinated', 'deliberated', 'negotiated',
  'restored', 'acquired', 'observed', 'cultivated', 'fabricated', 'renovated',
  'consulted', 'transported', 'examined', 'celebrated', 'retrieved',
  'anticipated', 'contemplated', 'resolved', 'adjusted', 'committed',
  'engaged', 'reflected', 'settled', 'provisioned', 'sustained', 'nourished',
  'accompanied', 'devoted', 'remembered', 'initiated', 'conducted', 'pursued',
  'facilitated', 'orchestrated', 'administered', 'supervised', 'organized',
  'scheduled', 'strategized', 'evaluated', 'assessed', 'reviewed', 'revised',
  'formulated', 'devised',
];

// Detail words: concrete-register descriptive filler used to give an
// individual memory a per-record specific "texture" beyond its topic --
// colors, materials, weather, small counts -- so that two memories on the
// same topic still differ in more than just person/place/date. Treated as
// CONCRETE for the disjointness check, since these can appear in body text.
export const DETAIL_WORDS = [
  'blue', 'green', 'yellow', 'red', 'orange', 'gray', 'white', 'black',
  'wooden', 'ceramic', 'plastic', 'metal', 'canvas', 'woolen', 'rusty',
  'chipped', 'cracked', 'faded', 'secondhand', 'borrowed', 'handmade',
  'leftover', 'spare', 'foldable', 'oversized', 'petite', 'squeaky',
  'flickering', 'humid', 'foggy', 'breezy', 'overcast', 'frosty', 'muggy',
  'drizzly', 'sweltering', 'chilly', 'windy', 'sunlit', 'moonlit',
];

// ---------------------------------------------------------------------------
// Register disjointness invariant
// ---------------------------------------------------------------------------

function prefix4(word) {
  return word.toLowerCase().slice(0, 4);
}

function prefixSet(words) {
  return new Set(words.map(prefix4));
}

// Called once at module load (bottom of this file). Throws immediately if
// any CONCRETE/ABSTRACT word pair shares a 4-character prefix -- this must
// never pass silently, because a collision here would silently break the
// paraphrase_nolex family's "Jaccard is exactly 0" invariant that
// gen-corpus.mjs's certification depends on.
export function assertDisjointRegisters() {
  const concrete = [...CONCRETE_NOUNS, ...CONCRETE_VERBS, ...DETAIL_WORDS];
  const abstract = [...ABSTRACT_NOUNS, ...ABSTRACT_VERBS];
  const concretePrefixes = prefixSet(concrete);
  const collisions = [];
  for (const word of abstract) {
    const p = prefix4(word);
    if (concretePrefixes.has(p)) collisions.push(word);
  }
  if (collisions.length > 0) {
    throw new Error(
      `lexicon.mjs: ${collisions.length} abstract word(s) share a 4-char prefix with a concrete word: ${collisions.join(', ')}. ` +
      `This breaks the paraphrase_nolex zero-Jaccard guarantee -- fix the word lists, do not weaken the check.`,
    );
  }
}

// ---------------------------------------------------------------------------
// People and places
// ---------------------------------------------------------------------------

const PEOPLE_NAMES = [
  'doan', 'minh', 'linh', 'quan', 'hoa', 'nam', 'an', 'binh', 'chi', 'dao',
  'giang', 'hai', 'khanh', 'lam', 'mai', 'ngoc', 'phong', 'quynh', 'son',
  'tam', 'thao', 'trang', 'tuan', 'van', 'vy', 'yen', 'duc', 'hieu', 'kien', 'loan',
];

export const PEOPLE = PEOPLE_NAMES.map((name, i) => ({
  id: i,
  slug: name,
  name: name[0].toUpperCase() + name.slice(1),
}));

const PLACE_NAMES = [
  'dobson-road', 'riverside-park', 'the-old-cafe', 'grandmas-house',
  'the-lake-house', 'downtown-office', 'maple-street', 'the-farmers-market',
  'harbor-view', 'the-corner-diner', 'willow-creek', 'the-community-center',
  'stone-bridge', 'the-botanical-garden', 'north-station', 'the-repair-shop',
  'cedar-hill', 'the-boardwalk', 'oakridge-school', 'the-parking-garage',
  'sunset-motel', 'the-hardware-store', 'pine-valley', 'the-airport-lounge',
  'east-market', 'the-veterinary-clinic', 'birchwood-trail', 'the-library-annex',
  'westgate-mall', 'the-marina',
];

export const PLACES = PLACE_NAMES.map((slug, i) => ({
  id: i,
  slug,
  name: slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
}));

// ---------------------------------------------------------------------------
// Topics: each is an identifier plus a per-topic subset of the registers.
// The `slug` is never rendered into generated text (so it never needs a
// disjointness check of its own) -- it exists only for logging and for
// tests to name a topic by something readable.
// ---------------------------------------------------------------------------

const TOPIC_SLUGS = [
  'cooking-dinner', 'fixing-the-sink', 'assembling-furniture', 'the-road-trip',
  'the-loud-party', 'planting-vegetables', 'the-power-outage', 'packing-boxes',
  'the-sick-puppy', 'practicing-music', 'the-birthday-cake', 'the-long-wait',
  'the-flat-tire', 'baking-bread', 'the-leaky-faucet', 'binge-watching',
  'the-first-snow', 'cleaning-the-garage', 'the-video-call', 'the-broken-router',
  'the-ridge-hike', 'the-market-run', 'painting-the-room', 'the-interview',
  'the-recipe-box', 'the-flooded-basement', 'learning-to-ride', 'the-new-puppy',
  'the-park-concert', 'the-squeaky-door', 'the-long-layover', 'the-overgrown-garden',
];

function slice(pool, start, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(pool[(start + i) % pool.length]);
  return out;
}

export const TOPICS = TOPIC_SLUGS.map((slug, id) => ({
  id,
  slug,
  concreteNouns: slice(CONCRETE_NOUNS, id * 5, 7),
  concreteVerbs: slice(CONCRETE_VERBS, id * 3, 5),
  abstractNouns: slice(ABSTRACT_NOUNS, id * 5, 7),
  abstractVerbs: slice(ABSTRACT_VERBS, id * 3, 5),
}));

export function topicById(id) {
  return TOPICS[id % TOPICS.length];
}

// ---------------------------------------------------------------------------
// Distinguisher phrases: short concrete details used by the near_dup family
// to give exactly one member of a crowd its "tell". Reused across different
// dup groups is safe (see gen-corpus.mjs's near_dup builder): a query always
// combines the distinguisher with topic-specific terms, and no two dup
// groups share both.
// ---------------------------------------------------------------------------

export const DISTINGUISHER_PHRASES = [
  'the blue mug', 'a cracked tile', 'the borrowed ladder', 'the spare key',
  'the yellow umbrella', 'a flickering porch light', 'the last candle',
  'a torn map', 'the missing screw', 'a cracked charger', 'the wrong wrench',
  'the dented kettle', 'a chipped saucer', 'the loose floorboard',
  'the second coat of paint', 'the leftover marinade', 'a rusty hinge',
  'the borrowed tent', 'a faded blanket', 'the extra flashlight',
  'a squeaky wheel', 'the folded tarp', 'a woolen scarf', 'the spare charger',
  'a secondhand ladder', 'the humid afternoon', 'a frosty morning',
  'the muggy evening', 'a windy porch', 'the overcast sky',
];

// ---------------------------------------------------------------------------
// Dates: fixed reference point plus the exact closed-world template list
// section 3.6 names. Each builder returns both the query TEXT and the exact
// [from, to) range it resolves to, computed directly rather than parsed back
// out of the text -- gen-corpus.mjs controls both sides of the template, so
// there is no ambiguity to resolve.
// ---------------------------------------------------------------------------

export const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export const SEASONS = ['winter', 'spring', 'summer', 'fall'];

// A fixed anchor, independent of wall-clock time, so "last <Month>" always
// resolves the same way regardless of when the generator runs.
export const REFERENCE_NOW = new Date('2026-01-01T00:00:00.000Z');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthRange(year, monthIndex0) {
  const from = new Date(Date.UTC(year, monthIndex0, 1));
  const to = new Date(Date.UTC(year, monthIndex0 + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

function yearRange(year) {
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

// season -> the 3 calendar months it spans, meteorological convention.
const SEASON_MONTHS = { winter: [11, 0, 1], spring: [2, 3, 4], summer: [5, 6, 7], fall: [8, 9, 10] };

function seasonRange(season, year) {
  const months = SEASON_MONTHS[season];
  // Winter spans a year boundary (Dec of `year` through Feb of `year+1`),
  // matching "that winter of <year>" meaning the winter that starts in year.
  if (season === 'winter') {
    const from = new Date(Date.UTC(year, 11, 1));
    const to = new Date(Date.UTC(year + 1, 2, 1));
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const from = new Date(Date.UTC(year, months[0], 1));
  const to = new Date(Date.UTC(year, months[2] + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

// The exhaustive template list DESIGN.md section 3.6 names. `kind` matches
// what tests/engine.test.mjs (owned by Track 3) is expected to enumerate.
export const DATE_TEMPLATE_KINDS = [
  'inMonthYear', 'inYear', 'lastMonth', 'seasonOfYear', 'aroundMonth',
  'beforeYear', 'afterYear', 'bareMonth',
];

export function buildDateTemplate(kind, params) {
  switch (kind) {
    case 'inMonthYear': {
      const { year, monthIndex0 } = params;
      return { text: `in ${MONTHS[monthIndex0]} ${year}`, range: monthRange(year, monthIndex0) };
    }
    case 'inYear': {
      const { year } = params;
      return { text: `in ${year}`, range: yearRange(year) };
    }
    case 'lastMonth': {
      // Relative to REFERENCE_NOW: the most recent occurrence of that month
      // strictly before REFERENCE_NOW's own month.
      const { monthIndex0 } = params;
      let year = REFERENCE_NOW.getUTCFullYear();
      if (monthIndex0 >= REFERENCE_NOW.getUTCMonth()) year -= 1;
      return { text: `last ${MONTHS[monthIndex0]}`, range: monthRange(year, monthIndex0) };
    }
    case 'seasonOfYear': {
      const { season, year } = params;
      return { text: `that ${season} of ${year}`, range: seasonRange(season, year) };
    }
    case 'aroundMonth': {
      // "around <Month>" is deliberately loose: the named month plus the
      // one before and after, still a closed, resolvable range.
      const { year, monthIndex0 } = params;
      const from = new Date(Date.UTC(year, monthIndex0 - 1, 1));
      const to = new Date(Date.UTC(year, monthIndex0 + 2, 1));
      return { text: `around ${MONTHS[monthIndex0]}`, range: { from: from.toISOString(), to: to.toISOString() } };
    }
    case 'beforeYear': {
      const { year } = params;
      return { text: `before ${year}`, range: { from: null, to: new Date(Date.UTC(year, 0, 1)).toISOString() } };
    }
    case 'afterYear': {
      const { year } = params;
      return { text: `after ${year}`, range: { from: new Date(Date.UTC(year + 1, 0, 1)).toISOString(), to: null } };
    }
    case 'bareMonth': {
      // A bare month name with no year is only resolvable relative to
      // REFERENCE_NOW, same as lastMonth's most-recent-occurrence rule.
      const { monthIndex0 } = params;
      let year = REFERENCE_NOW.getUTCFullYear();
      if (monthIndex0 >= REFERENCE_NOW.getUTCMonth()) year -= 1;
      return { text: MONTHS[monthIndex0], range: monthRange(year, monthIndex0) };
    }
    default:
      throw new Error(`unknown date template kind "${kind}"`);
  }
}

// ---------------------------------------------------------------------------
// Rare tokens
// ---------------------------------------------------------------------------

const RARE_CONSONANTS = 'bcdfghjklmnpqrstvwxz';

// A globally-unique-by-construction token like "kbz-4417". Uniqueness across
// the corpus is the caller's job (gen-corpus.mjs tracks a used-set and
// retries on the astronomically rare collision); this function only shapes
// the string.
export function makeRareToken(rng) {
  let letters = '';
  for (let i = 0; i < 3; i++) letters += rng.pick(RARE_CONSONANTS.split(''));
  const digits = pad2(rng.int(0, 99)) + pad2(rng.int(0, 99));
  return `${letters}-${digits}`;
}

assertDisjointRegisters();
