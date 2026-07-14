// The SessionEnd archive hook: a dumb local copy that must never fail the
// session it runs in. No parsing, no network, no database -- capture is
// split from ingestion on purpose (issue #12 plan point 1).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "..", "scripts", "hooks", "archive-session.mjs");

function runHook(input, env = {}) {
  return execFileSync("node", [hook], {
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  });
}

test("archives the transcript into the project-slug directory", () => {
  const home = mkdtempSync(join(tmpdir(), "fuzzy-hook-"));
  const projectDir = join(home, "projects", "-Users-tony-Desktop-fuzzy-brain");
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, "abc-123.jsonl");
  writeFileSync(transcript, '{"type":"user"}\n');

  try {
    runHook(
      JSON.stringify({ session_id: "abc-123", transcript_path: transcript, cwd: "/Users/tony/Desktop/fuzzy-brain" }),
      { FUZZY_BRAIN_HOME: home },
    );
    const archived = join(home, "session-archive", "claude-code", "-Users-tony-Desktop-fuzzy-brain", "abc-123.jsonl");
    assert.ok(existsSync(archived), "transcript must be copied into the archive");
    assert.equal(readFileSync(archived, "utf8"), '{"type":"user"}\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("re-archiving the same session overwrites with the newer copy", () => {
  const home = mkdtempSync(join(tmpdir(), "fuzzy-hook-"));
  const projectDir = join(home, "projects", "-Users-tony-Desktop-fuzzy-brain");
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, "abc-123.jsonl");

  try {
    writeFileSync(transcript, "first\n");
    runHook(JSON.stringify({ session_id: "abc-123", transcript_path: transcript }), { FUZZY_BRAIN_HOME: home });
    writeFileSync(transcript, "first\nsecond\n");
    runHook(JSON.stringify({ session_id: "abc-123", transcript_path: transcript }), { FUZZY_BRAIN_HOME: home });
    const archived = join(home, "session-archive", "claude-code", "-Users-tony-Desktop-fuzzy-brain", "abc-123.jsonl");
    assert.equal(readFileSync(archived, "utf8"), "first\nsecond\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("never fails the session: garbage stdin and missing files exit 0", () => {
  const home = mkdtempSync(join(tmpdir(), "fuzzy-hook-"));
  try {
    // Both would throw if unguarded; the hook must swallow and exit 0,
    // because a failing SessionEnd hook degrades every session it runs in.
    runHook("not json at all", { FUZZY_BRAIN_HOME: home });
    runHook(JSON.stringify({ session_id: "x", transcript_path: join(home, "does-not-exist.jsonl") }), {
      FUZZY_BRAIN_HOME: home,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
