import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// PRD #8: every eval run leaves a record whose shape stays comparable across
// months, with the model named per seat so a model change is never invisible.
const runsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "evals", "runs");

const SECTIONS = [
  "## Seats",
  "## Results",
  "## Skipped",
  "## Ablation",
  "## A/B",
  "## Synthesis",
  "## Capture candidates",
  "## Verdicts flipped",
];

test("eval run records exist and honor the PRD #8 contract", async (t) => {
  const files = (await readdir(runsDir)).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 1, "at least one run record must exist in docs/evals/runs/");

  for (const file of files) {
    const text = await readFile(join(runsDir, file), "utf8");

    await t.test(`${file}: machine-readable front matter`, () => {
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(fm, "record must open with a --- front matter block");
      assert.match(fm[1], /^run: \S+$/m, "front matter names the run id");
      assert.match(fm[1], /^date: \d{4}-\d{2}-\d{2}$/m, "front matter carries the date");
      const seats = fm[1].match(/^seats: (.+)$/m);
      assert.ok(seats, "front matter lists the seats");
      assert.match(seats[1], /companion=[^;]+/, "companion seat names its model");
      assert.match(seats[1], /scorer=[^;]+/, "scorer seat names its model");
      const arms = fm[1].match(/^ablation-arms-model: (.+)$/m);
      assert.ok(arms, "front matter names the single ablation-arms model");
      assert.ok(!arms[1].includes(";"), "ablation arms run on exactly one model");
    });

    await t.test(`${file}: required sections`, () => {
      for (const section of SECTIONS) {
        assert.ok(text.includes(`\n${section}`), `record must contain "${section}"`);
      }
    });

    await t.test(`${file}: per-question results with expected vs claimed`, () => {
      const results = text.split("\n## Results")[1].split("\n## ")[0];
      assert.match(results, /expected/i, "results table has an expected column");
      assert.match(results, /claimed/i, "results table has a claimed column");
      const rows = results.match(/Q\d\d/g) ?? [];
      assert.ok(rows.length >= 10, "results cover the question set, not a sample");
    });

    await t.test(`${file}: skipped questions carry reasons`, () => {
      const skipped = text.split("\n## Skipped")[1].split("\n## ")[0].trim();
      assert.ok(skipped.length > 0, "skipped section is never silently empty");
    });
  }
});
