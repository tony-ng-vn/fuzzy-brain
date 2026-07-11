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

test("the skill separates the four ways an answer from the brain can stand", async () => {
  const skill = await readFile(join(canonicalDir, "SKILL.md"), "utf8");
  assert.match(skill, /## Answering from the brain/);
  // Supported answers point at their evidence.
  assert.match(skill, /name the node or edge it stands on/);
  // Missing knowledge is admitted and turned into a question, not a guess.
  assert.match(skill, /not in the brain/i);
  assert.match(skill, /ask him/);
  // Conflicts surface both sides and Tony decides.
  assert.match(skill, /which is current/);
  // A broken lookup is never passed off as absent knowledge.
  assert.match(skill, /lookup broke/);
  assert.match(skill, /never dress a failed search/i);
});

test("the skill drafts whys with the relationship kind made explicit", async () => {
  const skill = await readFile(join(canonicalDir, "SKILL.md"), "utf8");
  assert.match(skill, /kind of connection/);
  assert.match(skill, /docs\/node-structuring\.md/);
});
