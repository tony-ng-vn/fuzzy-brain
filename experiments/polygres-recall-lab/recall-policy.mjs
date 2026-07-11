const UNKNOWN_ANCHOR_PLAN = [
  "exact_lookup",
  "lexical_search",
  "semantic_seed",
  "resolve_entity",
  "graph_expand",
  "inspect_evidence",
  "classify_epistemic_state",
  "choose_authorized_action",
];

const KNOWN_ANCHOR_PLAN = [
  "exact_lookup",
  "graph_expand",
  "inspect_evidence",
  "classify_epistemic_state",
  "choose_authorized_action",
];

export function buildRecallPlan({ hasKnownAnchor = false, maxSteps = 8 } = {}) {
  const budget = Math.max(0, Math.floor(maxSteps));
  const operators = hasKnownAnchor ? KNOWN_ANCHOR_PLAN : UNKNOWN_ANCHOR_PLAN;
  return operators.slice(0, budget);
}

export function classifyEpistemicState({
  asOf = new Date().toISOString(),
  claims = [],
  retrieval = { completed: true, indexHealthy: true },
  resolutionPaths = [],
} = {}) {
  if (!retrieval.completed || !retrieval.indexHealthy) {
    return {
      state: "retrieval_failure",
      nextAction: "repair_machine_index_and_retry",
      reason: "retrieval did not complete against a healthy index",
    };
  }

  const currentClaims = claims.filter(
    (claim) => claim.authority === "tony_ratified" && isCurrentAt(claim, asOf),
  );
  const values = new Set(currentClaims.map((claim) => stableValue(claim.object)));

  if (values.size > 1) {
    return {
      state: "conflicting",
      nextAction: "surface_conflict_and_request_ratification",
      reason: "multiple current ratified values disagree",
    };
  }

  if (values.size === 1) {
    return {
      state: "supported_current",
      nextAction: "answer_with_evidence",
      reason: "one current ratified value is supported",
    };
  }

  if (resolutionPaths.some((path) => path.authorized)) {
    return {
      state: "missing_resolvable",
      nextAction: "follow_resolution_path",
      reason: "no supported value is stored, but an authorized source can be checked",
    };
  }

  if (resolutionPaths.length > 0) {
    return {
      state: "inaccessible",
      nextAction: "report_blocked_source",
      reason: "a possible source exists, but this agent is not authorized to inspect it",
    };
  }

  return {
    state: "missing_unresolved",
    nextAction: "tell_tony_and_request_source",
    reason: "no supported value or authorized resolution path is available",
  };
}

function isCurrentAt(claim, asOf) {
  const instant = Date.parse(asOf);
  const start = claim.validFrom ? Date.parse(claim.validFrom) : Number.NEGATIVE_INFINITY;
  const end = claim.validTo ? Date.parse(claim.validTo) : Number.POSITIVE_INFINITY;
  return start <= instant && instant < end;
}

function stableValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
}
