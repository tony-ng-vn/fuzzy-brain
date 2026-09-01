// Reciprocal-rank fusion, in JavaScript.
//
//   rrf(id) = sum over lanes L containing id of weight[L] / (k[L] + rank_L(id))
//
// The bench harness computes this same sum inside one prepared SQL statement
// (its whole design rests on a single round trip), and
// tests/recall-bench-rrf.test.mjs pins that SQL against an independent oracle.
// The product fuses in JavaScript instead: its lanes ride one batched
// statement to spare the network round trips, but which rows get admitted
// and which nodes the one-hop edge walk starts from are decided here,
// between statements. This file is the product's side of that formula, and
// the shared test asserts it agrees with the bench oracle number for number.

export const DEFAULT_RRF_K = 60;

export function rrfContribution(weight, k, rank) {
  return weight / (k + rank);
}

// Dense ranks: rows with the same lane score share a rank. Two byte-identical
// quotes must fuse identically, so that only a deliberate boost can separate
// them -- with ordinal ranks the winner would be whichever row Postgres
// happened to return first.
export function denseRanks(rows, scoreOf) {
  let rank = 0;
  let prev;
  return rows.map((row) => {
    const s = scoreOf(row);
    if (prev === undefined || s !== prev) {
      rank += 1;
      prev = s;
    }
    return { row, rank };
  });
}

// laneResults: Record<laneName, Array<{ key, rank }>>.
// Returns Map<key, { rrf, laneRanks }>. A lane weighted 0 contributes nothing
// and is skipped outright, so it cannot admit a row it did not earn.
export function fuseRrf(laneResults, weights, rrfK = {}, defaultK = DEFAULT_RRF_K) {
  const fused = new Map();
  for (const [lane, entries] of Object.entries(laneResults)) {
    const weight = weights[lane] ?? 0;
    if (weight === 0) continue;
    const k = rrfK[lane] ?? defaultK;
    for (const { key, rank } of entries) {
      const acc = fused.get(key) ?? { rrf: 0, laneRanks: {} };
      acc.rrf += rrfContribution(weight, k, rank);
      // Keep the best rank a lane gave this key; a lane never lists a key twice.
      if (acc.laneRanks[lane] === undefined || rank < acc.laneRanks[lane]) acc.laneRanks[lane] = rank;
      fused.set(key, acc);
    }
  }
  return fused;
}
