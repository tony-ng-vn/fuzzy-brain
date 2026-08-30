// Names the resource that co-running queries contend for, by sampling
// pg_stat_activity at ~15 Hz while a closed-loop window runs and histogramming
// wait_event_type / wait_event across the bench's own backends.
//
// A backend that is running with wait_event NULL is on CPU, not waiting on a
// lock, a latch or IO. If the histogram is dominated by NULL, there is no
// contended Postgres resource to name and the limit is below Postgres.
//
//   CONC=32 SECS=40 node waitsample.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Bench root, resolved from this file rather than the caller's cwd.
const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config } = await import(`${BENCH}/config.mjs`);
const { benchClient } = await import(`${BENCH}/lib/safety.mjs`);

const SECS = Number(process.env.SECS ?? 40);
const HZ = Number(process.env.HZ ?? 15);
const client = benchClient();
await client.connect();

const counts = new Map();
const states = new Map();
let samples = 0;
let backendsSeen = 0;

const deadline = Date.now() + SECS * 1000;
while (Date.now() < deadline) {
  const { rows } = await client.query(`
    select state, wait_event_type, wait_event
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
      and query like 'with %'`);
  samples += 1;
  backendsSeen += rows.length;
  for (const r of rows) {
    const key = r.wait_event_type === null
      ? 'ON CPU (no wait event)'
      : `${r.wait_event_type} / ${r.wait_event}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    states.set(r.state, (states.get(r.state) ?? 0) + 1);
  }
  await new Promise((r) => setTimeout(r, 1000 / HZ));
}

const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`\n${samples} samples over ${SECS}s, ${backendsSeen} backend-observations`);
console.log(`mean concurrent bench backends: ${(backendsSeen / samples).toFixed(1)}\n`);
console.log('backend state:');
for (const [k, v] of [...states].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(24)} ${((v / total) * 100).toFixed(1)}%`);
}
console.log('\nwait event breakdown (share of backend-observations):');
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${k.padEnd(40)} ${((v / total) * 100).toFixed(1)}%  (${v})`);
}
await client.end();
