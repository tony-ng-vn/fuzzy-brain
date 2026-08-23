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

export function benchPool(size = config.db.poolSize, connectionString = config.db.url) {
  assertBenchTarget(connectionString);
  return new pg.Pool({ connectionString, max: size });
}
