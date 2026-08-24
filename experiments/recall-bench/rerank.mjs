// The rerank stage (DESIGN.md section 6.5).
//
// A linear scorer over features the retrieval statement already returned, not a
// cross-encoder. Section 6.5 is blunt about why: the measured embedder does ~50
// texts/sec, so a neural reranker over 50 candidates at 2,400 queries/sec is off
// by five orders of magnitude. Eight floats per candidate is not.
//
// engine.mjs calls this as ctx.rerank(qf, candidates, cfg) and re-sorts by
// rerankScore afterwards; the candidates arrive in fused (RRF) order, which
// matters because dupPenalty is defined against "how many same-group members
// already sit above this one".

import { config as defaultConfig } from './config.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function halfLifeDecay(distanceMs, halfLifeMs) {
  if (!Number.isFinite(distanceMs) || distanceMs <= 0) return 1;
  return Math.pow(0.5, distanceMs / halfLifeMs);
}

function entityMatch(qf, features) {
  const wanted = [...(qf.entities?.people ?? []), ...(qf.entities?.places ?? [])];
  if (wanted.length === 0) return 0;
  const present = new Set([...(features.people ?? []), ...(features.tags ?? [])]);
  return wanted.filter((slug) => present.has(slug)).length / wanted.length;
}

function dateFit(qf, features, cfg) {
  const range = qf.dateRange ?? { from: null, to: null };
  if (!range.from && !range.to) return 0; // no date signal: contributes nothing either way
  const at = features.occurredAt ? Date.parse(features.occurredAt) : NaN;
  if (Number.isNaN(at)) return 0;

  const from = range.from ? Date.parse(range.from) : -Infinity;
  const to = range.to ? Date.parse(range.to) : Infinity;
  if (at >= from && at <= to) return 1;

  const distance = at < from ? from - at : at - to;
  return halfLifeDecay(distance, cfg.rerank.dateFitHalfLifeDays * MS_PER_DAY);
}

function recencyDecay(features, cfg) {
  const at = features.occurredAt ? Date.parse(features.occurredAt) : NaN;
  if (Number.isNaN(at)) return 0;
  const reference = Date.parse(cfg.dates?.referenceIso ?? new Date().toISOString());
  return halfLifeDecay(reference - at, cfg.rerank.recencyHalfLifeDays * MS_PER_DAY);
}

// `lexical` comes back raw here: ts_rank_cd is unbounded and only comparable
// within one query's candidate set, so rerank() below normalizes it once the
// whole set is known. `dupPenalty` is likewise filled in by rerank(), which is
// the only place the candidate ordering exists.
export function rerankFeatures(qf, candidate, cfg = defaultConfig) {
  const f = candidate.features ?? {};
  return {
    // The fused RRF score, normalized per query in rerank() below.
    //
    // Section 6.5's formula has no fusion term, which makes the rerank a
    // REPLACEMENT for the retrieval ranking rather than a refinement of it.
    // Measured on the dev split, that is what it cost: the fused order already
    // places the target in the top 10 for 98.9% of queries, and the target is
    // inside the candidate set for 100% of them, but the best fit of the other
    // eight features by coordinate descent reached only 0.873. A reranker that
    // cannot see the retrieval score throws away the strongest signal it has.
    fused: Number(candidate.rrf ?? 0),
    lexical: Number(f.lexical ?? 0),
    cosine: Number(f.cosine ?? 0),
    entity: entityMatch(qf, f),
    recency: recencyDecay(f, cfg),
    dateFit: dateFit(qf, f, cfg),
    rareHit: f.rareHit ? 1 : 0,
    titleHit: f.titleHit ? 1 : 0,
    dupPenalty: 0,
  };
}

export function rerankScore(f, weights) {
  let score = 0;
  for (const [name, weight] of Object.entries(weights)) {
    score += weight * (f[name] ?? 0);
  }
  return score;
}

export function rerank(qf, candidates, cfg = defaultConfig) {
  const weights = cfg.rerank.weights;
  const scored = candidates.map((c) => ({ candidate: c, features: rerankFeatures(qf, c, cfg) }));

  // ts_rank_cd has no fixed scale, so normalize against the best candidate this
  // query actually produced. An all-zero set stays all-zero rather than dividing.
  const maxLexical = Math.max(0, ...scored.map((s) => s.features.lexical));
  if (maxLexical > 0) {
    for (const s of scored) s.features.lexical /= maxLexical;
  }

  // RRF sums are only comparable within one query's candidate set, exactly
  // like ts_rank_cd above, so the fusion prior is normalized the same way.
  const maxFused = Math.max(0, ...scored.map((s) => s.features.fused));
  if (maxFused > 0) {
    for (const s of scored) s.features.fused /= maxFused;
  }

  // The near_dup unblocker (section 6.5): each further member of a dup_group
  // already represented above this candidate costs it more. Counted in the
  // incoming fused order, which is the order the user would have seen.
  const seenInGroup = new Map();
  for (const s of scored) {
    const group = s.candidate.features?.dupGroup;
    if (group === null || group === undefined) continue;
    const already = seenInGroup.get(group) ?? 0;
    s.features.dupPenalty = already;
    seenInGroup.set(group, already + 1);
  }

  for (const s of scored) {
    s.candidate.rerankScore = rerankScore(s.features, weights);
    s.candidate.features = { ...s.candidate.features, ...s.features };
  }

  return scored
    .map((s) => s.candidate)
    .sort((a, b) => (b.rerankScore - a.rerankScore) || (a.id - b.id));
}
