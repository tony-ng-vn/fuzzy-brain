// A prepared-statement name must stay distinct after Postgres gets hold of it.
//
// engine.mjs's profileSignature carries this comment: "two different statements
// sharing one prepared-statement name is a silent wrong-plan bug rather than a
// slow one". That is exactly right, and the name it builds could still violate
// it, because Postgres identifiers truncate at NAMEDATALEN - 1 = 63 bytes and
// the name is `retrieve_<schema>_<signature>`. The signature alone is 34-37
// characters, so any schema past ~26 characters pushes two different profiles
// onto the same truncated name.
//
// Found the hard way on 2026-08-25: a build-strategy arm in a schema called
// bench_bs_bulkspill1m produced 2,655 "You supplied
// retrieve_bench_bs_bulkspill1m_andorvector_wquery-dependent_f1_r1_vg (67)"
// errors in one window, because the vectorGate and non-vectorGate variants of
// the same profile both truncated to the same 63 bytes.
//
// No database: buildRetrievalSql is pure string construction and hands back the
// name it would prepare under.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const benchRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'experiments', 'recall-bench');
const { buildRetrievalSql } = await import(pathToFileURL(join(benchRoot, 'engine.mjs')));
const { config, resolveTier } = await import(pathToFileURL(join(benchRoot, 'config.mjs')));

const PG_NAME_LIMIT = 63;

// The two profiles that differ only in vectorGate -- the pair that actually
// collided -- plus a long schema to push them over the limit.
function namesFor(schema) {
  const tier = { ...resolveTier('rehearsal1m'), schema };
  const base = config.profiles.tunedScale;
  return [
    buildRetrievalSql(tier, base, config).name,
    buildRetrievalSql(tier, { ...base, vectorGate: true }, config).name,
  ];
}

test('a prepared-statement name fits in a Postgres identifier', () => {
  for (const schema of ['bench_r1m', 'bench_x10m', 'bench_bs_bulkspill1m', 'b'.repeat(60)]) {
    for (const name of namesFor(schema)) {
      assert.ok(
        Buffer.byteLength(name, 'utf8') <= PG_NAME_LIMIT,
        `"${name}" is ${Buffer.byteLength(name, 'utf8')} bytes, past Postgres's ${PG_NAME_LIMIT}`,
      );
    }
  }
});

test('two statements that differ stay distinct after the length cap', () => {
  const [plain, gated] = namesFor('bench_bs_bulkspill1m');
  assert.notEqual(plain, gated, 'vectorGate must not collide with its ungated twin');

  // Different schemas are different statements over different tables, so their
  // names must differ too even when both are long enough to be capped.
  const [aPlain] = namesFor(`bench_${'a'.repeat(50)}`);
  const [bPlain] = namesFor(`bench_${'b'.repeat(50)}`);
  assert.notEqual(aPlain, bPlain, 'two long schemas must not share one name');
});

test('short names are left exactly as they were', () => {
  // The tiers that carry every committed measurement must keep the names those
  // measurements were taken under, or a pg_stat_statements comparison against
  // an earlier run stops lining up.
  const [plain] = namesFor('bench_r1m');
  assert.equal(plain, 'retrieve_bench_r1m_andorvector_wquery-dependent_f1_r1');
});
