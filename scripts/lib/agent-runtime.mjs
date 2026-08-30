// Maintains ~/.fuzzy-brain/runtime, the pinned copy of this repo that every
// coding agent actually runs. Agents used to run whatever branch the working
// checkout happened to be sitting on, so an unfinished feature branch became
// every agent's brain for as long as the checkout stayed there.
//
// The runtime is a local git clone of the working checkout, always parked on
// main. `git clone --local` hardlinks the object store, so the git half costs
// almost nothing; node_modules is a real second copy at roughly 1 GB.
//
// Never reads .env.local. The file is copied byte-for-byte into the runtime
// with copyFileSync so the cloned scripts can find a DATABASE_URL, and its
// contents never enter this process or its output.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { launcherPaths } from "./agent-launcher.mjs";

const ENV_FILE = ".env.local";
const LOCKFILE = "package-lock.json";

export function runtimePaths(homeDir) {
  const runtimeRoot = launcherPaths(homeDir).runtimeRoot;
  return {
    runtimeRoot,
    gitDir: join(runtimeRoot, ".git"),
    lockfile: join(runtimeRoot, LOCKFILE),
    nodeModules: join(runtimeRoot, "node_modules"),
    envFile: join(runtimeRoot, ENV_FILE),
  };
}

export class SourceNotReadyError extends Error {
  constructor(problems) {
    const body = problems.map((p) => `  - ${p.what}\n    fix: ${p.fix}`).join("\n");
    super(`refusing to build the agent runtime from this checkout:\n${body}`);
    this.name = "SourceNotReadyError";
    this.problems = problems;
  }
}

function defaultGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function defaultNpmInstall(cwd) {
  execFileSync("npm", ["ci"], { cwd, stdio: "inherit" });
}

function tryGit(git, args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

// Reads every fact the readiness check needs. Read-only: no fetch, so a
// --dry-run leaves the source checkout's .git exactly as it found it. The
// cost is that behindCount is only as fresh as the last fetch, which the
// refusal message says out loud.
export function readSourceState({ sourceRoot, git = defaultGit } = {}) {
  const hasMain = tryGit(git, ["rev-parse", "--verify", "--quiet", "refs/heads/main"], sourceRoot) !== null;
  const trackedChanges = (tryGit(git, ["status", "--porcelain", "--untracked-files=no"], sourceRoot) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const untracked = (tryGit(git, ["ls-files", "--others", "--exclude-standard"], sourceRoot) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const hasRemoteMain = tryGit(git, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], sourceRoot) !== null;
  const behindCount = hasRemoteMain
    ? Number.parseInt((tryGit(git, ["rev-list", "--count", "main..origin/main"], sourceRoot) ?? "0").trim(), 10)
    : null;

  const described = hasMain ? (tryGit(git, ["log", "-1", "--format=%h%x09%s", "main"], sourceRoot) ?? "").trim() : "";
  const [commit = "", subject = ""] = described.split("\t");

  return { hasMain, trackedChanges, untracked, behindCount, commit, subject };
}

// The runtime is only worth anything if it is a state someone could point at
// and say "that is main". Untracked files are only a warning: they cannot
// enter a clone, and the checkout legitimately carries scratch notes.
export function checkSourceReady({ hasMain, trackedChanges = [], untracked = [], behindCount } = {}) {
  const problems = [];
  const warnings = [];

  if (!hasMain) {
    problems.push({
      what: "there is no local main branch to build the runtime from",
      fix: "git fetch origin main:main",
    });
  }
  if (trackedChanges.length > 0) {
    problems.push({
      what: `${trackedChanges.length} uncommitted change(s) to tracked files: ${trackedChanges.slice(0, 5).join(", ")}${trackedChanges.length > 5 ? ", ..." : ""}`,
      fix: "commit or stash them, then rerun",
    });
  }
  if (typeof behindCount === "number" && behindCount > 0) {
    problems.push({
      what: `main is ${behindCount} commit(s) behind origin/main as of the last fetch`,
      fix: "git fetch origin && git merge --ff-only origin/main on main, then rerun",
    });
  }
  if (behindCount === null) {
    warnings.push("no origin/main ref, so how far main has drifted from the remote is unknown");
  }
  if (untracked.length > 0) {
    warnings.push(`${untracked.length} untracked file(s) in the source checkout will not reach the runtime`);
  }

  return { ok: problems.length === 0, problems, warnings };
}

// node_modules is roughly 1 GB and cannot be hardlinked, so it is only
// reinstalled when it has to be.
export function needsDependencyInstall({ freshClone, nodeModulesPresent, lockfileBefore, lockfileAfter } = {}) {
  if (freshClone) return { install: true, reason: "fresh clone" };
  if (!nodeModulesPresent) return { install: true, reason: "node_modules is missing" };
  if (lockfileBefore !== lockfileAfter) return { install: true, reason: `${LOCKFILE} changed` };
  return { install: false, reason: `${LOCKFILE} unchanged` };
}

// The launchd job and the agent configs should follow the pinned runtime once
// it exists, whichever checkout the installing command happens to run from.
export function resolveLaunchRoot({ homeDir, fallbackRoot, exists = existsSync } = {}) {
  const { gitDir, runtimeRoot } = runtimePaths(homeDir);
  return exists(gitDir) ? runtimeRoot : fallbackRoot;
}

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function syncRuntime({
  sourceRoot,
  homeDir,
  dryRun = false,
  git = defaultGit,
  npmInstall = defaultNpmInstall,
} = {}) {
  const paths = runtimePaths(homeDir);
  const state = readSourceState({ sourceRoot, git });
  const check = checkSourceReady(state);
  if (!check.ok) throw new SourceNotReadyError(check.problems);

  const freshClone = !existsSync(paths.gitDir);
  if (freshClone && existsSync(paths.runtimeRoot)) {
    throw new SourceNotReadyError([{
      what: `${paths.runtimeRoot} exists but is not a git clone`,
      fix: `remove ${paths.runtimeRoot} and rerun`,
    }]);
  }

  const lockfileBefore = readIfPresent(paths.lockfile);

  if (dryRun) {
    return {
      ...paths,
      dryRun: true,
      action: freshClone ? "clone" : "update",
      commit: state.commit,
      subject: state.subject,
      dependencies: { install: true, reason: "decided after the reset, from the lockfile" },
      warnings: check.warnings,
    };
  }

  if (freshClone) {
    mkdirSync(dirname(paths.runtimeRoot), { recursive: true });
    git(["clone", "--local", "--branch", "main", sourceRoot, paths.runtimeRoot], dirname(paths.runtimeRoot));
  } else {
    // Keeps working after the source checkout moves, since origin is a path.
    git(["remote", "set-url", "origin", sourceRoot], paths.runtimeRoot);
    git(["fetch", "--quiet", "origin", "main"], paths.runtimeRoot);
    // A hard reset onto main that also repairs a detached HEAD, and that
    // leaves untracked files alone so node_modules survives the refresh.
    git(["checkout", "--quiet", "--force", "-B", "main", "FETCH_HEAD"], paths.runtimeRoot);
  }

  const sourceEnv = join(sourceRoot, ENV_FILE);
  if (existsSync(sourceEnv)) {
    copyFileSync(sourceEnv, paths.envFile);
    chmodSync(paths.envFile, 0o600);
  }

  const dependencies = needsDependencyInstall({
    freshClone,
    nodeModulesPresent: existsSync(paths.nodeModules),
    lockfileBefore,
    lockfileAfter: readIfPresent(paths.lockfile),
  });
  if (dependencies.install) npmInstall(paths.runtimeRoot);

  const described = (git(["log", "-1", "--format=%h%x09%s", "HEAD"], paths.runtimeRoot) ?? "").trim();
  const [commit = "", subject = ""] = described.split("\t");

  return {
    ...paths,
    dryRun: false,
    action: freshClone ? "clone" : "update",
    commit,
    subject,
    dependencies,
    warnings: check.warnings,
  };
}
