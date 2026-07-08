"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-3d";
import * as THREE from "three";
import { colorFor } from "@/lib/node-colors";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import type { BrainEdge, BrainNode } from "@/components/types";

// This module imports react-force-graph-3d at the top level, which touches
// window at import time, so BrainView loads this whole file with ssr: false.

// Tooltip labels are raw HTML, so interpolated text must be escaped.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function brief(body: string): string {
  return body.length > 120 ? body.slice(0, 120).trimEnd() + "..." : body;
}

type MapNode = NodeObject<BrainNode>;
type MapLink = LinkObject<BrainNode, BrainEdge>;

// How far the camera settles from a focused node, in graph units.
const FOCUS_DISTANCE = 90;
const FOCUS_MS = 900;

// The force-directed map view, in 3D: drag rotates the camera, scroll zooms,
// dragging a node pulls its connections along. Selection state and the detail
// panels live in BrainView; this component only draws and reports clicks.
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
  const fgRef = useRef<ForceGraphMethods<MapNode, MapLink> | undefined>(undefined);
  const reducedMotion = usePrefersReducedMotion();
  // One glow texture shared by every node sprite.
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

  // Ease the camera in toward a clicked node while its panel opens: the move
  // orients (which part of the sky am I reading?) rather than decorates.
  const focusNode = (node: MapNode) => {
    const fg = fgRef.current;
    if (!fg || node.x == null || node.y == null || node.z == null) return;
    const distance = Math.hypot(node.x, node.y, node.z);
    const position =
      distance > 0
        ? {
            x: node.x * (1 + FOCUS_DISTANCE / distance),
            y: node.y * (1 + FOCUS_DISTANCE / distance),
            z: node.z * (1 + FOCUS_DISTANCE / distance),
          }
        : { x: 0, y: 0, z: FOCUS_DISTANCE };
    fg.cameraPosition(position, { x: node.x, y: node.y, z: node.z }, reducedMotion ? 0 : FOCUS_MS);
  };

  return (
    <div style={styles.layer}>
      {dims.w > 0 && (
        <ForceGraph3D
          ref={fgRef}
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          controlType="orbit"
          showNavInfo={false}
          nodeLabel={(node) => {
            const n = node as BrainNode;
            const typeLine = n.type ? `<div style="font-size:10px;text-transform:uppercase;letter-spacing:1.5px;opacity:.55;margin-top:2px">${esc(n.type)}</div>` : "";
            const bodyLine = n.body ? `<div style="margin-top:4px;opacity:.75">${esc(brief(n.body))}</div>` : "";
            return `<div style="max-width:280px;color:#c9d4e3;font-size:12px;line-height:1.5"><b>${esc(n.title)}</b>${typeLine}${bodyLine}</div>`;
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
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.25}
          onNodeClick={(node) => {
            onSelectNode(node as BrainNode);
            focusNode(node);
          }}
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
