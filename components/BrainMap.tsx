"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { colorFor } from "@/lib/node-colors";
import type { BrainEdge, BrainNode } from "@/components/types";

// force-graph touches window at import time, so it must never render on the server.
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false });

// Tooltip labels are raw HTML, so interpolated text must be escaped.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The force-directed map view, in 3D: drag rotates the camera, scroll zooms.
// Selection state and the detail panels live in BrainView; this component only
// draws the graph and reports clicks upward.
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
  // One glow texture shared by every node sprite; created lazily because
  // document does not exist during the server render pass.
  const spriteMap = useRef<THREE.Texture | null>(null);

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
        <ForceGraph3D
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          controlType="orbit"
          showNavInfo={false}
          nodeLabel={(node) => {
            const n = node as BrainNode;
            const typeLine = n.type ? `<br/><span style="opacity:.6">${esc(n.type)}</span>` : "";
            return `<div style="color:#c9d4e3;font-size:12px"><b>${esc(n.title)}</b>${typeLine}</div>`;
          }}
          nodeThreeObject={(node) => {
            const n = node as BrainNode;
            if (!spriteMap.current) spriteMap.current = makeGlowTexture();
            const isSelected = selectedNode?.id === n.id;
            const sprite = new THREE.Sprite(
              new THREE.SpriteMaterial({
                map: spriteMap.current,
                color: colorFor(n.type),
                transparent: true,
                opacity: isSelected ? 1 : 0.9,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
              }),
            );
            const scale = isSelected ? 16 : 10;
            sprite.scale.set(scale, scale, 1);
            return sprite;
          }}
          linkColor={() => "rgba(120,150,220,0.4)"}
          linkWidth={(link) => (selectedEdge?.id === (link as BrainEdge).id ? 1.5 : 0)}
          linkOpacity={0.35}
          linkLabel={(link) => {
            const e = link as BrainEdge;
            return `<div style="color:#c9d4e3;font-size:12px;max-width:280px">${esc(e.why)}</div>`;
          }}
          linkDirectionalParticles={1}
          linkDirectionalParticleSpeed={0.0025}
          linkDirectionalParticleWidth={1.6}
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

// Same 64x64 radial glow the face view uses, so both skies feel like one system.
function makeGlowTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture();
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.8)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
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
