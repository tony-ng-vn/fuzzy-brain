"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

// force-graph touches window at import time, so it must never render on the server.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

type BrainNode = {
  id: string;
  type: string;
  title: string;
  body: string;
  created_at: string;
  x?: number;
  y?: number;
};

type BrainEdge = {
  id: string;
  // The simulation replaces id strings with node objects once it takes over.
  source: string | BrainNode;
  target: string | BrainNode;
  why: string;
  created_at: string;
};

const TYPE_COLORS: Record<string, string> = {
  story: "#6ec8ff",
  lesson: "#b18aff",
  quote: "#ffc46b",
  event: "#6bffb8",
  person: "#ff8ab3",
};

// Unknown types still get a stable, luminous color of their own.
function colorFor(type: string): string {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  let hash = 0;
  for (const ch of type) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 85%, 72%)`;
}

// Tooltip labels are raw HTML, so interpolated text must be escaped.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function endpointId(end: string | BrainNode): string {
  return typeof end === "string" ? end : end.id;
}

export default function BrainMap() {
  const [nodes, setNodes] = useState<BrainNode[]>([]);
  const [edges, setEdges] = useState<BrainEdge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<BrainNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<BrainEdge | null>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const measure = () => setDims({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    fetch("/api/graph")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setNodes(data.nodes);
        setEdges(data.edges);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoaded(true));
  }, []);

  // force-graph mutates this object (positions, resolved links), so keep it stable.
  const graphData = useMemo(
    () => ({ nodes, links: edges.map((e) => ({ ...e })) }),
    [nodes, edges],
  );

  const connectionsOfSelected = useMemo(() => {
    if (!selectedNode) return [];
    return edges
      .filter(
        (e) =>
          endpointId(e.source) === selectedNode.id || endpointId(e.target) === selectedNode.id,
      )
      .map((e) => {
        const otherId =
          endpointId(e.source) === selectedNode.id ? endpointId(e.target) : endpointId(e.source);
        return { edge: e, other: nodes.find((n) => n.id === otherId) };
      });
  }, [selectedNode, edges, nodes]);

  const typesInUse = useMemo(() => [...new Set(nodes.map((n) => n.type))], [nodes]);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      {dims.w > 0 && (
        <ForceGraph2D
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          backgroundColor="#000005"
          nodeLabel={(node) => {
            const n = node as BrainNode;
            return `<div style="color:#c9d4e3;font-size:12px"><b>${esc(n.title)}</b><br/><span style="opacity:.6">${esc(n.type)}</span></div>`;
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
          onNodeClick={(node) => {
            setSelectedNode(node as BrainNode);
            setSelectedEdge(null);
          }}
          onLinkClick={(link) => {
            setSelectedEdge(link as BrainEdge);
            setSelectedNode(null);
          }}
          onBackgroundClick={() => {
            setSelectedNode(null);
            setSelectedEdge(null);
          }}
        />
      )}

      <header style={styles.header}>
        <span style={{ letterSpacing: 4, fontSize: 13, opacity: 0.9 }}>FUZZY BRAIN</span>
        <span style={{ fontSize: 11, opacity: 0.45 }}>
          {nodes.length} nodes / {edges.length} connections
        </span>
      </header>

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

      {loaded && !error && nodes.length === 0 && (
        <div style={styles.empty}>
          <p style={{ fontSize: 15, opacity: 0.8, margin: 0 }}>The brain is empty.</p>
          <p style={{ fontSize: 13, opacity: 0.45, marginTop: 8 }}>
            Open Claude Code in this repo and tell it a story.
          </p>
        </div>
      )}

      {error && (
        <div style={styles.empty}>
          <p style={{ fontSize: 14, color: "#ff8a8a", margin: 0 }}>Cannot reach the brain: {error}</p>
        </div>
      )}

      {selectedNode && (
        <aside style={styles.panel}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                ...styles.dot,
                background: colorFor(selectedNode.type),
                boxShadow: `0 0 8px ${colorFor(selectedNode.type)}`,
              }}
            />
            <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, opacity: 0.6 }}>
              {selectedNode.type}
            </span>
          </div>
          <h2 style={{ fontSize: 17, margin: "10px 0 4px" }}>{selectedNode.title}</h2>
          <p style={{ fontSize: 11, opacity: 0.4, margin: 0 }}>
            {new Date(selectedNode.created_at).toLocaleDateString()}
          </p>
          <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", opacity: 0.85 }}>
            {selectedNode.body}
          </p>
          {connectionsOfSelected.length > 0 && (
            <>
              <h3 style={styles.panelSubhead}>Connections</h3>
              {connectionsOfSelected.map(({ edge, other }) => (
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
      )}

      {selectedEdge && (
        <aside style={styles.panel}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, opacity: 0.6 }}>
            Connection
          </span>
          <h2 style={{ fontSize: 15, margin: "10px 0" }}>
            {typeof selectedEdge.source === "object" ? selectedEdge.source.title : ""}
            <span style={{ opacity: 0.4 }}> to </span>
            {typeof selectedEdge.target === "object" ? selectedEdge.target.title : ""}
          </h2>
          <p style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.85 }}>{selectedEdge.why}</p>
        </aside>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    position: "absolute",
    top: 20,
    left: 24,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    pointerEvents: "none",
  },
  // Bottom-right so the Next.js dev-tools badge (bottom-left) never covers it.
  legend: {
    position: "absolute",
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
  empty: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    pointerEvents: "none",
  },
  panel: {
    position: "absolute",
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
  panelSubhead: {
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
