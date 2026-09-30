import assert from "node:assert/strict";
import test from "node:test";
import { fetchGraphData } from "../lib/graph-client.ts";

test("graph reads bypass the browser cache and return backend data", async () => {
  let request;
  const graph = { nodes: [{ id: "node-1" }], edges: [] };
  const result = await fetchGraphData(async (...args) => {
    request = args;
    return { ok: true, json: async () => graph };
  });
  assert.deepEqual(request, ["/api/graph", { cache: "no-store" }]);
  assert.equal(result, graph);
});

test("a failed graph read rejects instead of reporting an empty graph", async () => {
  await assert.rejects(
    fetchGraphData(async () => ({ ok: false, status: 503, json: async () => ({ error: "database unavailable" }) })),
    /database unavailable/,
  );
});
