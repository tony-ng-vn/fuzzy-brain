import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationJournal } from "../scripts/lib/operation-journal.mjs";

async function journal(t) {
  const directory = await mkdtemp(join(tmpdir(), "tbrain-traces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createOperationJournal({ directory }) };
}
const details = { entry_point: "tbrain_mcp", operation: "recall", release: "0.31.0", input: { question: "PRIVATE QUERY", role: "user" } };

test("a trace survives reopening and distinguishes an unfinished request from a result", async t => {
  const { store, directory } = await journal(t);
  const started = await store.start(details);
  assert.equal(started.recorded, true);
  assert.equal((await store.read(started.id)).state, "incomplete");
  const ended = await store.finish(started.id, { duration_ms: 4.25, result: { hits: [], degraded: false } });
  assert.equal(ended.recorded, true);
  const saved = await createOperationJournal({ directory }).read(started.id);
  assert.equal(saved.state, "finished");
  assert.equal(saved.start.operation, "recall");
  assert.equal(saved.finish.outcome, "success");
  assert.equal(saved.finish.duration_ms, 4.25);
  assert.equal(saved.finish.output.hit_count, 0);
  assert.equal(saved.start.input.content_omitted, true);
  assert.equal(saved.start.input.filters.role, "user");
  const day = started.id.slice(0, 10);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, day))).mode & 0o777, 0o700);
  for (const filename of await readdir(join(directory, day))) {
    const path = join(directory, day, filename);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, "utf8"), /PRIVATE QUERY/);
  }
});

test("concurrent operations keep distinct records and a second finish cannot rewrite the first", async t => {
  const { store } = await journal(t);
  const starts = await Promise.all(Array.from({ length: 24 }, () => store.start(details)));
  assert.equal(new Set(starts.map(s => s.id)).size, 24);
  await Promise.all(starts.map((s, i) => store.finish(s.id, { duration_ms: i, result: { hits: [] } })));
  const again = await store.finish(starts[0].id, { duration_ms: 99, error: { code: "invalid", message: "PRIVATE ERROR" } });
  assert.equal(again.recorded, false);
  assert.equal((await store.read(starts[0].id)).finish.outcome, "success");
  const page = await store.list({ day: starts[0].id.slice(0, 10), limit: 10 });
  assert.equal(page.traces.length, 10);
  assert.equal(page.has_more, true);
  const second = await store.list({ day: starts[0].id.slice(0, 10), limit: 20, after: page.next_after });
  assert.equal(second.traces.length, 14);
  assert.equal(new Set([...page.traces, ...second.traces].map(t => t.id)).size, 24);
});

test("trace failures are separate from operation results and do not leak paths or input", async t => {
  const { directory } = await journal(t);
  const blocked = join(directory, "PRIVATE PATH");
  await writeFile(blocked, "not a directory");
  const store = createOperationJournal({ directory: blocked });
  const result = await store.start(details);
  assert.equal(result.recorded, false);
  assert.equal(store.status().state, "degraded");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|ENOTDIR/);
  assert.doesNotMatch(JSON.stringify(store.status()), /PRIVATE|ENOTDIR/);
});

test("untrusted trace identifiers and unsafe journal directories are rejected", async t => {
  const { directory, store } = await journal(t);
  await assert.rejects(() => store.read("../../private"), error => error.code === "invalid");
  await assert.rejects(() => store.list({ day: "../private" }), error => error.code === "invalid");
  await assert.rejects(() => store.list({ day: "2026-02-30" }), error => error.code === "invalid");
  await assert.rejects(() => store.list({ limit: 10001 }), error => error.code === "invalid");
  const target = join(directory, "target");
  await symlink(directory, target);
  assert.equal((await createOperationJournal({ directory: target }).start(details)).recorded, false);
  await chmod(directory, 0o755);
  assert.equal((await store.start(details)).recorded, false);
});

test("failed tools keep safe error codes, references, and output counts without private text", async t => {
  const { store } = await journal(t);
  const id = "11111111-1111-4111-8111-111111111111";
  const started = await store.start({ ...details, input: { question: "PRIVATE QUERY", source_id: id, api_key: "PRIVATE KEY" } });
  await store.finish(started.id, { duration_ms: 1, is_error: true, result: { error: { code: "invalid", message: "PRIVATE ERROR" } } });
  const saved = await store.read(started.id);
  assert.equal(saved.finish.outcome, "error");
  assert.equal(saved.finish.error_code, "invalid");
  assert.equal(saved.start.input.references.source_id, id);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/);
});
