// One bounded background cycle: ingest settled Claude/Codex sessions into
// the unratified evidence store, then fill a small number of missing vectors.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { installLauncher, launcherPaths } from "./lib/agent-launcher.mjs";
import { resolveLaunchRoot } from "./lib/agent-runtime.mjs";
import { runTracedCli } from "./lib/operation-cli.mjs";
import { operationChildEnvironment } from "./lib/operation-context.mjs";
import { safeErrorCode } from "./lib/operation-metadata.mjs";
import { loadEnvLocal } from "./recall.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DEFAULT_EMBEDDING_LIMIT = 32;
const DEFAULT_SESSION_LIMIT = 32;
const LABEL = "com.tony.fuzzy-brain.sync";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// ProgramArguments and WorkingDirectory only ever reference
// ~/.fuzzy-brain (via brain-run) -- never the checkout itself -- so
// reinstalling this plist after moving the checkout never bakes a
// worktree path into launchd; only `npm run agents:install` from the
// new checkout needs to run.
export function renderLaunchAgentPlist({ homeDir, intervalSeconds = 3600 }) {
  const { root: fuzzyBrainHome, brainRunPath } = launcherPaths(homeDir);
  const logDir = join(fuzzyBrainHome, "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(brainRunPath)}</string>
    <string>fusion-sync.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(fuzzyBrainHome)}</string>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "fusion-sync.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "fusion-sync.error.log"))}</string>
</dict>
</plist>
`;
}

async function runScript(script, args) {
  const { stdout } = await execFileAsync(process.execPath, [join(here, script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    env: operationChildEnvironment(),
  });
  return stdout.trim();
}

export async function runFusionSync({
  run = runScript,
  embeddingLimit = DEFAULT_EMBEDDING_LIMIT,
  sessionLimit = DEFAULT_SESSION_LIMIT,
  onError = () => {},
} = {}) {
  if (!Number.isSafeInteger(embeddingLimit) || embeddingLimit <= 0) {
    throw Object.assign(new Error("The indexing limit must be a positive integer."), { code: "invalid" });
  }
  if (!Number.isSafeInteger(sessionLimit) || sessionLimit <= 0) {
    throw Object.assign(new Error("The session limit must be a positive integer."), { code: "invalid" });
  }
  const output = [], failures = [];
  const steps = [
    ["ingest", "ingest-sessions.mjs", ["--limit", String(sessionLimit)], "Session ingestion failed; completed batches remain saved and the next run can resume."],
    ["watch-items", "sweep-watch-items.mjs", [], "Pasted video transcripts did not land; the next run retries them."],
    ["embedding", "embed-sweep.mjs", ["--limit", String(embeddingLimit)], "Some embeddings remain pending; the next run retries them."],
  ];
  for (const [stage, script, args, message] of steps) {
    try { output.push(await run(script, args)); }
    catch (error) {
      failures.push({ stage, message });
      // Logging failures must not prevent independent capture or indexing work.
      try { onError(stage, error); } catch { /* The returned failure still records the stage. */ }
    }
  }
  return failures.length
    ? { ok: false, error: failures.map(item => item.message).join(" "), failures, output }
    : { ok: true, output };
}

export function logSyncFailure(stage, error) {
  console.error(JSON.stringify({ event: "fusion_sync.stage_failed",
    stage: ["ingest", "watch-items", "embedding", "startup"].includes(stage) ? stage : "unknown",
    error_code: safeErrorCode(error?.code) }));
}

export async function installLaunchAgent({ intervalSeconds = 3600 } = {}) {
  const userHome = homedir();
  // Refreshes ~/.fuzzy-brain/{home,bin/brain-run,bin/node-path} before
  // writing a plist that launches through them, so `--install` alone is
  // enough after moving the checkout. It follows the pinned runtime when
  // one exists, so installing the job from a feature branch cannot drag
  // every agent onto that branch; a machine without a runtime yet falls
  // back to this checkout.
  const launcher = installLauncher({
    repoRoot: resolveLaunchRoot({ homeDir: userHome, fallbackRoot: root }),
    homeDir: userHome,
  });
  const logDir = join(launcher.root, "logs");
  const agentPath = join(userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(agentPath, renderLaunchAgentPlist({
    homeDir: userHome,
    intervalSeconds,
  }), { mode: 0o600 });

  const domain = `gui/${process.getuid()}`;
  try {
    await execFileAsync("launchctl", ["bootout", domain, agentPath]);
  } catch {
    // First install has nothing to unload.
  }
  await execFileAsync("launchctl", ["bootstrap", domain, agentPath]);
  return { label: LABEL, path: agentPath, intervalSeconds, brainRun: launcher.brainRunPath };
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && !["--install", "--print-plist", "--help", "-h"].includes(process.argv[2]))) {
    throw Object.assign(new Error("Unknown background sync option."), { code: "invalid" });
  }
  if (["--help", "-h"].includes(process.argv[2])) {
    const help = { state: "help", commands: ["Run without arguments for one sync cycle.", "--install installs the configured background job.", "--print-plist prints its configuration without installing it."],
      note: "Each cycle attempts session capture, pasted transcripts, and a bounded index pass independently." };
    console.log(JSON.stringify(help, null, 2));
    return help;
  }
  if (process.argv.includes("--install")) {
    console.log(JSON.stringify(await installLaunchAgent(), null, 2));
    return;
  }
  if (process.argv.includes("--print-plist")) {
    process.stdout.write(renderLaunchAgentPlist({ homeDir: homedir() }));
    return;
  }
  const result = await runFusionSync({
    onError: logSyncFailure,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnvLocal();
  const operation = process.argv[2] === "--install" ? "sync_install" : process.argv[2] === "--print-plist" ? "sync_config"
    : ["--help", "-h"].includes(process.argv[2]) ? "help" : "sync";
  runTracedCli("sync_cli", operation, process.argv.slice(2), main).catch((error) => {
    logSyncFailure("startup", error);
    process.exit(1);
  });
}
