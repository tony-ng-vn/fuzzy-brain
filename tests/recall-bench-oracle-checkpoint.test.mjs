// Covers the resumability contract load.mjs's verifyOracle grew for the
// quality50k tier (DESIGN.md section 4.3.1, section 7 rung 2): a checkpoint
// at .out/<tier>/oracle-progress.jsonl is appended per-query as ranks are
// measured, an already-checkpointed query is skipped on restart, and a
// checkpoint line is trusted only when its query-text hash still matches the
// text on disk -- which is what makes a crash mid-repair safe (see the
// comment above verifyOracle in load.mjs).
//
// No DB and no embedding model: verifyOracle takes a client, and here it's a
// fake whose .query() call count is the load-bearing assertion. Runs with no DB.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const benchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "experiments", "recall-bench");
const { verifyOracle } = await import(pathToFileURL(join(benchRoot, "load.mjs")));
const { config } = await import(pathToFileURL(join(benchRoot, "config.mjs")));

// Matches load.mjs's private queryTextHash exactly -- duplicated here rather
// than exported, since the checkpoint file's on-disk shape is the actual
// contract this test pins, not the helper name. The TARGET is part of the
// identity, not just the text: re-targeting changes which memory a query is
// about, and a line matched on text alone would hand back ranks measured
// against a different target.
const textHash = (text, targets = []) => createHash("sha256").update(JSON.stringify({ text, targets })).digest("hex");

function makeQuery(qid, text, target) {
  return {
    qid, split: "dev", family: "rare_token", text, targets: [target],
    declared_filters: { date_from: null, date_to: null, people: [] },
    certificate: { solvable: true, signals: [], pending_lanes: ["vector"] },
    diagnostics: { distractor_ids: [], difficulty: 1, repair_round: 0 },
  };
}

const tier = { schema: "test_schema", vector: "real", laneDepth: 10, dims: 2 };
const dims = 2;
const vectors = new Float32Array([0.1, 0.2, 0.3, 0.4]); // 2 queries x dims=2

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "oracle-checkpoint-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a checkpointed query with a matching text hash is skipped, not re-measured", async () => {
  await withTempDir(async (dir) => {
    const checkpointPath = join(dir, "oracle-progress.jsonl");
    const q1 = makeQuery("q1", "hello world", 101);
    const q2 = makeQuery("q2", "goodbye world", 102);

    await writeFile(checkpointPath, JSON.stringify({
      qid: "q1", family: "rare_token", textHash: textHash(q1.text, q1.targets),
      laneRanks: { and: 1, or: null, trigram: null, vector: 2 },
    }) + "\n");

    let calls = 0;
    const client = {
      query: async () => {
        calls++;
        return { rows: [{ and_rank: 5, or_rank: null, trg_rank: null, vector_rank: 20 }] };
      },
    };

    const result = await verifyOracle(client, tier, {
      dev: [q1, q2], test: [], vectors, dims, cfg: config, repairRounds: 0, checkpointPath,
    });

    // Only q2 should have hit the database -- q1 was satisfied from the checkpoint.
    assert.equal(calls, 1, "checkpointed query must not re-run measureLaneRanks");
    assert.equal(result.summary.overall.n, 2);

    const lines = (await readFile(checkpointPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2, "checkpoint gains exactly one new line, for the query actually measured");
    const q2Line = JSON.parse(lines[1]);
    assert.equal(q2Line.qid, "q2");
    assert.deepEqual(q2Line.laneRanks, { and: 5, or: null, trigram: null, vector: 20 });
  });
});

test("a checkpoint line whose text hash no longer matches on-disk text is not trusted", async () => {
  await withTempDir(async (dir) => {
    const checkpointPath = join(dir, "oracle-progress.jsonl");
    const q1 = makeQuery("q1", "hello world", 101);

    // Checkpoint line was written against different text -- e.g. a dead run's
    // repair round rewrote it in memory, checkpointed the rewrite, and then
    // crashed before the query files on disk were updated (see verifyOracle's
    // comment: repair only reaches disk at the very end of runVerifyOracle).
    await writeFile(checkpointPath, JSON.stringify({
      qid: "q1", family: "rare_token", textHash: textHash("some other repaired text"),
      laneRanks: { and: 1, or: null, trigram: null, vector: 2 },
    }) + "\n");

    let calls = 0;
    const client = {
      query: async () => {
        calls++;
        return { rows: [{ and_rank: 3, or_rank: null, trg_rank: null, vector_rank: 9 }] };
      },
    };

    await verifyOracle(client, tier, {
      dev: [q1], test: [], vectors: vectors.subarray(0, dims), dims, cfg: config, repairRounds: 0, checkpointPath,
    });

    assert.equal(calls, 1, "a stale checkpoint entry (text hash mismatch) must be re-measured against on-disk text, never trusted");
  });
});

test("a truncated trailing line in the checkpoint file is dropped, not thrown", async () => {
  await withTempDir(async (dir) => {
    const checkpointPath = join(dir, "oracle-progress.jsonl");
    const q1 = makeQuery("q1", "hello world", 101);
    const q2 = makeQuery("q2", "goodbye world", 102);

    await writeFile(checkpointPath, JSON.stringify({
      qid: "q1", family: "rare_token", textHash: textHash(q1.text, q1.targets),
      laneRanks: { and: 1, or: null, trigram: null, vector: 2 },
    }) + "\n");
    // Simulate a crash mid-append: a partial JSON line with no trailing newline.
    await appendFile(checkpointPath, '{"qid":"q2","family":"rare_token","textHa');

    let calls = 0;
    const client = {
      query: async () => {
        calls++;
        return { rows: [{ and_rank: 4, or_rank: null, trg_rank: null, vector_rank: 8 }] };
      },
    };

    await assert.doesNotReject(verifyOracle(client, tier, {
      dev: [q1, q2], test: [], vectors, dims, cfg: config, repairRounds: 0, checkpointPath,
    }));

    // q1's valid line survives; q2's truncated line is treated as absent, so
    // q2 gets freshly measured rather than the run failing outright.
    assert.equal(calls, 1, "q1 stays checkpointed; q2's truncated line falls back to a fresh measurement");
  });
});

test("a checkpoint line whose target no longer matches is not trusted, even when the text does", async () => {
  await withTempDir(async (dir) => {
    const checkpointPath = join(dir, "oracle-progress.jsonl");
    const q1 = makeQuery("q1", "hello world", 101);

    // Same text, different target: what a dead run's RE-TARGET round leaves
    // behind. Trusting this line would score the oracle on ranks measured
    // against a memory the query no longer points at.
    await writeFile(checkpointPath, JSON.stringify({
      qid: "q1", family: "rare_token", textHash: textHash(q1.text, [999]),
      laneRanks: { and: 1, or: null, trigram: null, vector: 2 },
    }) + "\n");

    let calls = 0;
    const client = {
      query: async () => {
        calls++;
        return { rows: [{ and_rank: 3, or_rank: null, trg_rank: null, vector_rank: 9 }] };
      },
    };

    await verifyOracle(client, tier, {
      dev: [q1], test: [], vectors: vectors.subarray(0, dims), dims, cfg: config, repairRounds: 0, checkpointPath,
    });

    assert.equal(calls, 1, "a checkpoint line measured against a different target must be re-measured");
  });
});

// The oracle-definition fix (evaluator calibration decision 1): a family that
// plants a resolvable closed-world date constraint has its lane reachability
// measured WITH the ground-truth range applied, because the engine genuinely
// carries that mechanism. Both numbers are reported so the filter's worth is
// visible rather than asserted.
test("a date-constrained query is measured both with and without its range, and the gate uses the filtered ranks", async () => {
  const dated = {
    ...makeQuery("d1", "the trellis and the awning in March 2019", 101),
    family: "date_filter",
    declared_filters: { date_from: "2019-03-01T00:00:00.000Z", date_to: "2019-04-01T00:00:00.000Z", people: [] },
  };

  const seen = [];
  const client = {
    query: async (sql, params) => {
      seen.push({ filtered: sql.includes("occurred_at <@"), params });
      // Unfiltered the target is buried; under its own date range it is first.
      return seen.length === 1
        ? { rows: [{ and_rank: null, or_rank: null, trg_rank: null, vector_rank: 812 }] }
        : { rows: [{ and_rank: 1, or_rank: 4, trg_rank: null, vector_rank: 2 }] };
    },
  };

  const result = await verifyOracle(client, tier, {
    dev: [dated], test: [], vectors: vectors.subarray(0, dims), dims, cfg: config,
    repairRounds: 0, retargetAttempts: 0,
  });

  assert.equal(seen.length, 2, "a date-constrained query is measured twice: unfiltered, then filtered");
  assert.equal(seen[0].filtered, false);
  assert.equal(seen[1].filtered, true);
  assert.equal(seen[1].params.at(-1), "[2019-03-01T00:00:00.000Z,2019-04-01T00:00:00.000Z)",
    "the range is bound half-open, matching engine.mjs's rangeLiteral");

  assert.equal(result.summary.overall.bestLaneRankAt10, 1, "the gate scores the filtered ranks");
  assert.equal(result.summaryUnfiltered.overall.bestLaneRankAt10, 0, "the unfiltered ranks are reported alongside");
});

test("a query that plants no date constraint is never measured under a filter", async () => {
  const plain = makeQuery("p1", "the reference code kbz-4417", 101);
  const seen = [];
  const client = {
    query: async (sql) => {
      seen.push(sql.includes("occurred_at <@"));
      return { rows: [{ and_rank: 1, or_rank: null, trg_rank: null, vector_rank: 30 }] };
    },
  };

  await verifyOracle(client, tier, {
    dev: [plain], test: [], vectors: vectors.subarray(0, dims), dims, cfg: config,
    repairRounds: 0, retargetAttempts: 0,
  });

  assert.deepEqual(seen, [false], "no date range in declared_filters means exactly one unfiltered measurement");
});
