"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { colorFor } from "@/lib/node-colors";
import type { BrainEdge, BrainNode } from "@/components/types";

// force-graph touches window at import time, so it must never render on the server.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// Tooltip labels are raw HTML, so interpolated text must be escaped.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The force-directed map view. Selection state and the detail panels live in
// BrainView; this component only draws the graph and reports clicks upward.
export default function BrainMap({
  nodes,
  edges,
  selectedNode,
  selectedEdge,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}: {
  nodes: BrainNode[];
  edges: BrainEdge[];
  selectedNode: BrainNode | null;
  selectedEdge: BrainEdge | null;
  onSelectNode: (node: BrainNode) => void;
  onSelectEdge: (edge: BrainEdge) => void;
  onClearSelection: () => void;
}) {
  const [dims, setDims] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const measure = () => setDims({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // force-graph mutates this object (positions, resolved links), so keep it stable.
  const graphData = useMemo(
    () => ({ nodes, links: edges.map((e) => ({ ...e })) }),
    [nodes, edges],
  );

  const typesInUse = useMemo(
    () => [...new Set(nodes.map((n) => n.type))].filter(Boolean),
    [nodes],
  );

  return (
    <div style={styles.layer}>
      {dims.w > 0 && (
        <ForceGraph2D
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={(node) => {
            const n = node as BrainNode;
            const typeLine = n.type ? `<br/><span style="opacity:.6">${esc(n.type)}</span>` : "";
            return `<div style="color:#c9d4e3;font-size:12px"><b>${esc(n.title)}</b>${typeLine}</div>`;
          }}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const n = node as BrainNode;
            const color = colorFor(n.type);
            const isSelected = selectedNode?.id === n.id;
            const r = isSelected ? 6 : 4;
            ctx.shadowColor = color;
            ctx.shadowBlur = isSelected ? 30 : 16;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
            ctx.fill();
            ctx.shadowBlur = 0;
            if (isSelected) {
              ctx.strokeStyle = color;
              ctx.lineWidth = 0.8;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r + 4, 0, 2 * Math.PI);
              ctx.stroke();
            }
            // Titles appear once you zoom in close enough to read them.
            if (globalScale > 1.6 || isSelected) {
              ctx.font = `${Math.max(3, 11 / globalScale)}px sans-serif`;
              ctx.textAlign = "center";
              ctx.fillStyle = "rgba(201,212,227,0.85)";
              ctx.fillText(n.title, n.x ?? 0, (n.y ?? 0) + r + 10 / globalScale);
            }
          }}
          nodePointerAreaPaint={(node, color, ctx) => {
            const n = node as BrainNode;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, 8, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={() => "rgba(120,150,220,0.25)"}
          linkWidth={(link) => (selectedEdge?.id === (link as BrainEdge).id ? 2 : 0.6)}
          linkLabel={(link) => {
            const e = link as BrainEdge;
            return `<div style="color:#c9d4e3;font-size:12px;max-width:280px">${esc(e.why)}</div>`;
          }}
          linkDirectionalParticles={1}
          linkDirectionalParticleSpeed={0.0025}
          linkDirectionalParticleWidth={1.6}
          linkDirectionalParticleColor={() => "rgba(160,190,255,0.5)"}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.25}
          onNodeClick={(node) => onSelectNode(node as BrainNode)}
          onLinkClick={(link) => onSelectEdge(link as BrainEdge)}
          onBackgroundClick={onClearSelection}
        />
      )}

      {typesInUse.length > 0 && (
        <div style={styles.legend}>
          {typesInUse.map((t) => (
            <span key={t} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ ...styles.dot, background: colorFor(t), boxShadow: `0 0 6px ${colorFor(t)}` }} />
              <span style={{ fontSize: 11, opacity: 0.6 }}>{t}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layer: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
  },
  // Bottom-right so the Next.js dev-tools badge (bottom-left) never covers it.
  legend: {
    position: "absolute",
    zIndex: 2,
    bottom: 20,
    right: 24,
    display: "flex",
    gap: 14,
    pointerEvents: "none",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    display: "inline-block",
  },
};
