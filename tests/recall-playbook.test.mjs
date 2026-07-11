import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const playbookPath = join(root, "docs", "playbooks", "fuzzy-brain-recall-playbook.html");

test("the Fuzzy Brain recall playbook exists", () => {
  assert.equal(existsSync(playbookPath), true, "create the standalone HTML playbook");
});

test("the playbook is a self-contained, accessible field manual", () => {
  if (!existsSync(playbookPath)) return;
  const html = readFileSync(playbookPath, "utf8");
  assert.match(html, /<!doctype html>/i);
  assert.equal((html.match(/<main\b/gi) ?? []).length, 1);
  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
  for (const id of [
    "answer",
    "polygres",
    "readiness",
    "knowledge-model",
    "search-system",
    "epistemic-loop",
    "trace-lab",
    "experiment",
    "priorities",
    "decisions",
    "sources",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet["']/i);
  assert.match(html, /<link rel="icon" href="data:/i, "the standalone page should not request a favicon");
  assert.doesNotMatch(html, /\bfetch\s*\(/i);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /aria-live=["']polite["']/);
  assert.match(html, /brain_dev/);
  assert.match(html, /girlfriend[^<]{0,160}(?:edge|relationship|role)/i);
  assert.equal(/[^\x00-\x7f]/.test(html), false, "the playbook must stay ASCII-only");
});

test("the traversal demo has explicit controls and valid scenario data", () => {
  if (!existsSync(playbookPath)) return;
  const html = readFileSync(playbookPath, "utf8");
  for (const id of ["trace-play", "trace-pause", "trace-step", "trace-reset", "trace-log"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.doesNotMatch(html, /(?:play|start)\s*\(\s*\)\s*;?\s*<\/script>/i, "the trace must not autoplay");

  const match = html.match(/<script type="application\/json" id="trace-scenarios">([\s\S]*?)<\/script>/);
  assert.ok(match, "embed parseable trace scenarios");
  const data = JSON.parse(match[1]);
  assert.ok(data.scenarios.length >= 4);

  for (const scenario of data.scenarios) {
    const nodeIds = new Set(scenario.nodes.map((node) => node.id));
    const edgeIds = new Set(scenario.edges.map((edge) => edge.id));
    for (const edge of scenario.edges) {
      assert.ok(nodeIds.has(edge.from));
      assert.ok(nodeIds.has(edge.to));
    }
    for (const step of scenario.steps) {
      if (step.nodeId) assert.ok(nodeIds.has(step.nodeId));
      if (step.edgeId) assert.ok(edgeIds.has(step.edgeId));
    }
    assert.equal(scenario.steps.at(-1).epistemicState, scenario.expectedEpistemicState);
  }

  const missing = data.scenarios.find((scenario) => scenario.id === "missing-resolvable");
  assert.ok(missing.steps.some((step) => step.epistemicState === "missing_resolvable"));
  const conflict = data.scenarios.find((scenario) => scenario.id === "conflicting");
  assert.equal(conflict.expectedAction, "surface_conflict_and_request_ratification");
});
