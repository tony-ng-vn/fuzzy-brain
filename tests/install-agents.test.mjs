import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodePath, installLauncher, launcherPaths } from "../scripts/lib/agent-launcher.mjs";
import { replaceTomlTable, mergeMcpServer, tomlTableExists } from "../scripts/lib/mcp-config.mjs";
import { parseArgs, runInstall } from "../scripts/install-agents.mjs";
import {
  checkSourceReady,
  needsDependencyInstall,
  readSourceState,
  resolveLaunchRoot,
  runtimePaths,
  syncRuntime,
  SourceNotReadyError,
} from "../scripts/lib/agent-runtime.mjs";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "fuzzy-brain-agents-test-"));
}

function captureLog() {
  const lines = [];
  return { log: (line) => lines.push(line), lines };
}

// Cloning a repo is not what the agent-config tests are about, and none of
// them may go near the real ~/.fuzzy-brain, so they all stub the sync.
function fakeRuntimeSync({ homeDir, dryRun }) {
  return {
    ...runtimePaths(homeDir),
    dryRun: Boolean(dryRun),
    action: "update",
    commit: "abc1234",
    subject: "a commit on main",
    dependencies: { install: false, reason: "package-lock.json unchanged" },
    warnings: [],
  };
}

function installAgents(options) {
  return runInstall({ syncRuntime: fakeRuntimeSync, ...options });
}

// A scripted git that answers the read-only questions readSourceState asks
// and records every command, so a test can assert what was and was not run.
function fakeGit({ dirty = [], untracked = [], hasMain = true, hasRemoteMain = true, behind = 0, described = "abc1234\tland the thing" } = {}) {
  const calls = [];
  const git = (args, cwd) => {
    calls.push({ args, cwd });
    const joined = args.join(" ");
    if (joined.includes("refs/heads/main")) {
      if (!hasMain) throw new Error("no such ref");
      return "aaaaaaa\n";
    }
    if (joined.includes("refs/remotes/origin/main")) {
      if (!hasRemoteMain) throw new Error("no such ref");
      return "bbbbbbb\n";
    }
    if (args[0] === "status") return `${dirty.join("\n")}\n`;
    if (args[0] === "ls-files") return `${untracked.join("\n")}\n`;
    if (args[0] === "rev-list") return `${behind}\n`;
    if (args[0] === "log") return `${described}\n`;
    // Real git creates the destination; the copy step after it depends on that.
    if (args[0] === "clone") mkdirSync(args[args.length - 1], { recursive: true });
    return "";
  };
  return { git, calls };
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
    const results = await installAgents({
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
    await installAgents({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });
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
    await installAgents({ repoRoot: "/repo/checkout", homeDir, dryRun: true, hasCli: () => false, log });

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

    const results = await installAgents({
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
    await installAgents({ repoRoot: "/repo/checkout", homeDir, hasCli: () => true, runCli, log: () => {} });

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
    await installAgents({
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

    await installAgents({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });

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
    const results = await installAgents({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });
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
    const results = await installAgents({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });
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

    const results = await installAgents({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log: () => {} });
    const vscode = results.find((r) => r.id === "vscode");
    assert.equal(vscode.status, "written");

    const written = JSON.parse(readFileSync(join(vscodeDir, "mcp.json"), "utf8"));
    assert.deepEqual(written.mcpServers.other, { command: "x", args: [] });
    assert.ok(written.mcpServers["fuzzy-brain"].command.endsWith("brain-run"));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("checkSourceReady passes a clean checkout whose main matches the remote", () => {
  const check = checkSourceReady({ hasMain: true, trackedChanges: [], untracked: [], behindCount: 0 });
  assert.equal(check.ok, true);
  assert.deepEqual(check.problems, []);
  assert.deepEqual(check.warnings, []);
});

test("checkSourceReady refuses a checkout with uncommitted tracked changes, and says how to fix it", () => {
  const check = checkSourceReady({ hasMain: true, trackedChanges: ["M scripts/brain.mjs"], behindCount: 0 });
  assert.equal(check.ok, false);
  assert.match(check.problems[0].what, /1 uncommitted change\(s\)/);
  assert.match(check.problems[0].what, /scripts\/brain\.mjs/);
  assert.match(check.problems[0].fix, /commit or stash/);
});

test("checkSourceReady refuses a main that is behind origin/main and names the gap", () => {
  const check = checkSourceReady({ hasMain: true, trackedChanges: [], behindCount: 3 });
  assert.equal(check.ok, false);
  assert.match(check.problems[0].what, /3 commit\(s\) behind origin\/main/);
  assert.match(check.problems[0].fix, /git fetch origin/);
});

test("checkSourceReady refuses a checkout with no local main", () => {
  const check = checkSourceReady({ hasMain: false, trackedChanges: [], behindCount: 0 });
  assert.equal(check.ok, false);
  assert.match(check.problems[0].what, /no local main branch/);
});

test("checkSourceReady only warns about untracked files, because they cannot enter a clone", () => {
  const check = checkSourceReady({ hasMain: true, trackedChanges: [], untracked: ["docs/scratch.md"], behindCount: 0 });
  assert.equal(check.ok, true);
  assert.match(check.warnings[0], /1 untracked file\(s\)/);
});

test("checkSourceReady warns, but does not refuse, when there is no origin/main to compare against", () => {
  const check = checkSourceReady({ hasMain: true, trackedChanges: [], behindCount: null });
  assert.equal(check.ok, true);
  assert.match(check.warnings[0], /no origin\/main ref/);
});

test("checkSourceReady reports every problem at once instead of stopping at the first", () => {
  const check = checkSourceReady({ hasMain: true, trackedChanges: ["M a", "M b"], behindCount: 2 });
  assert.equal(check.problems.length, 2);
});

test("readSourceState reads cleanliness, drift, and the commit main is on without fetching", () => {
  const { git, calls } = fakeGit({ dirty: ["M scripts/brain.mjs"], untracked: ["docs/scratch.md"], behind: 4 });
  const state = readSourceState({ sourceRoot: "/repo", git });

  assert.equal(state.hasMain, true);
  assert.deepEqual(state.trackedChanges, ["M scripts/brain.mjs"]);
  assert.deepEqual(state.untracked, ["docs/scratch.md"]);
  assert.equal(state.behindCount, 4);
  assert.equal(state.commit, "abc1234");
  assert.equal(state.subject, "land the thing");
  // A fetch would write into the source checkout's .git; reading must not.
  assert.ok(!calls.some((c) => c.args[0] === "fetch"));
});

test("readSourceState reports an unknown drift rather than zero when origin/main is missing", () => {
  const { git } = fakeGit({ hasRemoteMain: false });
  assert.equal(readSourceState({ sourceRoot: "/repo", git }).behindCount, null);
});

test("needsDependencyInstall installs on a fresh clone and whenever node_modules is gone", () => {
  assert.equal(needsDependencyInstall({ freshClone: true }).install, true);
  assert.equal(needsDependencyInstall({ freshClone: false, nodeModulesPresent: false, lockfileBefore: "a", lockfileAfter: "a" }).install, true);
});

test("needsDependencyInstall reinstalls only when the lockfile actually changed", () => {
  const changed = needsDependencyInstall({ freshClone: false, nodeModulesPresent: true, lockfileBefore: "a", lockfileAfter: "b" });
  assert.equal(changed.install, true);
  assert.match(changed.reason, /package-lock\.json changed/);

  const same = needsDependencyInstall({ freshClone: false, nodeModulesPresent: true, lockfileBefore: "a", lockfileAfter: "a" });
  assert.equal(same.install, false);
  assert.match(same.reason, /unchanged/);
});

test("resolveLaunchRoot prefers the pinned runtime and falls back to the calling checkout", () => {
  const homeDir = tempHome();
  try {
    const { runtimeRoot, gitDir } = runtimePaths(homeDir);
    assert.equal(resolveLaunchRoot({ homeDir, fallbackRoot: "/repo/checkout" }), "/repo/checkout");
    mkdirSync(gitDir, { recursive: true });
    assert.equal(resolveLaunchRoot({ homeDir, fallbackRoot: "/repo/checkout" }), runtimeRoot);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("syncRuntime clones main locally, installs dependencies, and copies .env.local across", () => {
  const homeDir = tempHome();
  const sourceRoot = tempHome();
  try {
    writeFileSync(join(sourceRoot, ".env.local"), "DATABASE_URL=postgres://fake/db\n");
    const { git, calls } = fakeGit();
    const installed = [];
    const result = syncRuntime({ sourceRoot, homeDir, git, npmInstall: (cwd) => installed.push(cwd) });

    const clone = calls.find((c) => c.args[0] === "clone");
    assert.deepEqual(clone.args, ["clone", "--local", "--branch", "main", sourceRoot, result.runtimeRoot]);
    assert.equal(result.action, "clone");
    assert.equal(result.commit, "abc1234");
    assert.equal(result.subject, "land the thing");
    assert.equal(result.dependencies.install, true);
    assert.deepEqual(installed, [result.runtimeRoot]);
    // Without this the cloned scripts have no DATABASE_URL and every agent
    // loses the brain the moment home points at the runtime.
    assert.equal(readFileSync(result.envFile, "utf8"), "DATABASE_URL=postgres://fake/db\n");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("syncRuntime updates an existing runtime with a hard reset and reuses node_modules when the lockfile held still", () => {
  const homeDir = tempHome();
  const sourceRoot = tempHome();
  try {
    const paths = runtimePaths(homeDir);
    mkdirSync(paths.gitDir, { recursive: true });
    mkdirSync(paths.nodeModules, { recursive: true });
    writeFileSync(paths.lockfile, '{"lockfileVersion":3}\n');

    const { git, calls } = fakeGit();
    const installed = [];
    const result = syncRuntime({ sourceRoot, homeDir, git, npmInstall: (cwd) => installed.push(cwd) });

    const verbs = calls.filter((c) => c.cwd === paths.runtimeRoot).map((c) => c.args.join(" "));
    assert.ok(verbs.includes("remote set-url origin " + sourceRoot), "origin must follow a moved source checkout");
    assert.ok(verbs.includes("fetch --quiet origin main"));
    assert.ok(verbs.includes("checkout --quiet --force -B main FETCH_HEAD"));
    // A clean of untracked files here would throw away a 1 GB node_modules.
    assert.ok(!verbs.some((v) => v.startsWith("clean")));
    assert.equal(result.action, "update");
    assert.equal(result.dependencies.install, false);
    assert.deepEqual(installed, []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("syncRuntime refuses a dirty source checkout and builds nothing", () => {
  const homeDir = tempHome();
  try {
    const { git } = fakeGit({ dirty: ["M scripts/brain.mjs"] });
    assert.throws(
      () => syncRuntime({ sourceRoot: "/repo/checkout", homeDir, git, npmInstall: () => { throw new Error("must not install"); } }),
      (error) => error instanceof SourceNotReadyError && /uncommitted change/.test(error.message) && /commit or stash/.test(error.message),
    );
    assert.equal(existsSync(runtimePaths(homeDir).runtimeRoot), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("syncRuntime refuses a main that is behind its remote and builds nothing", () => {
  const homeDir = tempHome();
  try {
    const { git } = fakeGit({ behind: 2 });
    assert.throws(
      () => syncRuntime({ sourceRoot: "/repo/checkout", homeDir, git }),
      (error) => error instanceof SourceNotReadyError && /2 commit\(s\) behind origin\/main/.test(error.message),
    );
    assert.equal(existsSync(runtimePaths(homeDir).runtimeRoot), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("syncRuntime refuses to clobber a runtime directory that is not a clone", () => {
  const homeDir = tempHome();
  try {
    const paths = runtimePaths(homeDir);
    mkdirSync(paths.runtimeRoot, { recursive: true });
    const { git } = fakeGit();
    assert.throws(
      () => syncRuntime({ sourceRoot: "/repo/checkout", homeDir, git }),
      (error) => /is not a git clone/.test(error.message),
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("syncRuntime --dry-run creates nothing, clones nothing, and installs nothing", () => {
  const homeDir = tempHome();
  try {
    const { git, calls } = fakeGit();
    const result = syncRuntime({
      sourceRoot: "/repo/checkout",
      homeDir,
      dryRun: true,
      git,
      npmInstall: () => { throw new Error("must not install"); },
    });

    assert.equal(result.action, "clone");
    assert.equal(result.commit, "abc1234");
    assert.equal(existsSync(join(homeDir, ".fuzzy-brain")), false);
    const mutating = calls.filter((c) => ["clone", "fetch", "checkout", "reset", "remote"].includes(c.args[0]));
    assert.deepEqual(mutating, []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall points ~/.fuzzy-brain/home at the pinned runtime, not at the working checkout", async () => {
  const homeDir = tempHome();
  try {
    const { log, lines } = captureLog();
    await installAgents({ repoRoot: "/repo/checkout", homeDir, hasCli: () => false, log });

    const paths = launcherPaths(homeDir);
    assert.equal(readFileSync(paths.homeFile, "utf8").trim(), runtimePaths(homeDir).runtimeRoot);
    assert.ok(lines.some((l) => l === "runtime is at abc1234 a commit on main"));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall --runtime-only refreshes the runtime and leaves every agent config alone", async () => {
  const homeDir = tempHome();
  try {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(join(homeDir, ".codex", "config.toml"), CODEX_FIXTURE);

    const { log, lines } = captureLog();
    const results = await installAgents({ repoRoot: "/repo/checkout", homeDir, runtimeOnly: true, hasCli: () => false, log });

    assert.deepEqual(results.map((r) => r.id), ["runtime"]);
    assert.equal(readFileSync(join(homeDir, ".codex", "config.toml"), "utf8"), CODEX_FIXTURE);
    assert.equal(existsSync(launcherPaths(homeDir).homeFile), false, "--runtime-only must not rewrite the launcher either");
    assert.ok(lines.some((l) => l === "runtime is at abc1234 a commit on main"));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall --dev points home back at the working checkout and warns first and last", async () => {
  const homeDir = tempHome();
  try {
    const { log, lines } = captureLog();
    const results = await installAgents({ repoRoot: "/repo/checkout", homeDir, dev: true, hasCli: () => false, log });

    assert.equal(readFileSync(launcherPaths(homeDir).homeFile, "utf8").trim(), "/repo/checkout");
    assert.equal(results.find((r) => r.id === "runtime").status, "skip");
    const warnings = lines.filter((l) => l.startsWith("WARNING: --dev"));
    assert.equal(warnings.length, 2, "the warning must survive a long scrollback in both directions");
    assert.match(lines.join("\n"), /Whatever branch that checkout is on is the brain every agent gets/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall rejects --dev together with --runtime-only", async () => {
  const homeDir = tempHome();
  try {
    await assert.rejects(
      installAgents({ repoRoot: "/repo/checkout", homeDir, dev: true, runtimeOnly: true, log: () => {} }),
      /opposite things/,
    );
    assert.equal(existsSync(join(homeDir, ".fuzzy-brain")), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runInstall surfaces the runtime's own warnings without turning them into failures", async () => {
  const homeDir = tempHome();
  try {
    const { log, lines } = captureLog();
    await runInstall({
      repoRoot: "/repo/checkout",
      homeDir,
      hasCli: () => false,
      log,
      syncRuntime: (options) => ({ ...fakeRuntimeSync(options), warnings: ["3 untracked file(s) in the source checkout will not reach the runtime"] }),
    });
    assert.ok(lines.some((l) => l.startsWith("[runtime] note: 3 untracked file(s)")));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("parseArgs reads the runtime flags alongside the ones that already existed", () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, dev: false, runtimeOnly: false, only: null });
  assert.deepEqual(parseArgs(["--dry-run", "--only", "codex,cursor"]), { dryRun: true, dev: false, runtimeOnly: false, only: ["codex", "cursor"] });
  assert.equal(parseArgs(["--dev"]).dev, true);
  assert.equal(parseArgs(["--runtime-only"]).runtimeOnly, true);
});
