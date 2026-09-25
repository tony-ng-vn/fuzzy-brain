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
    ["ingest-sessions.mjs", ["--limit", "32"]],
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

test("fusion sync continues independent work when session ingestion fails", async () => {
  const calls = [];
  const diagnostics = [];
  const result = await runFusionSync({
    run: async (script) => {
      calls.push(script);
      if (script === "ingest-sessions.mjs") throw new Error("ingest failed");
      return `${script} ok`;
    },
    onError: (stage, error) => diagnostics.push([stage, error.message]),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["ingest-sessions.mjs", "sweep-watch-items.mjs", "embed-sweep.mjs"]);
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


test("fusion sync reports each failed stage and keeps completed work visible", async () => {
  const result = await runFusionSync({
    run: async script => {
      if (script !== "embed-sweep.mjs") throw new Error("PRIVATE child command and source text");
      return "indexed 4 records";
    },
    onError() { throw new Error("PRIVATE logging failure"); },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(item => item.stage), ["ingest", "watch-items"]);
  assert.deepEqual(result.output, ["indexed 4 records"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("fusion sync rejects invalid indexing limits before starting capture", async () => {
  for (const embeddingLimit of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(runFusionSync({ embeddingLimit, run() { assert.fail("capture must not start"); } }), { code: "invalid" });
  }
});

test("fusion sync bounds each session source independently of the indexing limit", async () => {
  const calls = [];
  await runFusionSync({ sessionLimit: 4, embeddingLimit: 9, run: async (script, args) => { calls.push([script, args]); return "done"; } });
  assert.deepEqual(calls[0], ["ingest-sessions.mjs", ["--limit", "4"]]);
  assert.deepEqual(calls[2], ["embed-sweep.mjs", ["--limit", "9"]]);
  for (const sessionLimit of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(runFusionSync({ sessionLimit, run() { assert.fail("capture must not start"); } }), { code: "invalid" });
  }
});
