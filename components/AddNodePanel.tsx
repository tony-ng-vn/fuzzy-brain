"use client";

import { useState } from "react";

type BrainNode = { id: string; type: string; title: string };
type ConnectionDraft = { targetId: string; why: string };

export default function AddNodePanel({
  nodes,
  onClose,
  onCreated,
}: {
  nodes: BrainNode[];
  onClose: () => void;
  onCreated: (nodeId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
  const [connections, setConnections] = useState<ConnectionDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateConnection = (i: number, patch: Partial<ConnectionDraft>) =>
    setConnections((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = async () => {
    setError(null);
    if (!title.trim()) return setError("A title is required.");
    for (const c of connections) {
      if (!c.targetId) return setError("Every connection needs a target node.");
      if (!c.why.trim()) return setError("Every connection needs a why sentence.");
    }
    setSaving(true);
    try {
      const res = await fetch("/api/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, raw, connections }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      onCreated(data.node.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <aside style={styles.panel}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={styles.heading}>New node</span>
        <button style={styles.ghostButton} onClick={onClose}>
          close
        </button>
      </div>

      <label style={styles.label}>
        Title
        <input
          style={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="One line that names it"
        />
      </label>

      <label style={styles.label}>
        Story
        <textarea
          style={{ ...styles.input, minHeight: 110, resize: "vertical" }}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="The full story, as long as it needs to be"
        />
      </label>

      <span style={styles.heading}>Connections</span>
      {connections.map((c, i) => (
        <div key={i} style={styles.connection}>
          <select
            style={styles.input}
            value={c.targetId}
            onChange={(e) => updateConnection(i, { targetId: e.target.value })}
          >
            <option value="">connect to...</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title} ({n.type})
              </option>
            ))}
          </select>
          <textarea
            style={{ ...styles.input, minHeight: 48, resize: "vertical" }}
            value={c.why}
            onChange={(e) => updateConnection(i, { why: e.target.value })}
            placeholder="Why do these connect? (required)"
          />
          <button
            style={styles.ghostButton}
            onClick={() => setConnections((prev) => prev.filter((_, j) => j !== i))}
          >
            remove
          </button>
        </div>
      ))}
      <button
        style={styles.ghostButton}
        onClick={() => setConnections((prev) => [...prev, { targetId: "", why: "" }])}
        disabled={nodes.length === 0}
      >
        + add connection{nodes.length === 0 ? " (no other nodes yet)" : ""}
      </button>

      {error && <p style={{ color: "#ff8a8a", fontSize: 12, margin: "10px 0 0" }}>{error}</p>}

      <button style={styles.submit} onClick={submit} disabled={saving}>
        {saving ? "adding..." : "Add to the brain"}
      </button>
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
    background: "rgba(4, 8, 18, 0.92)",
    borderLeft: "1px solid rgba(120,150,220,0.15)",
    backdropFilter: "blur(6px)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  heading: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 2,
    opacity: 0.6,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 2,
    opacity: 0.8,
  },
  input: {
    width: "100%",
    padding: "8px 10px",
    fontSize: 13,
    letterSpacing: 0,
    textTransform: "none",
    color: "#c9d4e3",
    background: "rgba(120,150,220,0.08)",
    border: "1px solid rgba(120,150,220,0.2)",
    borderRadius: 6,
    outline: "none",
    fontFamily: "inherit",
  },
  connection: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "10px 12px",
    background: "rgba(120,150,220,0.06)",
    borderRadius: 8,
  },
  ghostButton: {
    alignSelf: "flex-start",
    padding: "4px 10px",
    fontSize: 12,
    color: "#9fb4d8",
    background: "transparent",
    border: "1px solid rgba(120,150,220,0.25)",
    borderRadius: 6,
    cursor: "pointer",
  },
  submit: {
    marginTop: 8,
    padding: "10px 12px",
    fontSize: 13,
    letterSpacing: 1,
    color: "#dfe9ff",
    background: "rgba(110,200,255,0.15)",
    border: "1px solid rgba(110,200,255,0.45)",
    borderRadius: 8,
    cursor: "pointer",
  },
};
