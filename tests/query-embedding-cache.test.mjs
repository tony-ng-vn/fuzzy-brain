// Unit tests for the bounded query-embedding cache in scripts/lib/embeddings.mjs.
// No model, no network, no weights: embedFn is stubbed so this suite never
// touches the real embedder and stays fast and offline.
import test from "node:test";
import assert from "node:assert/strict";
import { LruCache, normalizeQueryText, embedQueryCached } from "../scripts/lib/embeddings.mjs";

test("normalizeQueryText: trim, collapse whitespace, lowercase", () => {
  assert.equal(normalizeQueryText("  Where does my Girlfriend live?  "), "where does my girlfriend live?");
  assert.equal(normalizeQueryText("a\tb\n\nc   d"), "a b c d");
  assert.equal(normalizeQueryText("ALREADY lower"), "already lower");
  assert.equal(normalizeQueryText(""), "");
});

test("LruCache: get/set, capacity, and least-recently-used eviction", () => {
  const cache = new LruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.size, 2);

  // touching "a" makes "b" the least-recently-used entry
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined, "b should have been evicted");
  assert.equal(cache.get("a"), 1, "a was touched, should survive");
  assert.equal(cache.get("c"), 3);
});

test("LruCache: rejects a non-positive-integer capacity", () => {
  assert.throws(() => new LruCache(0));
  assert.throws(() => new LruCache(-1));
  assert.throws(() => new LruCache(1.5));
});

test("embedQueryCached: a cache hit skips the embed call", async () => {
  const cache = new LruCache(10);
  let calls = 0;
  const embedFn = async (text) => {
    calls += 1;
    return [text.length];
  };

  const first = await embedQueryCached("Where does my girlfriend live?", { cache, embedFn });
  const second = await embedQueryCached("Where does my girlfriend live?", { cache, embedFn });
  assert.deepEqual(first, second);
  assert.equal(calls, 1, "second call should be a cache hit, not a re-embed");
});

test("embedQueryCached: normalisation makes near-duplicate queries share a cache entry", async () => {
  const cache = new LruCache(10);
  let calls = 0;
  const embedFn = async (text) => {
    calls += 1;
    return [text.length];
  };

  await embedQueryCached("  Where does my girlfriend live?  ", { cache, embedFn });
  await embedQueryCached("where does my girlfriend live?", { cache, embedFn });
  await embedQueryCached("WHERE   DOES MY GIRLFRIEND LIVE?", { cache, embedFn });
  assert.equal(calls, 1, "trim/whitespace/case variants should all hit the same cache entry");
});

test("embedQueryCached: distinct queries evict under a small capacity", async () => {
  const cache = new LruCache(1);
  const embedFn = async (text) => [text.length];

  await embedQueryCached("first question", { cache, embedFn });
  await embedQueryCached("second question", { cache, embedFn });
  assert.equal(cache.get(normalizeQueryText("first question")), undefined, "capacity 1 should have evicted the first entry");
  assert.notEqual(cache.get(normalizeQueryText("second question")), undefined);
});
