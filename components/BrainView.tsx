"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import AddNodePanel from "@/components/AddNodePanel";
import NodeDetailPanel from "@/components/NodeDetailPanel";
import type { BrainEdge, BrainNode } from "@/components/types";
import { useTheme } from "@/lib/use-theme";

// Both views touch window and WebGL at import or mount time, so neither may
// ever server-render; BrainMap imports react-force-graph-3d at the top level.
const FaceView = dynamic(() => import("@/components/FaceView"), { ssr: false });
const BrainMap = dynamic(() => import("@/components/BrainMap"), { ssr: false });

type Mode = "face" | "map";

// Owns the single GET /api/graph read plus the header, mode toggle, and shared
// panels; the face and map views are pure renderers of the data it hands down.
export default function BrainView() {
  const [nodes, setNodes] = useState<BrainNode[]>([]);
  const [edges, setEdges] = useState<BrainEdge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("face");
  const [selectedNode, setSelectedNode] = useState<BrainNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<BrainEdge | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [theme, toggleTheme] = useTheme();

  const fetchGraph = useCallback(() => {
    return fetch("/api/graph")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setNodes(data.nodes);
        setEdges(data.edges);
        return data.nodes as BrainNode[];
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        return [] as BrainNode[];
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const clearSelection = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  const selectNode = useCallback((node: BrainNode | null) => {
    setSelectedNode(node);
    setSelectedEdge(null);
  }, []);

  const selectEdge = useCallback((edge: BrainEdge) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
  }, []);

  const switchMode = (next: Mode) => {
    setMode(next);
    clearSelection();
  };

  return (
    <div style={styles.root}>
      {mode === "face" ? (
        <FaceView
          nodes={nodes}
          edges={edges}
          selectedNode={selectedNode}
          loaded={loaded}
          onSelectNode={selectNode}
        />
      ) : (
        <BrainMap
          nodes={nodes}
          edges={edges}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          onSelectNode={selectNode}
          onSelectEdge={selectEdge}
          onClearSelection={clearSelection}
        />
      )}

      <header style={styles.header}>
        <span style={{ letterSpacing: 4, fontSize: 13, opacity: 0.9 }}>FUZZY BRAIN</span>
        <span style={{ fontSize: 11, opacity: 0.45 }}>
          {nodes.length} nodes / {edges.length} connections
        </span>
        <div style={styles.row}>
          <div style={styles.toggle}>
            {(["face", "map"] as const).map((m) => (
              <button
                key={m}
                style={m === mode ? styles.toggleActive : styles.toggleButton}
                onClick={() => switchMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            style={styles.themeButton}
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? "light" : "dark"}
          </button>
        </div>
        <button
          style={styles.addButton}
          onClick={() => {
            setShowAdd(true);
            clearSelection();
          }}
        >
          + add node
        </button>
      </header>

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
          <p style={{ fontSize: 14, color: "var(--error)", margin: 0 }}>Cannot reach the brain: {error}</p>
        </div>
      )}

      {showAdd && (
        <AddNodePanel
          nodes={nodes}
          onClose={() => setShowAdd(false)}
          onCreated={async (nodeId) => {
            const fresh = await fetchGraph();
            setShowAdd(false);
            selectNode(fresh.find((n) => n.id === nodeId) ?? null);
          }}
        />
      )}

      {!showAdd && selectedNode && (
        <NodeDetailPanel node={selectedNode} edges={edges} nodes={nodes} />
      )}

      {!showAdd && selectedEdge && (
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
  // Solid night sky, always dark: this is the space the views render into,
  // not chrome, so it does not theme. Only text/panels/controls below do.
  root: { width: "100vw", height: "100vh", position: "relative", background: "#05070f" },
  header: {
    position: "absolute",
    zIndex: 2,
    top: 20,
    left: 24,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    alignItems: "flex-start",
    color: "var(--text)",
    // The header must not swallow view drags; only its buttons are clickable.
    pointerEvents: "none",
  },
  row: {
    pointerEvents: "auto",
    display: "flex",
    gap: 8,
  },
  toggle: {
    display: "flex",
    gap: 4,
  },
  toggleButton: {
    padding: "4px 12px",
    fontSize: 12,
    color: "var(--text-accent)",
    background: "var(--surface-soft)",
    border: "1px solid var(--control-border)",
    borderRadius: 6,
    cursor: "pointer",
  },
  toggleActive: {
    padding: "4px 12px",
    fontSize: 12,
    color: "var(--text-strong)",
    background: "var(--accent-active-bg)",
    border: "1px solid var(--accent-active-border)",
    borderRadius: 6,
    cursor: "pointer",
  },
  themeButton: {
    padding: "4px 12px",
    fontSize: 12,
    color: "var(--text-accent)",
    background: "var(--surface-soft)",
    border: "1px solid var(--control-border)",
    borderRadius: 6,
    cursor: "pointer",
  },
  addButton: {
    pointerEvents: "auto",
    padding: "4px 10px",
    fontSize: 12,
    color: "var(--text-accent)",
    background: "var(--surface-soft)",
    border: "1px solid var(--control-border)",
    borderRadius: 6,
    cursor: "pointer",
  },
  empty: {
    position: "absolute",
    zIndex: 2,
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    color: "var(--text)",
    pointerEvents: "none",
  },
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
    background: "var(--panel-bg)",
    borderLeft: "1px solid var(--panel-border)",
    backdropFilter: "blur(6px)",
    color: "var(--text)",
  },
};
