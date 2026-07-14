// SessionEnd hook: copy the session transcript into the local archive.
// A dumb file copy on purpose -- no parsing (the transcript format is
// vendor-warned unstable), no network, no database. The archive is the
// durable capture that outlives Claude Code's transcript retention; the
// ingester (scripts/ingest-sessions.mjs) parses archives later and can be
// re-run forever against them.
//
// Failure discipline: this hook must NEVER fail the session it runs in.
// Every path out of here is exit 0; a broken archive run costs one
// session's copy (the ingester's live-directory sweep still catches it),
// while a failing hook would degrade every session on the machine.
import { copyFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const input = JSON.parse(await readStdin());
  const transcriptPath = input.transcript_path;
  if (transcriptPath) {
    const root = process.env.FUZZY_BRAIN_HOME || join(homedir(), ".fuzzy-brain");
    // The transcript's parent directory name IS the project slug
    // (~/.claude/projects/<slug>/<session-id>.jsonl).
    const slug = basename(dirname(transcriptPath));
    const destDir = join(root, "session-archive", "claude-code", slug);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(transcriptPath, join(destDir, basename(transcriptPath)));
  }
} catch {
  // Swallowed on purpose; see failure discipline above.
}
process.exit(0);
