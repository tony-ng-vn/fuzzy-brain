// Shared "make this checkout the live one" step, used by both the agent
// installer and the fusion-sync launchd job. Writes ~/.fuzzy-brain/home,
// installs brain-run, and freezes a resolved Node path next to it so
// every caller launches the same repo and the same interpreter without
// a config file baking in a worktree path.
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER_SOURCE = join(here, "..", "launcher", "brain-run");

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Order matters: a stable package-manager symlink survives `brew upgrade
// node`; the version-pinned Cellar path that process.execPath resolves
// to on a Homebrew install does not, so it is only the last resort.
export function resolveNodePath({
  candidates = [process.env.FUZZY_BRAIN_NODE_PATH, "/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath],
  isExecutable = executable,
} = {}) {
  const selected = candidates.find((candidate) => candidate && isExecutable(candidate));
  if (!selected) throw new Error("no executable Node binary found");
  return selected;
}

export function launcherPaths(homeDir) {
  const root = join(homeDir, ".fuzzy-brain");
  const binDir = join(root, "bin");
  return {
    root,
    binDir,
    // The pinned clone the agents actually run; see lib/agent-runtime.mjs.
    runtimeRoot: join(root, "runtime"),
    homeFile: join(root, "home"),
    brainRunPath: join(binDir, "brain-run"),
    nodePathFile: join(binDir, "node-path"),
  };
}

// Pure enough to preview: with dryRun it only reports what it would do.
export function installLauncher({
  repoRoot,
  homeDir,
  dryRun = false,
  nodePath = resolveNodePath(),
  copySource = copyFileSync,
} = {}) {
  const paths = launcherPaths(homeDir);
  const changes = [
    { path: paths.homeFile, detail: `checkout root -> ${repoRoot}` },
    { path: paths.brainRunPath, detail: "launcher script" },
    { path: paths.nodePathFile, detail: `node -> ${nodePath}` },
  ];
  if (!dryRun) {
    mkdirSync(paths.binDir, { recursive: true });
    writeFileSync(paths.homeFile, `${repoRoot}\n`, "utf8");
    copySource(LAUNCHER_SOURCE, paths.brainRunPath);
    chmodSync(paths.brainRunPath, 0o755);
    writeFileSync(paths.nodePathFile, `${nodePath}\n`, "utf8");
  }
  return { ...paths, nodePath, changes, dryRun };
}
