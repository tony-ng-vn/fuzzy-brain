// Local, in-process embeddings -- the ratified privacy shape: evidence text
// NEVER leaves this machine to be embedded. The one network touch is the
// first-run download of model weights from the Hugging Face hub into
// ~/.fuzzy-brain/models (code and weights coming down, never data going up).
//
// Model: nomic-ai/nomic-embed-text-v1.5 (768-dim, 8192-token window).
// Verified from the model card (2026-07-16):
// - Task prefixes are MANDATORY: "search_document: " for stored text,
//   "search_query: " for questions. Mixing them up degrades retrieval.
// - The documented recipe is mean pooling -> layer_norm over the feature
//   dim -> L2 normalize; the matryoshka slice between those steps is
//   omitted because we keep the native 768 dims.
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline, layer_norm, mean_pooling, env } from "@huggingface/transformers";

// Machine-local cache outside node_modules so a reinstall never re-downloads.
env.cacheDir = join(homedir(), ".fuzzy-brain", "models");

const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
export const EMBEDDING_DIM = 768;

// ONNX Runtime sizes its own intra-op thread pool when the session is built
// without session_options, and on this workload that default is the single
// largest source of heat in the whole system. Measured on a 12-core M-series
// Mac, same weights, same batch of real evidence rows, only the thread count
// varying:
//
//   threads   rows/s   CPU-seconds per 1000 rows   cores busy
//        2     12.30                        155                 1.91
//        3      6.72                        397                 2.67
//        6      8.25                        641                 5.28
//   default    7.18                        667                 4.79
//       12      1.53                      5233                 7.98
//
// More threads is both slower and hotter, which is the whole point: inference
// here is a batch of one row at up to 1000 tokens, so the matmuls are too
// small to amortize the pool's synchronization. Past two workers the threads
// spend their time spinning and contending for memory bandwidth. The default
// pool burned 4.3x the CPU of two threads for a result 71% slower, and the
// twelve-thread pool burned 7.2x for a result 39% slower.
//
// Two is a floor, not a ceiling, so an explicit override is honored:
// EMBEDDING_THREADS=1 for a laptop that must stay cool, higher only if a
// future workload is genuinely thread-bound rather than bandwidth-bound.
const INFER_THREADS = Number.parseInt(process.env.EMBEDDING_THREADS ?? "", 10);
const DEFAULT_INFER_THREADS = 2;
const intraOpNumThreads =
  Number.isInteger(INFER_THREADS) && INFER_THREADS >= 1 ? INFER_THREADS : DEFAULT_INFER_THREADS;
// interOp stays sequential. There is one model and one request shape here, so
// a second parallel-for pool has nothing to schedule and only adds contention.
const SESSION_OPTIONS = Object.freeze({ intraOpNumThreads, interOpNumThreads: 1 });

// Embed only the head of very long spans: the head carries a span's
// identity for retrieval, and full-window (8192-token) inference over tens
// of thousands of pasted-transcript spans would turn a CPU sweep into a
// multi-hour job. Full-text search still covers what the head cap skips.
const EMBED_CHAR_CAP = 4000;

let extractorPromise = null;
function loadExtractor() {
  // fp32 weights: reference quality; the sweep is a rare batch job, so
  // fidelity wins over quantized speed.
  //
  // A rejected load must not stick. It used to clear itself: every recall was
  // its own process and disposed the model on the way out, so the next
  // question retried the load. In a resident server one transient failure
  // would otherwise leave the vector lane dead for the life of the process,
  // and every answer would quietly come back from the text lanes alone.
  extractorPromise ??= pipeline("feature-extraction", MODEL_ID, { dtype: "fp32", session_options: SESSION_OPTIONS }).catch((err) => {
    extractorPromise = null;
    throw err;
  });
  return extractorPromise;
}

async function embed(prefix, texts) {
  const extractor = await loadExtractor();
  return embedWithExtractor(extractor, prefix, texts);
}

function disposeTensors(...containers) {
  const tensors = new Set();
  const visited = new Set();
  const collect = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (typeof value.dispose === "function" && Array.isArray(value.dims)) {
      tensors.add(value);
      return;
    }
    for (const child of Object.values(value)) collect(child);
  };
  for (const container of containers) collect(container);
  for (const tensor of tensors) tensor.dispose();
}

export async function embedWithExtractor(extractor, prefix, texts) {
  const inputs = texts.map((t) => `${prefix}: ${String(t).slice(0, EMBED_CHAR_CAP)}`);
  let modelInputs;
  let outputs;
  let pooled;
  let layerNormalized;
  let normalized;
  beginInference();
  try {
    modelInputs = extractor.tokenizer(inputs, { padding: true, truncation: true });
    outputs = await extractor.model(modelInputs);
    const hidden = outputs.last_hidden_state ?? outputs.logits ?? outputs.token_embeddings;
    if (!hidden) throw new Error("embedding model returned no hidden state");
    pooled = mean_pooling(hidden, modelInputs.attention_mask);
    layerNormalized = layer_norm(pooled, [pooled.dims[1]]);
    normalized = layerNormalized.normalize(2, -1);
    return normalized.tolist();
  } finally {
    endInference();
    disposeTensors(normalized, layerNormalized, pooled, outputs, modelInputs);
  }
}

// Releasing an idle model, and why the default exists.
//
// A resident MCP server answers a question in-process precisely so it does not
// pay the model load twice. Measured here, that load is 0.3s warm and about
// 1.9s cold, against roughly 600ms of actual searching, so holding the model
// across questions is worth it. Holding it forever is not: the fp32 session
// peaks near 1.9 GB resident, which is roughly three and a half times the
// weight file because ONNX keeps an activation arena sized to the longest
// sequence it has seen. Several agent sessions can be talking to the brain at
// once, and each of those processes was holding that 1.9 GB until its host
// disconnected. An abandoned session could sit on the memory for hours.
//
// So the model follows the same rule the connection pool already follows: warm
// while someone is talking, released once nobody is. The default window is ten
// minutes, comfortably longer than any pause inside a conversation, so an
// active session never pays a reload. Set EMBEDDING_IDLE_RELEASE_MS to tune
// it, or to 0 to keep the old hold-forever behavior.
const DEFAULT_IDLE_RELEASE_MS = 10 * 60_000;

// Inference is counted rather than timed, because a question can outlive its
// own window: a slow embed that started before the deadline must not have the
// model pulled out from under it.
let inferenceCount = 0;
let lastInferenceAt = 0;
let idleRelease = null;
// Inference stamps the last-use time through the same clock the reaper reads,
// so a caller that injects a clock for testing gets a coherent pair. Mixing a
// real Date.now() here against an injected now() there makes the window
// unmeasurable rather than merely fake.
let clockNow = Date.now;

function beginInference() {
  inferenceCount += 1;
  lastInferenceAt = clockNow();
  idleRelease?.rearm();
}

function endInference() {
  inferenceCount = Math.max(0, inferenceCount - 1);
}

/**
 * Arm a timer that disposes the model once it has gone unused for `idleMs`.
 *
 * Injectable on every moving part so the policy is testable without waiting ten
 * minutes or loading 547 MB of weights. Returns a handle with `rearm()` and
 * `stop()`; `stop()` disarms without disposing, so a caller shutting down can
 * still own teardown itself.
 */
export function startEmbeddingIdleRelease({
  idleMs = Number.parseInt(process.env.EMBEDDING_IDLE_RELEASE_MS ?? "", 10) || DEFAULT_IDLE_RELEASE_MS,
  dispose = disposeEmbeddingModel,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (!(idleMs > 0)) return { rearm() {}, stop() {} };
  idleRelease?.stop();
  clockNow = now;
  // Start measuring from arming, so a server that boots and is never asked
  // anything does not treat "no inference yet" as "idle since the epoch".
  // Arming happens before the first question, so this only ever delays a
  // release that nothing was waiting on.
  lastInferenceAt = now();

  let timer = null;
  const check = async () => {
    // An inference in flight owns the model until it finishes.
    if (inferenceCount > 0 || now() - lastInferenceAt < idleMs) return;
    handle.stop();
    // Best effort, exactly like the shutdown path: a failed release must not
    // take the server down, and the next question reloads the model anyway.
    await dispose();
  };
  const handle = {
    rearm() {
      handle.stop();
      // Polling at the window's own length would let a check land up to a full
      // window late; a short poll keeps the release close to when it is due.
      timer = setTimer(check, Math.min(idleMs, 30_000));
      // The reaper must never be the reason the process stays alive.
      timer.unref?.();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
  handle.rearm();
  idleRelease = handle;
  return handle;
}

/** Disarm the idle reaper without disposing. Used on shutdown paths. */
export function stopEmbeddingIdleRelease() {
  idleRelease?.stop();
  idleRelease = null;
  clockNow = Date.now;
}

export async function disposeEmbeddingModel() {
  const pending = extractorPromise;
  extractorPromise = null;
  await disposeExtractorPromise(pending);
}

export async function disposeExtractorPromise(pending) {
  if (!pending) return;
  let extractor;
  try {
    extractor = await pending;
  } catch {
    // A failed model load has nothing to dispose. Cleanup must not replay
    // that failure after recall has deliberately fallen back to text search.
    return;
  }
  try {
    await extractor.dispose();
  } catch {
    // Disposal is best-effort cleanup and must not replace the real result.
  }
}

/** Embed stored texts (evidence quotes, node text). Returns 768-float arrays. */
export async function embedDocuments(texts) {
  return embed("search_document", texts);
}

export async function embedDocument(text) {
  return (await embedDocuments([text]))[0];
}

/** Embed a question for retrieval against embedDocument vectors. */
export async function embedQuery(text) {
  return (await embed("search_query", [text]))[0];
}

/** Normalise query text for cache-key comparison: trim, collapse whitespace, lowercase. */
export function normalizeQueryText(text) {
  return String(text).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Small bounded LRU cache backed by a Map. Map iteration order is insertion
 * order, so re-inserting a touched key on every get/set keeps the least-
 * recently-used entry first for O(1) eviction.
 */
export class LruCache {
  #capacity;
  #map = new Map();

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`LruCache capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
  }

  get size() {
    return this.#map.size;
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value); // move to the most-recently-used position
    return value;
  }

  set(key, value) {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#capacity) {
      const oldestKey = this.#map.keys().next().value;
      this.#map.delete(oldestKey);
    }
  }

  clear() {
    this.#map.clear();
  }
}

// Recall re-asks near-duplicate questions often enough (retries, typos, the
// same session revisiting a topic) that skipping a ~20ms model call on a
// repeat is worth a small fixed-size cache.
const DEFAULT_QUERY_CACHE_CAPACITY = 500;
const queryEmbeddingCache = new LruCache(DEFAULT_QUERY_CACHE_CAPACITY);

/**
 * Embed a query through a bounded LRU cache keyed by normalised text.
 * cache/embedFn are injectable so tests and benchmarks can drive this
 * without touching the real model.
 */
export async function embedQueryCached(text, { cache = queryEmbeddingCache, embedFn = embedQuery } = {}) {
  const key = normalizeQueryText(text);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const vector = await embedFn(text);
  cache.set(key, vector);
  return vector;
}

/** Drop every entry from the process-wide query embedding cache. */
export function clearQueryEmbeddingCache() {
  queryEmbeddingCache.clear();
}
