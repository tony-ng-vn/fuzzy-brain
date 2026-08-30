// Unit tests for the local embedding module. The model loads in-process
// from a local cache (first run may download weights -- code coming down,
// never data going up). If the model genuinely cannot load (offline, no
// cache), skip with a clear message instead of failing the whole suite.
import test from "node:test";
import assert from "node:assert/strict";
import { Tensor } from "@huggingface/transformers";

test("embedding cleanup does not replay a failed model load", async () => {
  const { disposeExtractorPromise } = await import("../scripts/lib/embeddings.mjs");
  await assert.doesNotReject(disposeExtractorPromise(Promise.reject(new Error("model unavailable"))));

  let disposed = false;
  await disposeExtractorPromise(Promise.resolve({
    async dispose() {
      disposed = true;
    },
  }));
  assert.equal(disposed, true);
});

test("embedding inference disposes every temporary tensor", async () => {
  const { embedWithExtractor } = await import("../scripts/lib/embeddings.mjs");
  const disposed = new Set();
  const originalDispose = Tensor.prototype.dispose;
  Tensor.prototype.dispose = function () {
    disposed.add(this);
  };
  const tensor = (type, data, dims) => new Tensor(type, data, dims);
  const inputIds = tensor("int64", BigInt64Array.from([1n, 2n, 3n, 0n]), [1, 4]);
  const attentionMask = tensor("int64", BigInt64Array.from([1n, 1n, 1n, 0n]), [1, 4]);
  const hidden = tensor(
    "float32",
    Float32Array.from([
      1, 2, 3,
      2, 3, 4,
      3, 4, 5,
      100, 100, 100,
    ]),
    [1, 4, 3],
  );
  const extractor = {
    tokenizer() {
      return { input_ids: inputIds, attention_mask: attentionMask };
    },
    async model() {
      return { last_hidden_state: hidden };
    },
  };

  try {
    const [embedding] = await embedWithExtractor(extractor, "search_document", ["hello"]);

    assert.equal(embedding.length, 3);
    assert.ok(embedding.every(Number.isFinite));
    assert.ok(disposed.has(inputIds), "token IDs must be released after inference");
    assert.ok(disposed.has(attentionMask), "attention masks must be released after pooling");
    assert.ok(disposed.has(hidden), "the large hidden-state tensor must be released after pooling");
    assert.ok(disposed.size >= 6, "pooled and normalization tensors must also be released");
  } finally {
    Tensor.prototype.dispose = originalDispose;
  }
});

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
