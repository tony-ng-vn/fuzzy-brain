"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrainNode } from "@/components/types";

type NodeDraft = {
  type: string;
  title: string;
  raw: string;
  body: string;
  connections: { targetId: string; why: string }[];
};

type Turn = {
  role: "tony" | "companion";
  text: string;
  drafts?: DraftState[];
};

type DraftState = {
  draft: NodeDraft;
  status: "offered" | "saving" | "saved" | "failed" | "dismissed";
  error?: string;
};

// The talk panel: a conversation with the brain companion, driven by the
// local Claude Code bridge (/api/companion). The companion only proposes;
// every save is a click here, going through the same POST /api/nodes the
// add-node form uses -- one write path, one set of gates.
export default function CompanionPanel({
  nodes,
  onClose,
  onSaved,
}: {
  nodes: BrainNode[];
  onClose: () => void;
  onSaved: (nodeId: string) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleById = new Map(nodes.map((n) => [n.id, n.title]));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, thinking]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || thinking) return;
    setInput("");
    setError(null);
    setTurns((prev) => [...prev, { role: "tony", text: message }]);
    setThinking(true);
    try {
      const res = await fetch("/api/companion", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fuzzy-brain-companion": "1" },
        body: JSON.stringify({ message, sessionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      setSessionId(data.sessionId as string);
      setTurns((prev) => [
        ...prev,
        {
          role: "companion",
          text: data.reply as string,
          drafts: (data.drafts as NodeDraft[]).map((draft) => ({ draft, status: "offered" as const })),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinking(false);
    }
  }, [input, thinking, sessionId]);

  const updateDraft = (turnIndex: number, draftIndex: number, patch: Partial<DraftState>) =>
    setTurns((prev) =>
      prev.map((turn, i) =>
        i === turnIndex
          ? {
              ...turn,
              drafts: turn.drafts?.map((d, j) => (j === draftIndex ? { ...d, ...patch } : d)),
            }
          : turn,
      ),
    );

  const saveDraft = async (turnIndex: number, draftIndex: number, draft: NodeDraft) => {
    updateDraft(turnIndex, draftIndex, { status: "saving", error: undefined });
    try {
      const res = await fetch("/api/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      updateDraft(turnIndex, draftIndex, { status: "saved" });
      onSaved(data.node.id as string);
    } catch (err) {
      updateDraft(turnIndex, draftIndex, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <aside style={styles.panel}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={styles.heading}>Talk</span>
        <button style={styles.ghostButton} onClick={onClose}>
          close
        </button>
      </div>

      <div ref={scrollRef} style={styles.scroll}>
        {turns.length === 0 && !thinking && (
          <p style={{ fontSize: 13, opacity: 0.45, lineHeight: 1.6 }}>
            Say what is on your mind. The companion holds the whole brain; when something is worth
            keeping it will propose a node, and nothing is saved until you say so.
          </p>
        )}
        {turns.map((turn, i) => (
          <div key={i} style={turn.role === "tony" ? styles.tonyTurn : styles.companionTurn}>
            <p style={styles.turnText}>{turn.text}</p>
            {turn.drafts?.map((d, j) => (
              <div key={j} style={styles.draftCard}>
                <span style={styles.heading}>
                  proposed node{d.draft.type ? ` (${d.draft.type})` : ""}
                </span>
                <p style={{ ...styles.turnText, fontWeight: 600 }}>{d.draft.title}</p>
                <p style={styles.draftLabel}>raw</p>
                <p style={styles.draftText}>{d.draft.raw}</p>
                {d.draft.body !== d.draft.raw && (
                  <>
                    <p style={styles.draftLabel}>readable</p>
                    <p style={styles.draftText}>{d.draft.body}</p>
                  </>
                )}
                {d.draft.connections.map((c, k) => (
                  <p key={k} style={styles.draftText}>
                    connects to {titleById.get(c.targetId) ?? "an unknown node"}: {c.why}
                  </p>
                ))}
                {d.status === "offered" || d.status === "failed" ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button style={styles.saveButton} onClick={() => saveDraft(i, j, d.draft)}>
                      {d.status === "failed" ? "try again" : "save to the brain"}
                    </button>
                    <button
                      style={styles.ghostButton}
                      onClick={() => updateDraft(i, j, { status: "dismissed" })}
                    >
                      not this one
                    </button>
                  </div>
                ) : (
                  <p style={{ ...styles.draftLabel, marginTop: 6 }}>
                    {d.status === "saving" ? "saving..." : d.status === "saved" ? "saved" : "set aside"}
                  </p>
                )}
                {d.error && <p style={styles.errorText}>{d.error}</p>}
              </div>
            ))}
          </div>
        ))}
        {thinking && <p style={{ fontSize: 12, opacity: 0.45 }}>thinking...</p>}
        {error && <p style={styles.errorText}>{error}</p>}
      </div>

      <div style={styles.composer}>
        <textarea
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="What's on your mind?"
          rows={3}
        />
        <button style={styles.saveButton} onClick={send} disabled={thinking || !input.trim()}>
          {thinking ? "..." : "send"}
        </button>
      </div>
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    zIndex: 2,
    top: 0,
    right: 0,
    width: 400,
    maxWidth: "94vw",
    height: "100vh",
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
  scroll: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    paddingRight: 4,
  },
  tonyTurn: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    padding: "8px 12px",
    background: "rgba(110,200,255,0.12)",
    border: "1px solid rgba(110,200,255,0.25)",
    borderRadius: 10,
  },
  companionTurn: {
    alignSelf: "flex-start",
    maxWidth: "94%",
    padding: "8px 12px",
    background: "rgba(120,150,220,0.07)",
    borderRadius: 10,
  },
  turnText: {
    fontSize: 13,
    lineHeight: 1.6,
    margin: 0,
    whiteSpace: "pre-wrap",
  },
  draftCard: {
    marginTop: 10,
    padding: "10px 12px",
    background: "rgba(120,150,220,0.08)",
    border: "1px solid rgba(120,150,220,0.25)",
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  draftLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 2,
    opacity: 0.5,
    margin: "4px 0 0",
  },
  draftText: {
    fontSize: 12,
    lineHeight: 1.55,
    margin: 0,
    opacity: 0.85,
    whiteSpace: "pre-wrap",
  },
  errorText: {
    fontSize: 12,
    color: "#ff8a8a",
    margin: "6px 0 0",
  },
  composer: {
    display: "flex",
    gap: 8,
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    padding: "8px 10px",
    fontSize: 13,
    color: "#c9d4e3",
    background: "rgba(120,150,220,0.08)",
    border: "1px solid rgba(120,150,220,0.2)",
    borderRadius: 6,
    outline: "none",
    fontFamily: "inherit",
    resize: "none",
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
  saveButton: {
    padding: "8px 12px",
    fontSize: 12,
    letterSpacing: 1,
    color: "#dfe9ff",
    background: "rgba(110,200,255,0.15)",
    border: "1px solid rgba(110,200,255,0.45)",
    borderRadius: 8,
    cursor: "pointer",
  },
};
