// The binary-quantized vector lane (DESIGN.md 7.8, experiment 3).
//
// At 10M the halfvec HNSW graph is 7,920 MB against 6 GB of shared_buffers, and
// 7.6 measured what that costs: a 35-38% heap buffer hit ratio and an index scan
// that runs 57-206 ms per query because most of the nodes it visits have to be
// faulted in. `binary_quantize` turns each 512-byte halfvec into 32 bytes, so an
// HNSW graph over the quantized column is a fraction of the size and the search
// walks a graph that has a chance of staying resident.
//
// The price is that Hamming distance over sign bits is not cosine distance, so
// the lane cannot return its top `depth` directly. It takes `depth * oversample`
// candidates by Hamming and reranks THOSE by the exact halfvec cosine before
// fusion sees anything -- which is why the fused ranks, the `cosine` rerank
// feature, and every number downstream stay defined exactly as they were.
//
// Measured on this corpus before any index was built (scripts/bq-agreement.mjs,
// exact scans over a 1/20 sample, 60 dev queries): the nearest cosine neighbour
// is inside the exact Hamming top-30 for 95.0% of queries and inside the top-150
// for 100.0%, and the cosine top-3 is 92.8% recovered at 60 candidates and 98.3%
// at 300. So the quantizer keeps the near neighbourhood; what the oversample buys
// back is the tail.

// Both CTEs, in the order they must appear. Split out of engine.mjs rather than
// branched inside it so the SQL this shape produces can be asserted without a
// database.
export function binaryVectorLaneCtes({
  schema,
  vecParam,
  dims,
  depth,
  oversample,
  efSearch,
  iterativeScan = 'off',
  spanClause = '',
  vectorGate = '',
}) {
  if (!Number.isInteger(oversample) || oversample < 1) {
    throw new Error(
      `binaryVectorLaneCtes: oversample must be an integer >= 1 (got ${oversample}). ` +
        'At 1 the lane is a pure Hamming ranking with nothing for the cosine rerank to reorder.',
    );
  }
  const candidates = depth * oversample;
  // hnsw.ef_search is also a ceiling on how many rows the scan RETURNS. With
  // iterative scan off, a `limit 600` under ef_search 400 quietly yields 400
  // candidates and no error -- the same silent-default failure mode that
  // engine.assertEfSearch exists for, one layer down. An arm that asked for an
  // oversample it never got would report a latency and a recall belonging to a
  // different oversample, so it fails here instead.
  if (iterativeScan === 'off' && candidates > efSearch) {
    throw new Error(
      `binaryVectorLaneCtes: the candidate stage asks for ${candidates} rows (depth ${depth} x oversample ` +
        `${oversample}) but hnsw.ef_search is ${efSearch} and hnsw.iterative_scan is off, so the scan would ` +
        `return only ${efSearch}. Raise config.lanes.scale.efSearch to at least ${candidates} (pgvector's own ` +
        'cap is 1000) or set filteredIterativeScan to relaxed_order.',
    );
  }
  // The candidate stage's ORDER BY has to be the index expression VERBATIM --
  // binary_quantize(m.embedding)::bit(N) -- or the planner matches nothing and
  // silently sequential-scans 10M rows. The query side is the same call over the
  // bind parameter, which is immutable and therefore folded once per execution.
  const bits = `binary_quantize(${vecParam}::halfvec)::bit(${dims})`;
  return [
    // The date filter stays HERE, on the candidate stage, not after the rerank.
    // Filtering a Hamming top-600 down to a date window would leave the lane
    // with whatever survives instead of 600 candidates inside the window --
    // the classic ANN mistake DESIGN.md 6.1 already calls out.
    `vec_cand as materialized (
  select m.id, m.embedding
  from ${schema}.memories m
  where m.embedding is not null${spanClause}${vectorGate}
  order by binary_quantize(m.embedding)::bit(${dims}) <~> ${bits}
  limit ${candidates}
)`,
    `vec_lane as (
  select id, row_number() over (order by embedding <=> ${vecParam}::halfvec) as rnk, null::real as score
  from vec_cand
  order by embedding <=> ${vecParam}::halfvec
  limit ${depth}
)`,
  ];
}
