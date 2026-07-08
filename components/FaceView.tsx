"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentRef } from "react";
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
import type { BrainNode } from "@/components/types";

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

export default function FaceView({
  nodes,
  loaded,
  onSelectNode,
}: {
  nodes: BrainNode[];
  loaded: boolean;
  onSelectNode: (node: BrainNode | null) => void;
}) {
  const [asset, setAsset] = useState<FaceAsset | null>(null);
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
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

  const snapToFront = () => {
    const controls = controlsRef.current;
    if (!controls) return;
    const camera = controls.object as THREE.OrthographicCamera;
    camera.position.set(...FRONT_POSITION);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
  };

  return (
    <div style={styles.layer}>
      {asset && sprite && lit && ghost && (
        <Canvas
          gl={{ alpha: true, antialias: true }}
          dpr={[1, 2]}
          style={{ position: "absolute", inset: 0 }}
          onCreated={({ raycaster }) => {
            raycaster.params.Points.threshold = POINT_RAYCAST_THRESHOLD;
          }}
          onPointerMissed={() => onSelectNode(null)}
        >
          <RevealCamera />
          <OrbitControls ref={controlsRef} makeDefault enableDamping={!reducedMotion} />
          <PointCloud
            key={`lit-${lit.positions.length}`}
            positions={lit.positions}
            colors={lit.colors}
            baseSize={asset.settings.pointSize}
            sprite={sprite}
            opacity={1}
            onPick={(index) => {
              const node = sorted[index];
              if (node) onSelectNode(node);
            }}
          />
          <PointCloud
            key={`ghost-${ghost.positions.length}`}
            positions={ghost.positions}
            uniformColor={GHOST_COLOR}
            baseSize={asset.settings.pointSize}
            sprite={sprite}
            opacity={GHOST_OPACITY}
          />
        </Canvas>
      )}
      {asset && (
        <button style={styles.frontButton} onClick={snapToFront}>
          front
        </button>
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

function PointCloud({
  positions,
  colors,
  uniformColor,
  opacity,
  baseSize,
  sprite,
  onPick,
}: {
  positions: Float32Array;
  colors?: Float32Array;
  uniformColor?: number;
  opacity: number;
  baseSize: number;
  sprite: THREE.Texture;
  onPick?: (index: number) => void;
}) {
  const materialRef = useRef<THREE.PointsMaterial>(null);
  // sizeAttenuation is off (see PointsMaterial), so size lives in pixels and is
  // scaled by zoom here each frame; this is what lets dense clouds hold together.
  useFrame(({ camera }) => {
    const material = materialRef.current;
    if (material) material.size = baseSize * (camera as THREE.OrthographicCamera).zoom;
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
        opacity={opacity}
        alphaTest={0.05}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function buildAttributes(asset: FaceAsset, indices: readonly number[], withColor: boolean) {
  const { scatter, contrast, brightness } = asset.settings;
  const positions = new Float32Array(indices.length * 3);
  const colors = withColor ? new Float32Array(indices.length * 3) : undefined;
  for (let i = 0; i < indices.length; i++) {
    const point = asset.points[indices[i]];
    positions[i * 3] = (point.x - 0.5) * 1.6;
    // Negate y to turn image space (y-down) into three.js space (y-up); skip it
    // and the face renders upside-down.
    positions[i * 3 + 1] = -(point.y - 0.5) * 1.6;
    positions[i * 3 + 2] = point.zScatter * scatter;
    if (colors) {
      const [r, g, b] = parseRgb(point.color);
      colors[i * 3] = grade(r, contrast, brightness);
      colors[i * 3 + 1] = grade(g, contrast, brightness);
      colors[i * 3 + 2] = grade(b, contrast, brightness);
    }
  }
  return { positions, colors };
}

function parseRgb(rgb: string): [number, number, number] {
  const match = rgb.match(/(\d+)[^\d]+(\d+)[^\d]+(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
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

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

const styles: Record<string, React.CSSProperties> = {
  layer: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
  },
  frontButton: {
    position: "absolute",
    zIndex: 2,
    bottom: 20,
    left: "50%",
    transform: "translateX(-50%)",
    padding: "5px 14px",
    fontSize: 12,
    color: "#b9a6ff",
    background: "rgba(120,150,220,0.12)",
    border: "1px solid rgba(120,150,220,0.3)",
    borderRadius: 6,
    cursor: "pointer",
  },
};
