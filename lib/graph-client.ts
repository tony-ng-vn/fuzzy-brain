import type { BrainEdge, BrainNode } from "@/components/types";

export type GraphData = { nodes: BrainNode[]; edges: BrainEdge[] };

export async function fetchGraphData(fetchImpl: typeof fetch = fetch): Promise<GraphData> {
  const res = await fetchImpl("/api/graph", { cache: "no-store" });
  const data: unknown = await res.json();
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : `request failed (${res.status})`;
    throw new Error(message);
  }
  if (!data || typeof data !== "object" || !("nodes" in data) || !("edges" in data)
      || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error("invalid graph response");
  }
  return data as GraphData;
}
