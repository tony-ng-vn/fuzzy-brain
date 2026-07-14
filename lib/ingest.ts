import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultScriptPath = join(process.cwd(), "scripts", "ingest-sessions.mjs");

export type IngestResult =
  | { ok: true; output: string }
  | { ok: false; error: string; alreadyRunning?: boolean };

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

type SubprocessError = { code?: string; message?: string; stderr?: string };

// This app runs as a single local Node process, so a module-scope flag is
// enough to stop two overlapping ingest runs (e.g. two clicks, or a click
// during a terminal run) from racing the same database inserts. It does
// not protect against a *separate* OS process (a concurrent CLI run) --
// see translateError's duplicate-key case for that half of the story.
let inFlight: Promise<IngestResult> | null = null;

// Never forward a raw subprocess error to the caller: it can contain
// absolute filesystem paths, the Postgres host/user, and quoted session
// content (via DETAIL lines) -- unacceptable for a LAN-reachable route in
// a project whose whole premise is keeping this data local. Full detail
// still goes to the server log for whoever is at the terminal.
function translateError(err: unknown): string {
  console.error("[ingest] subprocess failed:", err);
  const { code, message, stderr } = (err ?? {}) as SubprocessError;
  const text = `${stderr ?? ""}\n${message ?? ""}`;

  if (code === "ETIMEDOUT") {
    return "Sync timed out after 10 minutes. Everything ingested so far is saved -- run it again to pick up where it left off.";
  }
  if (code === "ENOENT") {
    return "Could not find the ingest script or the node binary.";
  }
  if (/duplicate key value/i.test(text)) {
    return "A sync was already running in another process (e.g. the terminal). Wait for it to finish, then try again.";
  }
  return "The sync failed. Check the server log for details.";
}

// Runs the session ingester as a subprocess -- the exact same
// scripts/ingest-sessions.mjs the CLI runs, so the frontend button and the
// terminal share one code path, one set of guards (allowlist, exclusions,
// scrub), and one set of tests. execFn is injectable so most tests never
// spawn the real (multi-minute, filesystem-heavy) process; a couple of
// tests still exercise the real default path against a tiny fixture
// script to cover what an injected fake can't (encoding, exit handling,
// the actual node binary).
export async function runIngest(
  execFn: ExecFn = (cmd, args) => execFileAsync(cmd, args, { encoding: "utf8", timeout: 10 * 60 * 1000 }),
  scriptPath: string = defaultScriptPath,
): Promise<IngestResult> {
  if (inFlight) {
    return {
      ok: false,
      error: "A sync is already running. Wait for it to finish before starting another.",
      alreadyRunning: true,
    };
  }

  const run = (async (): Promise<IngestResult> => {
    try {
      const { stdout } = await execFn(process.execPath, [scriptPath]);
      return { ok: true, output: stdout };
    } catch (err) {
      return { ok: false, error: translateError(err) };
    }
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    inFlight = null;
  }
}
