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

The ratified asset is `tools/tony-face-anamorphosis.json`: 3,809 points at pitch 16, scatter 1.8, brightness 1.1, contrast 2.2.
The committed asset contains only coordinates and colors, never the photo.

## Rendering (the app side)

New `FaceView` client component using `@react-three/fiber` and `@react-three/drei` OrbitControls (two new dependencies).
Orthographic camera: this is load-bearing, since perspective projection would break the head-on alignment that makes the reveal work.
Points render as soft radial-gradient sprites with additive blending, `sizeAttenuation: false`, and material size multiplied by camera zoom each frame (attenuated size ignores zoom under an orthographic camera and dense clouds dissolve into dust).
Point colors are graded at build time: contrast pivots around mid-grey, then brightness scales, clamped to [0, 1], using the settings stored in the asset file.
Free orbit (no rotation clamp): losing and refinding the face is the point.
A snap-to-front control returns the camera to the reveal viewpoint.

## Reveal logic

One node = one point, strictly 1:1; the full portrait completes at 3,809 thoughts, deliberately a decade-scale project.
On load, fetch `GET /api/graph` (same endpoint the graph view uses; no new backend).
Point indices are shuffled once with a deterministic seeded shuffle (fixed seed, same order on every load); nodes ordered by `created_at` with `id` as tiebreaker map to shuffled points by index, so a given node always owns the same point.
The first `nodes.length` shuffled points render lit, in their graded photo colors.
All remaining points render as ghosts: dim neutral grey at low opacity, so the target shape is always faintly present (Tony's chosen reveal style).
Clicking a lit point opens the existing node detail panel (title, body, date, connections with whys).
Ghost points are not clickable; there is nothing behind them yet.

## Mode toggle

The face view is the new default landing view.
A small header control switches between face and map (today's force graph).
Both views read the same `GET /api/graph` response; fetch logic is shared, not duplicated.

## Data and schema

No schema changes, no new endpoints, no writes.
This feature is entirely a client-side view over data the API already returns.

## Testing

Consistent with the repo's light-by-design testing philosophy.
`node --test` units for: seeded shuffle determinism (same seed, same order, across calls), reveal count equals node count, color grading clamps to [0, 1], and the node-to-point mapping staying stable when nodes are appended.
No visual tests; the visual test is Tony looking at it.

## Explicitly out of scope for v1

- Edges or connection lines in the face view (the graph view owns relationships).
- Per-type point colors (the photo's own colors are the palette).
- Any behavior at or past 3,809 nodes (years away; decide then).
- Rotation clamping and the synthesized back-of-head shell (explored in spikes, dropped with the anamorphic design).
- MediaPipe or any face-landmark model (explored, researched, and deliberately removed from the design).
- Re-running extraction automatically; regenerating the portrait is a manual visit to `tools/face-scatter.html`.
