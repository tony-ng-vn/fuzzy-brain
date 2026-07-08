# Anamorphic face reveal: design

Date: 2026-07-08
Status: approved through live prototyping with Tony (8 spike iterations); ready for implementation planning.

## What it is

A new default view for the brain map: Tony's face as a 3D anamorphic point-cloud portrait that fills in, one point per thought, as the brain grows.
From any oblique angle the points read as a shapeless star field.
Viewed dead-on (front or back), the points align into Tony's actual face.
The current force-directed graph stays available as a second mode, one toggle away, for browsing connections and whys.

## How we got here (spike history, condensed)

We prototyped eight versions live before writing this spec, and the design changed materially along the way.
MediaPipe face landmarks alone (478 points, eyebrows to chin) did not read as Tony: no hair, no head shape.
Following the drone-show industry pipeline (uniform drone matrix + photo texture projection) fixed recognizability: the likeness lives in evenly spaced points showing the right colors, not in anatomical landmark positions.
Attempts at a true 3D head (depth relief plus a synthesized back-of-head shell) hit the hollow-mask illusion and never felt right.
Tony then described anamorphosis: keep x/y faithful to the photo, make z pure scatter, so the face only resolves from the privileged viewpoint.
That final design needs no ML at all and is the one specified here.

## The asset pipeline (offline, one-time, no ML)

The generator is `tools/face-scatter.html`, a self-contained page opened directly in a browser.
Nothing is uploaded anywhere; all processing is local canvas pixel work.
It samples the photo on a hexagonal grid (drone spacing slider), keeps cells that are not near-white background, and averages each cell's photo color.
Each kept point gets a deterministic seeded-random z scatter value (mulberry32, fixed seed 20260708), so the same photo and spacing always produce the same cloud.
Live 3D preview with sliders: drone spacing, point size, scatter depth, brightness, contrast; plus snap-to-front.
Export is `brain-face.json`: `{ settings: { pitch, scatter, pointSize, brightness, contrast, mode }, points: [{ x, y, zScatter, color }] }`.
`color` is the raw averaged photo color (`rgb(r,g,b)`), ungraded; brightness and contrast live in `settings` and are applied at render time, not baked into `points` (see Rendering).

The ratified asset is `tools/tony-face-anamorphosis.json`: 3,809 points at pitch 16, scatter 1.8, brightness 1.1, contrast 2.2.
The committed asset contains only coordinates and colors, never the photo.

## Rendering (the app side)

New `FaceView` client component built on `three`, `@react-three/fiber`, and `@react-three/drei` OrbitControls (three new dependencies; `three` is a peer of the other two and must be declared explicitly).
`tools/face-scatter.html` is the authoritative render reference: FaceView ports its scene config verbatim (orthographic frustum, camera position and near/far planes, the 64x64 radial-gradient sprite, additive blending, `alphaTest`, `depthWrite: false`, `sizeAttenuation: false`, and the per-frame `material.size = pointSize * camera.zoom` formula) rather than re-deriving those constants, so the app matches the look Tony ratified across 8 spike iterations.
Duplicating the numbers into this doc would create a second source that drifts the moment the tool is retuned; the tool stays the single source of truth.
Orthographic camera: this is load-bearing, since perspective projection would break the head-on alignment that makes the reveal work.
The one transform detail worth spelling out here, because it is the highest-risk thing to get wrong, is the y-flip: point positions are `x = (px - 0.5) * 1.6`, `y = -(py - 0.5) * 1.6`, `z = zScatter * settings.scatter`, where the negation on y turns image space (y-down) into three.js space (y-up); skip it and the face renders upside-down.
Point colors are graded at render time, not baked into the asset: the committed asset stores raw averaged photo colors, so FaceView reuses the tool's `grade()` formula (contrast pivots around mid-grey, then brightness scales, clamped to [0, 1]) per point on load, reading `settings.contrast` and `settings.brightness` from the asset file.
Lit points and ghost points are two separate `THREE.Points` clouds sharing the sprite texture but with different materials, so raycasting only ever targets the lit cloud and ghosts are structurally unclickable.
Ghost points are a fixed dim grey (`rgb(120,120,120)`) at low opacity (0.15), stored as named constants so the "always faintly present" target shape is tunable in one place.
The `<Canvas>` is transparent (`gl={{ alpha: true }}`, no `scene.background`) over `BrainView`'s solid night-sky root (`#05070f`); the animated galaxy background was removed at Tony's request on 2026-07-08, same day as launch.
Connected lit points are joined by faint line strands (`lineSegments`, the map view's link color at low opacity): Tony asked for visible connections after seeing the near-empty reveal, where the whys are most of the brain; an edge draws only when both its endpoints are lit.
OrbitControls keep `enableDamping` on for the intended inertial feel, but damping is disabled when `prefers-reduced-motion: reduce` is set, matching how `GalaxyBackground` gates its animation.
Free orbit (no rotation clamp): losing and refinding the face is the point.
A slow idle drift (OrbitControls autoRotate at a very low speed) keeps the scatter alive when untouched, so the face gently dissolves on its own and invites refinding; it is movement, so reduced motion disables it.
A small "front" button snaps the camera back to the reveal viewpoint (position `(0, 0, 6)`, zoom 1, target origin); the snap is a tweened camera move (about 0.8s, strong ease-in-out) so the face visibly assembles rather than teleporting, a user drag cancels the tween immediately, and reduced motion jumps instantly instead.
On mount the clouds fade in staggered (ghosts, then lit points, then strands, opacity-only over about 0.5s), which survives reduced motion because nothing moves.
The selected node's point carries a slow-breathing lavender halo (state indication shared with the new-node moment, since a just-created node is auto-selected); under reduced motion the halo is static but still present.
Hovering a lit point shows a brief tooltip (title, type, first ~120 characters of the body), mirroring the map view's hover labels.
We do not clamp zoom: the ratified tool sets no min/max zoom, and snap-to-front already recovers any extreme, so adding limits would fight the "lose and refind" intent.

## App integration

FaceView and the existing map view are siblings under a new top-level `BrainView` container that `app/page.tsx` renders instead of `BrainMap` directly.
`BrainView` owns the single `GET /api/graph` fetch (the same endpoint the graph view uses; no new backend), the `nodes`/`edges`/`loaded`/`error` state, the header (title, node and edge counts, add-node trigger), and the face/map mode toggle; it passes the data and a `mode` prop down so neither view fetches on its own.
This is what "fetch logic is shared, not duplicated" requires: today that state and the header live inside `BrainMap`, so its self-fetch is lifted into `BrainView` as part of this work.
FaceView must be wrapped in `dynamic(() => import("@/components/FaceView"), { ssr: false })`, imported from a client component, exactly as `BrainMap` already wraps `ForceGraph2D`: r3f's `Canvas` and drei's OrbitControls touch `window`, `document`, and WebGL at mount and are not SSR-safe, and `"use client"` alone still server-renders once.
The selected-node detail panel (and its `connectionsOfSelected` edge lookup), currently inline in `BrainMap`, is extracted into a shared `NodeDetailPanel` component taking `{ node, edges, nodes }`, used identically by both views so the two panels cannot drift.
FaceView reuses `BrainMap`'s loaded/error/empty semantics: render nothing (or a subtle loading hint) until `loaded`, surface the same "Cannot reach the brain" message on fetch failure, and at zero nodes show the all-ghost cloud alongside the existing "The brain is empty" messaging so an empty brain never reads as a stuck load.
The ratified asset ships as a static file under `public/` (e.g. `public/brain-face.json`), fetched at runtime the same way `GET /api/graph` is, rather than statically imported from `tools/`: `tools/` is dev-only generator output outside the Next app tree, and a runtime fetch keeps the 368KB dataset out of the client JS bundle.
FaceView is desktop-first for v1, mirroring the tool, which was only ever used at a desk; OrbitControls' default touch handling is accepted as best-effort and not hardened.

## Reveal logic

One node = one point, strictly 1:1; the full portrait completes at 3,809 thoughts, deliberately a decade-scale project.
On load, `BrainView` fetches `GET /api/graph` (same endpoint the graph view uses; no new backend) and hands the data to FaceView.
Point indices are shuffled once with a deterministic seeded shuffle: Fisher-Yates driven by mulberry32 with a fixed seed (`20260709`, distinct from the asset generator's `20260708`), so every load and every reimplementation lights the same physical points for the same early nodes.
The API's `order by created_at` alone is not a stable order (Postgres gives no tiebreak among equal `created_at`, and `now()` is identical for every row in one transaction, so a bulk insert ties), so FaceView re-sorts nodes client-side by `(created_at, id)` before mapping; it does not trust API response order, and the read route is left untouched.
Those sorted nodes map to shuffled points by index, clamped to `Math.min(nodes.length, points.length)` so that once the brain ever exceeds 3,809 nodes the extra nodes simply own no point yet instead of reading past the array and crashing.
The first `nodes.length` shuffled points render lit, in their render-time graded photo colors.
All remaining points render as ghosts: the fixed dim grey at low opacity from the Rendering section, so the target shape is always faintly present (Tony's chosen reveal style).
Clicking a lit point opens the shared node detail panel (title, body, date, connections with whys); the `Canvas` sets `raycaster.params.Points.threshold` to a value tuned once against the exported point spacing (the default of 1 world unit does not match this cloud's scale), and the intersection's point index is read with a guard, not a bare non-null assertion.
Because material size is normalized by `camera.zoom` each frame, a point's world-space footprint is constant across zoom, so the threshold is set once and never recomputed per frame.
Ghost points are not clickable: they live in a separate cloud the raycaster never targets, so there is nothing to hit behind them.

## Mode toggle

The face view is the new default landing view.
A small header control in `BrainView` switches between face and map.
The map itself became a 3D force graph (react-force-graph-3d, orbit controls: drag rotates, scroll zooms) at Tony's request on launch day, with the same glow-sprite look as the face view so the two skies feel like one system.
Both views read the one `GET /api/graph` response `BrainView` owns; fetch logic is shared there, not duplicated per view (see App integration).

## Data and schema

No schema changes, no new endpoints, no writes.
This feature is entirely a client-side view over data the API already returns.

## Testing

Consistent with the repo's light-by-design testing philosophy.
The pure reveal logic (seeded shuffle, reveal count, color grading, node-to-point mapping) lives in a shared `lib/*.ts` module, matching `lib/validation.ts`, so both `tests/*.test.mjs` (via `node --test`) and FaceView import the same code; the module stays erasable-syntax TypeScript so Node's type-stripping loads it directly.
`node --test` units for: seeded shuffle determinism (same seed, same order, across calls), reveal count equals node count, color grading clamps to [0, 1] (which only has something to test because grading happens at render time over raw stored colors), and the node-to-point mapping staying stable when nodes are appended.
No visual tests; the visual test is Tony looking at it.

## Explicitly out of scope for v1

- Per-type point colors (the photo's own colors are the palette).
- Any behavior at or past 3,809 nodes (years away; decide then).
- Rotation clamping and the synthesized back-of-head shell (explored in spikes, dropped with the anamorphic design).
- MediaPipe or any face-landmark model (explored, researched, and deliberately removed from the design).
- Re-running extraction automatically; regenerating the portrait is a manual visit to `tools/face-scatter.html`.
