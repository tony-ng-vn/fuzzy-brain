// Unit tests for the local embedding module. The model loads in-process
// from a local cache (first run may download weights -- code coming down,
// never data going up). If the model genuinely cannot load (offline, no
// cache), skip with a clear message instead of failing the whole suite.
import test from "node:test";
import assert from "node:assert/strict";

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

test("local embeddings: dimension, normalization, and semantic ordering", async (t) => {
  // A missing or broken module is a build failure; only a model that cannot
  // load (offline, no cached weights) earns a skip.
  const mod = await import("../scripts/lib/embeddings.mjs");
  let docA, docB, docC, query;
  try {
    [docA, docB, docC] = await Promise.all([
      mod.embedDocument("my girlfriend moved to arizona and we are doing long distance"),
      mod.embedDocument("she lives far away in the southwest and we only see each other sometimes"),
      mod.embedDocument("the database migration added a gin index to the evidence table"),
    ]);
    query = await mod.embedQuery("where does my girlfriend live?");
  } catch (err) {
    t.skip(`embedding model unavailable (${err.message}); run once online to cache the weights`);
    return;
  }

  await t.test("embeddings are 768-dim float arrays", () => {
    for (const v of [docA, docB, docC, query]) {
      assert.equal(v.length, 768);
      assert.ok(v.every((x) => typeof x === "number" && Number.isFinite(x)));
    }
  });

  await t.test("embeddings are unit-normalized (cosine ready)", () => {
    for (const v of [docA, docB, docC, query]) {
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit norm, got ${norm}`);
    }
  });

  await t.test("related sentences land closer than unrelated ones", () => {
    const related = cosine(docA, docB);
    const unrelatedA = cosine(docA, docC);
    const unrelatedB = cosine(docB, docC);
    assert.ok(related > unrelatedA, `related ${related} must beat unrelated ${unrelatedA}`);
    assert.ok(related > unrelatedB, `related ${related} must beat unrelated ${unrelatedB}`);
  });

  await t.test("a query lands nearer its answering document than an off-topic one", () => {
    const onTopic = cosine(query, docA);
    const offTopic = cosine(query, docC);
    assert.ok(onTopic > offTopic, `on-topic ${onTopic} must beat off-topic ${offTopic}`);
  });
});
