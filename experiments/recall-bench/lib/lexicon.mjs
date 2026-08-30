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
// Stopwords
//
// Verbatim copy of the file Postgres 17's 'english' text-search config
// actually loads (share/tsearch_data/english.stop, 127 words). It lives here
// rather than in gen-corpus.mjs because both the generator's certification
// and the paraphrase register check need the SAME notion of "content word",
// and that notion has to be Postgres's: a lexeme Postgres drops never reaches
// any tsvector, so two texts sharing one are not sharing content. The older,
// hand-trimmed 24-word list undercounted stopwords, which made the reported
// lexical_overlap numbers noisier than the lanes they are supposed to predict.
// ---------------------------------------------------------------------------

export const PG_ENGLISH_STOPWORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she',
  'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
  'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'this', 'that',
  'these', 'those', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an',
  'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down',
  'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's',
  't', 'can', 'will', 'just', 'don', 'should', 'now',
]);

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
// Paraphrase frames (DESIGN.md 4.1, paraphrase_nolex)
//
// The original implementation of this family drew query words from the
// ABSTRACT_* registers above, which are disjoint from CONCRETE_* by
// construction but also disjoint from them in MEANING: "what was that
// ceremony where we retrieved the endeavor" is not a paraphrase of a memory
// about a skillet and some garlic, it is unrelated text that happens to
// share no stems. Measured against the real embedder (nomic-embed-text-v1.5)
// those queries ranked their targets ~500th by cosine, so the family's own
// solving lane could not solve it and the harness-reported oracle of 1.0 was
// false.
//
// A frame fixes that by describing ONE event twice. Every slot below is a
// pair: `a` is the wording the memory uses, `b` is a synonym/hypernym
// rewording of the same thing for the query. Same event, same participants,
// same salient details, two vocabularies. The honesty rule (zero content-stem
// overlap) is kept by the same mechanism as before -- a static 4-character
// prefix disjointness assertion between the whole A column and the whole B
// column, checked at module load -- so the family name stays literally true
// while the two texts stay about the same thing.
//
// Slots per domain:
//   actions  verb phrase, the core of the event
//   props    a concrete thing present at it
//   mishaps  what went wrong
//   details  one further salient specific
// Shared across domains: aftermaths, reflections (body-only tail), fillers
// (body-only padding), and the scaffolding word lists each side may use.
// ---------------------------------------------------------------------------

export const PARAPHRASE_DOMAINS = [
  {
    slug: 'kitchen',
    actions: [
      { a: 'simmered a pot of beef broth on the stove', b: 'had a deep vessel of meaty stock bubbling atop our burner' },
      { a: 'kneaded dough for bread rolls', b: 'pressed wheat paste into small oven buns' },
      { a: 'chopped onions for a wide pan of curry', b: 'diced sharp bulbs into a broad frying dish of spiced sauce' },
      { a: 'roasted a tray of chicken and potatoes', b: 'oven cooked one sheet of poultry beside some spuds' },
    ],
    props: [
      { a: 'cast iron skillet', b: 'weighty black frying vessel' },
      { a: 'wooden spoon with a split handle', b: 'timber stirrer whose grip had cracked' },
      { a: 'chipped blue mug', b: 'nicked azure drinking cup' },
      { a: 'stack of mismatched plates', b: 'pile of odd dishes' },
    ],
    mishaps: [
      { a: 'the whole pot boiled hard and spilled onto the floor', b: 'our vessel churned wildly and poured across that ground' },
      { a: 'we forgot the salt entirely and had to start again', b: 'seasoning slipped our minds, forcing a fresh attempt' },
      { a: 'the smoke alarm shrieked twice before we noticed', b: 'our fire siren wailed two separate rounds while nobody reacted' },
    ],
    details: [
      { a: 'the window fogged from all the steam', b: 'our glass pane clouded with rising vapour' },
      { a: 'dinner landed on the table close to midnight', b: 'that meal reached our surface near the small hours' },
      { a: 'the recipe card was covered in old grease', b: 'our instruction slip lay smeared with aged fat' },
    ],
  },
  {
    slug: 'repair',
    actions: [
      { a: 'tightened the leaking pipe under the sink', b: 'cranked down a dripping tube beneath our basin' },
      { a: 'rewired the broken lamp in the hallway', b: 'reconnected a busted light along that corridor' },
      { a: 'patched a hole in the plaster wall', b: 'sealed one gap within our chalky partition' },
      { a: 'sanded down the warped cabinet door', b: 'smoothed a twisted cupboard panel' },
    ],
    props: [
      { a: 'rusted wrench from my father', b: 'corroded spanner passed along by dad' },
      { a: 'roll of duct tape', b: 'coil of sticky silver band' },
      { a: 'ladder with a cracked step', b: 'climbing frame bearing a split rung' },
      { a: 'jar of loose screws', b: 'tub of stray fasteners' },
    ],
    mishaps: [
      { a: 'the whole job swallowed an entire weekend', b: 'that chore consumed our full pair of rest days' },
      { a: 'I stripped a screw head by accident', b: 'my careless twist ruined one bolt top' },
      { a: 'we drove back to the store for the right size', b: 'our second trip fetched a proper measure' },
    ],
    details: [
      { a: 'the floor stayed wet for hours afterward', b: 'our ground remained damp long past that point' },
      { a: 'nothing lined up the way the manual promised', b: 'each piece refused what our printed guide claimed' },
      { a: 'the bulbs flickered every time we tested it', b: 'illumination wavered during each trial run' },
    ],
  },
  {
    slug: 'garden',
    actions: [
      { a: 'planted tomato seedlings along the back fence', b: 'set young vine sprouts beside our rear barrier' },
      { a: 'raked the fallen leaves into a pile', b: 'gathered dropped foliage toward one heap' },
      { a: 'mowed the overgrown lawn', b: 'cut our shaggy grass short' },
      { a: 'pruned the rose bushes near the gate', b: 'trimmed those thorny flower shrubs by our entry' },
    ],
    props: [
      { a: 'green watering can', b: 'emerald liquid pourer' },
      { a: 'trowel with a bent tip', b: 'small digging blade whose point was crooked' },
      { a: 'wheelbarrow that squeaked', b: 'single axle cart which creaked' },
      { a: 'bag of dark compost', b: 'sack of rich rotted matter' },
    ],
    mishaps: [
      { a: 'a sudden downpour soaked everything we had laid out', b: 'one abrupt squall drenched all our arranged items' },
      { a: 'the neighbour cat dug up half the row', b: 'that local feline excavated part of our line' },
      { a: 'I snapped the handle clean off', b: 'my grip broke one shaft entirely away' },
    ],
    details: [
      { a: 'the soil smelled sour after the rain', b: 'our earth carried a bitter odour once wet' },
      { a: 'bees kept circling the open blossoms', b: 'insects continued looping around exposed flowers' },
      { a: 'my hands were filthy well past dinner', b: 'both palms stayed grimy long beyond our meal' },
    ],
  },
  {
    slug: 'travel',
    actions: [
      { a: 'missed the last train out of the city', b: 'lost our final rail departure leaving that town' },
      { a: 'drove six hours to the coast', b: 'motored half a day toward our shoreline' },
      { a: 'waited out a long delay at the airport', b: 'sat through an extended holdup inside our terminal' },
      { a: 'walked the whole old quarter before dark', b: 'strolled that entire historic district ahead of nightfall' },
    ],
    props: [
      { a: 'battered suitcase with one wheel', b: 'beaten luggage case having a single caster' },
      { a: 'paper map folded wrong', b: 'printed chart creased badly' },
      { a: 'thermos of cold coffee', b: 'insulated flask holding chilled brew' },
      { a: 'ticket stub in my pocket', b: 'fare receipt tucked inside our coat' },
    ],
    mishaps: [
      { a: 'the hotel had no record of our booking', b: 'that inn showed zero trace of our reservation' },
      { a: 'my phone died before we found the address', b: 'our handset expired ahead of locating that street number' },
      { a: 'we ended up sleeping in the car', b: 'our evening concluded asleep inside a parked vehicle' },
    ],
    details: [
      { a: 'the rain never let up the whole way', b: 'wet weather refused to ease across our journey' },
      { a: 'every restaurant was closed by then', b: 'each eatery had shuttered by that point' },
      { a: 'we quarrelled about the route twice', b: 'our path caused two separate disputes' },
    ],
  },
  {
    slug: 'music',
    actions: [
      { a: 'restrung the old guitar in the garage', b: 'refitted our aged six string within that carport' },
      { a: 'practiced the same four bars for an hour', b: 'repeated identical measures across sixty minutes' },
      { a: 'recorded a rough demo on my laptop', b: 'captured one crude sample using our portable machine' },
      { a: 'played a short set at the corner bar', b: 'performed a brief show inside that neighbourhood pub' },
    ],
    props: [
      { a: 'amplifier that hummed', b: 'sound booster which buzzed' },
      { a: 'cracked plastic pick', b: 'split synthetic plectrum' },
      { a: 'notebook crammed with half finished lyrics', b: 'pad packed with partly written verses' },
      { a: 'microphone borrowed from a friend', b: 'audio capsule lent by our neighbour' },
    ],
    mishaps: [
      { a: 'a wire snapped in the middle of it', b: 'a single cord parted partway through our attempt' },
      { a: 'nobody clapped when we finished', b: 'zero applause arrived once our piece ended' },
      { a: 'the recording came out completely distorted', b: 'that captured audio emerged fully warped' },
    ],
    details: [
      { a: 'my fingertips were sore for days', b: 'both hands ached across several mornings' },
      { a: 'the people upstairs banged on the wall', b: 'our floor above pounded that partition' },
      { a: 'we kept the worst take anyway', b: 'our poorest attempt was retained regardless' },
    ],
  },
  {
    slug: 'pets',
    actions: [
      { a: 'walked the puppy around the block twice', b: 'took our young dog along that street loop two rounds' },
      { a: 'washed the muddy puppy in the bathtub', b: 'scrubbed one filthy young dog inside a deep tub' },
      { a: 'drove the cat to the vet for shots', b: 'carried our feline toward an animal doctor seeking injections' },
      { a: 'trained the puppy to sit for treats', b: 'taught our young dog resting posture in exchange for snacks' },
    ],
    props: [
      { a: 'chewed leash by the door', b: 'gnawed lead strap near our entrance' },
      { a: 'bag of expensive kibble', b: 'sack of costly dry pellets' },
      { a: 'crate lined with an old towel', b: 'carrier padded using an aged cloth' },
      { a: 'squeaky rubber bone', b: 'noisy elastic gnaw toy' },
    ],
    mishaps: [
      { a: 'he chewed through a whole shoe by daybreak', b: 'our animal destroyed one entire boot before sunrise' },
      { a: 'the vet bill came to more than we expected', b: 'that clinic charge exceeded what anyone anticipated' },
      { a: 'she bolted the second I let go', b: 'our pet fled instantly once released' },
    ],
    details: [
      { a: 'the whole car smelled like wet fur', b: 'our vehicle carried a damp coat odour throughout' },
      { a: 'he slept on the bed anyway', b: 'our animal rested atop that mattress regardless' },
      { a: 'the towels never looked right again', b: 'those cloths remained stained permanently' },
    ],
  },
  {
    slug: 'moving',
    actions: [
      { a: 'packed the kitchen into cardboard boxes', b: 'loaded our cooking room within paper cartons' },
      { a: 'carried the couch down three flights', b: 'hauled that sofa along a triple staircase' },
      { a: 'labelled every box with a marker', b: 'tagged each carton using one felt pen' },
      { a: 'cleaned the empty apartment top to bottom', b: 'scrubbed our vacant flat completely' },
    ],
    props: [
      { a: 'roll of bubble wrap', b: 'length of cushioned plastic sheeting' },
      { a: 'dolly borrowed from the landlord', b: 'wheeled trolley lent by our building owner' },
      { a: 'stack of empty boxes', b: 'pile of folded cartons' },
      { a: 'toolbox nobody could find', b: 'equipment chest that vanished' },
    ],
    mishaps: [
      { a: 'the truck arrived four hours late', b: 'our hired van showed up well behind schedule' },
      { a: 'we scratched the doorframe getting it through', b: 'our entry moulding took gouges during that passage' },
      { a: 'half the boxes turned out unlabelled', b: 'many cartons proved to bear no tag whatsoever' },
    ],
    details: [
      { a: 'the elevator broke partway through', b: 'our lift failed midway across that effort' },
      { a: 'we ate pizza on the bare floor', b: 'our meal happened seated upon uncovered ground' },
      { a: 'the keys went back through the letterbox', b: 'those brass openers returned via a mail slot' },
    ],
  },
  {
    slug: 'outdoors',
    actions: [
      { a: 'hiked the ridge trail before sunrise', b: 'climbed that crest path ahead of first light' },
      { a: 'pitched a tent beside the river', b: 'raised our shelter alongside one flowing stream' },
      { a: 'paddled a kayak across the lake', b: 'rowed our narrow boat over that broad pond' },
      { a: 'built a fire from damp wood', b: 'lit our blaze from wet timber' },
    ],
    props: [
      { a: 'heavy backpack with a broken strap', b: 'weighted rucksack whose band had split' },
      { a: 'flashlight that kept dying', b: 'handheld torch which repeatedly quit' },
      { a: 'canteen of warm water', b: 'metal bottle holding tepid liquid' },
      { a: 'folded tarp under the tent', b: 'creased ground sheet below our shelter' },
    ],
    mishaps: [
      { a: 'the trail was washed out halfway up', b: 'our path had eroded partway along that climb' },
      { a: 'we ran out of daylight before the top', b: 'darkness arrived ahead of any summit' },
      { a: 'a storm rolled in and soaked the packs', b: 'one squall struck, drenching all our bags' },
    ],
    details: [
      { a: 'my boots were soaked all the way through', b: 'both shoes had absorbed moisture completely' },
      { a: 'we saw nobody else the entire day', b: 'not one other person crossed our sight' },
      { a: 'the coffee tasted like ash', b: 'our brew carried a burnt cinder flavour' },
    ],
  },
];

// Body-only tail. Never rendered into query text, so only the `a` side is
// used at generation time; the `b` side exists so the pair table stays one
// shape and so a future query template can reach for it.
export const PARAPHRASE_AFTERMATHS = [
  { a: 'we laughed about it on the way home', b: 'that whole business amused everyone afterward' },
  { a: 'neither of them wanted to try again', b: 'zero appetite remained for a repeat attempt' },
  { a: 'it turned into the story we retell', b: 'our retelling has since become a favourite tale' },
  { a: 'we agreed never to plan it that way again', b: 'both sides swore off arranging matters similarly' },
  { a: 'somehow it worked out anyway', b: 'matters resolved themselves eventually' },
  { a: 'the photos from it are terrible', b: 'each picture taken then looks awful' },
];

export const PARAPHRASE_REFLECTIONS = [
  { a: 'I still think about how close it came to going wrong', b: 'our near failure stays on my mind' },
  { a: 'it is the kind of thing you only do once', b: 'nobody repeats such an experience willingly' },
  { a: 'looking back it was mostly my fault', b: 'blame belonged largely to me in hindsight' },
  { a: 'that was the last calm patch before everything changed', b: 'calm ended shortly after, once life shifted' },
  { a: 'I would do the whole thing again tomorrow', b: 'a repeat tomorrow would suit me fine' },
  { a: 'we never did wrap up what we began', b: 'our beginning was left permanently incomplete' },
];

// A-side padding sentences, used only to bin-pack the body into its tier's
// bodyChars window. Deliberately generic: they carry no discriminating
// content, so they cannot leak a signal the query could not have.
export const PARAPHRASE_FILLERS_A = [
  'It ran much later than we planned.',
  'None of it was thought through beforehand.',
  'The whole afternoon disappeared into it.',
  'We stopped twice to argue about the order.',
  'I kept a list that immediately went missing.',
  'It seemed easy enough at the start.',
];

export const PARAPHRASE_TIME_WORDS_B = ['evening', 'morning', 'night', 'spell', 'session', 'occasion'];

// The query templates gen-corpus.mjs renders. Every word outside a slot is a
// Postgres stopword, deliberately: it keeps the disjointness question about
// the frame table alone, where it can be audited by reading two columns.
// (The body side is assembled in gen-corpus.mjs rather than from a template
// string, because it has to drop slots to fit a tier's bodyChars window.)
export const PARAPHRASE_QUERY_TEMPLATES_B = [
  'what was that {time} we {action} and {mishap}',
  'that {time} when {mishap} while we {action}',
  'we {action} that {time}, and {detail}, and {mishap}',
  'the {time} with the {prop}, when we {action} and {mishap}',
];

// A query only ever pairs with a target from its own domain, so the A/B
// disjointness question is per-domain for the domain slots, and global for
// the shared tail (any domain can draw any aftermath/reflection/filler).
//
// Collision test is prefix-4 OR identical approximate stem. Prefix-4 alone is
// a superset of "shares a Snowball stem" only for words of 4+ characters; the
// stem comparison covers the short words ("set"/"setting", "ran"/"running")
// where it is not. gen-corpus.mjs additionally measures the real overlap on
// every rendered case and regenerates on any nonzero result, so this
// assertion is the design-time guard that keeps regeneration rare rather than
// the thing the certificate rests on.
function paraphraseStemKeys(phrase) {
  const keys = [];
  for (const w of String(phrase).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (PG_ENGLISH_STOPWORDS.has(w)) continue;
    keys.push({ word: w, prefix: prefix4(w), stem: crudeStem(w) });
  }
  return keys;
}

// Deliberately the same shape of suffix stripping gen-corpus.mjs uses for its
// own certification, duplicated here so this file has no import cycle with a
// module that imports it.
function crudeStem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('ly')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function collectPhrases(pairs, side) {
  return pairs.map((p) => p[side]);
}

export function assertParaphraseRegisters() {
  const sharedA = [
    ...collectPhrases(PARAPHRASE_AFTERMATHS, 'a'),
    ...collectPhrases(PARAPHRASE_REFLECTIONS, 'a'),
    ...PARAPHRASE_FILLERS_A,
    ...MONTHS,
  ];
  const sharedB = [...PARAPHRASE_TIME_WORDS_B];

  const collisions = [];
  for (const domain of PARAPHRASE_DOMAINS) {
    const aPhrases = [...sharedA];
    const bPhrases = [...sharedB];
    for (const slot of ['actions', 'props', 'mishaps', 'details']) {
      aPhrases.push(...collectPhrases(domain[slot], 'a'));
      bPhrases.push(...collectPhrases(domain[slot], 'b'));
    }
    const byPrefix = new Map();
    const byStem = new Map();
    for (const phrase of aPhrases) {
      for (const k of paraphraseStemKeys(phrase)) {
        if (!byPrefix.has(k.prefix)) byPrefix.set(k.prefix, k.word);
        if (!byStem.has(k.stem)) byStem.set(k.stem, k.word);
      }
    }
    for (const phrase of bPhrases) {
      for (const k of paraphraseStemKeys(phrase)) {
        const hit = byPrefix.get(k.prefix) ?? byStem.get(k.stem);
        if (hit) collisions.push(`${domain.slug}: ${k.word} ~ ${hit}`);
      }
    }
  }

  if (collisions.length > 0) {
    const unique = [...new Set(collisions)];
    throw new Error(
      `lexicon.mjs: ${unique.length} paraphrase B-side word(s) collide with an A-side word in the same domain: ` +
      `${unique.join(', ')}. This breaks paraphrase_nolex's zero-Jaccard guarantee -- ` +
      `reword the frame table, do not weaken the check.`,
    );
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
// A pronounceable one-off name ("korvant", "belmoth") for the typo_noisy
// family. DESIGN.md 4.1 says that family corrupts "the discriminating term",
// and the trigram lane can only earn a target back when the term it scores
// actually separates it: a corrupted CONCRETE_NOUN does not, because the
// topic pools are seven words wide and filler memories redraw from them
// constantly, so hundreds of memories contain the same noun and score the
// same extent. Deliberately letters-only so it never looks like a
// rare_token ("kbz-4417"), which is a different family's device.
const RARE_ONSETS = ['br', 'dr', 'gr', 'kr', 'pl', 'tr', 'vl', 'zh', 'kh', 'sm', 'th', 'fr'];
const RARE_NUCLEI = ['a', 'e', 'i', 'o', 'u', 'ae', 'ou', 'ei'];
const RARE_CODAS = ['nt', 'sk', 'rm', 'th', 'ld', 'mp', 'rk', 'ns', 'ft', 'lm'];

export function makeRareWord(rng) {
  const first = `${rng.pick(RARE_ONSETS)}${rng.pick(RARE_NUCLEI)}`;
  const second = `${rng.pick(RARE_ONSETS)}${rng.pick(RARE_NUCLEI)}${rng.pick(RARE_CODAS)}`;
  return `${first}${second}`;
}

export function makeRareToken(rng) {
  let letters = '';
  for (let i = 0; i < 3; i++) letters += rng.pick(RARE_CONSONANTS.split(''));
  const digits = pad2(rng.int(0, 99)) + pad2(rng.int(0, 99));
  return `${letters}-${digits}`;
}

assertDisjointRegisters();
assertParaphraseRegisters();
