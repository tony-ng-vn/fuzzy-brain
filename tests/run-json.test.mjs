import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJson } from "../scripts/lib/run-json.mjs";

async function childScript(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "brain-run-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "child.mjs");
  await writeFile(script, source);
  return script;
}

test("runJson delivers the complete JSON body and closes subprocess stdin", async (t) => {
  const script = await childScript(t, `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(JSON.stringify({ input: JSON.parse(input), args: process.argv.slice(2) }));
  `);
  const input = { raw: "Keep my exact words.\n".repeat(20_000), body: "quoted \"text\"" };
  const result = await runJson(script, ["add-node"], input, { timeout: 1000 });
  assert.deepEqual(result, { input, args: ["add-node"] });
});
