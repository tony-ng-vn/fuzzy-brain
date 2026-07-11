import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = join(root, "experiments", "polygres-recall-lab", "recall-policy.mjs");

test("the recall policy exists as an isolated experiment module", () => {
  assert.equal(existsSync(modulePath), true, "create the recall policy in the isolated lab");
});

test("the recall policy classifies supported, missing, blocked, broken, and conflicting states", async () => {
  if (!existsSync(modulePath)) return;
  const { classifyEpistemicState } = await import(pathToFileURL(modulePath));
  const currentClaim = {
    subject: "doan",
    predicate: "lives_in",
    object: "safford",
    authority: "tony_ratified",
    validFrom: "2026-01-01T00:00:00Z",
    validTo: null,
  };
  const base = {
    asOf: "2026-07-10T00:00:00Z",
    claims: [],
    retrieval: { completed: true, indexHealthy: true },
    resolutionPaths: [],
  };

  assert.deepEqual(classifyEpistemicState({ ...base, claims: [currentClaim] }), {
    state: "supported_current",
    nextAction: "answer_with_evidence",
    reason: "one current ratified value is supported",
  });

  assert.deepEqual(
    classifyEpistemicState({
      ...base,
      claims: [currentClaim, { ...currentClaim, object: "phoenix" }],
    }),
    {
      state: "conflicting",
      nextAction: "surface_conflict_and_request_ratification",
      reason: "multiple current ratified values disagree",
    },
  );

  assert.deepEqual(
    classifyEpistemicState({
      ...base,
      resolutionPaths: [{ source: "uber_eats", authorized: true }],
    }),
    {
      state: "missing_resolvable",
      nextAction: "follow_resolution_path",
      reason: "no supported value is stored, but an authorized source can be checked",
    },
  );

  assert.deepEqual(
    classifyEpistemicState({
      ...base,
      resolutionPaths: [{ source: "messages", authorized: false }],
    }),
    {
      state: "inaccessible",
      nextAction: "report_blocked_source",
      reason: "a possible source exists, but this agent is not authorized to inspect it",
    },
  );

  assert.deepEqual(
    classifyEpistemicState({
      ...base,
      retrieval: { completed: false, indexHealthy: false },
    }),
    {
      state: "retrieval_failure",
      nextAction: "repair_machine_index_and_retry",
      reason: "retrieval did not complete against a healthy index",
    },
  );

  assert.deepEqual(classifyEpistemicState(base), {
    state: "missing_unresolved",
    nextAction: "tell_tony_and_request_source",
    reason: "no supported value or authorized resolution path is available",
  });
});

test("historical claims do not conflict with the current answer", async () => {
  if (!existsSync(modulePath)) return;
  const { classifyEpistemicState } = await import(pathToFileURL(modulePath));
  const result = classifyEpistemicState({
    asOf: "2026-07-10T00:00:00Z",
    retrieval: { completed: true, indexHealthy: true },
    resolutionPaths: [],
    claims: [
      {
        subject: "doan",
        predicate: "lives_in",
        object: "tucson",
        authority: "tony_ratified",
        validFrom: "2024-01-01T00:00:00Z",
        validTo: "2025-01-01T00:00:00Z",
      },
      {
        subject: "doan",
        predicate: "lives_in",
        object: "safford",
        authority: "tony_ratified",
        validFrom: "2025-01-01T00:00:00Z",
        validTo: null,
      },
    ],
  });
  assert.equal(result.state, "supported_current");
});

test("the planner uses reusable operators instead of case-specific source rules", async () => {
  if (!existsSync(modulePath)) return;
  const { buildRecallPlan } = await import(pathToFileURL(modulePath));

  assert.deepEqual(buildRecallPlan({ hasKnownAnchor: false, maxSteps: 7 }), [
    "exact_lookup",
    "lexical_search",
    "semantic_seed",
    "resolve_entity",
    "graph_expand",
    "inspect_evidence",
    "classify_epistemic_state",
  ]);

  assert.deepEqual(buildRecallPlan({ hasKnownAnchor: true, maxSteps: 5 }), [
    "exact_lookup",
    "graph_expand",
    "inspect_evidence",
    "classify_epistemic_state",
    "choose_authorized_action",
  ]);
});

