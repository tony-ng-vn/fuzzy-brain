import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodePath, installLauncher, launcherPaths } from "../scripts/lib/agent-launcher.mjs";
import { replaceTomlTable, mergeMcpServer, tomlTableExists } from "../scripts/lib/mcp-config.mjs";
import { runInstall } from "../scripts/install-agents.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "fuzzy-brain-agents-test-"));
}

function captureLog() {
  const lines = [];
  return { log: (line) => lines.push(line), lines };
}

// A fixture shaped like the real ~/.codex/config.toml: an http_headers
// subtable carrying a live-looking token, an existing fuzzy-brain table
// to replace, and a trailing table with its own env subtable.
const CODEX_FIXTURE = `[mcp_servers.Neon]
url = "https://mcp.neon.tech/mcp"
enabled = false

[mcp_servers.Neon.http_headers]
Authorization = "Bearer napi_FAKETOKEN12345"

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[mcp_servers.fuzzy-brain]
command = "/old/worktree/bin/brain-run"
args = ["fuzzy-brain-mcp.mjs"]

[mcp_servers.node_repl]
args = []
command = "/some/node_repl"

[mcp_servers.node_repl.env]
FOO = "bar"
`;

test("resolveNodePath prefers a stable package-manager symlink over a version-pinned Cellar path", () => {
  const selected = resolveNodePath({
    candidates: ["/opt/homebrew/bin/node", "/opt/homebrew/Cellar/node/26.6.0/bin/node"],
    isExecutable: (path) => path === "/opt/homebrew/bin/node",
  });
  assert.equal(selected, "/opt/homebrew/bin/node");
});

test("resolveNodePath falls back to process.execPath only when nothing stable exists", () => {
  const selected = resolveNodePath({
    candidates: [undefined, "/opt/homebrew/bin/node", "/it/self"],
    isExecutable: (path) => path === "/it/self",
  });
  assert.equal(selected, "/it/self");
});

test("replaceTomlTable replaces the table in place and leaves every other table byte-for-byte untouched", () => {
  const body = ["[mcp_servers.fuzzy-brain]", 'command = "/Users/tony/.fuzzy-brain/bin/brain-run"', 'args = ["fuzzy-brain-mcp.mjs"]'].join("\n");
  const once = replaceTomlTable(CODEX_FIXTURE, "mcp_servers.fuzzy-brain", body);

  assert.match(once, /\/Users\/tony\/\.fuzzy-brain\/bin\/brain-run/);
  assert.doesNotMatch(once, /\/old\/worktree\/bin\/brain-run/);
  // Every other table, including its live-looking token, is untouched.
  assert.match(once, /Bearer napi_FAKETOKEN12345/);
  assert.match(once, /\[mcp_servers\.openaiDeveloperDocs\]/);
  assert.match(once, /\[mcp_servers\.node_repl\.env\]\nFOO = "bar"/);
});

test("replaceTomlTable is idempotent: a second identical call reproduces the first call's output byte-for-byte", () => {
  const body = ["[mcp_servers.fuzzy-brain]", 'command = "/Users/tony/.fuzzy-brain/bin/brain-run"', 'args = ["fuzzy-brain-mcp.mjs"]'].join("\n");
  const once = replaceTomlTable(CODEX_FIXTURE, "mcp_servers.fuzzy-brain", body);
  const twice = replaceTomlTable(once, "mcp_servers.fuzzy-brain", body);
  assert.equal(twice, once);
});

test("replaceTomlTable appends the table when it is missing, and stays idempotent once appended", () => {
  const noFuzzyBrain = `[mcp_servers.openaiDeveloperDocs]\nurl = "https://developers.openai.com/mcp"\n`;
  const body = ["[mcp_servers.fuzzy-brain]", 'command = "/Users/tony/.fuzzy-brain/bin/brain-run"', 'args = ["fuzzy-brain-mcp.mjs"]'].join("\n");
  const appended = replaceTomlTable(noFuzzyBrain, "mcp_servers.fuzzy-brain", body);
  assert.match(appended, /\[mcp_servers\.openaiDeveloperDocs\]/);
  assert.match(appended, /\[mcp_servers\.fuzzy-brain\]/);
  const appendedTwice = replaceTomlTable(appended, "mcp_servers.fuzzy-brain", body);
  assert.equal(appendedTwice, appended);
});

test("replaceTomlTable writes a clean single table into an empty or missing file", () => {
  const result = replaceTomlTable("", "mcp_servers.fuzzy-brain", "[mcp_servers.fuzzy-brain]\ncommand = \"x\"");
  assert.equal(result, "[mcp_servers.fuzzy-brain]\ncommand = \"x\"\n");
});

test("tomlTableExists reports presence without mutating anything", () => {
  assert.equal(tomlTableExists(CODEX_FIXTURE, "mcp_servers.fuzzy-brain"), true);
  assert.equal(tomlTableExists("", "mcp_servers.fuzzy-brain"), false);
});

test("mergeMcpServer preserves every other top-level key and every other server", () => {
  const config = {
    someOtherSetting: true,
    mcpServers: { xcode: { command: "xcrun", args: ["mcpbridge"] } },
  };
  const merged = mergeMcpServer(config, "fuzzy-brain", { command: "/x/brain-run", args: ["fuzzy-brain-mcp.mjs"] });
  assert.equal(merged.someOtherSetting, true);
  assert.deepEqual(merged.mcpServers.xcode, { command: "xcrun", args: ["mcpbridge"] });
  assert.deepEqual(merged.mcpServers["fuzzy-brain"], { command: "/x/brain-run", args: ["fuzzy-brain-mcp.mjs"] });
});

test("mergeMcpServer is idempotent and handles a config with no mcpServers key yet", () => {
  const once = mergeMcpServer({ general: {} }, "fuzzy-brain", { command: "/x", args: ["a"] });
  const twice = mergeMcpServer(once, "fuzzy-brain", { command: "/x", args: ["a"] });
  assert.deepEqual(once, twice);
});

test("installLauncher writes the home file, a copy of brain-run, and a resolved node path into a temp home", () => {
  const homeDir = tempHome();
  try {
    const result = installLauncher({ repoRoot: "/repo/checkout", homeDir, nodePath: "/opt/homebrew/bin/node" });
    const paths = launcherPaths(homeDir);
    assert.equal(readFileSync(paths.homeFile, "utf8").trim(), "/repo/checkout");
    assert.equal(readFileSync(paths.nodePathFile, "utf8").trim(), "/opt/homebrew/bin/node");
    assert.match(readFileSync(paths.brainRunPath, "utf8"), /Stable launcher for Fuzzy Brain/);
    assert.equal(result.brainRunPath, paths.brainRunPath);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("installLauncher --dry-run writes nothing", () => {
  const homeDir = tempHome();
  try {
    installLauncher({ repoRoot: "/repo/checkout", homeDir, dryRun: true, nodePath: "/opt/homebrew/bin/node" });
    assert.equal(existsSync(join(homeDir, ".fuzzy-brain")), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall registers Codex and the JSON agents idempotently, and skips agents with no config directory", async () => {
  const homeDir = tempHome();
  try {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(join(homeDir, ".codex", "config.toml"), CODEX_FIXTURE);
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    writeFileSync(join(homeDir, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: { nia: { command: "pipx", args: ["run", "nia-mcp-server"], env: { NIA_API_KEY: "nk_FAKESECRET" } } },
    }, null, 2));
    // ~/.gemini, ~/.claude, Claude Desktop's directory, and VS Code's
    // mcp.json are all deliberately absent from this fixture.

    const { log, lines } = captureLog();
    const results = await runInstall({
      repoRoot: "/repo/checkout",
      homeDir,
      hasCli: () => false,
      log,
    });

    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId.codex.status, "written");
    assert.equal(byId.cursor.status, "written");
    assert.equal(byId.gemini.status, "skip");
    assert.equal(byId["claude-desktop"].status, "skip");
    assert.equal(byId.vscode.status, "skip");
    assert.match(byId.vscode.detail, /not found/);

    const codexOut = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    assert.match(codexOut, /command = "[^"]*\.fuzzy-brain\/bin\/brain-run"/);
    assert.match(codexOut, /Bearer napi_FAKETOKEN12345/, "unrelated Codex table must survive untouched");

    const cursorOut = JSON.parse(readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf8"));
    assert.deepEqual(cursorOut.mcpServers.nia.env, { NIA_API_KEY: "nk_FAKESECRET" });
    assert.ok(cursorOut.mcpServers["fuzzy-brain"].command.endsWith("brain-run"));

    // A codex backup was made of the pre-existing file; cursor's file also
    // pre-existed, so it gets one too.
    const dateStamp = new Date().toISOString().slice(0, 10);
    assert.equal(existsSync(join(homeDir, ".codex", `config.toml.bak-${dateStamp}`)), true);
    assert.equal(existsSync(join(homeDir, ".cursor", `mcp.json.bak-${dateStamp}`)), true);

    // Rerunning must be a no-op on both files.
    const codexOutBefore = codexOut;
    const cursorOutBefore = JSON.stringify(cursorOut);
    await runInstall({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });
    assert.equal(readFileSync(join(homeDir, ".codex", "config.toml"), "utf8"), codexOutBefore);
    assert.equal(JSON.stringify(JSON.parse(readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf8"))), cursorOutBefore);

    assert.ok(lines.some((l) => l.includes("For any other MCP-compatible agent")));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall --dry-run writes nothing and never prints a secret from an existing config", async () => {
  const homeDir = tempHome();
  try {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(join(homeDir, ".codex", "config.toml"), CODEX_FIXTURE);
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    writeFileSync(join(homeDir, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: { nia: { command: "pipx", args: [], env: { NIA_API_KEY: "nk_FAKESECRET" } } },
    }));

    const codexBefore = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    const cursorBefore = readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf8");

    const { log, lines } = captureLog();
    await runInstall({ repoRoot: "/repo/checkout", homeDir, dryRun: true, hasCli: () => false, log });

    assert.equal(existsSync(join(homeDir, ".fuzzy-brain")), false, "dry-run must not install the launcher either");
    assert.equal(readFileSync(join(homeDir, ".codex", "config.toml"), "utf8"), codexBefore);
    assert.equal(readFileSync(join(homeDir, ".cursor", "mcp.json"), "utf8"), cursorBefore);

    const output = lines.join("\n");
    assert.doesNotMatch(output, /napi_FAKETOKEN/);
    assert.doesNotMatch(output, /nk_FAKESECRET/);
    assert.ok(lines.some((l) => l.startsWith("[codex] would write:")));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall --only limits which agents are touched", async () => {
  const homeDir = tempHome();
  try {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });

    const results = await runInstall({
      repoRoot: "/repo/checkout",
      homeDir,
      only: ["codex"],
      hasCli: () => false,
      log: () => {},
    });

    const ids = results.map((r) => r.id);
    assert.ok(ids.includes("codex"));
    assert.ok(!ids.includes("cursor"));
    assert.equal(existsSync(join(homeDir, ".cursor", "mcp.json")), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall registers Claude Code via the CLI when present, and is a no-op to run twice", async () => {
  const homeDir = tempHome();
  try {
    const calls = [];
    const runCli = (args) => calls.push(args);
    await runInstall({ repoRoot: "/repo/checkout", homeDir, hasCli: () => true, runCli, log: () => {} });

    assert.deepEqual(calls[0], ["mcp", "remove", "fuzzy-brain", "-s", "user"]);
    assert.deepEqual(calls[1].slice(0, 4), ["mcp", "add", "fuzzy-brain", "-s"]);
    assert.ok(calls[1].includes("--"));
    assert.ok(calls[1][calls[1].length - 1] === "fuzzy-brain-mcp.mjs");
    // Registering via the CLI never touches ~/.claude.json directly.
    assert.equal(existsSync(join(homeDir, ".claude.json")), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall --dry-run never invokes the Claude CLI", async () => {
  const homeDir = tempHome();
  try {
    const calls = [];
    await runInstall({
      repoRoot: "/repo/checkout",
      homeDir,
      dryRun: true,
      hasCli: () => true,
      runCli: (args) => calls.push(args),
      log: () => {},
    });
    assert.deepEqual(calls, []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall falls back to editing ~/.claude.json, in the same shape `claude mcp add` writes, preserving other servers", async () => {
  const homeDir = tempHome();
  try {
    writeFileSync(join(homeDir, ".claude.json"), JSON.stringify({
      mcpServers: { xcode: { type: "stdio", command: "xcrun", args: ["mcpbridge"], env: {} } },
      numStartups: 42,
    }));

    await runInstall({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });

    const written = JSON.parse(readFileSync(join(homeDir, ".claude.json"), "utf8"));
    assert.equal(written.numStartups, 42);
    assert.deepEqual(written.mcpServers.xcode, { type: "stdio", command: "xcrun", args: ["mcpbridge"], env: {} });
    assert.equal(written.mcpServers["fuzzy-brain"].type, "stdio");
    assert.deepEqual(written.mcpServers["fuzzy-brain"].args, ["fuzzy-brain-mcp.mjs"]);
    assert.deepEqual(written.mcpServers["fuzzy-brain"].env, {});
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall detects Claude Code from a bare ~/.claude directory even without ~/.claude.json", async () => {
  const homeDir = tempHome();
  try {
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    const results = await runInstall({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });
    const claudeCode = results.find((r) => r.id === "claude-code");
    assert.equal(claudeCode.status, "written");
    assert.equal(existsSync(join(homeDir, ".claude.json")), true);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall skips Claude Code entirely when nothing signals it is installed", async () => {
  const homeDir = tempHome();
  try {
    const results = await runInstall({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });
    const claudeCode = results.find((r) => r.id === "claude-code");
    assert.equal(claudeCode.status, "skip");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall only rewrites VS Code's mcp.json when it already exists", async () => {
  const homeDir = tempHome();
  try {
    const vscodeDir = join(homeDir, "Library", "Application Support", "Code", "User");
    mkdirSync(vscodeDir, { recursive: true });
    writeFileSync(join(vscodeDir, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));

    const results = await runInstall({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });
    const vscode = results.find((r) => r.id === "vscode");
    assert.equal(vscode.status, "written");

    const written = JSON.parse(readFileSync(join(vscodeDir, "mcp.json"), "utf8"));
    assert.deepEqual(written.mcpServers.other, { command: "x", args: [] });
    assert.ok(written.mcpServers["fuzzy-brain"].command.endsWith("brain-run"));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
