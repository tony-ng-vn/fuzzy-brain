// One bounded background cycle: ingest settled Claude/Codex sessions into
// the unratified evidence store, then fill a small number of missing vectors.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DEFAULT_EMBEDDING_LIMIT = 32;
const LABEL = "com.tony.fuzzy-brain.sync";

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveNodePath({
  candidates = [process.env.FUZZY_BRAIN_NODE_PATH, "/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath],
  isExecutable = executable,
} = {}) {
  const selected = candidates.find((candidate) => candidate && isExecutable(candidate));
  if (!selected) throw new Error("no executable Node binary found for the launch agent");
  return selected;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist({ nodePath, repoRoot, homeDir, intervalSeconds = 3600 }) {
  const logDir = join(homeDir, ".fuzzy-brain", "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(join(repoRoot, "scripts", "fusion-sync.mjs"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoRoot)}</string>
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
  });
  return stdout.trim();
}

export async function runFusionSync({
  run = runScript,
  embeddingLimit = DEFAULT_EMBEDDING_LIMIT,
  onError = () => {},
} = {}) {
  const output = [];
  try {
    output.push(await run("ingest-sessions.mjs", []));
  } catch (error) {
    onError("ingest", error);
    return { ok: false, error: "session ingestion failed; completed batches remain saved and the next run can resume", output };
  }
  try {
    output.push(await run("embed-sweep.mjs", ["--limit", String(embeddingLimit)]));
  } catch (error) {
    onError("embedding", error);
    return { ok: false, error: "session ingestion succeeded, but some embeddings remain pending", output };
  }
  return { ok: true, output };
}

export async function installLaunchAgent({ intervalSeconds = 3600 } = {}) {
  const userHome = homedir();
  const logDir = join(userHome, ".fuzzy-brain", "logs");
  const agentPath = join(userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(agentPath, renderLaunchAgentPlist({
    nodePath: resolveNodePath(),
    repoRoot: root,
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
  return { label: LABEL, path: agentPath, intervalSeconds };
}

async function main() {
  if (process.argv.includes("--install")) {
    console.log(JSON.stringify(await installLaunchAgent(), null, 2));
    return;
  }
  if (process.argv.includes("--print-plist")) {
    process.stdout.write(renderLaunchAgentPlist({
      nodePath: resolveNodePath(),
      repoRoot: root,
      homeDir: homedir(),
    }));
    return;
  }
  const result = await runFusionSync({
    onError: (stage, error) => console.error(`[fusion-sync:${stage}]`, error),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
