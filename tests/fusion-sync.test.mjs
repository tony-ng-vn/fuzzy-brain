import test from "node:test";
import assert from "node:assert/strict";
import { renderLaunchAgentPlist, resolveNodePath, runFusionSync } from "../scripts/fusion-sync.mjs";

test("launch agent prefers a stable package-manager Node symlink", () => {
  const selected = resolveNodePath({
    candidates: ["/opt/homebrew/bin/node", "/opt/homebrew/Cellar/node/26.6.0/bin/node"],
    isExecutable: (path) => path === "/opt/homebrew/bin/node",
  });
  assert.equal(selected, "/opt/homebrew/bin/node");
});

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

test("launch agent plist uses stable absolute paths and a one-hour cadence", () => {
  const plist = renderLaunchAgentPlist({
    nodePath: "/opt/homebrew/bin/node",
    repoRoot: "/Users/tony/Desktop/fuzzy-brain",
    homeDir: "/Users/tony",
    intervalSeconds: 3600,
  });
  assert.match(plist, /com\.tony\.fuzzy-brain\.sync/);
  assert.match(plist, /<integer>3600<\/integer>/);
  assert.match(plist, /\/Users\/tony\/Desktop\/fuzzy-brain\/scripts\/fusion-sync\.mjs/);
  assert.match(plist, /\/Users\/tony\/\.fuzzy-brain\/logs\/fusion-sync\.log/);
});
