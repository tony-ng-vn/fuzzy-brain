// Recompute a synthetic tier's embedding column at the recalibrated geometry
// (DESIGN.md 7.3), preserving the corpus text and every query file.
//
//   node scripts/reembed-synthetic.mjs --tier rehearsal1m
//   node scripts/reembed-synthetic.mjs --tier rehearsal1m --dry-run
//
// WHY NOT `load.mjs --stream`, which is the obvious way to rebuild a tier:
// because it would rebuild a DIFFERENT corpus. config.corpus has moved since
// bench_r1m was loaded (the 2026-08-24 familyMix shift, mustIncludeVocab,
// partialRef.vagueWords), and those knobs feed the generator's seeded streams,
// so the same seeds now render different dates, people, places and cluster
// ids. Checked before touching anything: of 7 sampled ids, 0 of 7 regenerate
// to the text that is actually loaded.
//
// The loaded corpus is still internally consistent with .out/rehearsal1m's
// query files -- every family except paraphrase_nolex (0 by design) has its
// targets sharing content words with the queries that name them -- so a
// --stream rebuild would strand 4,000 queries against targets that no longer
// contain what they ask for, and silently void every lexical certificate.
//
// It is also better science. The vector is a pure function of (id, cluster_id,
// dims, jitter), and both inputs are columns on the row. Recomputing from the
// rows that are already there makes GEOMETRY THE ONLY VARIABLE between 7.2's
// frontier and the one measured after this runs; a regeneration would move the
// corpus and the geometry at once and neither table would explain the other.
//
// Mechanically this is still a stream COPY down the loader's own encoder: it
// writes a fresh table and swaps it in, rather than UPDATE-ing 1M rows, which
// would leave ~1 GB of dead tuples needing a VACUUM FULL to reclaim. The
// generated tsvector column is declared identically and so is recomputed by
// Postgres on insert, exactly as the original load did it.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, resolveTier } = await import(`${BENCH}/config.mjs`);
const { benchClient, assertBenchTarget } = await import(`${BENCH}/lib/safety.mjs`);
const { encodeField } = await import(`${BENCH}/load.mjs`);
const { DEFAULT_MEMORY_JITTER } = await import(`${BENCH}/lib/synth-vectors.mjs`);

const { values: args } = parseArgs({
  options: { tier: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
if (!args.tier) throw new Error('reembed-synthetic.mjs requires --tier <name>');

const tier = resolveTier(args.tier);
if (tier.vector !== 'synthetic') {
  throw new Error(`--tier ${args.tier} is a real-vector tier; its embeddings come from the model, not from this script`);
}
const SCHEMA = tier.schema;
const LIVE = `${SCHEMA}.memories`;
const STAGE = `${SCHEMA}.memories_regen`;

console.log(`reembed-synthetic: target=${config.db.url} tier=${args.tier} schema=${SCHEMA}`);
console.log(`  jitter ${DEFAULT_MEMORY_JITTER} (lib/synth-vectors.mjs), dims ${tier.dims}`);
assertBenchTarget(config.db.url);

const client = benchClient();
await client.connect();

const psqlBin = process.env.BENCH_PSQL_BIN ?? '/opt/homebrew/opt/postgresql@17/bin/psql';

// Streams CSV into COPY via psql, the same technique load.mjs uses (node-postgres
// has no COPY support without a package this project does not depend on).
async function copyViaPsql(table, columns, rows) {
  const child = spawn(psqlBin, [config.db.url, '-v', 'ON_ERROR_STOP=1', '-q', '-c',
    `COPY ${table} (${columns.join(',')}) FROM STDIN WITH (FORMAT csv)`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  child.stdout.resume();
  const exited = new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
  let n = 0;
  try {
    for await (const fields of rows) {
      n++;
      if (!child.stdin.write(fields.join(',') + '\n')) await once(child.stdin, 'drain');
    }
  } finally { child.stdin.end(); }
  const code = await exited;
  if (code !== 0) throw new Error(`COPY into ${table} failed (exit ${code}): ${stderr.trim()}`);
  return n;
}

const csvField = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /["\n\r,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

try {
  const { rows: [{ count }] } = await client.query(`select count(*) as count from ${LIVE}`);
  console.log(`  ${Number(count).toLocaleString()} rows to re-embed`);

  if (args['dry-run']) {
    // Prove the recomputation is what it claims on a handful of rows, without
    // writing anything: the new literal must differ from the stored vector
    // (the geometry moved) and must be reproducible from the row's own columns.
    const { rows } = await client.query(
      `select id, cluster_id, embedding::text as stored from ${LIVE} order by id limit 5`);
    for (const r of rows) {
      const fresh = encodeField('embedding', { id: Number(r.id), cluster_id: r.cluster_id }, tier);
      console.log(`  id ${r.id}: stored[0..40]=${r.stored.slice(0, 40)}...`);
      console.log(`           fresh [0..40]=${fresh.slice(0, 40)}...`);
    }
    console.log('  dry run: nothing written');
    process.exit(0);
  }

  await client.query(`drop table if exists ${STAGE}`);
  // Same DDL as load.mjs createSchema's synthetic branch, including the stored
  // generated tsvector, so the swapped-in table is shape-identical to the one
  // it replaces.
  await client.query(`create unlogged table ${STAGE} (
      id          bigint primary key,
      body        text not null,
      kind_id     smallint not null,
      person_id   smallint not null,
      place_id    smallint not null,
      occurred_at date not null,
      cluster_id  int not null,
      embedding   halfvec(${tier.dims}),
      fts         tsvector generated always as (to_tsvector('english', body)) stored
    )`);

  const COLUMNS = ['id', 'body', 'kind_id', 'person_id', 'place_id', 'occurred_at', 'cluster_id', 'embedding'];
  const started = Date.now();
  let seen = 0;

  // Cursor rather than a plain SELECT: 1M rows of body text will not fit
  // comfortably in one client-side result set.
  async function* sourceRows() {
    await client.query('begin');
    await client.query(`declare reembed_cur cursor for
      select id, body, kind_id, person_id, place_id, occurred_at, cluster_id from ${LIVE} order by id`);
    for (;;) {
      const { rows } = await client.query('fetch 5000 from reembed_cur');
      if (rows.length === 0) break;
      for (const r of rows) {
        const record = {
          id: Number(r.id),
          body: r.body,
          kind_id: r.kind_id,
          person_id: r.person_id,
          place_id: r.place_id,
          // date column: keep the ISO day, no timezone shift.
          occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString().slice(0, 10) : r.occurred_at,
          cluster_id: r.cluster_id,
        };
        seen += 1;
        if (seen % 100_000 === 0) {
          console.log(`  [${new Date().toISOString().slice(11, 19)}] ${seen.toLocaleString()} rows re-embedded`);
        }
        // encodeField is the loader's own encoder, so the vector written here
        // is byte-for-byte what a fresh load would have written.
        yield COLUMNS.map((col) => csvField(encodeField(col, record, tier)));
      }
    }
    await client.query('close reembed_cur');
    await client.query('commit');
  }

  const copied = await copyViaPsql(STAGE, COLUMNS, sourceRows());
  console.log(`  copied ${copied.toLocaleString()} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (copied !== Number(count)) {
    throw new Error(`row count mismatch: ${LIVE} had ${count}, staged ${copied}; refusing to swap`);
  }

  // The swap. One transaction, so there is never a window with no memories
  // table; indexes are rebuilt afterwards because every vector in the old
  // HNSW graph moved and the lexical ones travel with the dropped table.
  await client.query('begin');
  await client.query(`drop table ${LIVE} cascade`);
  await client.query(`alter table ${STAGE} rename to memories`);
  await client.query('commit');
  console.log(`  swapped ${STAGE} into place as ${LIVE}`);
  console.log('  indexes are GONE with the old table -- run scripts/hnsw-build.sh and rebuild the lexical ones');
} catch (err) {
  await client.query('rollback').catch(() => {});
  throw err;
} finally {
  await client.end();
}
