import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function cli(args) {
  const result = spawnSync(process.execPath, ["scripts/tbrain.mjs", ...args], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE: "0", DATABASE_URL: "postgresql://127.0.0.1:1/unavailable" },
  });
  assert.equal(result.error, undefined);
  return result;
}

test("every portable command explains its use without storage or input files", () => {
  const general = JSON.parse(cli(["--help"]).stdout);
  for (const usage of general.commands) {
    const command = usage.split(" ")[0];
    for (const args of [[command, "--help"], ["help", command]]) {
      const result = cli(args);
      assert.equal(result.status, 0, `${command} help failed: ${result.stderr}`);
      const help = JSON.parse(result.stdout);
      assert.equal(help.state, "help");
      assert.equal(help.command, command);
      assert.equal(help.usage, usage);
      assert.ok(help.note.length > 20);
    }
  }
});

test("file-writing commands expose the actual JSON format without reading a supplied file", () => {
  for (const command of ["validate", "import", "report-outcome"]) {
    const result = cli([command, "/PRIVATE_MISSING_FILE", "--help"]);
    assert.equal(result.status, 0);
    const help = JSON.parse(result.stdout);
    assert.equal(help.input_schema.type, "object");
    assert.ok(help.input_schema.properties);
    assert.doesNotMatch(result.stdout, /PRIVATE_MISSING_FILE/);
    assert.equal(result.stderr, "");
  }
  const report = JSON.parse(cli(["report-outcome", "--help"]).stdout);
  assert.ok(report.input_schema.properties.finding.enum.includes("incomplete_readback"));
  assert.match(report.note, /operation_id.*workflow_id/);
});

test("unknown commands remain invalid and point to offline help without echoing input", () => {
  for (const args of [["PRIVATE_UNKNOWN", "--help"], ["help", "PRIVATE_UNKNOWN"], ["search", "PRIVATE_QUERY", "--limit", "0"]]) {
    const result = cli(args);
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error.code, "invalid");
    assert.match(failure.error.help, /--help/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/);
  }
});
