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

test("runJson closes stdin even when no input is supplied", async (t) => {
  const script = await childScript(t, `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(JSON.stringify({ input }));
  `);
  assert.deepEqual(await runJson(script, [], undefined, { timeout: 1000 }), { input: "" });
});

test("runJson reports exit status without exposing child output or arguments", async (t) => {
  const script = await childScript(t, `
    process.stdout.write("private stdout");
    process.stderr.write("private stderr postgresql://credentials");
    process.exitCode = 7;
  `);
  await assert.rejects(runJson(script, ["private argument"], { raw: "private input" }), (error) => {
    assert.equal(error.code, 7);
    assert.equal(error.message, "Brain subprocess failed.");
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /private|postgresql|child\.mjs/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("runJson rejects invalid JSON without including the source passage", async (t) => {
  const script = await childScript(t, 'process.stdout.write("private invalid JSON");');
  await assert.rejects(runJson(script, []), (error) => {
    assert.equal(error.message, "Brain subprocess returned invalid JSON.");
    assert.doesNotMatch(error.stack, /private invalid/);
    return true;
  });
});

test("runJson terminates a child that stalls and handles SIGTERM", async (t) => {
  const script = await childScript(t, `
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(runJson(script, [], undefined, { timeout: 400 }), (error) => {
    assert.equal(error.killed, true);
    assert.equal(error.signal, "SIGKILL");
    return true;
  });
});

test("runJson handles a child closing stdin before a large write completes", async (t) => {
  const script = await childScript(t, `
    import { closeSync } from "node:fs";
    closeSync(0);
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(runJson(script, [], { raw: "x".repeat(2_000_000) }, { timeout: 1000 }),
    /Brain subprocess failed/);
});

test("runJson limits subprocess output", async (t) => {
  const script = await childScript(t, 'process.stdout.write("x".repeat(4096));');
  await assert.rejects(runJson(script, [], undefined, { maxBuffer: 1024 }), (error) => {
    assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    assert.equal(error.message, "Brain subprocess failed.");
    return true;
  });
});

test("runJson handles spawn failure without exposing paths", async (t) => {
  const script = await childScript(t, 'process.stdout.write("{}");');
  await assert.rejects(runJson(script, [], undefined, { cwd: join(script, "missing-private-path") }), (error) => {
    assert.equal(error.code, "ENOTDIR");
    assert.doesNotMatch(error.stack, /missing-private-path|child\.mjs/);
    return true;
  });
});

test("runJson rejects unserializable input without including its contents", async () => {
  const input = { raw: "private input" };
  input.self = input;
  await assert.rejects(runJson("unused.mjs", [], input), (error) => {
    assert.equal(error.message, "Brain operation input is not JSON serializable.");
    assert.doesNotMatch(error.stack, /private input/);
    return true;
  });
});
