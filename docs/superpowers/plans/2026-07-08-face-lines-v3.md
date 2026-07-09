# Face Lines v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third face rendering to fuzzy-brain: Tony's head as a fully rotatable 3D contour-line dot portrait (drone-light-show style), built from a depth map of his real portrait, with a node-lights-a-region reveal.

**Architecture:** One-time offline bake (Depth Anything V2 depth PNG, then a browser studio tool that samples contour rows, hair flow strands, and a procedural back shell into `brain-face-v3.json`). At runtime a new `FaceLinesView` r3f component renders the baked dots with per-dot lambert shading through a bronze ramp, as a third `BrainView` mode. All pure math lives in one plain-JS module (`lib/face-lines.mjs`) shared by the studio (browser), the app (Next), and `node --test`.

**Tech Stack:** three / @react-three/fiber / @react-three/drei (already installed, no new npm deps), Python + Hugging Face transformers (dev-only, one-time depth bake), plain-JS ES module for shared math.

**Spec:** `docs/superpowers/specs/2026-07-08-face-lines-v3-design.md`

## Global Constraints

- Plain ASCII only in everything written: code, comments, commits, docs. No emoji, no em-dash, no ellipsis character, no curly quotes.
- Conventional Commits: `type(scope): description`, imperative, lowercase, no trailing period. Never mention agent or tool names, never add agent co-author lines.
- Comments explain WHY, not what; one line where possible.
- `lib/*.ts` modules stay erasable-syntax TypeScript so `node --test` loads them via type stripping (matching `lib/face-reveal.ts`).
- `lib/face-lines.mjs` stays plain browser-safe JS with JSDoc types (no imports from `.ts` files) because the studio tool loads it directly over HTTP.
- Seeds already in use and reserved: 20260708 (v2 asset), 20260709 (v2 reveal). v3 region seed is 20260710.
- The studio tool pins the same three.js CDN version the v1 tool uses: 0.166.0.
- Tests run with `npm test` (`node --test tests/*.test.mjs`). Run the full suite after implementing, plus `npx tsc --noEmit` and `npm run lint` before each commit that touches app code.
- Task 6 is a HARD GATE: no app-side rendering work (Tasks 7-8) until Tony has signed off on the studio look and the ratified asset is committed. If the look fails, stop and return to design.
- The portrait photo and depth PNG are dev-only inputs and are never committed; only the exported JSON asset is.
- All work happens in `/Users/minhthiennguyen/Desktop/fuzzy-brain` on branch `main` (the repo's convention so far is direct-to-main commits).

---

### Task 1: Shading math in `lib/face-lines.mjs`

**Files:**
- Create: `lib/face-lines.mjs`
- Test: `tests/face-lines.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2, 5, 7):
  - `lambert(normal: [number,number,number], light: [number,number,number]): number` -- clamped cosine, normalizes `light`, assumes `normal` is already unit length.
  - `dotBrightness(lambertTerm: number, albedo: number, ambient: number): number` -- `ambient + lambertTerm * albedo` clamped to [0, 1].
  - `rampColor(t: number, stops: [rgb, rgb, rgb]): [number,number,number]` -- piecewise lerp lo->mid on t in [0, 0.5], mid->hi on [0.5, 1]; rgb components are 0..1.
  - `normalFromGradient(dzdx: number, dzdy: number): [number,number,number]` -- unit surface normal of z(x, y) in world space (y up, z toward viewer).

- [ ] **Step 1: Write the failing tests**

Create `tests/face-lines.test.mjs`:

```js
// Pure math for the v3 face-lines head: shading, geometry, clustering.
import test from "node:test";
import assert from "node:assert/strict";
import {
  lambert,
  dotBrightness,
  rampColor,
  normalFromGradient,
} from "../lib/face-lines.mjs";

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("lambert is 1 facing the light, 0 perpendicular, clamped behind", () => {
  assert.ok(close(lambert([0, 0, 1], [0, 0, 1]), 1));
  assert.ok(close(lambert([1, 0, 0], [0, 0, 1]), 0));
  assert.equal(lambert([0, 0, -1], [0, 0, 1]), 0);
});

test("lambert normalizes the light vector", () => {
  assert.ok(close(lambert([0, 0, 1], [0, 0, 10]), 1));
});

test("dotBrightness applies the ambient floor and clamps to [0, 1]", () => {
  assert.ok(close(dotBrightness(0, 0.5, 0.2), 0.2));
  assert.ok(close(dotBrightness(1, 0.5, 0.2), 0.7));
  assert.equal(dotBrightness(1, 1, 0.5), 1);
  assert.equal(dotBrightness(-1, 1, 0), 0);
});

const STOPS = [
  [0.1, 0.05, 0.02],
  [0.7, 0.44, 0.23],
  [1, 0.91, 0.76],
];

test("rampColor hits the stops at 0, 0.5, and 1 and clamps outside", () => {
  assert.deepEqual(rampColor(0, STOPS), STOPS[0]);
  assert.deepEqual(rampColor(0.5, STOPS), STOPS[1]);
  assert.deepEqual(rampColor(1, STOPS), STOPS[2]);
  assert.deepEqual(rampColor(-5, STOPS), STOPS[0]);
  assert.deepEqual(rampColor(5, STOPS), STOPS[2]);
});

test("rampColor lerps midway between stops", () => {
  const quarter = rampColor(0.25, STOPS);
  for (let i = 0; i < 3; i++) {
    assert.ok(close(quarter[i], (STOPS[0][i] + STOPS[1][i]) / 2));
  }
});

test("normalFromGradient is unit length and faces the viewer on flat ground", () => {
  assert.deepEqual(normalFromGradient(0, 0), [-0, -0, 1]);
  const n = normalFromGradient(1, -2);
  assert.ok(close(Math.hypot(n[0], n[1], n[2]), 1));
  // Surface rising toward +x tilts the normal toward -x.
  assert.ok(n[0] < 0 && n[1] > 0 && n[2] > 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/minhthiennguyen/Desktop/fuzzy-brain && npm test`
Expected: FAIL, `Cannot find module '.../lib/face-lines.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `lib/face-lines.mjs`:

```js
// Pure math for the v3 face-lines head, shared by three consumers: the studio
// tool (tools/face-lines.html, loaded over HTTP), FaceLinesView (via Next), and
// node --test. Kept as plain browser-safe JS with JSDoc types for that reason.

/** @typedef {[number, number, number]} Vec3 */

/**
 * Clamped cosine shading term. `light` is normalized here so callers can pass
 * raw slider vectors; `normal` is expected to already be unit length.
 * @param {Vec3} normal @param {Vec3} light @returns {number}
 */
export function lambert(normal, light) {
  const len = Math.hypot(light[0], light[1], light[2]) || 1;
  const d =
    (normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2]) / len;
  return Math.max(0, d);
}

/**
 * Ambient floor keeps the unlit side of the head readable on black.
 * @param {number} lambertTerm @param {number} albedo @param {number} ambient
 * @returns {number} brightness in [0, 1]
 */
export function dotBrightness(lambertTerm, albedo, ambient) {
  return Math.min(1, Math.max(0, ambient + lambertTerm * albedo));
}

/** @param {Vec3} a @param {Vec3} b @param {number} t @returns {Vec3} */
function lerp3(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Bronze ramp: brightness 0..1 through three color stops (lo, mid, hi).
 * @param {number} t @param {readonly [Vec3, Vec3, Vec3]} stops @returns {Vec3}
 */
export function rampColor(t, stops) {
  const c = Math.min(1, Math.max(0, t));
  if (c <= 0.5) return lerp3(stops[0], stops[1], c * 2);
  return lerp3(stops[1], stops[2], (c - 0.5) * 2);
}

/**
 * Unit normal of a height field z(x, y) from its world-space gradient
 * (y up, z toward viewer): normalize([-dz/dx, -dz/dy, 1]).
 * @param {number} dzdx @param {number} dzdy @returns {Vec3}
 */
export function normalFromGradient(dzdx, dzdy) {
  const len = Math.hypot(dzdx, dzdy, 1);
  return [-dzdx / len, -dzdy / len, 1 / len];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all existing suites plus the 6 new tests).

- [ ] **Step 5: Commit**

```bash
git add lib/face-lines.mjs tests/face-lines.test.mjs
git commit -m "feat(face): add shared shading math for the face-lines head"
```

---

### Task 2: Geometry math in `lib/face-lines.mjs`

**Files:**
- Modify: `lib/face-lines.mjs` (append)
- Test: `tests/face-lines.test.mjs` (append)

**Interfaces:**
- Consumes: nothing from Task 1 (independent functions in the same module).
- Produces (used by Task 5's studio):
  - `resamplePolyline(points: Vec3[], spacing: number): Vec3[]` -- even arc-length resampling; keeps the first point.
  - `shellPoint(row: {y, cx, a, zEdge}, phi: number, depthFactor: number): {point: Vec3, normal: Vec3}` -- one back-shell dot on the half-ellipse behind row profile; phi 0..PI sweeps right edge to left edge.
  - `traceFlowStrand(seed: [number,number], field: (x,y) => [number,number], opts: {step, maxSteps, inside}): Array<[number,number]>` -- 2D strand traced both ways along an undirected orientation field.
  - `clusterRegions(points: Vec3[], targetRegions: number): {region: number[], count: number}` -- deterministic grid-bucket clustering with compact first-seen ids.

- [ ] **Step 1: Write the failing tests**

Append to `tests/face-lines.test.mjs` (extend the import at the top of the file to include the four new names):

```js
import {
  lambert,
  dotBrightness,
  rampColor,
  normalFromGradient,
  resamplePolyline,
  shellPoint,
  traceFlowStrand,
  clusterRegions,
} from "../lib/face-lines.mjs";
```

and add:

```js
test("resamplePolyline spaces points evenly along a straight line", () => {
  const dense = Array.from({ length: 101 }, (_, i) => [i / 100, 0, 0]);
  const out = resamplePolyline(dense, 0.25);
  assert.equal(out.length, 5);
  out.forEach(([x], i) => assert.ok(close(x, i * 0.25, 1e-6), `point ${i} at ${x}`));
});

test("resamplePolyline measures arc length in 3D, not just x", () => {
  // A 3-4-5 diagonal: length 0.5 per step in x means arc steps of 0.5*5/3.
  const dense = Array.from({ length: 61 }, (_, i) => [i / 100, (i / 100) * (4 / 3), 0]);
  const out = resamplePolyline(dense, 0.5);
  assert.equal(out.length, 3);
  assert.ok(close(out[1][0], 0.3, 1e-6));
  assert.ok(close(out[1][1], 0.4, 1e-6));
});

test("resamplePolyline handles empty and single-point input", () => {
  assert.deepEqual(resamplePolyline([], 0.1), []);
  assert.deepEqual(resamplePolyline([[1, 2, 3]], 0.1), [[1, 2, 3]]);
});

test("shellPoint puts phi=0 on the right edge with an outward +x normal", () => {
  const row = { y: 0.2, cx: 0.1, a: 0.5, zEdge: -0.1 };
  const { point, normal } = shellPoint(row, 0, 1);
  assert.ok(close(point[0], 0.6) && close(point[1], 0.2) && close(point[2], -0.1));
  assert.ok(close(normal[0], 1) && close(normal[1], 0) && close(normal[2], 0));
});

test("shellPoint puts phi=PI/2 directly behind with a -z normal", () => {
  const row = { y: 0, cx: 0, a: 0.5, zEdge: -0.1 };
  const { point, normal } = shellPoint(row, Math.PI / 2, 0.8);
  assert.ok(close(point[0], 0));
  assert.ok(close(point[2], -0.1 - 0.5 * 0.8));
  assert.ok(close(normal[0], 0, 1e-9) && close(normal[2], -1));
});

test("shellPoint normals are unit length across the sweep", () => {
  const row = { y: 0, cx: 0.05, a: 0.4, zEdge: 0 };
  for (let k = 0; k <= 8; k++) {
    const { normal } = shellPoint(row, (k / 8) * Math.PI, 1.2);
    assert.ok(close(Math.hypot(...normal), 1, 1e-9));
  }
});

test("traceFlowStrand follows a uniform field both ways from the seed", () => {
  const field = () => [1, 0];
  const pts = traceFlowStrand([5, 0], field, {
    step: 1,
    maxSteps: 3,
    inside: ([x]) => x >= 0 && x <= 10,
  });
  // 3 back, seed, 3 forward; ordered by x.
  assert.equal(pts.length, 7);
  assert.deepEqual(pts.map(([x]) => x), [2, 3, 4, 5, 6, 7, 8]);
});

test("traceFlowStrand stops at the mask boundary", () => {
  const pts = traceFlowStrand([1, 0], () => [1, 0], {
    step: 1,
    maxSteps: 50,
    inside: ([x]) => x >= 0 && x <= 3,
  });
  assert.ok(pts.every(([x]) => x >= 0 && x <= 3));
  assert.ok(pts.length <= 4);
});

test("traceFlowStrand keeps direction continuity when the field flips sign", () => {
  // An undirected field that reports [-1, 0] on the right half must not
  // bounce the trace back on itself.
  const field = ([x]) => (x >= 5 ? [-1, 0] : [1, 0]);
  const pts = traceFlowStrand([4.5, 0], field, {
    step: 1,
    maxSteps: 4,
    inside: () => true,
  });
  const xs = pts.map(([x]) => x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `xs not monotonic: ${xs}`);
});

test("clusterRegions gives compact deterministic ids and roughly the target count", () => {
  const points = [];
  for (let x = 0; x < 10; x++)
    for (let y = 0; y < 10; y++) points.push([x / 10, y / 10, 0]);
  const a = clusterRegions(points, 25);
  const b = clusterRegions(points, 25);
  assert.deepEqual(a.region, b.region);
  assert.equal(a.region.length, 100);
  const ids = new Set(a.region);
  assert.equal(ids.size, a.count);
  for (let i = 0; i < a.count; i++) assert.ok(ids.has(i), `id ${i} missing`);
  assert.ok(a.count >= 9 && a.count <= 60, `count ${a.count} far from target 25`);
});

test("clusterRegions puts identical points in one region", () => {
  const { region, count } = clusterRegions([[1, 1, 1], [1, 1, 1], [1, 1, 1]], 10);
  assert.deepEqual(region, [0, 0, 0]);
  assert.equal(count, 1);
});
```

Note: `traceFlowStrand`'s `inside` callback receives the candidate point as a `[x, y]` pair.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `resamplePolyline is not a function` (or equivalent missing-export errors).

- [ ] **Step 3: Write the implementation**

Append to `lib/face-lines.mjs`:

```js
/**
 * Resample a dense polyline to points spaced evenly by 3D arc length.
 * Keeps the first point; later points land exactly `spacing` apart along the
 * line, which is what makes rows read as deliberate strands, not pixel noise.
 * @param {Vec3[]} points @param {number} spacing @returns {Vec3[]}
 */
export function resamplePolyline(points, spacing) {
  if (points.length === 0) return [];
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    let [px, py, pz] = points[i - 1];
    const [qx, qy, qz] = points[i];
    let seg = Math.hypot(qx - px, qy - py, qz - pz);
    while (carry + seg >= spacing) {
      const t = (spacing - carry) / seg;
      px += (qx - px) * t;
      py += (qy - py) * t;
      pz += (qz - pz) * t;
      out.push([px, py, pz]);
      seg = Math.hypot(qx - px, qy - py, qz - pz);
      carry = 0;
    }
    carry += seg;
  }
  return out;
}

/**
 * One dot on the procedural back shell: a half-ellipse behind the row's
 * silhouette (half-width `a`, half-depth `a * depthFactor`), joining the front
 * at the silhouette edges (z = zEdge). phi 0..PI sweeps right edge to left.
 * Normal is the outward ellipse gradient, flat in y; good enough for shading.
 * @param {{y: number, cx: number, a: number, zEdge: number}} row
 * @param {number} phi @param {number} depthFactor
 * @returns {{point: Vec3, normal: Vec3}}
 */
export function shellPoint(row, phi, depthFactor) {
  const b = row.a * depthFactor;
  const x = row.cx + row.a * Math.cos(phi);
  const z = row.zEdge - b * Math.sin(phi);
  let nx = (x - row.cx) / (row.a * row.a);
  let nz = (z - row.zEdge) / (b * b);
  const len = Math.hypot(nx, nz) || 1;
  return { point: [x, row.y, z], normal: [nx / len, 0, nz / len] };
}

/**
 * Trace a 2D strand through an undirected orientation field, both directions
 * from the seed. Sign continuity: each step keeps the field vector on the
 * same side as the previous step so an undirected field cannot bounce the
 * trace back on itself. Returned points are ordered tail..seed..head.
 * @param {[number, number]} seed
 * @param {(x: number, y: number) => [number, number]} field
 * @param {{step: number, maxSteps: number, inside: (p: [number, number]) => boolean}} opts
 * @returns {Array<[number, number]>}
 */
export function traceFlowStrand(seed, field, { step, maxSteps, inside }) {
  const half = (sign) => {
    const pts = [];
    let [x, y] = seed;
    let prev = null;
    for (let i = 0; i < maxSteps; i++) {
      let [dx, dy] = field(x, y);
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) break;
      dx /= len;
      dy /= len;
      if (prev && dx * prev[0] + dy * prev[1] < 0) {
        dx = -dx;
        dy = -dy;
      }
      x += dx * step * sign;
      y += dy * step * sign;
      if (!inside([x, y])) break;
      pts.push([x, y]);
      prev = [dx * sign, dy * sign];
    }
    return pts;
  };
  return [...half(-1).reverse(), [...seed], ...half(1)];
}

/**
 * Grid-bucket clustering: cube cells sized so non-empty cells land near
 * `targetRegions`; ids are compacted in first-seen order, so the result is
 * deterministic for a given point order. Determinism matters because region
 * ids feed the seeded reveal shuffle.
 * @param {Vec3[]} points @param {number} targetRegions
 * @returns {{region: number[], count: number}}
 */
export function clusterRegions(points, targetRegions) {
  if (points.length === 0) return { region: [], count: 0 };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const eps = 1e-6;
  const dx = Math.max(eps, maxX - minX);
  const dy = Math.max(eps, maxY - minY);
  const dz = Math.max(eps, maxZ - minZ);
  const cell = Math.cbrt((dx * dy * dz) / Math.max(1, targetRegions));
  const ids = new Map();
  const region = points.map(([x, y, z]) => {
    const key =
      Math.floor((x - minX) / cell) +
      ":" +
      Math.floor((y - minY) / cell) +
      ":" +
      Math.floor((z - minZ) / cell);
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  });
  return { region, count: ids.size };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/face-lines.mjs tests/face-lines.test.mjs
git commit -m "feat(face): add contour, shell, strand, and region geometry math"
```

---

### Task 3: Reveal logic in `lib/face-lines-reveal.ts`

**Files:**
- Create: `lib/face-lines-reveal.ts`
- Test: `tests/face-lines-reveal.test.mjs`

**Interfaces:**
- Consumes: `seededShuffle` from `lib/face-reveal.ts` (existing, DRY).
- Produces (used by Task 7):
  - `REGION_SEED = 20260710`
  - `regionRevealOrder(regionCount: number): number[]` -- the fixed shuffled region order.
  - `litRegionIds(order: readonly number[], nodeCount: number): Set<number>` -- regions owned by the first `nodeCount` sorted nodes, clamped.
  - `nodeIndexForRegion(order: readonly number[], regionId: number, nodeCount: number): number | null` -- inverse mapping for click handling.

- [ ] **Step 1: Write the failing tests**

Create `tests/face-lines-reveal.test.mjs`:

```js
// Node strips TypeScript types at import time, so the .ts module loads directly.
import test from "node:test";
import assert from "node:assert/strict";
import {
  REGION_SEED,
  regionRevealOrder,
  litRegionIds,
  nodeIndexForRegion,
} from "../lib/face-lines-reveal.ts";

test("region seed is distinct from the v2 seeds", () => {
  assert.equal(REGION_SEED, 20260710);
  assert.notEqual(REGION_SEED, 20260708);
  assert.notEqual(REGION_SEED, 20260709);
});

test("regionRevealOrder is a deterministic permutation", () => {
  const a = regionRevealOrder(300);
  const b = regionRevealOrder(300);
  assert.deepEqual(a, b);
  assert.deepEqual(
    [...a].sort((x, y) => x - y),
    Array.from({ length: 300 }, (_, i) => i),
  );
});

test("litRegionIds grows as a stable prefix when nodes are appended", () => {
  const order = regionRevealOrder(50);
  const five = litRegionIds(order, 5);
  const eight = litRegionIds(order, 8);
  assert.equal(five.size, 5);
  assert.equal(eight.size, 8);
  for (const id of five) assert.ok(eight.has(id), `region ${id} unlit after append`);
});

test("litRegionIds clamps when nodes exceed regions", () => {
  const order = regionRevealOrder(10);
  assert.equal(litRegionIds(order, 99).size, 10);
});

test("nodeIndexForRegion inverts the mapping and rejects unlit regions", () => {
  const order = regionRevealOrder(20);
  // Node 3 owns region order[3].
  assert.equal(nodeIndexForRegion(order, order[3], 5), 3);
  // That region is not lit with only 3 nodes.
  assert.equal(nodeIndexForRegion(order, order[3], 3), null);
  assert.equal(nodeIndexForRegion(order, 9999, 5), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find `lib/face-lines-reveal.ts`.

- [ ] **Step 3: Write the implementation**

Create `lib/face-lines-reveal.ts`:

```ts
// Region reveal logic for the v3 face-lines head, shared by FaceLinesView and
// the node --test suite. Erasable-syntax TypeScript, like face-reveal.ts.

import { seededShuffle } from "./face-reveal";

// Distinct from the v2 seeds (asset 20260708, point reveal 20260709): this one
// shuffles which regions light up, so early nodes always claim the same
// patches of the head.
export const REGION_SEED = 20260710;

export function regionRevealOrder(regionCount: number): number[] {
  return seededShuffle(regionCount, REGION_SEED);
}

// Node i (in sortNodesForReveal order) owns region order[i]; clamped so nodes
// beyond the region count simply own no region yet.
export function litRegionIds(order: readonly number[], nodeCount: number): Set<number> {
  return new Set(order.slice(0, Math.min(nodeCount, order.length)));
}

// Inverse for click handling: which sorted-node index owns this region, if it
// is lit at the current node count.
export function nodeIndexForRegion(
  order: readonly number[],
  regionId: number,
  nodeCount: number,
): number | null {
  const index = order.indexOf(regionId);
  return index >= 0 && index < nodeCount ? index : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` -- expected: no errors.

```bash
git add lib/face-lines-reveal.ts tests/face-lines-reveal.test.mjs
git commit -m "feat(face): add region reveal mapping for the face-lines head"
```

---

### Task 4: Depth bake script `tools/depth-bake.py`

**Files:**
- Create: `tools/depth-bake.py`
- Modify: `.gitignore` (append)

**Interfaces:**
- Consumes: a portrait image path (Tony supplies it; it is the same portrait used for the v2 asset).
- Produces: `<portrait>.depth.png` next to the input, same pixel dimensions, grayscale, brighter = closer. Task 5's studio consumes it.

No unit tests: the script is a thin wrapper around a pinned model pipeline; the verification is running it and eyeballing the depth PNG. This matches the repo's light-by-design testing philosophy.

- [ ] **Step 1: Write the script**

Create `tools/depth-bake.py`:

```python
#!/usr/bin/env python3
"""One-time depth bake for the face-lines v3 asset.

Usage:
    python3 -m venv tools/.depth-venv
    tools/.depth-venv/bin/pip install transformers torch pillow
    tools/.depth-venv/bin/python tools/depth-bake.py /path/to/portrait.png

Writes /path/to/portrait.depth.png (same dimensions, brighter = closer).
The portrait and the depth PNG are dev-only inputs and are never committed;
only the studio-exported brain-face-v3.json ships.
"""

import sys
from pathlib import Path

from PIL import Image
from transformers import pipeline

MODEL = "depth-anything/Depth-Anything-V2-Small-hf"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    if not src.is_file():
        sys.exit(f"no such file: {src}")

    image = Image.open(src).convert("RGB")
    print(f"estimating depth for {src.name} ({image.width}x{image.height}) ...")
    depth = pipeline("depth-estimation", model=MODEL)(image)["depth"]
    # The pipeline may return a slightly different resolution; the studio
    # requires portrait and depth to match exactly.
    depth = depth.resize(image.size, Image.BILINEAR)

    out = src.with_suffix(".depth.png")
    depth.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Ignore the venv and local images**

Append to `.gitignore`:

```
# face-lines depth bake (dev-only inputs, never committed)
/tools/.depth-venv/
/tools/*.png
```

- [ ] **Step 3: Set up the venv and install dependencies**

```bash
cd /Users/minhthiennguyen/Desktop/fuzzy-brain
python3 -m venv tools/.depth-venv
tools/.depth-venv/bin/pip install --quiet transformers torch pillow
```

Expected: installs cleanly (torch is large, several hundred MB; first model run also downloads ~100 MB of weights to the Hugging Face cache).

- [ ] **Step 4: CHECKPOINT -- get the portrait from Tony**

Ask Tony for the portrait path (the same photo the v2 asset was generated from; last seen as the source of `~/Downloads/tony-face-anamorphosis.json`). Do not proceed on a guessed file. If the portrait is not a PNG, any format Pillow reads is fine.

- [ ] **Step 5: Run the bake and verify**

```bash
tools/.depth-venv/bin/python tools/depth-bake.py <portrait-path>
open <portrait-path minus extension>.depth.png
```

Expected: a grayscale image the same size as the portrait where the nose and forehead are brightest and the background is near black. If the background is brightest instead, the model output is inverted for this image; note it, the studio has an "invert depth" checkbox for exactly this.

- [ ] **Step 6: Commit**

```bash
git add tools/depth-bake.py .gitignore
git commit -m "feat(tools): add one-time depth bake script for the v3 portrait"
```

---

### Task 5: Studio tool `tools/face-lines.html`

**Files:**
- Create: `tools/face-lines.html`

**Interfaces:**
- Consumes: `resamplePolyline`, `shellPoint`, `traceFlowStrand`, `clusterRegions`, `lambert`, `dotBrightness`, `rampColor`, `normalFromGradient` from `../lib/face-lines.mjs` (Tasks 1-2); the portrait and depth PNG from Task 4.
- Produces: exported `brain-face-v3.json` with shape `{ settings: { mode, pointSize, regionCount, light, ambient, ramp, ghostFactor }, positions: number[], normals: number[], albedo: number[], region: number[], strand: number[] }`. Task 7 consumes this shape.

Because the page imports a local module, it cannot be opened via `file://` in Chrome; serve the repo root instead (one command, no install): `python3 -m http.server 8123` then open `http://localhost:8123/tools/face-lines.html`.

No unit tests for the page itself: all math it leans on is already covered in Tasks 1-2, and the page is a dev-only tuning surface whose test is Tony's eyes (Task 6). Verification here is functional: it builds a cloud and exports valid JSON.

- [ ] **Step 1: Write the studio page**

Create `tools/face-lines.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Face Lines Studio (v3)</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; display: flex; height: 100vh; background: #000; color: #cfd8e6;
         font: 12px/1.5 -apple-system, "Segoe UI", sans-serif; }
  #ui { width: 280px; padding: 14px; overflow-y: auto; background: #0a0d14;
        border-right: 1px solid #1d2430; flex-shrink: 0; box-sizing: border-box; }
  #ui h1 { font-size: 13px; letter-spacing: 2px; margin: 0 0 12px; }
  #ui label { display: block; margin-top: 10px; opacity: 0.85; }
  #ui input[type=range] { width: 100%; }
  #ui input[type=color] { width: 100%; height: 24px; border: none; background: none; padding: 0; }
  #ui .val { float: right; opacity: 0.6; }
  #ui button { margin-top: 12px; width: 100%; padding: 7px; background: #16202f;
               color: #cfd8e6; border: 1px solid #2c3a50; border-radius: 5px; cursor: pointer; }
  #stats { display: block; margin-top: 10px; opacity: 0.6; white-space: pre-line; }
  #view { flex: 1; display: block; }
</style>
<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.166.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.166.0/examples/jsm/"
} }
</script>
</head>
<body>
<div id="ui">
  <h1>FACE LINES STUDIO</h1>
  <label>portrait <input id="portrait" type="file" accept="image/*"></label>
  <label>depth map <input id="depth" type="file" accept="image/*"></label>
  <label><input id="invertDepth" type="checkbox"> invert depth</label>

  <label>row spacing px <span class="val" id="rowSpacing-v"></span>
    <input id="rowSpacing" type="range" min="4" max="30" step="1" value="9"></label>
  <label>dot spacing px <span class="val" id="dotSpacing-v"></span>
    <input id="dotSpacing" type="range" min="2" max="20" step="1" value="6"></label>
  <label>depth scale <span class="val" id="depthScale-v"></span>
    <input id="depthScale" type="range" min="0.1" max="2" step="0.05" value="0.9"></label>
  <label>back depth <span class="val" id="depthFactor-v"></span>
    <input id="depthFactor" type="range" min="0.4" max="1.6" step="0.05" value="1"></label>
  <label>hair threshold <span class="val" id="hairThreshold-v"></span>
    <input id="hairThreshold" type="range" min="20" max="160" step="1" value="80"></label>
  <label>albedo gamma <span class="val" id="gamma-v"></span>
    <input id="gamma" type="range" min="0.4" max="2" step="0.05" value="1"></label>
  <label>regions <span class="val" id="regionCount-v"></span>
    <input id="regionCount" type="range" min="50" max="800" step="10" value="300"></label>

  <label>light azimuth <span class="val" id="lightAz-v"></span>
    <input id="lightAz" type="range" min="-90" max="90" step="1" value="-30"></label>
  <label>light elevation <span class="val" id="lightEl-v"></span>
    <input id="lightEl" type="range" min="-60" max="80" step="1" value="25"></label>
  <label>ambient <span class="val" id="ambient-v"></span>
    <input id="ambient" type="range" min="0" max="0.6" step="0.02" value="0.22"></label>
  <label>point size <span class="val" id="pointSize-v"></span>
    <input id="pointSize" type="range" min="0.002" max="0.03" step="0.001" value="0.011"></label>
  <label>ghost factor <span class="val" id="ghostFactor-v"></span>
    <input id="ghostFactor" type="range" min="0.02" max="0.4" step="0.01" value="0.12"></label>
  <label>ramp low <input id="rampLo" type="color" value="#1a0d06"></label>
  <label>ramp mid <input id="rampMid" type="color" value="#b5713a"></label>
  <label>ramp high <input id="rampHi" type="color" value="#ffe8c2"></label>

  <button id="rebuild">rebuild</button>
  <button id="export">export brain-face-v3.json</button>
  <span id="stats">load a portrait and its depth map</span>
</div>
<canvas id="view"></canvas>

<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  lambert, dotBrightness, rampColor, normalFromGradient,
  resamplePolyline, shellPoint, traceFlowStrand, clusterRegions,
} from '../lib/face-lines.mjs';

// Processing at full portrait resolution is wasteful; dots are sampled every
// few pixels anyway, so cap the working width.
const MAX_WIDTH = 900;

const state = { img: null, dep: null, built: null, colors: null };

// ---------- ui plumbing ----------

const GEOMETRY_IDS = ['rowSpacing', 'dotSpacing', 'depthScale', 'depthFactor',
                      'hairThreshold', 'gamma', 'regionCount'];
const LIGHT_IDS = ['lightAz', 'lightEl', 'ambient'];
const el = (id) => document.getElementById(id);

function sliderVals() {
  const v = {};
  for (const id of [...GEOMETRY_IDS, ...LIGHT_IDS, 'pointSize', 'ghostFactor']) {
    v[id] = Number(el(id).value);
  }
  v.invertDepth = el('invertDepth').checked;
  for (const id of ['rampLo', 'rampMid', 'rampHi']) v[id] = el(id).value;
  return v;
}

function showVals() {
  for (const id of [...GEOMETRY_IDS, ...LIGHT_IDS, 'pointSize', 'ghostFactor']) {
    const label = el(id + '-v');
    if (label) label.textContent = el(id).value;
  }
}

function hex2rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function lightVec(S) {
  const az = (S.lightAz * Math.PI) / 180;
  const elv = (S.lightEl * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(elv), Math.sin(elv), Math.cos(az) * Math.cos(elv)];
}

function rampStops(S) {
  return [hex2rgb(S.rampLo), hex2rgb(S.rampMid), hex2rgb(S.rampHi)];
}

// ---------- image loading ----------

async function loadImageData(file, targetW, targetH) {
  const bmp = await createImageBitmap(file);
  const scale = targetW ? targetW / bmp.width : Math.min(1, MAX_WIDTH / bmp.width);
  const w = targetW ?? Math.round(bmp.width * scale);
  const h = targetH ?? Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

el('portrait').addEventListener('change', async (e) => {
  state.img = await loadImageData(e.target.files[0]);
  state.dep = null; // depth must be re-read at the portrait's working size
  el('stats').textContent = 'portrait loaded; (re)load the depth map';
});

el('depth').addEventListener('change', async (e) => {
  if (!state.img) { el('stats').textContent = 'load the portrait first'; return; }
  state.dep = await loadImageData(e.target.files[0], state.img.width, state.img.height);
  build();
});

// ---------- build pipeline ----------

// Two-pass box blur; enough smoothing for a stable hair orientation field.
function boxBlur(src, W, H, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / span;
      const add = Math.min(W - 1, x + radius + 1);
      const sub = Math.max(0, x - radius);
      acc += src[y * W + add] - src[y * W + sub];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / span;
      const add = Math.min(H - 1, y + radius + 1);
      const sub = Math.max(0, y - radius);
      acc += tmp[add * W + x] - tmp[sub * W + x];
    }
  }
  return out;
}

function build() {
  if (!state.img || !state.dep) return;
  const S = sliderVals();
  const { width: W, height: H } = state.img;
  const P = state.img.data;
  const D = state.dep.data;
  const N = W * H;

  const lum = new Float32Array(N);
  const dep = new Float32Array(N);
  const mask = new Uint8Array(N);
  const hair = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = P[i * 4], g = P[i * 4 + 1], b = P[i * 4 + 2], a = P[i * 4 + 3];
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let d = (0.2126 * D[i * 4] + 0.7152 * D[i * 4 + 1] + 0.0722 * D[i * 4 + 2]) / 255;
    if (S.invertDepth) d = 1 - d;
    dep[i] = d;
    // Same background convention as the v1 tool: transparent or near-white.
    mask[i] = a < 128 || (r > 243 && g > 243 && b > 243) ? 0 : 1;
    hair[i] = mask[i] && lum[i] < S.hairThreshold ? 1 : 0;
  }

  // Center the head near z=0 so orbiting pivots through it.
  let sum = 0, cnt = 0;
  for (let i = 0; i < N; i++) if (mask[i]) { sum += dep[i]; cnt++; }
  const depthMid = cnt ? sum / cnt : 0.5;

  // World mapping matches v2: head height 1.6 world units, y up, z to viewer.
  const unit = 1.6 / H; // world units per pixel, both axes
  const wx = (x) => (x / W - 0.5) * 1.6 * (W / H);
  const wy = (y) => -(y / H - 0.5) * 1.6;
  const clampPix = (v, max) => Math.min(max - 1, Math.max(0, Math.round(v)));
  const zAt = (x, y) =>
    (dep[clampPix(y, H) * W + clampPix(x, W)] - depthMid) * S.depthScale;
  const albAt = (x, y) =>
    Math.pow(lum[clampPix(y, H) * W + clampPix(x, W)] / 255, S.gamma);
  const normalAt = (x, y) => {
    const xi = Math.min(W - 2, Math.max(1, Math.round(x)));
    const yi = Math.min(H - 2, Math.max(1, Math.round(y)));
    const dzdx = ((dep[yi * W + xi + 1] - dep[yi * W + xi - 1]) * S.depthScale) / (2 * unit);
    // Image y grows down, world y grows up.
    const dzdy = (-(dep[(yi + 1) * W + xi] - dep[(yi - 1) * W + xi]) * S.depthScale) / (2 * unit);
    return normalFromGradient(dzdx, dzdy);
  };

  const out = { pos: [], nrm: [], alb: [], strand: [] };
  let strandId = 0;
  const pushDot = (p, n, a, s) => {
    out.pos.push(p[0], p[1], p[2]);
    out.nrm.push(n[0], n[1], n[2]);
    out.alb.push(a);
    out.strand.push(s);
  };
  const spacingWorld = S.dotSpacing * unit;
  const pixOfWx = (x) => (x / (1.6 * (W / H)) + 0.5) * W;
  const pixOfWy = (y) => (0.5 - y / 1.6) * H;

  // Skin: horizontal contour rows across the depth relief.
  for (let y = Math.floor(S.rowSpacing / 2); y < H; y += S.rowSpacing) {
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        for (const p of resamplePolyline(run, spacingWorld)) {
          const px = pixOfWx(p[0]);
          const py = pixOfWy(p[1]);
          pushDot(p, normalAt(px, py), albAt(px, py), strandId);
        }
        strandId++;
      }
      run = [];
    };
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] && !hair[i]) run.push([wx(x), wy(y), zAt(x, y)]);
      else flush();
    }
    flush();
  }

  // Hair: strands along the orientation field (perpendicular to the blurred
  // luminance gradient), which is what makes hair read as combed strands.
  const blurred = boxBlur(lum, W, H, 4);
  const fieldAt = (x, y) => {
    const xi = Math.min(W - 2, Math.max(1, Math.round(x)));
    const yi = Math.min(H - 2, Math.max(1, Math.round(y)));
    const gx = blurred[yi * W + xi + 1] - blurred[yi * W + xi - 1];
    const gy = blurred[(yi + 1) * W + xi] - blurred[(yi - 1) * W + xi];
    return [-gy, gx];
  };
  const cell = Math.max(2, S.dotSpacing);
  const cw = Math.ceil(W / cell);
  const visited = new Uint8Array(cw * Math.ceil(H / cell));
  const cellIdx = (x, y) => Math.floor(y / cell) * cw + Math.floor(x / cell);
  const inHair = (x, y) =>
    x >= 0 && y >= 0 && x < W && y < H && hair[Math.round(y) * W + Math.round(x)] === 1;
  for (let sy = 0; sy < H; sy += S.rowSpacing) {
    for (let sx = 0; sx < W; sx += S.rowSpacing) {
      if (!inHair(sx, sy) || visited[cellIdx(sx, sy)]) continue;
      const strand = traceFlowStrand([sx, sy], fieldAt, {
        step: S.dotSpacing,
        maxSteps: 300,
        inside: ([x, y]) => inHair(x, y) && !visited[cellIdx(x, y)],
      });
      if (strand.length < 3) continue;
      for (const [x, y] of strand) {
        visited[cellIdx(x, y)] = 1;
        pushDot([wx(x), wy(y), zAt(x, y)], normalAt(x, y), albAt(x, y), strandId);
      }
      strandId++;
    }
  }

  // Back shell: per-row silhouette profile, then vertical strands that
  // converge at the crown (the reference's back views are mostly this).
  const rows = [];
  for (let y = Math.floor(S.rowSpacing / 2); y < H; y += S.rowSpacing) {
    let xl = -1, xr = -1;
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) { if (xl < 0) xl = x; xr = x; }
    }
    if (xl < 0 || xr - xl < 4) continue;
    rows.push({
      y: wy(y),
      cx: (wx(xl) + wx(xr)) / 2,
      a: (wx(xr) - wx(xl)) / 2,
      zEdge: Math.min(zAt(xl, y), zAt(xr, y)),
    });
  }
  let hSum = 0, hCnt = 0;
  for (let i = 0; i < N; i++) {
    if (hair[i]) { hSum += Math.pow(lum[i] / 255, S.gamma); hCnt++; }
  }
  const hairAlb = hCnt ? hSum / hCnt : 0.3;
  const aMax = rows.reduce((m, r) => Math.max(m, r.a), 0.001);
  const strandCount = Math.max(3, Math.round((Math.PI * aMax) / spacingWorld));
  // Deterministic per-dot flicker so the inferred back has hair-like texture.
  const hash01 = (i) => {
    const s = Math.sin(i * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let k = 0; k < strandCount; k++) {
    const phi = ((k + 0.5) / strandCount) * Math.PI;
    let emitted = false;
    for (const row of rows) {
      // Thin converging strands near the crown so dots keep their pitch.
      const wanted = Math.max(1, Math.floor((Math.PI * row.a) / spacingWorld));
      const keepEvery = Math.max(1, Math.round(strandCount / wanted));
      if (k % keepEvery !== 0) continue;
      const { point, normal } = shellPoint(row, phi, S.depthFactor);
      pushDot(point, normal, hairAlb * (0.75 + 0.5 * hash01(out.alb.length)), strandId);
      emitted = true;
    }
    if (emitted) strandId++;
  }

  // Regions for the node-lights-a-region reveal.
  const pts3 = [];
  for (let i = 0; i < out.pos.length; i += 3) {
    pts3.push([out.pos[i], out.pos[i + 1], out.pos[i + 2]]);
  }
  const { region, count } = clusterRegions(pts3, S.regionCount);
  state.built = { ...out, region, regionCount: count };
  el('stats').textContent =
    `${pts3.length} dots / ${strandId} strands / ${count} regions`;
  recolor();
  updateCloud();
}

// ---------- shading ----------

function recolor() {
  const b = state.built;
  if (!b) return;
  const S = sliderVals();
  const L = lightVec(S);
  const stops = rampStops(S);
  const colors = new Float32Array(b.alb.length * 3);
  for (let i = 0; i < b.alb.length; i++) {
    const n = [b.nrm[i * 3], b.nrm[i * 3 + 1], b.nrm[i * 3 + 2]];
    const t = dotBrightness(lambert(n, L), b.alb[i], S.ambient);
    const [r, g, bl] = rampColor(t, stops);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = bl;
  }
  state.colors = colors;
}

// ---------- three preview ----------

const renderer = new THREE.WebGLRenderer({ canvas: el('view'), antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
camera.position.set(0, 0, 4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function makeSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}
const sprite = makeSprite();

let cloud = null;
function updateCloud() {
  const b = state.built;
  if (!b || !state.colors) return;
  if (cloud) {
    scene.remove(cloud);
    cloud.geometry.dispose();
    cloud.material.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(state.colors, 3));
  const material = new THREE.PointsMaterial({
    size: sliderVals().pointSize,
    sizeAttenuation: true,
    map: sprite,
    vertexColors: true,
    transparent: true,
    alphaTest: 0.05,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  cloud = new THREE.Points(geometry, material);
  scene.add(cloud);
}

function resize() {
  const rect = el('view').getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------- slider wiring ----------

// Geometry sliders rebuild on release (expensive); light sliders recolor live.
for (const id of GEOMETRY_IDS) {
  el(id).addEventListener('input', showVals);
  el(id).addEventListener('change', build);
}
el('invertDepth').addEventListener('change', build);
for (const id of LIGHT_IDS) {
  el(id).addEventListener('input', () => {
    showVals();
    recolor();
    if (cloud && state.colors) {
      cloud.geometry.setAttribute('color', new THREE.BufferAttribute(state.colors, 3));
    }
  });
}
for (const id of ['rampLo', 'rampMid', 'rampHi']) {
  el(id).addEventListener('input', () => {
    recolor();
    if (cloud && state.colors) {
      cloud.geometry.setAttribute('color', new THREE.BufferAttribute(state.colors, 3));
    }
  });
}
el('pointSize').addEventListener('input', () => {
  showVals();
  if (cloud) cloud.material.size = sliderVals().pointSize;
});
el('ghostFactor').addEventListener('input', showVals);
el('rebuild').addEventListener('click', build);
showVals();

// ---------- export ----------

el('export').addEventListener('click', () => {
  const b = state.built;
  if (!b) return;
  const S = sliderVals();
  const round3 = (arr) => Array.from(arr, (v) => Math.round(v * 1000) / 1000);
  const json = {
    settings: {
      mode: 'face-lines-v3',
      pointSize: S.pointSize,
      regionCount: b.regionCount,
      light: lightVec(S).map((v) => Math.round(v * 1000) / 1000),
      ambient: S.ambient,
      ramp: rampStops(S).map((c) => c.map((v) => Math.round(v * 1000) / 1000)),
      ghostFactor: S.ghostFactor,
    },
    positions: round3(b.pos),
    normals: round3(b.nrm),
    albedo: round3(b.alb),
    region: Array.from(b.region),
    strand: Array.from(b.strand),
  };
  const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'brain-face-v3.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
</script>
</body>
</html>
```

- [ ] **Step 2: Functional verification**

```bash
cd /Users/minhthiennguyen/Desktop/fuzzy-brain
python3 -m http.server 8123
```

Open `http://localhost:8123/tools/face-lines.html`, load the portrait and its depth PNG, and verify:
- A dot head appears within a couple of seconds; the stats line reports dots, strands, and regions.
- Orbiting shows a closed head (front relief plus back shell), not a flat relief.
- The light sliders re-shade live without a rebuild; geometry sliders rebuild on release.
- "invert depth" flips the nose from sticking out to sinking in (use whichever is correct for the baked PNG).
- Export downloads `brain-face-v3.json`; spot-check in a scratch node session that `positions.length === 3 * albedo.length`, `region.length === albedo.length`, and `settings.regionCount > 0`.

- [ ] **Step 3: Commit**

```bash
git add tools/face-lines.html
git commit -m "feat(tools): add face lines studio for the v3 contour dot head"
```

---

### Task 6: HARD GATE -- Tony sign-off and asset ratification

This task is a checkpoint with a human in the loop. Do not start Task 7 until it completes.

- [ ] **Step 1: Live tuning session with Tony**

Tony drives the studio (or the agent drives while Tony watches) and tunes: row/dot spacing, depth scale, back depth, hair threshold, light, ramp colors, point size. The question to answer, per the spec's hollow-mask history: does the rotating head read as a solid head of Tony from front, three-quarter, profile, low, top, and rear views?

- [ ] **Step 2: Decision**

- If YES: Tony picks the final slider state and exports. Proceed.
- If NO after honest tuning effort: STOP. Record what failed (in a short note under `docs/superpowers/specs/`), do not build Tasks 7-8, and return to design. The plan ends here in that branch.

- [ ] **Step 3: Ratify the asset**

```bash
cp ~/Downloads/brain-face-v3.json tools/tony-face-lines.json
cp ~/Downloads/brain-face-v3.json public/brain-face-v3.json
git add tools/tony-face-lines.json public/brain-face-v3.json
git commit -m "feat(tools): ratify the face-lines v3 portrait asset"
```

(`tools/` copy is the archival ratified export, mirroring `tools/tony-face-anamorphosis.json`; `public/` copy is what the app fetches.)

---

### Task 7: `components/FaceLinesView.tsx`

**Files:**
- Create: `components/FaceLinesView.tsx`

**Interfaces:**
- Consumes: `lambert`, `dotBrightness`, `rampColor` from `lib/face-lines.mjs`; `regionRevealOrder`, `litRegionIds`, `nodeIndexForRegion` from `lib/face-lines-reveal.ts`; `sortNodesForReveal` from `lib/face-reveal.ts`; `usePrefersReducedMotion` from `lib/use-prefers-reduced-motion.ts`; `public/brain-face-v3.json` (Task 6 shape).
- Produces: default export `FaceLinesView({ nodes, selectedNode, loaded, onSelectNode }: { nodes: BrainNode[]; selectedNode: BrainNode | null; loaded: boolean; onSelectNode: (node: BrainNode | null) => void })` -- consumed by Task 8's BrainView. No `edges` prop: v3 has no connection strands (spec scope).

The pure logic is already tested (Tasks 1-3); this component is rendering glue, verified visually in Task 8. Follow FaceView.tsx's structure and conventions closely; differences are deliberate and listed in the file's comments.

- [ ] **Step 1: Write the component**

Create `components/FaceLinesView.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { dotBrightness, lambert, rampColor } from "@/lib/face-lines.mjs";
import {
  litRegionIds,
  nodeIndexForRegion,
  regionRevealOrder,
} from "@/lib/face-lines-reveal";
import { sortNodesForReveal } from "@/lib/face-reveal";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import type { BrainNode } from "@/components/types";

type Rgb = [number, number, number];
type LinesAsset = {
  settings: {
    pointSize: number;
    regionCount: number;
    light: Rgb;
    ambient: number;
    ramp: [Rgb, Rgb, Rgb];
    ghostFactor: number;
  };
  positions: number[];
  normals: number[];
  albedo: number[];
  region: number[];
};

// Unlike v2's orthographic face, this is a real 3D head: a perspective camera
// gives natural parallax, and sizeAttenuation handles dot scaling for free
// (the v2 per-frame zoom hack was orthographic-specific).
const FOV = 35;
const FRONT_POSITION: [number, number, number] = [0, 0, 4];
const SNAP_SECONDS = 0.8;
const DRIFT_SPEED = 0.3;
const FADE_SECONDS = 0.5;
const HALO_COLOR = 0xb9a6ff;

export default function FaceLinesView({
  nodes,
  selectedNode,
  loaded,
  onSelectNode,
}: {
  nodes: BrainNode[];
  selectedNode: BrainNode | null;
  loaded: boolean;
  onSelectNode: (node: BrainNode | null) => void;
}) {
  const [asset, setAsset] = useState<LinesAsset | null>(null);
  const [snapSignal, setSnapSignal] = useState(0);
  const [hovering, setHovering] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    let cancelled = false;
    fetch("/brain-face-v3.json")
      .then((res) => {
        if (!res.ok) throw new Error(`asset ${res.status}`);
        return res.json();
      })
      .then((data: LinesAsset) => {
        if (!cancelled) setAsset(data);
      })
      .catch(() => {
        // A missing asset leaves the other views fully usable; fail quiet.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sprite = useMemo(() => (asset ? makeSprite() : null), [asset]);

  // Shaded base color per dot, computed once per asset: the light is fixed in
  // world space (the ratified studio light), so colors never change per frame.
  const baseColors = useMemo(() => {
    if (!asset) return null;
    const { light, ambient, ramp } = asset.settings;
    const count = asset.albedo.length;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const normal: Rgb = [
        asset.normals[i * 3],
        asset.normals[i * 3 + 1],
        asset.normals[i * 3 + 2],
      ];
      const t = dotBrightness(lambert(normal, light), asset.albedo[i], ambient);
      const [r, g, b] = rampColor(t, ramp);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    return colors;
  }, [asset]);

  // Region centroids for the selection halo.
  const centroids = useMemo(() => {
    if (!asset) return null;
    const sums = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < asset.region.length; i++) {
      const id = asset.region[i];
      const entry = sums.get(id) ?? [0, 0, 0, 0];
      entry[0] += asset.positions[i * 3];
      entry[1] += asset.positions[i * 3 + 1];
      entry[2] += asset.positions[i * 3 + 2];
      entry[3] += 1;
      sums.set(id, entry);
    }
    const out = new Map<number, [number, number, number]>();
    for (const [id, [x, y, z, n]] of sums) out.set(id, [x / n, y / n, z / n]);
    return out;
  }, [asset]);

  const order = useMemo(
    () => (asset ? regionRevealOrder(asset.settings.regionCount) : []),
    [asset],
  );
  const sorted = useMemo(() => sortNodesForReveal(nodes), [nodes]);
  // Gate on `loaded` so the head never flashes lit-then-ghost mid-fetch.
  const litSet = useMemo(
    () => litRegionIds(order, loaded ? sorted.length : 0),
    [order, sorted.length, loaded],
  );

  // Partition dots into lit and ghost clouds by region membership. litRegions
  // maps a lit-cloud dot index back to its region id for click handling.
  const split = useMemo(() => {
    if (!asset || !baseColors) return null;
    const litIdx: number[] = [];
    const ghostIdx: number[] = [];
    for (let i = 0; i < asset.region.length; i++) {
      (litSet.has(asset.region[i]) ? litIdx : ghostIdx).push(i);
    }
    return {
      lit: gather(asset, baseColors, litIdx),
      ghost: gather(asset, baseColors, ghostIdx),
      litRegions: litIdx.map((i) => asset.region[i]),
    };
  }, [asset, baseColors, litSet]);

  const haloPosition = useMemo(() => {
    if (!asset || !centroids || !selectedNode) return null;
    const index = sorted.findIndex((n) => n.id === selectedNode.id);
    if (index < 0 || index >= order.length) return null;
    return centroids.get(order[index]) ?? null;
  }, [asset, centroids, selectedNode, sorted, order]);

  if (!asset || !sprite || !split) return <div style={styles.layer} />;

  const { pointSize, ghostFactor } = asset.settings;

  return (
    <div style={styles.layer}>
      <Canvas
        gl={{ alpha: true, antialias: true }}
        dpr={[1, 2]}
        style={{ position: "absolute", inset: 0, cursor: hovering ? "pointer" : "grab" }}
        onCreated={({ raycaster }) => {
          raycaster.params.Points.threshold = pointSize * 0.75;
        }}
        onPointerMissed={() => onSelectNode(null)}
      >
        <PerspectiveCamera makeDefault fov={FOV} near={0.01} far={100} position={FRONT_POSITION} />
        <OrbitControls
          makeDefault
          enableDamping={!reducedMotion}
          autoRotate={!reducedMotion}
          autoRotateSpeed={DRIFT_SPEED}
        />
        <CameraDirector snapSignal={snapSignal} reducedMotion={reducedMotion} />
        <DotCloud
          key={`lit-${split.lit.positions.length}`}
          positions={split.lit.positions}
          colors={split.lit.colors}
          size={pointSize}
          sprite={sprite}
          targetOpacity={1}
          onPick={(index) => {
            const regionId = split.litRegions[index];
            const nodeIndex = nodeIndexForRegion(order, regionId, sorted.length);
            if (nodeIndex != null && sorted[nodeIndex]) onSelectNode(sorted[nodeIndex]);
          }}
          onHoverChange={setHovering}
        />
        <DotCloud
          key={`ghost-${split.ghost.positions.length}`}
          positions={split.ghost.positions}
          colors={split.ghost.colors}
          size={pointSize}
          sprite={sprite}
          targetOpacity={ghostFactor}
        />
        {haloPosition && (
          <SelectedHalo
            position={haloPosition}
            size={pointSize * 3}
            sprite={sprite}
            reducedMotion={reducedMotion}
          />
        )}
      </Canvas>
      <div style={styles.frontWrap}>
        <button style={styles.frontButton} onClick={() => setSnapSignal((s) => s + 1)}>
          front
        </button>
      </div>
    </div>
  );
}

function gather(asset: LinesAsset, baseColors: Float32Array, indices: number[]) {
  const positions = new Float32Array(indices.length * 3);
  const colors = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const src = indices[i];
    positions[i * 3] = asset.positions[src * 3];
    positions[i * 3 + 1] = asset.positions[src * 3 + 1];
    positions[i * 3 + 2] = asset.positions[src * 3 + 2];
    colors[i * 3] = baseColors[src * 3];
    colors[i * 3 + 1] = baseColors[src * 3 + 1];
    colors[i * 3 + 2] = baseColors[src * 3 + 2];
  }
  return { positions, colors };
}

type ControlsLike = {
  target: THREE.Vector3;
  update: () => void;
  autoRotate: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

function easeInOutQuart(t: number): number {
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const FRONT_VEC = new THREE.Vector3(...FRONT_POSITION);
const ORIGIN = new THREE.Vector3(0, 0, 0);

// v2's snap logic minus the zoom handling: a perspective OrbitControls zoom is
// a dolly, so restoring position and target restores everything.
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
    const camera = state.camera;
    const controls = state.controls as unknown as ControlsLike | null;

    if (snapSignal !== lastSignal.current) {
      lastSignal.current = snapSignal;
      if (reducedMotion) {
        camera.position.copy(FRONT_VEC);
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
        fromTarget: controls ? controls.target.clone() : ORIGIN.clone(),
      };
    }

    const tw = tween.current;
    if (!tw) return;
    const progress = Math.min(1, (state.clock.elapsedTime - tw.start) / SNAP_SECONDS);
    const eased = easeInOutQuart(progress);
    camera.position.lerpVectors(tw.fromPos, FRONT_VEC, eased);
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

function DotCloud({
  positions,
  colors,
  size,
  sprite,
  targetOpacity,
  onPick,
  onHoverChange,
}: {
  positions: Float32Array;
  colors: Float32Array;
  size: number;
  sprite: THREE.Texture;
  targetOpacity: number;
  onPick?: (index: number) => void;
  onHoverChange?: (hovering: boolean) => void;
}) {
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const fadeStart = useRef<number | null>(null);
  const fadeDone = useRef(false);
  // Mount fade is opacity-only, so it survives prefers-reduced-motion.
  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (!material || fadeDone.current) return;
    if (fadeStart.current == null) fadeStart.current = clock.elapsedTime;
    const t = (clock.elapsedTime - fadeStart.current) / FADE_SECONDS;
    if (t >= 1) {
      material.opacity = targetOpacity;
      fadeDone.current = true;
    } else {
      material.opacity = targetOpacity * easeOutCubic(Math.max(0, t));
    }
  });

  return (
    <points
      onClick={
        onPick
          ? (event) => {
              event.stopPropagation();
              if (event.index == null) return;
              onPick(event.index);
            }
          : undefined
      }
      onPointerOver={onHoverChange ? () => onHoverChange(true) : undefined}
      onPointerOut={onHoverChange ? () => onHoverChange(false) : undefined}
    >
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        ref={materialRef}
        size={size}
        sizeAttenuation
        map={sprite}
        vertexColors
        transparent
        opacity={0}
        alphaTest={0.05}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// Same breathing halo as v2, sized in world units (sizeAttenuation handles
// screen scaling under the perspective camera).
function SelectedHalo({
  position,
  size,
  sprite,
  reducedMotion,
}: {
  position: [number, number, number];
  size: number;
  sprite: THREE.Texture;
  reducedMotion: boolean;
}) {
  const ref = useRef<THREE.Sprite>(null);
  useFrame(({ clock }) => {
    const halo = ref.current;
    if (!halo) return;
    const breath = reducedMotion ? 1 : 1 + 0.08 * Math.sin(clock.elapsedTime * 2.6);
    halo.scale.set(size * breath, size * breath, 1);
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
  frontWrap: {
    position: "absolute",
    zIndex: 2,
    bottom: 20,
    left: "50%",
    transform: "translateX(-50%)",
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
};
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (If tsc reports the `.mjs` import as untyped, the JSDoc in `lib/face-lines.mjs` was dropped or malformed; fix it there rather than adding `any` casts here.)

- [ ] **Step 3: Commit**

```bash
git add components/FaceLinesView.tsx
git commit -m "feat(face): add FaceLinesView renderer for the v3 contour dot head"
```

---

### Task 8: BrainView integration, changelog, and full verification

**Files:**
- Modify: `components/BrainView.tsx` (mode type at line 14, dynamic imports at lines 11-12, view branch at lines 70-88, toggle at line 96)
- Modify: `CHANGELOG.md`, `package.json`

**Interfaces:**
- Consumes: `FaceLinesView` default export from Task 7.
- Produces: the shipped three-mode BrainView.

- [ ] **Step 1: Add the third mode to BrainView**

In `components/BrainView.tsx`, add the dynamic import next to the existing two:

```tsx
const FaceLinesView = dynamic(() => import("@/components/FaceLinesView"), { ssr: false });
```

Change the mode type:

```tsx
type Mode = "face" | "lines" | "map";
```

Replace the two-way view branch with:

```tsx
      {mode === "face" ? (
        <FaceView
          nodes={nodes}
          edges={edges}
          selectedNode={selectedNode}
          loaded={loaded}
          onSelectNode={selectNode}
        />
      ) : mode === "lines" ? (
        <FaceLinesView
          nodes={nodes}
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
```

Update the toggle list:

```tsx
          {(["face", "lines", "map"] as const).map((m) => (
```

The default mode stays `"face"` (v2); per the spec, the default landing view is decided with Tony at visual sign-off, and changing it later is a one-word diff.

- [ ] **Step 2: Verify in the running app**

```bash
npm run dev
```

Open the app and verify:
- The `lines` toggle shows the bronze dot head; orbit works all the way around; `front` snaps back.
- Clicking a lit dot opens the node detail panel for its owning node; clicking empty space closes it.
- Adding a node lights a new region.
- The `face` and `map` modes still work exactly as before.
- With `public/brain-face-v3.json` temporarily renamed, the `lines` mode renders an empty layer and nothing crashes; rename it back.

- [ ] **Step 3: Full verification suite**

```bash
npm test && npx tsc --noEmit && npm run lint && npm run build
```

Expected: all pass.

- [ ] **Step 4: Changelog and version bump**

`CHANGELOG.md` gets a new top entry (categories from the repo's existing set: Face, Map, UI, Tools):

```markdown
## v0.3.0

<today's date, e.g. Jul 9, 2026>

**Face**

- Added the face-lines view: a fully rotatable 3D dot portrait in a drone-light-show style, built from a depth map of the real portrait, where each node lights up a patch of the head.

**Tools**

- Added a depth bake script (Depth Anything V2, local and one-time) and a face-lines studio for tuning contour rows, hair strands, the inferred back of the head, lighting, and the bronze ramp before exporting the asset.

---
```

Bump `package.json` version to `0.3.0`.

- [ ] **Step 5: Commit**

```bash
git add components/BrainView.tsx CHANGELOG.md package.json
git commit -m "feat(views): add the face-lines head as a third brain view"
```

---

## Self-Review Notes

- Spec coverage: depth bake (Task 4), studio with all spec'd sliders (Task 5), skin rows / hair strands / back shell / normals (Tasks 2, 5), asset format (Task 5 export), rendering with perspective camera and carried-over v2 lessons (Task 7), region reveal with distinct seed and clamping (Task 3, 7), three-way BrainView toggle with default decided at sign-off (Task 8), silent asset fallback (Task 7), reduced motion (Task 7), tests per the light-by-design philosophy (Tasks 1-3), out-of-scope items untouched (no v2/v3 transition animation, no strand animation, no mobile tuning).
- The hollow-mask gate from the spec is Task 6 and blocks Tasks 7-8 explicitly.
- Type/name consistency: `litRegionIds`/`nodeIndexForRegion`/`regionRevealOrder` (Tasks 3, 7), asset keys `positions/normals/albedo/region/strand` (Tasks 5, 7), `shellPoint` row shape `{y, cx, a, zEdge}` (Tasks 2, 5) all match across tasks.
- Known judgment calls an implementer should not "fix": the `strand` array is exported but unread by the app (spec: recorded for the future); the back shell light response will be dim under the fixed front key light (ambient floor keeps it readable; Tony judges at the gate); hair albedo on the back is deterministic hash noise, not photo data (there is no photo data back there).
