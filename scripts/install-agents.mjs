// Registers the fuzzy-brain MCP server with every coding agent this Mac
// has installed, pointed at the stable ~/.fuzzy-brain/bin/brain-run
// launcher instead of a git worktree path. Safe to rerun: every config
// write is a merge or an in-place table replace, never a rewrite of the
// whole file, and --dry-run previews every change without touching disk.
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
import { mergeMcpServer, replaceTomlTable, tomlTableExists } from "./lib/mcp-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const SERVER_NAME = "fuzzy-brain";
const SERVER_SCRIPT = "fuzzy-brain-mcp.mjs";

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

function writeJsonConfig(id, path, entry, dryRun) {
  if (dryRun) {
    const exists = existsSync(path);
    return planned(id, `${exists ? "merge into" : "create"} ${path}: mcpServers.${SERVER_NAME} -> ${describeEntry(entry)}`);
  }
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const next = mergeMcpServer(existing, SERVER_NAME, entry);
  backupIfExists(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return written(id, `updated ${path}`);
}

function registerJsonAgent({ id, dir, file, brainRunPath, dryRun, extraEntryFields = {} }) {
  if (!existsSync(dir)) return skip(id, `${dir} not found`);
  const entry = { command: brainRunPath, args: [SERVER_SCRIPT], ...extraEntryFields };
  return writeJsonConfig(id, join(dir, file), entry, dryRun);
}

function registerVsCode({ homeDir, brainRunPath, dryRun }) {
  const path = join(homeDir, "Library", "Application Support", "Code", "User", "mcp.json");
  if (!existsSync(path)) return skip("vscode", `${path} not found (VS Code MCP config is only rewritten if it already exists)`);
  const entry = { command: brainRunPath, args: [SERVER_SCRIPT] };
  return writeJsonConfig("vscode", path, entry, dryRun);
}

function registerCodex({ homeDir, brainRunPath, dryRun }) {
  const codexDir = join(homeDir, ".codex");
  if (!existsSync(codexDir)) return skip("codex", `${codexDir} not found`);
  const configPath = join(codexDir, "config.toml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const body = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${brainRunPath}"`,
    `args = ["${SERVER_SCRIPT}"]`,
  ].join("\n");

  if (dryRun) {
    const action = tomlTableExists(existing, `mcp_servers.${SERVER_NAME}`) ? "replace in place" : "append";
    return planned("codex", `${action} [mcp_servers.${SERVER_NAME}] in ${configPath}`);
  }
  const next = replaceTomlTable(existing, `mcp_servers.${SERVER_NAME}`, body);
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
    const removeArgs = ["mcp", "remove", SERVER_NAME, "-s", "user"];
    const addArgs = ["mcp", "add", SERVER_NAME, "-s", "user", "--", brainRunPath, SERVER_SCRIPT];
    if (dryRun) {
      return planned("claude-code", `claude ${removeArgs.join(" ")} (ignore failure if not registered), then claude ${addArgs.join(" ")}`);
    }
    try {
      runCli(removeArgs);
    } catch {
      // Nothing registered yet under this name; add still runs.
    }
    runCli(addArgs);
    return written("claude-code", "registered via `claude mcp add -s user`");
  }

  // No CLI on PATH: edit the user-scope config directly, matching the
  // exact shape `claude mcp add` itself would have written so a later
  // run through either path is a no-op against the other.
  const entry = { type: "stdio", command: brainRunPath, args: [SERVER_SCRIPT], env: {} };
  return writeJsonConfig("claude-code", claudeJsonPath, entry, dryRun);
}

function formatResult(result) {
  const label = { skip: "skip", "would-write": "would write", written: "wrote" }[result.status];
  return `[${result.id}] ${label}: ${result.detail}`;
}

function genericSnippet(brainRunPath) {
  const snippet = { mcpServers: { [SERVER_NAME]: { command: brainRunPath, args: [SERVER_SCRIPT] } } };
  return [
    "For any other MCP-compatible agent, add this to its config:",
    JSON.stringify(snippet, null, 2),
  ].join("\n");
}

export async function runInstall({
  repoRoot: root = repoRoot,
  homeDir,
  dryRun = false,
  only = null,
  hasCli = defaultHasClaudeCli,
  runCli = defaultRunCli,
  log = console.log,
} = {}) {
  const launcher = installLauncher({ repoRoot: root, homeDir, dryRun });
  const results = [
    dryRun
      ? planned("launcher", `~/.fuzzy-brain/{home,bin/brain-run,bin/node-path}: home -> ${root}, node -> ${launcher.nodePath}`)
      : written("launcher", `home -> ${root}, node -> ${launcher.nodePath}`),
  ];

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
  return results;
}

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex !== -1 && argv[onlyIndex + 1] ? argv[onlyIndex + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  return { dryRun, only };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dryRun, only } = parseArgs(process.argv.slice(2));
  runInstall({ homeDir: homedir(), dryRun, only }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
