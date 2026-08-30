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

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DEFAULT_EMBEDDING_LIMIT = 32;
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
  // Before the embed sweep, so a transcript landed this cycle gets its
  // vectors in the same cycle. Its failure is the one that does not stop
  // the run: this is the only step reaching a backend off this Mac, and an
  // outage there must not quietly freeze retrieval for everything else.
  let watchItemsError = null;
  try {
    output.push(await run("sweep-watch-items.mjs", []));
  } catch (error) {
    onError("watch-items", error);
    watchItemsError = "pasted video transcripts did not land; the next run retries them";
  }
  try {
    output.push(await run("embed-sweep.mjs", ["--limit", String(embeddingLimit)]));
  } catch (error) {
    onError("embedding", error);
    return { ok: false, error: "session ingestion succeeded, but some embeddings remain pending", output };
  }
  if (watchItemsError) return { ok: false, error: watchItemsError, output };
  return { ok: true, output };
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
  if (process.argv.includes("--install")) {
    console.log(JSON.stringify(await installLaunchAgent(), null, 2));
    return;
  }
  if (process.argv.includes("--print-plist")) {
    process.stdout.write(renderLaunchAgentPlist({ homeDir: homedir() }));
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
