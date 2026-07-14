// Unit tests for the ingest trigger's logic (lib/ingest.ts), which the
// frontend button's API route calls. Matches the repo's own pattern: the
// route stays a thin, untested pass-through (see app/api/nodes/route.ts);
// the real logic gets tested directly.
import test from "node:test";
import assert from "node:assert/strict";
import { runIngest } from "../lib/ingest.ts";

test("runIngest runs the ingest script by name and returns its stdout", () => {
  const fakeExec = (cmd, args) => {
    assert.equal(cmd, "node");
    assert.ok(args[0].endsWith("ingest-sessions.mjs"), `expected the ingest script, got ${args[0]}`);
    return "ingest-sessions summary (claude-code)\n  ingested         3 (12 evidence rows)\n";
  };
  const result = runIngest(fakeExec);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.output, /ingested\s+3/);
});

test("runIngest surfaces a subprocess failure as a structured error, never throws", () => {
  const fakeExec = () => {
    throw new Error("no ingest config at ~/.fuzzy-brain/ingest.json; create it with at least an allowlist");
  };
  assert.doesNotThrow(() => runIngest(fakeExec));
  const result = runIngest(fakeExec);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /ingest config/);
});
