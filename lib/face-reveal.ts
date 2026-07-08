// Pure reveal logic for the anamorphic face view, shared by FaceView and the
// node --test suite. Kept to erasable-syntax TypeScript so Node loads the .ts
// directly by stripping types.

// Distinct from the asset generator's seed (20260708): this one shuffles which
// physical points light up, so every load and reimplementation reveals the same
// early nodes.
export const REVEAL_SEED = 20260709;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates over [0, length). Same seed always yields the same order.
export function seededShuffle(length: number, seed: number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// Contrast pivots around mid-grey, then brightness scales; clamp to [0, 1].
// Contrast separates hair from skin; brightness makes the additive glow read on
// a dark sky. The asset stores raw photo colors, so grading happens here.
export function grade(value: number, contrast: number, brightness: number): number {
  const graded = ((value / 255 - 0.5) * contrast + 0.5) * brightness;
  return Math.min(1, Math.max(0, graded));
}

export type RevealNode = { id: string; created_at: string };

// The API's `order by created_at` is not stable on its own (a bulk insert ties
// on `now()`), so the reveal re-sorts client-side and tiebreaks by id.
export function sortNodesForReveal<T extends RevealNode>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

// The shuffled point indices that light up: the first `nodeCount`, clamped so
// that once nodes ever exceed points the extra nodes simply own no point yet.
// order[i] is the point for the i-th sorted node, so this is stable under
// append: growing nodeCount only extends the prefix, never reshuffles it.
export function litPointIndices(order: readonly number[], nodeCount: number): number[] {
  return order.slice(0, Math.min(nodeCount, order.length));
}
