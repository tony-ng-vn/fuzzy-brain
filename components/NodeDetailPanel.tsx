"use client";

import { colorFor } from "@/lib/node-colors";
import type { BrainEdge, BrainNode } from "@/components/types";

function endpointId(end: string | BrainNode): string {
  return typeof end === "string" ? end : end.id;
}

// The selected-node panel, shared by the face and map views so the two can never drift.
export default function NodeDetailPanel({
  node,
  edges,
  nodes,
}: {
  node: BrainNode;
  edges: BrainEdge[];
  nodes: BrainNode[];
}) {
  const connections = edges
    .filter((e) => endpointId(e.source) === node.id || endpointId(e.target) === node.id)
    .map((e) => {
      const otherId =
        endpointId(e.source) === node.id ? endpointId(e.target) : endpointId(e.source);
      return { edge: e, other: nodes.find((n) => n.id === otherId) };
    });

  return (
    <aside style={styles.panel}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            ...styles.dot,
            background: colorFor(node.type),
            boxShadow: `0 0 8px ${colorFor(node.type)}`,
          }}
        />
        {node.type && (
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, opacity: 0.6 }}>
            {node.type}
          </span>
        )}
      </div>
      <h2 style={{ fontSize: 17, margin: "10px 0 4px" }}>{node.title}</h2>
      <p style={{ fontSize: 11, opacity: 0.4, margin: 0 }}>
        {new Date(node.created_at).toLocaleDateString()}
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", opacity: 0.85 }}>
        {node.body}
      </p>
      {connections.length > 0 && (
        <>
          <h3 style={styles.subhead}>Connections</h3>
          {connections.map(({ edge, other }) => (
            <div key={edge.id} style={styles.connection}>
              <p style={{ fontSize: 13, margin: 0, color: other ? colorFor(other.type) : undefined }}>
                {other?.title ?? "(unknown node)"}
              </p>
              <p style={{ fontSize: 12, opacity: 0.55, margin: "4px 0 0", lineHeight: 1.5 }}>
                {edge.why}
              </p>
            </div>
          ))}
        </>
      )}
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    zIndex: 2,
    top: 0,
    right: 0,
    width: 340,
    maxWidth: "90vw",
    height: "100vh",
    overflowY: "auto",
    padding: "24px 22px",
    background: "rgba(4, 8, 18, 0.88)",
    borderLeft: "1px solid rgba(120,150,220,0.15)",
    backdropFilter: "blur(6px)",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    display: "inline-block",
  },
  subhead: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 2,
    opacity: 0.5,
    marginTop: 24,
  },
  connection: {
    padding: "10px 12px",
    marginBottom: 8,
    background: "rgba(120,150,220,0.06)",
    borderRadius: 8,
  },
};
