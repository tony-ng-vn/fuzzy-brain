import { execFileSync } from "node:child_process";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "scripts", "ingest-sessions.mjs");

export type IngestResult = { ok: true; output: string } | { ok: false; error: string };

type ExecFn = (cmd: string, args: string[]) => string;

// Runs the session ingester as a subprocess -- the exact same
// scripts/ingest-sessions.mjs the CLI runs, so the frontend button and the
// terminal share one code path, one set of guards (allowlist, exclusions,
// scrub), and one set of tests. execFn is injectable so tests never spawn
// the real (multi-minute, filesystem-heavy) process.
export function runIngest(
  execFn: ExecFn = (cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf8", timeout: 10 * 60 * 1000 }) as unknown as string,
): IngestResult {
  try {
    return { ok: true, output: execFn("node", [scriptPath]) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
