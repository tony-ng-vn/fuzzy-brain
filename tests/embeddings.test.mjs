// Unit tests for the local embedding module. The model loads in-process
// from a local cache (first run may download weights -- code coming down,
// never data going up). If the model genuinely cannot load (offline, no
// cache), skip with a clear message instead of failing the whole suite.
import test from "node:test";
import assert from "node:assert/strict";
import { Tensor } from "@huggingface/transformers";

// A fake interval clock, so the idle-release policy is testable without waiting
// ten minutes or loading 547 MB of weights. It mirrors the real contract
// exactly: setTimer hands back a handle carrying unref, clearTimer takes that
// same handle back, and a fired timer reschedules itself the way setInterval
// does. `advance` runs every timer that came due, in order.
function fakeClock() {
  let current = 1_000_000;
  const scheduled = new Map();
  return {
    now: () => current,
    setTimer(fn, ms) {
      const handle = { unref() {} };
      scheduled.set(handle, { fn, every: ms, due: current + ms });
      return handle;
    },
    clearTimer(handle) {
      scheduled.delete(handle);
    },
    async advance(ms) {
      const target = current + ms;
      // Repeatedly take the earliest due timer and run it, since a callback
      // may clear other timers or rearm itself. The callback must observe the
      // time this tick was DUE, not the time of the next one, or a policy that
      // compares against "now" reads a tick into the future every time.
      for (;;) {
        const due = [...scheduled].filter(([, e]) => e.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        const entry = due[1];
        current = Math.max(current, entry.due);
        entry.due += entry.every;
        await entry.fn();
      }
      current = target;
    },
    get armed() {
      return scheduled.size;
    },
  };
}

// A one-shot fake extractor. Enough surface for embedWithExtractor, and it
// optionally parks on a gate so a test can hold an inference open.
function fakeExtractor({ gate = null } = {}) {
  const token = new Tensor("int64", BigInt64Array.from([1n, 1n]), [1, 2]);
  const mask = new Tensor("int64", BigInt64Array.from([1n, 1n]), [1, 2]);
  const hidden = new Tensor("float32", Float32Array.from([1, 2, 3, 4]), [1, 2, 2]);
  return {
    tokenizer: () => ({ input_ids: token, attention_mask: mask }),
    model: async () => {
      if (gate) await gate;
      return { last_hidden_state: hidden };
    },
  };
}

test("the idle window is measured from the last inference, not from arming", async () => {
  const { embedWithExtractor, startEmbeddingIdleRelease, stopEmbeddingIdleRelease } =
    await import("../scripts/lib/embeddings.mjs");
  const clock = fakeClock();
  let disposals = 0;
  startEmbeddingIdleRelease({
    idleMs: 600_000,
    dispose: () => { disposals += 1; },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  try {
    // A server nobody has asked anything of holds no model worth keeping, so
    // a long quiet stretch releases it.
    await clock.advance(5 * 3_600_000);
    assert.equal(disposals, 1, "a model nobody used is released once the window closes");

    // Now the interesting half. Answering a question must restart the window,
    // so the release is measured from that use rather than from arming.
    await embedWithExtractor(fakeExtractor(), "search_query", ["hello"]);
    await clock.advance(599_000);
    assert.equal(disposals, 1, "still inside the window that follows real use");
    assert.ok(clock.armed > 0, "the reaper stays armed while the model is in use");

    await clock.advance(2_000);
    assert.equal(disposals, 2, "the window restarts from the last question, not from arming");
  } finally {
    stopEmbeddingIdleRelease();
  }
});

test("a zero idle window keeps the model resident for the life of the process", async () => {
  const { embedWithExtractor, startEmbeddingIdleRelease, stopEmbeddingIdleRelease } =
    await import("../scripts/lib/embeddings.mjs");
  const clock = fakeClock();
  let disposals = 0;
  startEmbeddingIdleRelease({
    idleMs: 0,
    dispose: () => { disposals += 1; },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  try {
    await embedWithExtractor(fakeExtractor(), "search_query", ["hello"]);
    await clock.advance(3 * 3_600_000);
    assert.equal(disposals, 0);
    assert.equal(clock.armed, 0, "no timer is armed at all when the window is off");
  } finally {
    stopEmbeddingIdleRelease();
  }
});

test("inference in progress is never interrupted by the idle reaper", async () => {
  const { embedWithExtractor, startEmbeddingIdleRelease, stopEmbeddingIdleRelease } =
    await import("../scripts/lib/embeddings.mjs");
  const clock = fakeClock();
  let disposals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  startEmbeddingIdleRelease({
    idleMs: 1_000,
    dispose: () => { disposals += 1; },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  try {
    // model() parks on the gate, so the deadline passes with the caller still
    // waiting on the model. Disposing here would take the answer away.
    const pending = embedWithExtractor(fakeExtractor({ gate }), "search_document", ["hello"]);
    await clock.advance(5_000);
    assert.equal(disposals, 0, "a model mid-inference is not disposed underneath the caller");

    release();
    await pending;
    await clock.advance(1_000);
    assert.equal(disposals, 1, "the model is released once the caller is finished with it");
  } finally {
    stopEmbeddingIdleRelease();
  }
});

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
