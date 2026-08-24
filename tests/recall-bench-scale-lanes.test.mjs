// Pins the scale-path lexical redesign from DESIGN.md 6.6: rare-term anchoring,
// the candidate caps, the AND-first gate, and query-side spell correction.
//
// Two halves, same reason recall-bench-rrf.test.mjs has two halves. The first
// exercises engine.scaleQueryParams directly, because that function is where
// the anchoring decision actually gets made. The second reads the SQL the
// engine emits and asserts the bounds are really in it -- an anchoring rule
// that picks the right terms is worthless if the statement then ranks an
// unbounded candidate set anyway.
//
// Runs with no database: scaleQueryParams takes a vocab object, and
// buildRetrievalSql is pure string construction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const benchRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'experiments', 'recall-bench');
const engine = await import(pathToFileURL(join(benchRoot, 'engine.mjs')));
const { config, resolveTier } = await import(pathToFileURL(join(benchRoot, 'config.mjs')));

const { parseQueryFeatures, scaleQueryParams, buildRetrievalSql, vectorSessionSettings } = engine;

const scaleTier = resolveTier('rehearsal1m');
const qualityTier = resolveTier('quality50k');
const scaleCfg = config.lanes.scale;

// A vocabulary shaped exactly like lib/term-stats.mjs writes it: surface word ->
// { lexemes, frag, ndoc }. The frequencies below bracket the real corpus --
// "gravel" sits at the ~24,000 the cross-topic nouns really measure, "trowel"
// and "kbz" are inside the anchor budget, and "took" is the common-word case.
function vocabOf(entries) {
  const terms = new Map();
  const df = new Map();
  for (const [term, ndoc, lexemes] of entries) {
    const lex = lexemes ?? [term];
    terms.set(term, { lexemes: lex, frag: lex.map((l) => `'${l}'`).join(' & '), ndoc });
    for (const l of lex) df.set(l, ndoc);
  }
  return { totalDocs: 1_000_000, df, terms };
}

const VOCAB = vocabOf([
  ['took', 540_000],
  ['gravel', 24_925],
  ['staircase', 24_109],
  ['trowel', 180],
  ['lantern', 90],
  ['ochre', 12],
  ['kbz-4417', 1, ['kbz', '-4417']],
]);

function paramsFor(text, vocab = VOCAB) {
  return scaleQueryParams(parseQueryFeatures(text, vocab, config), vocab, config);
}

// --- anchoring ------------------------------------------------------------

test('the OR lane anchors on the rarest terms and drops the common ones entirely', () => {
  const p = paramsFor('the ochre lantern that we took');

  assert.deepEqual(p.anchorTerms, ['ochre', 'lantern'], 'anchors must be rarest first');
  assert.equal(p.anchorDf, 102, 'anchorDf is the cumulative document frequency of the anchors');
  assert.ok(!p.orFrags.includes("'took'"), 'a 540,000-document term must never reach the OR tsquery');
  assert.match(p.orFrags, /\('ochre'\) \| \('lantern'\)/);

  // The AND lane is unaffected: every in-vocabulary term still has to appear.
  assert.match(p.andFrags, /\('took'\)/);
});

test('anchors stop at the cumulative document-frequency budget', () => {
  const p = paramsFor('the ochre lantern trowel');
  // ochre(12) + lantern(90) = 102; adding trowel(180) would reach 282, still
  // inside the 300 budget, so all three anchor.
  assert.deepEqual(p.anchorTerms, ['ochre', 'lantern', 'trowel']);
  assert.ok(p.anchorDf <= scaleCfg.orAnchorDfBudget);

  const wide = vocabOf([['ochre', 12], ['lantern', 90], ['trowel', 250]]);
  const q = scaleQueryParams(parseQueryFeatures('the ochre lantern trowel', wide, config), wide, config);
  assert.deepEqual(q.anchorTerms, ['ochre', 'lantern'], 'trowel would push cumulative df past the budget');
});

test('anchors never exceed orAnchorMaxTerms even when every term is rare', () => {
  const rare = vocabOf([['aa', 1], ['bb', 2], ['cc', 3], ['dd', 4], ['ee', 5]]);
  const p = scaleQueryParams(parseQueryFeatures('aa bb cc dd ee', rare, config), rare, config);
  assert.equal(p.anchorTerms.length, scaleCfg.orAnchorMaxTerms);
  assert.deepEqual(p.anchorTerms, ['aa', 'bb', 'cc']);
});

test('the OR lane stands down when even the rarest term is not selective', () => {
  // Both terms sit around 24,000 documents, far past the 400-row candidate cap.
  // Running the lane could only return an arbitrary 400-row slice, so it is
  // switched off rather than paid for. Measured cost of NOT doing this: 4.4 ms
  // of to_tsvector recompute per query for a ~1.7% chance of the target.
  const p = paramsFor('the gravel and the staircase');
  assert.equal(p.orSelective, false);
  assert.equal(p.orFrags, null, 'no OR tsquery means the SQL falls through to its no-match sentinel');
  assert.deepEqual(p.anchorTerms, []);
  assert.ok(p.anchorDf > scaleCfg.orCandidateCap, 'fixture must actually exceed the cap');

  // The AND lane and its terms are untouched -- the query is still served.
  assert.match(p.andFrags, /\('gravel'\)/);
  assert.match(p.andFrags, /\('staircase'\)/);
});

test('a surface word that parses into several lexemes becomes a conjunction fragment', () => {
  // Postgres's english parser splits "kbz-4417" into 'kbz' and '-4417', so the
  // correct query fragment for that one word is a conjunction, not a lexeme.
  const p = paramsFor('the reference code kbz-4417');
  assert.match(p.orFrags, /\('kbz' & '-4417'\)/);
  assert.ok(p.baseLexemes.includes('kbz') && p.baseLexemes.includes('-4417'),
    'both lexemes must reach the fragment bar');
});

// --- spell correction -----------------------------------------------------

test('out-of-vocabulary terms are only sent for correction once the query looks like a typo', () => {
  // One unknown word out of two clears the oov ratio floor.
  const typo = paramsFor('the greidreim and the staircase');
  assert.deepEqual(typo.oovTerms, ['greidreim']);

  // One unknown word out of four does not: a query mostly made of real words is
  // likelier to name something the corpus does not contain than to be a typo.
  const proper = paramsFor('the ochre lantern trowel gravelly');
  assert.equal(proper.oovTerms.length, 0);
  assert.ok(proper.oovRatio < config.weighting.oovRatioFloor);
});

test('at most spellMaxTerms corrections are attempted per query', () => {
  const p = paramsFor('zzaa zzbb zzcc zzdd zzee');
  assert.equal(p.oovTerms.length, scaleCfg.spellMaxTerms);
});

test('an empty vocabulary degrades to a vector-only query rather than throwing', () => {
  const empty = { totalDocs: 1, df: new Map(), terms: new Map() };
  const p = scaleQueryParams(parseQueryFeatures('the ochre lantern', empty, config), empty, config);
  assert.equal(p.andFrags, null);
  assert.equal(p.orFrags, null);
  assert.deepEqual(p.baseLexemes, []);
});

// --- the emitted SQL ------------------------------------------------------

const scaleSql = buildRetrievalSql(scaleTier, config.profiles.tunedScale, config).text;

test('both lexical lanes cap their candidate set before anything is ranked', () => {
  assert.match(scaleSql, new RegExp(`and_cand as materialized \\([\\s\\S]*?limit ${scaleCfg.andCandidateCap}\\n\\)`));
  assert.match(scaleSql, new RegExp(`or_cand as materialized \\([\\s\\S]*?limit ${scaleCfg.orCandidateCap}\\n\\)`));
  // materialized, not inlined: an inlined candidate CTE lets the planner
  // re-evaluate to_tsvector once per reference instead of once per row.
  assert.doesNotMatch(scaleSql, /_cand as not materialized/);
});

test('the OR lane is gated on the AND lane through a single uncorrelated subquery', () => {
  assert.match(
    scaleSql,
    new RegExp(`and \\(select count\\(\\*\\) from and_lane\\) < ${scaleCfg.andFirstThreshold}`),
    'AND-first must be expressed inside the one statement, not as a second round trip',
  );
});

test('the fragment bar compares lexeme arrays instead of parsing a tsquery per row', () => {
  assert.match(scaleSql, /where x = any\(c\.lex\)/);
  assert.doesNotMatch(scaleSql, /to_tsquery\('english', ql\)/);
  assert.match(scaleSql, />= least\(2, cardinality\(q\.bar_lex\)\)/, "the bar itself is still min(2, terms)");
});

test('spell correction reads the term_stats trigram index and nothing else', () => {
  assert.match(scaleSql, new RegExp(`from ${scaleTier.schema}\\.term_stats v`));
  assert.match(scaleSql, /where v\.term % t and similarity\(v\.term, t\) >= /);
  // The whole point of correcting query-side: no trigram index on the corpus.
  assert.doesNotMatch(scaleSql, /word_similarity/);
});

test('the vector lane reads the query vector straight off the bind parameter', () => {
  // Routing it through a CTE is what turned this lane into a sequential scan
  // plus an external sort at 1M. Assert the ORDER BY names the parameter.
  assert.match(scaleSql, /order by m\.embedding <=> \$\d+::halfvec\n  limit/);
  assert.doesNotMatch(scaleSql, /q\.vec/);
});

test('the lexical rerank feature rides out of the lanes rather than being recomputed', () => {
  assert.match(scaleSql, /max\(score\) as lexical/);
  assert.match(scaleSql, /coalesce\(t\.lexical, 0\)::real as lexical/);
  // 50 more to_tsvector calls per query is ~0.55 ms at the measured 11 us each.
  const finalSelect = scaleSql.slice(scaleSql.indexOf('select t.id, t.rrf'));
  assert.doesNotMatch(finalSelect, /ts_rank_cd/);
});

test('the scale statement still travels as one prepared statement over three lanes', () => {
  const built = buildRetrievalSql(scaleTier, config.profiles.tunedScale, config);
  assert.match(built.name, /^retrieve_bench_r1m_/);
  assert.equal((scaleSql.match(/\$\d+::float \/ \(\d+ \+ rnk\)/g) ?? []).length, 3);
  assert.equal(scaleSql.split(';').length, 1, 'one statement, not a script');
});

// --- the quality tier must not have moved ---------------------------------

test('the quality tier keeps the SQL it was calibrated against', () => {
  const sql = buildRetrievalSql(qualityTier, config.profiles.tuned, config).text;
  assert.match(sql, /with q as not materialized/);
  assert.match(sql, /websearch_to_tsquery\('english', \$1\)/);
  assert.match(sql, /word_similarity\(q\.raw_text/);
  assert.match(sql, /ts_rank_cd\(m\.fts, q\.orq\)\s+as lexical/, 'lexical is still recomputed at the top');
  assert.doesNotMatch(sql, /and_cand/, 'no candidate cap at the quality tier');
  assert.doesNotMatch(sql, /term_stats/, 'no spell correction at the quality tier');
});

test('the filtered vector lane uses iterative scan at scale and the old ef_search at quality', () => {
  const scaleFiltered = vectorSessionSettings(scaleTier, config, true);
  assert.match(scaleFiltered, new RegExp(`hnsw.iterative_scan = ${scaleCfg.filteredIterativeScan}`));
  assert.match(scaleFiltered, new RegExp(`hnsw.max_scan_tuples = ${scaleCfg.filteredMaxScanTuples}`));
  assert.match(scaleFiltered, new RegExp(`hnsw.ef_search = ${scaleCfg.filteredEfSearch}`));

  assert.match(vectorSessionSettings(scaleTier, config, false), /hnsw.iterative_scan = off/);

  const qualityFiltered = vectorSessionSettings(qualityTier, config, true);
  assert.match(qualityFiltered, new RegExp(`hnsw.ef_search = ${config.lanes.filteredEfSearch}`));
  assert.match(qualityFiltered, /hnsw.iterative_scan = off/, 'quality tier behaviour is unchanged');
});

test('the trigram lane is still refused on a synthetic tier', () => {
  assert.throws(
    () => buildRetrievalSql(scaleTier, config.profiles.tuned, config),
    /trigram lane requested on a synthetic-vector tier/,
  );
});
