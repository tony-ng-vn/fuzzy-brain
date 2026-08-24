// DESIGN.md 6.3: "tests/engine.test.mjs pins each rule to a fixture query so
// the rules stay readable and a change that silently inverts one fails a test."
//
// Every case here is one that was measured wrong on the dev split and fixed.
// They exist so the fix cannot be silently undone, not to restate the config.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.join(here, '..', 'experiments', 'recall-bench', 'engine.mjs');
const rerankPath = path.join(here, '..', 'experiments', 'recall-bench', 'rerank.mjs');

const engine = await import(pathToFileURL(enginePath));
const { rerank } = await import(pathToFileURL(rerankPath));
const { parseQueryFeatures, laneWeights } = engine;

// A vocabulary shaped like buildMemoryIndex's output. "an" is a person whose
// alias is the indefinite article; "van" is a person whose alias is also a
// vehicle, so its alias appears in far more documents than carry the tag.
// "minh" is an ordinary name: alias df equals tagged-document count.
function fixtureVocab() {
  return {
    totalDocs: 50_000,
    df: new Map([
      ['kettle', 3000], ['spatula', 2800], ['paddle', 2600], ['van', 3800],
      ['minh', 1690], ['drawer', 2400], ['thermostat', 900],
    ]),
    people: new Map([['an', ['an']], ['van', ['van']], ['minh', ['minh']]]),
    peopleDocs: new Map([['an', 1674], ['van', 1658], ['minh', 1690]]),
    places: new Map(),
    stem: (w) => String(w).toLowerCase(),
  };
}

const tunedProfile = { lanes: ['and', 'or', 'vector', 'trigram'], weighting: 'query-dependent', filters: true, rerank: true };

test('the indefinite article is never a person mention', () => {
  const qf = parseQueryFeatures('we carried our feline toward an animal doctor seeking injections', fixtureVocab());
  assert.ok(!qf.entities.people.includes('an'), 'the article "an" must not extract as a person');
  assert.ok(!qf.entities.peopleConfident.includes('an'));
});

test('an alias that is also an ordinary word cannot drive a hard filter', () => {
  const qf = parseQueryFeatures('our hired van showed up well behind schedule that evening', fixtureVocab());
  // Still a mention, so the rerank feature and the AND boost can use it...
  assert.ok(qf.entities.people.includes('van'));
  // ...but never a metadata filter, which deletes rather than reorders.
  assert.ok(!qf.entities.peopleConfident.includes('van'));
});

test('an unambiguous name still drives the filter', () => {
  const qf = parseQueryFeatures('the gutter and the chimney with minh', fixtureVocab());
  assert.ok(qf.entities.peopleConfident.includes('minh'));
});

test('a long out-of-vocabulary query is a paraphrase, not a typo', () => {
  const text = 'what was that spell we took our young hound along that street loop two rounds '
    + 'and our companion bolted instantly once released from its tether somehow';
  const qf = parseQueryFeatures(text, fixtureVocab());
  assert.equal(qf.looksParaphrase, true, 'long + mostly OOV + no entities is the paraphrase shape');
  assert.equal(qf.typoSuspect, false, 'a 20-word query is not a typo, however out-of-vocabulary it looks');

  const w = laneWeights(qf, tunedProfile);
  assert.ok(w.vector > w.and && w.vector > w.or, 'paraphrase queries must be vector-dominant');
  assert.equal(w.or, 0, 'the OR lane is measured noise on this family and is zeroed');
  assert.equal(w.trigram, 0, 'a paraphrase must not switch the trigram lane on');
});

test('a short out-of-vocabulary query is a typo, not a paraphrase', () => {
  const qf = parseQueryFeatures('the trakhrem and the thermostat', fixtureVocab());
  assert.equal(qf.typoSuspect, true);
  assert.equal(qf.looksParaphrase, false);

  const w = laneWeights(qf, tunedProfile);
  assert.ok(w.trigram > 0, 'the trigram lane is the only lane a typo query leaves standing');
});

test('the reranker preserves the fused order it is handed', () => {
  // Three candidates whose fused ranking is 1, 2, 3 but whose other features
  // all point the other way. The fusion prior has to win.
  const qf = { entities: { people: [], places: [] }, dateRange: { from: null, to: null } };
  const candidates = [
    { id: 10, rrf: 0.9, features: { cosine: 0.1, lexical: 0, rareHit: false, titleHit: false, dupGroup: null, occurredAt: null, people: [], tags: [] } },
    { id: 20, rrf: 0.5, features: { cosine: 0.9, lexical: 100, rareHit: true, titleHit: true, dupGroup: null, occurredAt: null, people: [], tags: [] } },
    { id: 30, rrf: 0.1, features: { cosine: 0.8, lexical: 90, rareHit: true, titleHit: true, dupGroup: null, occurredAt: null, people: [], tags: [] } },
  ];
  const out = rerank(qf, candidates);
  assert.deepEqual(out.map((c) => c.id), [10, 20, 30], 'the fused order survives contrary feature evidence');
});
