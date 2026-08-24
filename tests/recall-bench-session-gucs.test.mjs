// engine.applyVectorGucs caches the vector GUCs on a WeakMap keyed by whatever
// `client` it is handed. Both benches hand it a Pool, so the cache is per-pool
// while the SET lands on one physical connection -- every connection the pool
// opens afterwards runs pgvector's defaults instead.
//
// Measured 2026-08-24 against bench_r1m, one awaited query then a concurrent
// burst: 1 of 8 backends carried ivfflat.probes=8, the other 7 ran probes=1 with
// hnsw.iterative_scan=off. That is a silently faster and much less accurate
// vector lane, so it corrupts latency and recall together.
//
// The fix is for the pool to apply the settings when it opens a connection, so
// every connection has them before it serves anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionSqlFor, shouldIssueSessionSql, toStartupOptions } from '../experiments/recall-bench/lib/safety.mjs';

test('session SQL becomes Postgres startup options', () => {
  assert.equal(
    toStartupOptions('SET ivfflat.probes = 8; SET hnsw.iterative_scan = relaxed_order'),
    '-c ivfflat.probes=8 -c hnsw.iterative_scan=relaxed_order',
  );
});

test('startup options survive a single setting with no trailing semicolon', () => {
  assert.equal(toStartupOptions('SET hnsw.ef_search = 40'), '-c hnsw.ef_search=40');
});

test('a pool carrying the settings does not re-issue them per query', () => {
  const pool = { __benchSessionSql: 'SET ivfflat.probes = 8' };
  assert.equal(shouldIssueSessionSql(pool, 'SET ivfflat.probes = 8'), false);
});

test('a pool carrying different settings still issues them', () => {
  // The quality tier raises ef_search when a filter is present, so the per-query
  // path has to stay live for settings the pool did not pin.
  const pool = { __benchSessionSql: 'SET hnsw.ef_search = 400' };
  assert.equal(shouldIssueSessionSql(pool, 'SET hnsw.ef_search = 800'), true);
});

test('a plain client with no pinned settings issues them', () => {
  assert.equal(shouldIssueSessionSql({}, 'SET ivfflat.probes = 8'), true);
});

test('sessionSqlFor records what the pool pinned', () => {
  const pool = {};
  sessionSqlFor(pool, 'SET ivfflat.probes = 8');
  assert.equal(pool.__benchSessionSql, 'SET ivfflat.probes = 8');
  assert.equal(shouldIssueSessionSql(pool, 'SET ivfflat.probes = 8'), false);
});
