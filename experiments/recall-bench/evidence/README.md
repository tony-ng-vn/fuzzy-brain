# Evidence

The measured results behind every number in `DESIGN.md` section 7 and the README's results table.

`.out/` is gitignored, because it also holds multi-hundred-megabyte corpora, query-vector caches and oracle checkpoints that are all reproducible from a seed.
These files are not reproducible in the same sense: `TEST-RUNS.log` is the audit trail for the frozen test split, and a recall report records what a specific commit measured on a specific day.
Regenerating them would produce new numbers, not the same ones, so they are copied here and tracked.

- `quality50k/TEST-RUNS.log` -- every invocation against the frozen test split, with the config hash it ran under. The freeze discipline is only as good as this file.
- `quality50k/CORPUS.lock` -- the frozen corpus identity for claim A.
- `quality50k/recall-*.json` -- the ablation ladder, naive through learned.
- `quality50k/learned-weights.json` -- the fitted lane and rerank weights with their bootstrap intervals (DESIGN.md 7.7).
- `quality50k/oracle.json` -- the real-embedding solvability oracle for the frozen corpus.
- `rehearsal1m/`, `smoke1k/`, `build-strategy/`, `baseline-iter0/`, `iter1/` -- the same for the other tiers and for the build-strategy comparison.

The corpora themselves are not here and do not need to be: `gen-corpus.mjs` is deterministic across processes, which `tests/recall-bench-corpus.test.mjs` pins by hashing two independent runs.
