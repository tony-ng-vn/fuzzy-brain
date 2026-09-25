import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCaptureCursor } from "../scripts/lib/session-capture-cursor.mjs";

test("capture position survives restarts and stays separate for each source", t => {
  const home = mkdtempSync(join(tmpdir(), "capture-position-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, "private");
  const first = createCaptureCursor(directory, "source-a");
  assert.equal(first.read(), null);
  first.write("session-b");
  assert.equal(createCaptureCursor(directory, "source-a").read(), "session-b");
  assert.equal(createCaptureCursor(directory, "source-b").read(), null);
  first.write("session-c");
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const file = join(directory, files[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, after: "session-c" });
  writeFileSync(file, "unfinished hint");
  assert.equal(first.read(), null);
  first.write("session-d");
  assert.equal(first.read(), "session-d");
  assert.throws(() => first.write("x".repeat(1025)));
});

test("capture progress refuses linked files and directories", t => {
  const home = mkdtempSync(join(tmpdir(), "capture-position-links-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, "target");
  writeFileSync(target, "leave this alone");
  const directory = join(home, "private"), cursor = createCaptureCursor(directory, "source");
  cursor.write("first");
  const file = join(directory, readdirSync(directory)[0]);
  rmSync(file);
  symlinkSync(target, file);
  assert.throws(() => cursor.read());
  assert.throws(() => cursor.write("next"));
  assert.equal(readFileSync(target, "utf8"), "leave this alone");
  const link = join(home, "link");
  symlinkSync(directory, link);
  assert.throws(() => createCaptureCursor(link, "source").read());
  assert.throws(() => createCaptureCursor(link, "source").write("next"));
});
