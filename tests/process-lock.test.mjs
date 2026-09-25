import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireProcessLock } from "../scripts/lib/process-lock.mjs";

function setup(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), "tbrain-process-lock-"));
  const lockPath = join(directory, "work.lock"), gatePath = join(directory, "continue");
  let worker;
  t.after(() => { worker?.kill(); rmSync(directory, { force: true, recursive: true }); });
  return { lockPath, resume: () => writeFileSync(gatePath, "continue"),
    start() {
      worker = fork(new URL("./fixtures/process-lock-worker.mjs", import.meta.url), [lockPath, gatePath, mode],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      return worker;
    } };
}

test("another process cannot acquire a lock while its owner publishes the PID", { timeout: 15000 }, async t => {
  const fixture = setup(t, "publish"), worker = fixture.start();
  assert.equal((await once(worker, "message"))[0].state, "paused");
  let competingRelease;
  try {
    assert.throws(() => { competingRelease = acquireProcessLock(fixture.lockPath, "competing work"); }, /already running/i);
  } finally {
    competingRelease?.();
    const exited = once(worker, "exit");
    fixture.resume();
    await exited;
  }
});

test("a delayed stale-lock cleanup cannot remove a replacement owner's lock", { timeout: 15000 }, async t => {
  const fixture = setup(t, "stale");
  writeFileSync(fixture.lockPath, "99999999");
  const worker = fixture.start();
  assert.equal((await once(worker, "message"))[0].state, "paused");
  const release = acquireProcessLock(fixture.lockPath, "replacement work");
  try {
    const result = once(worker, "message"), exited = once(worker, "exit");
    fixture.resume();
    assert.equal((await result)[0].state, "blocked");
    await exited;
    assert.throws(() => acquireProcessLock(fixture.lockPath, "third work"), /already running/i);
  } finally { release(); }
});

test("a new process recovers a lock after its owner exits without releasing it", { timeout: 15000 }, async t => {
  const fixture = setup(t, "hold"), worker = fixture.start();
  assert.equal((await once(worker, "message"))[0].state, "acquired");
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;
  const release = acquireProcessLock(fixture.lockPath, "recovered work");
  assert.throws(() => acquireProcessLock(fixture.lockPath, "concurrent work"), /already running/i);
  release();
  release();
  acquireProcessLock(fixture.lockPath, "later work")();
});

test("concurrent cleanup of a stale directory preserves its replacement owner", { timeout: 15000 }, async t => {
  const fixture = setup(t, "stale");
  mkdirSync(fixture.lockPath);
  writeFileSync(join(fixture.lockPath, `99999999-${randomUUID()}.owner`), "");
  const worker = fixture.start();
  assert.equal((await once(worker, "message"))[0].state, "paused");
  const release = acquireProcessLock(fixture.lockPath, "replacement work");
  try {
    const result = once(worker, "message"), exited = once(worker, "exit");
    fixture.resume();
    assert.equal((await result)[0].state, "blocked");
    await exited;
    assert.throws(() => acquireProcessLock(fixture.lockPath, "third work"), /already running/i);
  } finally { release(); }
});

test("releasing an old claim cannot remove a replacement in the same process", t => {
  const { lockPath } = setup(t, "hold");
  const releaseOld = acquireProcessLock(lockPath, "old work");
  rmSync(lockPath, { recursive: true });
  const releaseNew = acquireProcessLock(lockPath, "new work");
  releaseOld();
  assert.throws(() => acquireProcessLock(lockPath, "third work"), /already running/i);
  releaseNew();
});

test("unknown ownership and symbolic links fail closed without removing files", t => {
  const { lockPath } = setup(t, "hold");
  for (const value of ["", "unknown", String(process.pid)]) {
    writeFileSync(lockPath, value);
    assert.throws(() => acquireProcessLock(lockPath, "test work"), /unknown owner|already running/i);
    rmSync(lockPath);
  }
  const target = `${lockPath}.target`;
  mkdirSync(target);
  writeFileSync(join(target, "preserved"), "keep");
  symlinkSync(target, lockPath);
  assert.throws(() => acquireProcessLock(lockPath, "test work"), /symbolic link/i);
  assert.deepEqual(readdirSync(target), ["preserved"]);
});
