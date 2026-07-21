// The one shell-out path to brain.mjs, shared by every sweeper
// (ingest-sessions, sweep-clippings) so their guards can never drift
// apart: same buffer ceiling, same timeout, same source helpers.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const brainCli = join(here, "..", "brain.mjs");

export const CLI_EXEC_OPTS = Object.freeze({
  // add-episode echoes the whole stored raw back; a pasted meeting
  // transcript already blew the 1MB default and killed a real backfill.
  maxBuffer: 64 * 1024 * 1024,
  // A wedged child must fail loudly, never hang its parent: a dead link
  // mid-call once stalled the whole ingest silently for 8+ minutes
  // (2026-07-16). The child's own DB timeouts fire well before this; the
  // cap here is the outer net for everything else.
  timeout: 5 * 60 * 1000,
});

export function cli(verb, extraArgs = [], input) {
  const out = execFileSync("node", [brainCli, verb, ...extraArgs], {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    env: process.env,
    ...CLI_EXEC_OPTS,
  });
  return JSON.parse(out);
}

export function ensureSource(kind, label) {
  const sources = cli("list-sources");
  const found = sources.find((s) => s.kind === kind && s.label === label);
  if (found) return found;
  return cli("add-source", [], { kind, label });
}

export function listExistingLocators(sourceId) {
  return cli("list-episodes", [sourceId]).map((e) => e.source_locator).filter(Boolean);
}
