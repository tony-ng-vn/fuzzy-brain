// The one gate between this harness and the real brain (DESIGN.md section 0).
//
// This file is the only .mjs under experiments/recall-bench allowed to name the
// managed database's env var at all, and tests/recall-bench-safety.test.mjs
// enforces that by grepping every sibling for the literals DATABASE_URL and
// .env.local. The harness reads neither: its target comes from config.db.url,
// which defaults to the disposable local cluster and can only be overridden
// through BENCH_DATABASE_URL, a deliberately separate name.
//
// The guard is a positive allowlist, not a denylist. A denylist has to predict
// every managed-brain hostname; an allowlist only has to describe the one
// throwaway cluster, so anything unexpected -- including a typo -- fails closed.
//
// Per the section 12 addendum the cluster is native Postgres on loopback, not a
// container, so there is no BENCH_IN_CONTAINER escape hatch and no second
// accepted host:port pair. 127.0.0.1:55433/recallbench is the whole allowlist.

import pg from 'pg';

import { config } from '../config.mjs';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ALLOWED_PORT = '55433';
const ALLOWED_DATABASE = 'recallbench';

export function assertBenchTarget(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new Error('assertBenchTarget: expected a connection string, got ' + typeof connectionString);
  }

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    // Unparseable input never reaches pg: an unrecognized string is exactly the
    // case where we cannot prove the target is the bench cluster.
    throw new Error(`assertBenchTarget: refusing an unparseable connection string: ${redact(connectionString)}`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`assertBenchTarget: refusing protocol "${url.protocol}"; expected postgres:`);
  }

  const database = url.pathname.replace(/^\//, '');
  const problems = [];
  if (!ALLOWED_HOSTS.has(url.hostname)) problems.push(`host "${url.hostname}" is not 127.0.0.1 or localhost`);
  if (url.port !== ALLOWED_PORT) problems.push(`port "${url.port || '(none)'}" is not ${ALLOWED_PORT}`);
  if (database !== ALLOWED_DATABASE) problems.push(`database "${database}" is not ${ALLOWED_DATABASE}`);

  if (problems.length > 0) {
    throw new Error(
      `assertBenchTarget: refusing to connect to ${redact(connectionString)} -- ${problems.join('; ')}. ` +
      'The recall bench only ever talks to its own disposable cluster (DESIGN.md section 0).',
    );
  }
}

// Keeps a password out of thrown errors, which get logged and pasted around.
function redact(connectionString) {
  return String(connectionString).replace(/\/\/[^@/]*@/, '//***@');
}

export function benchClient(connectionString = config.db.url) {
  assertBenchTarget(connectionString);
  return new pg.Client({ connectionString });
}

// Session settings a pooled connection must carry before it serves anything.
//
// engine.applyVectorGucs caches on a WeakMap keyed by the `client` it is handed,
// and both benches hand it the Pool -- so the cache goes per-pool while the SET
// lands on one physical connection. Measured 2026-08-24 against bench_r1m (one
// awaited query, then a concurrent burst): 1 of 8 backends carried the pinned
// ivfflat.probes=8, and the other 7 ran pgvector's defaults, probes=1 with
// hnsw.iterative_scan=off. A vector lane searching one list instead of eight is
// quietly faster and much less accurate, so that race corrupts latency and recall
// at the same time, in the flattering direction.
//
// A pool cannot know the tier's settings, so the caller passes them and the pool
// applies them in its connect hook. node-postgres emits 'connect' with the new
// client before handing it to whoever asked for it, and queries queue per client
// in order, so the SET is always that connection's first statement.
export function sessionSqlFor(pool, sessionSql) {
  pool.__benchSessionSql = sessionSql;
  return pool;
}

// Whether engine.applyVectorGucs still has to issue the settings itself. False
// once the pool pinned exactly these, which is the steady state for a homogeneous
// workload; true for a plain client, and true for the quality tier's filtered
// ef_search, which differs from what the pool pinned and must still take effect.
export function shouldIssueSessionSql(client, settings) {
  return client?.__benchSessionSql !== settings;
}

// "SET a = 1; SET b = x" -> "-c a=1 -c b=x", Postgres's startup options form.
// Applying the settings at session startup beats issuing them over a connect hook:
// the server has them before the connection is handed out, so there is no window
// where a query can run without them, it costs no round trip, and it cannot race
// with the first user query. Every value here is a config integer or a fixed
// keyword, so the naive split is safe -- none of them contain spaces or quotes.
export function toStartupOptions(sessionSql) {
  return sessionSql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `-c ${s.replace(/^SET\s+/i, '').replace(/\s*=\s*/, '=')}`)
    .join(' ');
}

export function benchPool(size = config.db.poolSize, connectionString = config.db.url, sessionSql = null) {
  assertBenchTarget(connectionString);
  const options = sessionSql ? { options: toStartupOptions(sessionSql) } : {};
  const pool = new pg.Pool({ connectionString, max: size, ...options });
  if (sessionSql) sessionSqlFor(pool, sessionSql);
  return pool;
}
