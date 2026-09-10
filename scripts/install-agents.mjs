// Registers the fuzzy-brain MCP server with every coding agent this Mac
// has installed, pointed at the stable ~/.fuzzy-brain/bin/brain-run
// launcher instead of a git worktree path. Safe to rerun: every config
// write is a merge or an in-place table replace, never a rewrite of the
// whole file, and --dry-run previews every change without touching disk.
//
// brain-run follows ~/.fuzzy-brain/home, and that points at
// ~/.fuzzy-brain/runtime: a pinned clone of main, not the working
// checkout, so a feature branch in the checkout can never become every
// agent's brain. --dev opts back out of that for debugging.
//
// Never reads .env.local or DATABASE_URL, and never prints file
// contents or a diff -- only the path, action, and our own entry -- so a
// dry-run against a real config with live tokens in it (Codex's
// [mcp_servers.*.http_headers], an API key in a Cursor server entry)
// cannot leak one onto stdout.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLauncher } from "./lib/agent-launcher.mjs";
import { syncRuntime as defaultSyncRuntime } from "./lib/agent-runtime.mjs";
import { mergeMcpServer, replaceTomlTable, tomlTableExists } from "./lib/mcp-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const SERVERS = Object.freeze([
  { name: "fuzzy-brain", script: "fuzzy-brain-mcp.mjs" },
  { name: "tbrain", script: "tbrain-mcp.mjs" },
]);

function skip(id, reason) {
  return { id, status: "skip", detail: reason };
}
function planned(id, detail) {
  return { id, status: "would-write", detail };
}
function written(id, detail) {
  return { id, status: "written", detail };
}

function backupIfExists(path) {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().slice(0, 10);
  copyFileSync(path, `${path}.bak-${stamp}`);
}

function describeEntry(entry) {
  return JSON.stringify({ command: entry.command, args: entry.args });
}

function writeJsonConfig(id, path, entries, dryRun) {
  if (dryRun) {
    const exists = existsSync(path);
    const summary = entries.map(({ name, entry }) => `mcpServers.${name} -> ${describeEntry(entry)}`).join(", ");
    return planned(id, `${exists ? "merge into" : "create"} ${path}: ${summary}`);
  }
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const next = entries.reduce((config, { name, entry }) => mergeMcpServer(config, name, entry), existing);
  backupIfExists(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return written(id, `updated ${path}`);
}

function registerJsonAgent({ id, dir, file, brainRunPath, dryRun, extraEntryFields = {} }) {
  if (!existsSync(dir)) return skip(id, `${dir} not found`);
  const entries = SERVERS.map(({ name, script }) => ({
    name,
    entry: { command: brainRunPath, args: [script], ...extraEntryFields },
  }));
  return writeJsonConfig(id, join(dir, file), entries, dryRun);
}

function registerVsCode({ homeDir, brainRunPath, dryRun }) {
  const path = join(homeDir, "Library", "Application Support", "Code", "User", "mcp.json");
  if (!existsSync(path)) return skip("vscode", `${path} not found (VS Code MCP config is only rewritten if it already exists)`);
  const entries = SERVERS.map(({ name, script }) => ({ name, entry: { command: brainRunPath, args: [script] } }));
  return writeJsonConfig("vscode", path, entries, dryRun);
}

function registerCodex({ homeDir, brainRunPath, dryRun }) {
  const codexDir = join(homeDir, ".codex");
  if (!existsSync(codexDir)) return skip("codex", `${codexDir} not found`);
  const configPath = join(codexDir, "config.toml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const bodies = SERVERS.map(({ name, script }) => ({
    name,
    body: [
      `[mcp_servers.${name}]`,
      `command = "${brainRunPath}"`,
      `args = ["${script}"]`,
    ].join("\n"),
  }));

  if (dryRun) {
    const actions = bodies.map(({ name }) => {
      const action = tomlTableExists(existing, `mcp_servers.${name}`) ? "replace in place" : "append";
      return `${action} [mcp_servers.${name}]`;
    });
    return planned("codex", `${actions.join(", ")} in ${configPath}`);
  }
  const next = bodies.reduce(
    (config, { name, body }) => replaceTomlTable(config, `mcp_servers.${name}`, body),
    existing,
  );
  backupIfExists(configPath);
  writeFileSync(configPath, next, "utf8");
  return written("codex", `updated ${configPath}`);
}

function defaultHasClaudeCli() {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultRunCli(args) {
  execFileSync("claude", args, { stdio: "ignore" });
}

function registerClaudeCode({ homeDir, brainRunPath, dryRun, hasCli, runCli }) {
  const claudeJsonPath = join(homeDir, ".claude.json");
  const claudeDir = join(homeDir, ".claude");
  const cliPresent = hasCli();
  if (!cliPresent && !existsSync(claudeJsonPath) && !existsSync(claudeDir)) {
    return skip("claude-code", `no ${claudeJsonPath}, ${claudeDir}, or claude CLI found`);
  }

  if (cliPresent) {
    const commands = SERVERS.flatMap(({ name, script }) => [
      ["mcp", "remove", name, "-s", "user"],
      ["mcp", "add", name, "-s", "user", "--", brainRunPath, script],
    ]);
    if (dryRun) {
      return planned("claude-code", commands.map(args => `claude ${args.join(" ")}`).join(", then "));
    }
    for (let index = 0; index < commands.length; index += 2) {
      try {
        runCli(commands[index]);
      } catch {
        // Nothing registered yet under this name; add still runs.
      }
      runCli(commands[index + 1]);
    }
    return written("claude-code", "registered both servers via `claude mcp add -s user`");
  }

  // No CLI on PATH: edit the user-scope config directly, matching the
  // exact shape `claude mcp add` itself would have written so a later
  // run through either path is a no-op against the other.
  const entries = SERVERS.map(({ name, script }) => ({
    name,
    entry: { type: "stdio", command: brainRunPath, args: [script], env: {} },
  }));
  return writeJsonConfig("claude-code", claudeJsonPath, entries, dryRun);
}

function formatResult(result) {
  const label = { skip: "skip", "would-write": "would write", written: "wrote" }[result.status];
  return `[${result.id}] ${label}: ${result.detail}`;
}

// The one line that answers "which version are the agents actually on".
function runtimeLine(runtime, dryRun) {
  if (!runtime) return "runtime: not used (--dev)";
  const verb = dryRun ? "would resolve to" : "is at";
  return `runtime ${verb} ${runtime.commit} ${runtime.subject}`;
}

function genericSnippet(brainRunPath) {
  const snippet = {
    mcpServers: Object.fromEntries(SERVERS.map(({ name, script }) => [
      name,
      { command: brainRunPath, args: [script] },
    ])),
  };
  return [
    "For any other MCP-compatible agent, add this to its config:",
    JSON.stringify(snippet, null, 2),
  ].join("\n");
}

function devWarning(root) {
  return [
    "WARNING: --dev points every coding agent on this Mac at the working checkout",
    `  ${root}`,
    "  Whatever branch that checkout is on is the brain every agent gets, half-finished work included.",
    "  Run `npm run agents:install` with no flags to put the agents back on the pinned runtime.",
  ].join("\n");
}

function describeRuntime(runtime) {
  const deps = runtime.dryRun
    ? (runtime.action === "clone" ? "then npm ci" : "then npm ci only if the lockfile changed")
    : (runtime.dependencies.install
      ? `npm ci (${runtime.dependencies.reason})`
      : `dependencies reused (${runtime.dependencies.reason})`);
  return `${runtime.action} ${runtime.runtimeRoot} at main, ${deps}`;
}

export async function runInstall({
  repoRoot: root = repoRoot,
  homeDir,
  dryRun = false,
  dev = false,
  runtimeOnly = false,
  only = null,
  hasCli = defaultHasClaudeCli,
  runCli = defaultRunCli,
  syncRuntime = defaultSyncRuntime,
  log = console.log,
} = {}) {
  if (dev && runtimeOnly) throw new Error("--dev and --runtime-only ask for opposite things; pick one");

  const results = [];
  let runtime = null;
  if (dev) {
    log(devWarning(root));
    log("");
    results.push(skip("runtime", `--dev: agents follow the working checkout at ${root}`));
  } else {
    runtime = syncRuntime({ sourceRoot: root, homeDir, dryRun });
    for (const warning of runtime.warnings) log(`[runtime] note: ${warning}`);
    results.push(dryRun ? planned("runtime", describeRuntime(runtime)) : written("runtime", describeRuntime(runtime)));
  }

  // The runtime is the whole point of the launcher, so refreshing it alone
  // is a safe no-touch update after landing a change on main.
  if (runtimeOnly) {
    for (const result of results) log(formatResult(result));
    log("");
    log(runtimeLine(runtime, dryRun));
    return results;
  }

  const launchRoot = dev ? root : runtime.runtimeRoot;
  const launcher = installLauncher({ repoRoot: launchRoot, homeDir, dryRun });
  results.push(
    dryRun
      ? planned("launcher", `~/.fuzzy-brain/{home,bin/brain-run,bin/node-path}: home -> ${launchRoot}, node -> ${launcher.nodePath}`)
      : written("launcher", `home -> ${launchRoot}, node -> ${launcher.nodePath}`),
  );

  const brainRunPath = launcher.brainRunPath;
  const agents = [
    { id: "claude-code", run: () => registerClaudeCode({ homeDir, brainRunPath, dryRun, hasCli, runCli }) },
    { id: "codex", run: () => registerCodex({ homeDir, brainRunPath, dryRun }) },
    { id: "cursor", run: () => registerJsonAgent({ id: "cursor", dir: join(homeDir, ".cursor"), file: "mcp.json", brainRunPath, dryRun }) },
    { id: "gemini", run: () => registerJsonAgent({ id: "gemini", dir: join(homeDir, ".gemini"), file: "settings.json", brainRunPath, dryRun }) },
    { id: "claude-desktop", run: () => registerJsonAgent({ id: "claude-desktop", dir: join(homeDir, "Library", "Application Support", "Claude"), file: "claude_desktop_config.json", brainRunPath, dryRun }) },
    { id: "vscode", run: () => registerVsCode({ homeDir, brainRunPath, dryRun }) },
  ];

  for (const agent of agents) {
    if (only && !only.includes(agent.id)) continue;
    results.push(agent.run());
  }

  for (const result of results) log(formatResult(result));
  log("");
  log(genericSnippet(brainRunPath));
  log("");
  log(runtimeLine(runtime, dryRun));
  if (dev) log(devWarning(root));
  return results;
}

export function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const dev = argv.includes("--dev");
  const runtimeOnly = argv.includes("--runtime-only");
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex !== -1 && argv[onlyIndex + 1] ? argv[onlyIndex + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  return { dryRun, dev, runtimeOnly, only };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dryRun, dev, runtimeOnly, only } = parseArgs(process.argv.slice(2));
  runInstall({ homeDir: homedir(), dryRun, dev, runtimeOnly, only }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
