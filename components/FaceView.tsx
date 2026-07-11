"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import * as THREE from "three";
import {
  REVEAL_SEED,
  grade,
  litPointIndices,
  seededShuffle,
  sortNodesForReveal,
} from "@/lib/face-reveal";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import type { BrainEdge, BrainNode } from "@/components/types";

type FacePoint = { x: number; y: number; zScatter: number; color: string };
type FaceAsset = {
  settings: { scatter: number; brightness: number; contrast: number; pointSize: number };
  points: FacePoint[];
};

// Ghost points are the always-faintly-present target shape: a fixed dim grey so
// the unlit face is visible from the first thought. Tunable in one place.
const GHOST_COLOR = 0x787878; // rgb(120, 120, 120)
const GHOST_OPACITY = 0.15;

// Scene constants ported verbatim from tools/face-scatter.html, the ratified
// render reference. FRUSTUM is the vertical world extent; horizontal scales with
// aspect. An orthographic camera is load-bearing: perspective would break the
// head-on alignment that makes the reveal work.
const FRUSTUM = 2.2;
const NEAR = 0.01;
const FAR = 100;
const FRONT_POSITION: [number, number, number] = [0, 0, 6];

// World units, roughly the exported point spacing. The default of 1 world unit
// dwarfs this cloud. Point footprint is normalized by camera.zoom each frame, so
// the world footprint is constant and this is set once, never per frame.
const POINT_RAYCAST_THRESHOLD = 0.02;

// Connection strands between lit points, matching the map view's link color.
const EDGE_COLOR = 0x7896dc;
const EDGE_OPACITY = 0.3;

// Selection halo shares the UI's lavender accent so "selected" reads the same
// in the panel and in the sky.
const HALO_COLOR = 0xb9a6ff;

// Motion constants. Fades are opacity-only (kept under reduced motion); the
// snap tween and idle drift are movement (dropped under reduced motion).
const FADE_SECONDS = 0.5;
const LIT_FADE_DELAY = 0.15;
const STRAND_FADE_DELAY = 0.3;
const SNAP_SECONDS = 0.8;
const DRIFT_SPEED = 0.3; // autoRotateSpeed units: 2.0 is one orbit in 30s

export default function FaceView({
  nodes,
  edges,
  selectedNode,
  loaded,
  onSelectNode,
}: {
  nodes: BrainNode[];
  edges: BrainEdge[];
  selectedNode: BrainNode | null;
  loaded: boolean;
  onSelectNode: (node: BrainNode | null) => void;
}) {
  const [asset, setAsset] = useState<FaceAsset | null>(null);
  const [hover, setHover] = useState<{ node: BrainNode; x: number; y: number } | null>(null);
  const [snapSignal, setSnapSignal] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    let cancelled = false;
    fetch("/brain-face.json")
      .then((res) => {
        if (!res.ok) throw new Error(`asset ${res.status}`);
        return res.json();
      })
      .then((data: FaceAsset) => {
        if (!cancelled) setAsset(data);
      })
      .catch(() => {
        // A missing portrait leaves the map view fully usable; fail quiet here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sprite = useMemo(() => (asset ? makeSprite() : null), [asset]);

  // Shuffle once (fixed seed) so early nodes always claim the same points. The
  // sort re-derives a stable order client-side; API response order is not trusted.
  const shuffle = useMemo(
    () => (asset ? seededShuffle(asset.points.length, REVEAL_SEED) : []),
    [asset],
  );
  const sorted = useMemo(() => sortNodesForReveal(nodes), [nodes]);
  // Gate lit points on `loaded` so the cloud never flashes lit-then-empty mid-load.
  const litIndices = useMemo(
    () => litPointIndices(shuffle, loaded ? sorted.length : 0),
    [shuffle, sorted.length, loaded],
  );

  const lit = useMemo(
    () => (asset ? buildAttributes(asset, litIndices, true) : null),
    [asset, litIndices],
  );
  const ghost = useMemo(
    () => (asset ? buildAttributes(asset, shuffle.slice(litIndices.length), false) : null),
    [asset, shuffle, litIndices.length],
  );
  // Strands between connected lit points: with a handful of nodes the whys are
  // most of the brain, so their existence should be visible in the face too.
  const edgeLines = useMemo(
    () => (asset ? buildEdgeLines(asset, sorted, litIndices, edges) : null),
    [asset, sorted, litIndices, edges],
  );

  const haloPosition = useMemo(() => {
    if (!asset || !selectedNode) return null;
    const index = sorted.findIndex((n) => n.id === selectedNode.id);
    if (index < 0 || index >= litIndices.length) return null;
    return toWorld(asset.points[litIndices[index]], asset.settings.scatter);
  }, [asset, selectedNode, sorted, litIndices]);

  return (
    <div style={styles.layer}>
      {asset && sprite && lit && ghost && (
        <Canvas
          gl={{ alpha: true, antialias: true }}
          dpr={[1, 2]}
          style={{ position: "absolute", inset: 0, cursor: hover ? "pointer" : "grab" }}
          onCreated={({ raycaster }) => {
            raycaster.params.Points.threshold = POINT_RAYCAST_THRESHOLD;
          }}
          onPointerMissed={() => onSelectNode(null)}
        >
          <RevealCamera />
          <OrbitControls
            makeDefault
            enableDamping={!reducedMotion}
            autoRotate={!reducedMotion}
            autoRotateSpeed={DRIFT_SPEED}
          />
          <CameraDirector snapSignal={snapSignal} reducedMotion={reducedMotion} />
          <PointCloud
            key={`lit-${lit.positions.length}`}
            positions={lit.positions}
            colors={lit.colors}
            baseSize={asset.settings.pointSize}
            sprite={sprite}
            targetOpacity={1}
            fadeDelay={LIT_FADE_DELAY}
            onPick={(index) => {
              const node = sorted[index];
              if (node) onSelectNode(node);
            }}
            onHover={(index, x, y) => {
              if (index == null) {
                setHover(null);
                return;
              }
              const node = sorted[index];
              if (node) setHover({ node, x, y });
            }}
          />
          <PointCloud
            key={`ghost-${ghost.positions.length}`}
            positions={ghost.positions}
            uniformColor={GHOST_COLOR}
            baseSize={asset.settings.pointSize}
            sprite={sprite}
            targetOpacity={GHOST_OPACITY}
            fadeDelay={0}
          />
          {edgeLines && edgeLines.length > 0 && (
            <EdgeStrands key={`edges-${edgeLines.length}`} positions={edgeLines} />
          )}
          {haloPosition && (
            <SelectedHalo
              position={haloPosition}
              baseSize={asset.settings.pointSize}
              sprite={sprite}
              reducedMotion={reducedMotion}
            />
          )}
        </Canvas>
      )}
      {asset && (
        <div style={styles.frontWrap}>
          <button style={styles.frontButton} onClick={() => setSnapSignal((s) => s + 1)}>
            front
          </button>
        </div>
      )}
      {hover && (
        <div style={{ ...styles.tooltip, left: hover.x + 14, top: hover.y + 14 }}>
          <div style={{ fontWeight: 600 }}>{hover.node.title}</div>
          {hover.node.type && <div style={styles.tooltipType}>{hover.node.type}</div>}
          {hover.node.body && <div style={styles.tooltipBody}>{brief(hover.node.body)}</div>}
        </div>
      )}
    </div>
  );
}

// Reads the live canvas size to keep a fixed-world-height frustum whose width
// tracks aspect. `manual` stops drei from overwriting it with pixel-unit bounds.
function RevealCamera() {
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  const aspect = width / height;
  return (
    <OrthographicCamera
      makeDefault
      manual
      left={(-FRUSTUM * aspect) / 2}
      right={(FRUSTUM * aspect) / 2}
      top={FRUSTUM / 2}
      bottom={-FRUSTUM / 2}
      near={NEAR}
      far={FAR}
      position={FRONT_POSITION}
    />
  );
}

type ControlsLike = {
  target: THREE.Vector3;
  update: () => void;
  autoRotate: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

// Strong ease-in-out: the snap is a scene-level camera move, watched closely,
// so it gets more shape than a micro-interaction would.
function easeInOutQuart(t: number): number {
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

const FRONT_VEC = new THREE.Vector3(...FRONT_POSITION);
const ORIGIN = new THREE.Vector3(0, 0, 0);

// Tweens the camera home when the front button fires. A user drag cancels the
// tween immediately: gestures win over system motion, always. All camera and
// controls mutation happens inside useFrame via r3f state, never at render.
function CameraDirector({
  snapSignal,
  reducedMotion,
}: {
  snapSignal: number;
  reducedMotion: boolean;
}) {
  const lastSignal = useRef(0);
  const tween = useRef<{
    start: number;
    fromPos: THREE.Vector3;
    fromZoom: number;
    fromTarget: THREE.Vector3;
  } | null>(null);

  const controlsForCancel = useThree((state) => state.controls) as unknown as ControlsLike | null;
  useEffect(() => {
    const controls = controlsForCancel;
    if (!controls) return;
    const cancel = () => {
      tween.current = null;
      controls.autoRotate = !reducedMotion;
    };
    controls.addEventListener("start", cancel);
    return () => controls.removeEventListener("start", cancel);
  }, [controlsForCancel, reducedMotion]);

  useFrame((state) => {
    const camera = state.camera as THREE.OrthographicCamera;
    const controls = state.controls as unknown as ControlsLike | null;

    if (snapSignal !== lastSignal.current) {
      lastSignal.current = snapSignal;
      if (reducedMotion) {
        camera.position.copy(FRONT_VEC);
        camera.zoom = 1;
        camera.updateProjectionMatrix();
        if (controls) {
          controls.target.copy(ORIGIN);
          controls.update();
        }
        tween.current = null;
        return;
      }
      if (controls) controls.autoRotate = false;
      tween.current = {
        start: state.clock.elapsedTime,
        fromPos: camera.position.clone(),
        fromZoom: camera.zoom,
        fromTarget: controls ? controls.target.clone() : ORIGIN.clone(),
      };
    }

    const tw = tween.current;
    if (!tw) return;
    const progress = Math.min(1, (state.clock.elapsedTime - tw.start) / SNAP_SECONDS);
    const eased = easeInOutQuart(progress);
    camera.position.lerpVectors(tw.fromPos, FRONT_VEC, eased);
    camera.zoom = tw.fromZoom + (1 - tw.fromZoom) * eased;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.lerpVectors(tw.fromTarget, ORIGIN, eased);
      controls.update();
    }
    if (progress === 1) {
      tween.current = null;
      if (controls) controls.autoRotate = !reducedMotion;
    }
  });

  return null;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function PointCloud({
  positions,
  colors,
  uniformColor,
  targetOpacity,
  fadeDelay,
  baseSize,
  sprite,
  onPick,
  onHover,
}: {
  positions: Float32Array;
  colors?: Float32Array;
  uniformColor?: number;
  targetOpacity: number;
  fadeDelay: number;
  baseSize: number;
  sprite: THREE.Texture;
  onPick?: (index: number) => void;
  onHover?: (index: number | null, x: number, y: number) => void;
}) {
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const fadeStart = useRef<number | null>(null);
  const fadeDone = useRef(false);
  // sizeAttenuation is off (see PointsMaterial), so size lives in pixels and is
  // scaled by zoom here each frame; this is what lets dense clouds hold together.
  // The mount fade is opacity-only, so it survives prefers-reduced-motion.
  useFrame(({ camera, clock }) => {
    const material = materialRef.current;
    if (!material) return;
    material.size = baseSize * (camera as THREE.OrthographicCamera).zoom;
    if (fadeDone.current) return;
    if (fadeStart.current == null) fadeStart.current = clock.elapsedTime;
    const t = (clock.elapsedTime - fadeStart.current - fadeDelay) / FADE_SECONDS;
    if (t <= 0) {
      material.opacity = 0;
    } else if (t >= 1) {
      material.opacity = targetOpacity;
      fadeDone.current = true;
    } else {
      material.opacity = targetOpacity * easeOutCubic(t);
    }
  });

  return (
    <points
      onClick={
        onPick
          ? (event) => {
              event.stopPropagation();
              const index = event.index;
              if (index == null) return;
              onPick(index);
            }
          : undefined
      }
      onPointerMove={
        onHover
          ? (event) => {
              event.stopPropagation();
              if (event.index == null) return;
              onHover(event.index, event.nativeEvent.clientX, event.nativeEvent.clientY);
            }
          : undefined
      }
      onPointerOut={onHover ? () => onHover(null, 0, 0) : undefined}
    >
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        {colors && <bufferAttribute attach="attributes-color" args={[colors, 3]} />}
      </bufferGeometry>
      <pointsMaterial
        ref={materialRef}
        size={baseSize}
        sizeAttenuation={false}
        map={sprite}
        vertexColors={Boolean(colors)}
        color={uniformColor ?? 0xffffff}
        transparent
        opacity={0}
        alphaTest={0.05}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// Strands fade in last: constellation base, then thoughts, then their whys.
function EdgeStrands({ positions }: { positions: Float32Array }) {
  const materialRef = useRef<THREE.LineBasicMaterial>(null);
  const fadeStart = useRef<number | null>(null);
  const fadeDone = useRef(false);
  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (!material || fadeDone.current) return;
    if (fadeStart.current == null) fadeStart.current = clock.elapsedTime;
    const t = (clock.elapsedTime - fadeStart.current - STRAND_FADE_DELAY) / FADE_SECONDS;
    if (t <= 0) {
      material.opacity = 0;
    } else if (t >= 1) {
      material.opacity = EDGE_OPACITY;
      fadeDone.current = true;
    } else {
      material.opacity = EDGE_OPACITY * easeOutCubic(t);
    }
  });
  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial
        ref={materialRef}
        color={EDGE_COLOR}
        transparent
        opacity={0}
        depthWrite={false}
      />
    </lineSegments>
  );
}

// A soft breathing glow behind the selected point: state indication, not
// decoration, so under reduced motion it stays visible but holds still.
function SelectedHalo({
  position,
  baseSize,
  sprite,
  reducedMotion,
}: {
  position: [number, number, number];
  baseSize: number;
  sprite: THREE.Texture;
  reducedMotion: boolean;
}) {
  const ref = useRef<THREE.Sprite>(null);
  const height = useThree((state) => state.size.height);
  // Matches the points' constant world footprint (their px size scales with
  // zoom, so world size is fixed); the halo just multiplies it.
  const worldSize = ((baseSize * FRUSTUM) / height) * 2.6;
  useFrame(({ clock }) => {
    const halo = ref.current;
    if (!halo) return;
    const breath = reducedMotion ? 1 : 1 + 0.08 * Math.sin(clock.elapsedTime * 2.6);
    halo.scale.set(worldSize * breath, worldSize * breath, 1);
  });
  return (
    <sprite ref={ref} position={position}>
      <spriteMaterial
        map={sprite}
        color={HALO_COLOR}
        transparent
        opacity={0.5}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </sprite>
  );
}

// Negate y to turn image space (y-down) into three.js space (y-up); skip it
// and the face renders upside-down.
function toWorld(point: FacePoint, scatter: number): [number, number, number] {
  return [(point.x - 0.5) * 1.6, -(point.y - 0.5) * 1.6, point.zScatter * scatter];
}

function buildAttributes(asset: FaceAsset, indices: readonly number[], withColor: boolean) {
  const { scatter, contrast, brightness } = asset.settings;
  const positions = new Float32Array(indices.length * 3);
  const colors = withColor ? new Float32Array(indices.length * 3) : undefined;
  for (let i = 0; i < indices.length; i++) {
    const point = asset.points[indices[i]];
    const [x, y, z] = toWorld(point, scatter);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    if (colors) {
      const [r, g, b] = parseRgb(point.color);
      colors[i * 3] = grade(r, contrast, brightness);
      colors[i * 3 + 1] = grade(g, contrast, brightness);
      colors[i * 3 + 2] = grade(b, contrast, brightness);
    }
  }
  return { positions, colors };
}

function endpointId(end: BrainEdge["source"]): string {
  return typeof end === "string" ? end : end.id;
}

// One line segment per edge whose endpoints are both lit. Positions reuse the
// exact lit-point transform so strands land on the points they connect.
function buildEdgeLines(
  asset: FaceAsset,
  sortedNodes: readonly BrainNode[],
  litIndices: readonly number[],
  edges: readonly BrainEdge[],
): Float32Array {
  const positionByNode = new Map<string, [number, number, number]>();
  for (let i = 0; i < litIndices.length && i < sortedNodes.length; i++) {
    positionByNode.set(sortedNodes[i].id, toWorld(asset.points[litIndices[i]], asset.settings.scatter));
  }
  const segments: number[] = [];
  for (const edge of edges) {
    const a = positionByNode.get(endpointId(edge.source));
    const b = positionByNode.get(endpointId(edge.target));
    if (!a || !b) continue;
    segments.push(...a, ...b);
  }
  return new Float32Array(segments);
}

function parseRgb(rgb: string): [number, number, number] {
  const match = rgb.match(/(\d+)[^\d]+(\d+)[^\d]+(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function brief(body: string): string {
  return body.length > 120 ? body.slice(0, 120).trimEnd() + "..." : body;
}

// The 64x64 radial-gradient glow sprite from the render reference.
function makeSprite(): THREE.Texture {
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
  // Positioning lives on the wrapper so the button's transform slot stays free
  // for the global :active press feedback.
  frontWrap: {
    position: "absolute",
    zIndex: 2,
    top: "50%",
    left: 24,
    transform: "translateY(-50%)",
  },
  frontButton: {
    padding: "5px 14px",
    fontSize: 12,
    color: "#b9a6ff",
    background: "rgba(120,150,220,0.12)",
    border: "1px solid rgba(120,150,220,0.3)",
    borderRadius: 6,
    cursor: "pointer",
  },
  tooltip: {
    position: "fixed",
    zIndex: 3,
    maxWidth: 280,
    padding: "8px 10px",
    background: "rgba(4, 8, 18, 0.92)",
    border: "1px solid rgba(120,150,220,0.2)",
    borderRadius: 6,
    fontSize: 12,
    color: "#c9d4e3",
    lineHeight: 1.5,
    pointerEvents: "none",
  },
  tooltipType: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    opacity: 0.55,
    marginTop: 2,
  },
  tooltipBody: {
    marginTop: 4,
    opacity: 0.75,
  },
};
