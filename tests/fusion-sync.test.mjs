import test from "node:test";
import assert from "node:assert/strict";
import { renderLaunchAgentPlist, runFusionSync } from "../scripts/fusion-sync.mjs";

test("fusion sync ingests settled sessions before filling a bounded number of embeddings", async () => {
  const calls = [];
  const result = await runFusionSync({
    run: async (script, args) => {
      calls.push([script, args]);
      return `${script} ok`;
    },
    embeddingLimit: 32,
  });

  assert.deepEqual(calls, [
    ["ingest-sessions.mjs", []],
    ["sweep-watch-items.mjs", []],
    ["embed-sweep.mjs", ["--limit", "32"]],
  ]);
  assert.equal(result.ok, true);
});

test("fusion sync still fills embeddings when the watch-item sweep cannot reach its backend", async () => {
  const calls = [];
  const diagnostics = [];
  const result = await runFusionSync({
    run: async (script) => {
      calls.push(script);
      if (script === "sweep-watch-items.mjs") throw new Error("insforge unreachable");
      return `${script} ok`;
    },
    onError: (stage, error) => diagnostics.push([stage, error.message]),
  });

  assert.deepEqual(calls, ["ingest-sessions.mjs", "sweep-watch-items.mjs", "embed-sweep.mjs"]);
  assert.deepEqual(diagnostics, [["watch-items", "insforge unreachable"]]);
  assert.equal(result.ok, false);
  assert.match(result.error, /next run retries them/);
  assert.doesNotMatch(result.error, /DATABASE_URL|postgres/i);
});

test("fusion sync stops before embedding when ingestion fails", async () => {
  const calls = [];
  const diagnostics = [];
  const result = await runFusionSync({
    run: async (script) => {
      calls.push(script);
      throw new Error("ingest failed");
    },
    onError: (stage, error) => diagnostics.push([stage, error.message]),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["ingest-sessions.mjs"]);
  assert.deepEqual(diagnostics, [["ingest", "ingest failed"]]);
  assert.doesNotMatch(result.error, /DATABASE_URL|postgres/i);
});

test("launch agent plist launches through the stable brain-run launcher, never a checkout path", () => {
  const plist = renderLaunchAgentPlist({
    homeDir: "/Users/tony",
    intervalSeconds: 3600,
  });
  assert.match(plist, /com\.tony\.fuzzy-brain\.sync/);
  assert.match(plist, /<integer>3600<\/integer>/);
  assert.match(plist, /<string>\/Users\/tony\/\.fuzzy-brain\/bin\/brain-run<\/string>/);
  assert.match(plist, /<string>fusion-sync\.mjs<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/tony\/\.fuzzy-brain<\/string>/);
  assert.match(plist, /\/Users\/tony\/\.fuzzy-brain\/logs\/fusion-sync\.log/);
  // Reinstalling this plist after moving the checkout must never bake a
  // worktree or repo path back into launchd's ProgramArguments.
  assert.doesNotMatch(plist, /Desktop\/fuzzy-brain/);
  assert.doesNotMatch(plist, /worktrees/);
});
