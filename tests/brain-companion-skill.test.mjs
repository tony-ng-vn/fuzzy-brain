import test from "node:test";
import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalDir = join(root, ".agents", "skills", "brain-companion");
const claudeDir = join(root, ".claude", "skills", "brain-companion");

test("Claude and Codex load one canonical brain companion skill", async () => {
  assert.equal(
    (await lstat(claudeDir)).isSymbolicLink(),
    true,
    "Claude's skill directory must import the canonical .agents skill through a symlink",
  );
  assert.equal(await realpath(claudeDir), await realpath(canonicalDir));

  const [claudeSkill, canonicalSkill] = await Promise.all([
    readFile(join(claudeDir, "SKILL.md"), "utf8"),
    readFile(join(canonicalDir, "SKILL.md"), "utf8"),
  ]);
  assert.equal(claudeSkill, canonicalSkill);
  assert.match(canonicalSkill, /raw layer exactly as he gave them/);
  assert.match(canonicalSkill, /add-talk/);
  assert.match(canonicalSkill, /no set-raw and no delete/);
});
