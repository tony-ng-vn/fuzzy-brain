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
import { pipeline, layer_norm, env } from "@huggingface/transformers";

// Machine-local cache outside node_modules so a reinstall never re-downloads.
env.cacheDir = join(homedir(), ".fuzzy-brain", "models");

const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
export const EMBEDDING_DIM = 768;

// Embed only the head of very long spans: the head carries a span's
// identity for retrieval, and full-window (8192-token) inference over tens
// of thousands of pasted-transcript spans would turn a CPU sweep into a
// multi-hour job. Full-text search still covers what the head cap skips.
const EMBED_CHAR_CAP = 4000;

let extractorPromise = null;
function loadExtractor() {
  // fp32 weights: reference quality; the sweep is a rare batch job, so
  // fidelity wins over quantized speed.
  extractorPromise ??= pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" });
  return extractorPromise;
}

async function embed(prefix, texts) {
  const extractor = await loadExtractor();
  const inputs = texts.map((t) => `${prefix}: ${String(t).slice(0, EMBED_CHAR_CAP)}`);
  const pooled = await extractor(inputs, { pooling: "mean" });
  const normalized = layer_norm(pooled, [pooled.dims[1]]).normalize(2, -1);
  return normalized.tolist();
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
