"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-3d";
import * as THREE from "three";
import { colorFor } from "@/lib/node-colors";
import { guardOrbitPointerPositions } from "@/lib/orbit-pointer-guard";
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

// Node-dot motion. A dot brightens and swells while it moves (during layout or a
// drag), then relaxes as it settles; at rest the whole field breathes gently so
// the sky never freezes. All of this is dropped under prefers-reduced-motion.
const SWELL = 0.55; // extra size at full motion, as a fraction of base scale
const BRIGHTEN = 0.3; // extra opacity added at full motion
const DELTA_FULL = 2.2; // per-frame travel (graph units) that reads as full motion
const ATTACK = 0.35; // how fast a dot flares up when it starts moving
const RELEASE = 0.06; // how slowly it eases back down once it stops
const BREATHE_AMP = 0.05; // idle pulse depth, as a fraction of base scale
const BREATHE_SPEED = 0.0009; // idle pulse rate (rad/ms); ~7s period

// Per-sprite animation state, stashed on sprite.userData.
type SpriteAnim = {
  baseScale: number;
  baseOpacity: number;
  phase: number; // breathing offset so dots don't pulse in lockstep
  lastX?: number;
  lastY?: number;
  lastZ?: number;
  intensity: number; // smoothed 0..1 motion level
};

// Stable per-node breathing phase derived from the id (no per-frame randomness).
function phaseFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return (h / 1000) * Math.PI * 2;
}

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
  // Live node sprites keyed by node id, so the motion loop can animate them.
  const nodeSprites = useRef<Map<string, THREE.Sprite>>(new Map());

  useEffect(() => {
    const measure = () => setDims({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Harden the OrbitControls instance against an upstream onPointerUp crash as
  // soon as the graph exposes it. controls() is only ready after mount, so poll
  // briefly; guardOrbitPointerPositions is idempotent and best-effort.
  useEffect(() => {
    if (dims.w === 0) return;
    let tries = 0;
    const id = setInterval(() => {
      const controls = fgRef.current?.controls?.();
      if (guardOrbitPointerPositions(controls) || ++tries > 50) clearInterval(id);
    }, 60);
    return () => clearInterval(id);
  }, [dims.w]);

  // Drive the node-dot motion each frame: swell + brighten a dot by how far it
  // travelled since the last frame (captures both layout settling and drags),
  // plus a gentle idle breathe. force-graph only writes each sprite's position,
  // so our scale/opacity writes are ours to own. Skipped under reduced motion,
  // which leaves every dot at the base size and opacity set in nodeThreeObject.
  useEffect(() => {
    if (reducedMotion || dims.w === 0) return;
    let raf = 0;
    const tick = (t: number) => {
      nodeSprites.current.forEach((sprite) => {
        if (!sprite.parent) return; // replaced or disposed; skip
        const u = sprite.userData as SpriteAnim;
        const { x, y, z } = sprite.position;
        if (u.lastX === undefined) {
          u.lastX = x;
          u.lastY = y;
          u.lastZ = z;
        }
        const delta = Math.hypot(x - u.lastX, y - (u.lastY ?? y), z - (u.lastZ ?? z));
        u.lastX = x;
        u.lastY = y;
        u.lastZ = z;
        const target = Math.min(1, delta / DELTA_FULL);
        // Flare up quickly, ease back down slowly.
        u.intensity += (target - u.intensity) * (target > u.intensity ? ATTACK : RELEASE);
        const breathe = 1 + BREATHE_AMP * Math.sin(t * BREATHE_SPEED + u.phase);
        const s = u.baseScale * (1 + SWELL * u.intensity) * breathe;
        sprite.scale.set(s, s, 1);
        (sprite.material as THREE.SpriteMaterial).opacity = Math.min(
          1,
          u.baseOpacity + BRIGHTEN * u.intensity,
        );
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion, dims.w]);

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
            sprite.userData = {
              baseScale: scale,
              baseOpacity: isSelected ? 1 : 0.9,
              phase: phaseFor(n.id),
              intensity: 0,
            } satisfies SpriteAnim;
            nodeSprites.current.set(n.id, sprite);
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
