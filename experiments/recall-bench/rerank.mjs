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
//
// The scorer itself now lives in scripts/lib/retrieval/rerank.mjs, which
// scripts/recall.mjs imports too -- one implementation, two callers, no way for
// the harness and the product to drift apart on what a rerank feature means.
// This file keeps the section 3.6 signatures and binds the bench config as the
// default, so every existing call site is unchanged.

import { config as defaultConfig } from './config.mjs';
import {
  rerankFeatures as sharedRerankFeatures,
  rerankScore as sharedRerankScore,
  rerank as sharedRerank,
} from '../../scripts/lib/retrieval/rerank.mjs';

export function rerankFeatures(qf, candidate, cfg = defaultConfig) {
  return sharedRerankFeatures(qf, candidate, cfg);
}

export const rerankScore = sharedRerankScore;

export function rerank(qf, candidates, cfg = defaultConfig) {
  return sharedRerank(qf, candidates, cfg);
}
