import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

test("a full trace summary stays within a small process file limit", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "trace-read-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = "2026-09-25";
  const folder = join(root, day);
  await mkdir(folder, { mode: 0o700 });
  for (let i = 0; i < 320; i++) {
    const id = `${day}_${randomUUID()}`;
    await writeFile(join(folder, `${id}.start.json`), JSON.stringify({ id, event: "start", operation: "recall", release: "test" }), { mode: 0o600 });
    await writeFile(join(folder, `${id}.finish.json`), JSON.stringify({ id, event: "finish", outcome: "success", output: { hit_count: 0 }, duration_ms: 1 }), { mode: 0o600 });
  }
  const moduleUrl = new URL("../scripts/lib/operation-journal.mjs", import.meta.url).href;
  const script = `import { createOperationJournal } from ${JSON.stringify(moduleUrl)};
    const summary = await createOperationJournal({ directory: process.argv[1] }).summary({ day: ${JSON.stringify(day)} });
    console.log(JSON.stringify(summary));`;
  const { stdout } = await run("/bin/bash", ["-c", 'ulimit -Sn 128; ulimit -Hn 128; exec "$@"', "trace-read-limit", process.execPath, "--input-type=module", "-e", script, root], { timeout: 30000 });
  const summary = JSON.parse(stdout);
  assert.equal(summary.operations, 320);
  assert.equal(summary.empty_retrievals, 320);
  assert.equal(summary.exhaustive, true);
});
