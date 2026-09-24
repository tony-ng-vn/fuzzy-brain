import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { renderEpisode } from "../scripts/lib/session-parser.mjs";

function command(url, verb, input, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["scripts/brain.mjs", verb, ...args, "--json-errors"], {
      timeout: 20000, encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url, DATABASE_URL_DEV: url, BRAIN_SCHEMA: "brain_dev" },
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function packet(sourceId, key, turns, fileTime = 1) {
  const rendered = renderEpisode(turns);
  return { source_id: sourceId, source_locator: key, raw: rendered.raw, file_mtime_ms: fileTime,
    file_size: Buffer.byteLength(rendered.raw), thread_context: "/synthetic/fuzzy-brain",
    evidence: rendered.spans.map((span, index) => ({ quote: span.text, speaker: span.speaker,
      start_offset: span.start, end_offset: span.end, occurred_at: span.ts,
      omitted_before: turns[index].omittedBefore ?? 0 })) };
}

test("session reconciliation commits evidence and checkpoints without duplicating occurrences", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  const run = (verb, input, args) => command(db.url, verb, input, args);
  const source = await run("add-source", { kind: "claude_code_session", label: randomUUID() });
  const turns = [
    { speaker: "tony", text: "same undated words", ts: null },
    { speaker: "tony", text: "same undated words", ts: null },
    { speaker: "assistant", text: "dated reply", ts: "2026-09-23T17:00:00-07:00", omittedBefore: 2 },
  ];
  const input = packet(source.id, randomUUID(), turns);
  const first = await run("sync-session", input);
  assert.equal(first.state, "committed");
  assert.equal(first.evidence_count, 3);
  assert.ok(first.checkpoint_id);

  await t.test("replay returns the same committed result and duplicate words retain multiplicity", async () => {
    const retry = await run("sync-session", input);
    assert.equal(retry.checkpoint_id, first.checkpoint_id);
    assert.equal(retry.id, first.id);
    assert.equal(retry.replayed, true);
    const extended = packet(source.id, input.source_locator, [...turns, turns[0]], 2);
    const added = await run("sync-session", extended);
    assert.equal(added.evidence_count, 1);
    const count = await db.client.query("select count(*)::int n from brain_dev.evidence where quote='same undated words'");
    assert.equal(count.rows[0].n, 3);
  });

  await t.test("equivalent timestamps and changed file metadata verify without new evidence", async () => {
    const equivalent = [...turns.slice(0, 2), { ...turns[2], ts: "2026-09-24T00:00:00.000Z" }, turns[0]];
    const result = await run("sync-session", packet(source.id, input.source_locator, equivalent, 3));
    assert.equal(result.evidence_count, 0);
    assert.equal(result.id, null);
    assert.equal(result.state, "committed");
    assert.ok(result.checkpoint_id);
    const progress = await run("list-session-checkpoints", undefined, [source.id]);
    assert.ok(progress.some(row => row.session_key === input.source_locator && row.file_mtime_ms === 3));
  });

  await t.test("new content with the same timestamp stays distinct and offsets bound scrubbed words", async () => {
    const next = [...turns, turns[0], { speaker: "tony", text: "a different thought with private 123-45-6789", ts: turns[2].ts }];
    const result = await run("sync-session", packet(source.id, input.source_locator, next, 4));
    assert.equal(result.evidence_count, 1);
    const rows = (await db.client.query("select e.raw,v.quote,v.start_offset,v.end_offset from brain_dev.episodes e join brain_dev.evidence v on v.episode_id=e.id where e.source_id=$1", [source.id])).rows;
    for (const row of rows) {
      assert.equal(row.raw.slice(row.start_offset, row.end_offset), row.quote);
      assert.doesNotMatch(row.raw, /123-45-6789/);
      assert.doesNotMatch(row.quote, /123-45-6789/);
    }
    assert.match(rows.find(row => row.quote.includes("private")).quote, /\[REDACTED:ssn_pattern\]/);
    assert.match((await db.client.query("select raw from brain_dev.episodes where id=$1", [first.id])).rows[0].raw, /2 tool calls omitted/);
  });

  await t.test("concurrent deliveries share one episode and checkpoint", async () => {
    const next = packet(source.id, randomUUID(), [{ speaker: "tony", text: "concurrent synthetic capture", ts: null }]);
    const results = await Promise.all(Array.from({ length: 5 }, () => run("sync-session", next)));
    assert.equal(new Set(results.map(result => result.id)).size, 1);
    assert.equal(new Set(results.map(result => result.checkpoint_id)).size, 1);
    assert.equal(results.filter(result => result.replayed === false).length, 1);
  });

  await t.test("source exclusions cover earlier context at the write boundary", async () => {
    await run("set-exclusions", { exclusions: [{ kind: "topic", value: "same undated words" }] }, [source.id]);
    try {
      const next = packet(source.id, input.source_locator, [...turns, { speaker: "tony", text: "innocent later text", ts: null }], 5);
      assert.equal((await run("sync-session", next)).error.code, "excluded");
      assert.equal((await db.client.query("select count(*)::int n from brain_dev.evidence where quote='innocent later text'")).rows[0].n, 0);
    } finally { await run("set-exclusions", { exclusions: [] }, [source.id]); }
  });

  await t.test("checkpoint failure rolls back appended evidence and a retry can succeed", async () => {
    const next = { ...packet(source.id, randomUUID(), [{ speaker: "tony", text: "atomic synthetic capture", ts: null }]), file_size: 777 };
    await db.client.query("alter table brain_dev.session_ingest_checkpoints add constraint reject_fixture check (file_size <> 777)");
    try {
      assert.equal((await run("sync-session", next)).error.code, "unavailable");
      assert.equal((await db.client.query("select count(*)::int n from brain_dev.evidence where quote='atomic synthetic capture'")).rows[0].n, 0);
    } finally { await db.client.query("alter table brain_dev.session_ingest_checkpoints drop constraint reject_fixture"); }
    assert.equal((await run("sync-session", next)).evidence_count, 1);
  });

  await t.test("invalid source offsets fail without storing evidence", async () => {
    const invalid = { ...input, source_locator: randomUUID(), evidence: [{ ...input.evidence[0], start_offset: 0 }] };
    assert.equal((await run("sync-session", invalid)).error.code, "invalid");
  });

  await t.test("checkpoints are append-only", async () => {
    for (const sql of ["update brain_dev.session_ingest_checkpoints set result='{}'", "delete from brain_dev.session_ingest_checkpoints", "truncate brain_dev.session_ingest_checkpoints"]) {
      await assert.rejects(db.client.query(sql), /append-only/);
    }
  });
});
