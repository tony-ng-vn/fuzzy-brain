# Face lines v3: contour-line dot head design

Date: 2026-07-08
Status: approved in conversation with Tony; studio-tool sign-off is a hard gate before app integration.

## What it is

A third face rendering for the brain: Tony's head as a fully rotatable 3D dot portrait in the style of a drone light show.
Dots are arranged along contour lines that wrap the head's surface (scan rows on skin, flowing strands in the hair), lit by a fixed key light, in a warm bronze monochrome on black.
Unlike v2's anamorphic scatter, which only resolves head-on, v3 reads as a head from every angle: front, three-quarter, profile, low, top, rear.
It lives alongside the v2 face view and the 3D map as a third mode in `BrainView`.

## Prior art and the hollow-mask risk

The v2 spikes already tried a depth relief with a synthesized back-of-head shell and dropped it: it hit the hollow-mask illusion and never felt right (see the v2 spec, spike history).
That attempt differed from this design in the two ways that matter for volume perception: its dots were randomly scattered rather than arranged along surface contours, and dot brightness came only from photo color rather than from lighting.
Contour lines and normal-based shading are the strongest monocular volume cues a point cloud can carry, so this design is a genuinely new bet, not a rerun of the failed spike.
The bet is validated or killed in the studio tool, live with Tony, before any app code is written.
If the studio look fails, the app integration sections of this spec do not proceed.

## Geometry source: depth map from the real portrait

Identity comes primarily from Tony's actual uploaded portrait, not from a generic stock head mesh.
A monocular depth-estimation model gives every portrait pixel a real z, preserving facial proportions, hairline, hairstyle, jawline, nose, lips, eyes, and overall head shape.
Angles not visible in the portrait (the back of the head) are inferred procedurally so the result still feels like the same person.
Identity consistency is prioritized over perfect full-3D accuracy: the front hemisphere is faithful, the rear is plausible.

## The asset pipeline (offline, one-time)

Step 1, depth bake: a small local script (`tools/depth-bake.py`) runs Depth Anything V2 Small via Hugging Face transformers on the portrait and writes a depth PNG at photo resolution next to it.
This is the only ML dependency in the whole feature, it runs once on Tony's machine, and nothing is uploaded anywhere.
The depth PNG is a dev-only intermediate, like the portrait itself; neither is committed.

Step 2, studio: a new self-contained `tools/face-lines.html` page (the v3 sibling of `face-scatter.html`) loads the portrait and depth PNG via local file inputs and builds the point cloud live.
Sliders: row spacing, dot spacing along rows, depth scale, hair-region threshold, back-shell depth, light direction, bronze ramp endpoints, point size.
Export writes `brain-face-v3.json`; the ratified copy is committed to `tools/` and shipped as `public/brain-face-v3.json`.
As with v2, the committed asset contains only coordinates and derived values, never the photo, and the tool remains the single source of truth for scene constants.

## Building the head

Skin and face: dots are sampled along horizontal contour rows across the depth relief, evenly spaced in arc length so rows read as lines wrapping the form.
Hair: inside the hair region (masked by the hair-region threshold slider), dots instead follow strands traced along the image's gradient flow field, recreating the combed dotted-hair look of the reference.
Back of head: the head silhouette is revolved around the vertical axis to close the skull volume, and the back shell is covered with strands flowing from the crown, matching the hairstyle silhouette from the photo; the seam is blended near the ears.
Normals: from the depth-map gradient on the front, from the revolved shell geometry on the back.

## Asset format

`brain-face-v3.json` is `{ settings, points }` like v2, but `points` uses flat parallel arrays to keep tens of thousands of dots small: `positions` (xyz triples), `normals` (xyz triples), `albedo` (one luminance value per dot from the photo), `region` (one region id per dot), `strand` (one strand id per dot, for possible strand-level effects).
Values are rounded to 3 decimals; at the expected 30k-60k dots the file lands in the low single-digit megabytes and is fetched at runtime like `brain-face.json`, staying out of the client JS bundle.
`settings` records the ratified slider values plus the light direction and bronze ramp, applied at render time, not baked into dot colors, mirroring v2's render-time grading decision.

## Rendering (the app side)

A new `FaceLinesView` client component (or a mode inside `FaceView` if the overlap turns out large; decided during implementation planning) built on the existing three / r3f / drei stack, no new dependencies.
Perspective camera with full 360 orbit: v2's orthographic camera was load-bearing for the anamorphic trick, but v3 is a real 3D head and perspective gives natural parallax.
Per-dot brightness at render time: lambert term (normal dot light direction) times albedo, mapped through the bronze ramp (deep brown when dim, warm gold approaching white when bright), on black.
Reuses the hard-won v2 rendering lessons verbatim: `sizeAttenuation: false` with per-frame `material.size = pointSize * camera.zoom`, additive blending with `depthWrite: false` and `alphaTest`, the radial-gradient sprite, damping and autorotate disabled under `prefers-reduced-motion`, snap-to-front button, and silent fallback (view renders nothing and the app stays functional) if the asset fetch fails.
Lit and ghost dots are separate `THREE.Points` clouds so raycasting only targets lit dots, as in v2.

## Reveal logic

One brain node lights one region: dots are grouped at export time into a few hundred spatial regions (grid-bucket clustering in the studio, region count recorded in `settings`), so the head fills in patch by patch as the brain grows.
Region order is shuffled once with the v2 pattern: Fisher-Yates driven by mulberry32 with a fixed seed, distinct from the seeds already in use, so the same early nodes always light the same regions.
Nodes are sorted client-side by `(created_at, id)` exactly as v2 does, then mapped to shuffled regions by index, clamped to the region count so overflow nodes simply own no region yet.
Unlit dots render as a dim ghost version of their lit self (same position, heavily dimmed bronze) so the full head silhouette is always faintly present.
Clicking a lit dot opens the shared `NodeDetailPanel` for the node that owns its region.
The pure logic (region shuffle, node-to-region mapping, lambert-plus-ramp color math) lives in a `lib/*.ts` module so tests and the component share one implementation, matching `lib/face-reveal.ts`.

## App integration

`BrainView`'s mode state grows from two modes to three: v2 face, v3 lines, map; the toggle becomes a three-way control.
Which mode is the default landing view is decided at visual sign-off, not in this spec.
The new view receives the same single `GET /api/graph` payload `BrainView` already owns; no new endpoints, no schema changes, no writes.
The component is dynamically imported with `ssr: false` for the same reasons FaceView is.

## Testing

Consistent with the repo's light-by-design testing philosophy.
`node --test` units over the shared `lib` module: region shuffle determinism, node-to-region mapping stability under appended nodes, overflow clamping, lambert-plus-ramp output clamped to [0, 1].
Studio-side geometry math that is pure (silhouette revolve, arc-length row sampling) is extracted into a small shared module and unit tested the same way.
No visual tests; the visual test is Tony in the studio tool, then Tony in the app.

## Explicitly out of scope

- Animating transitions between v2 and v3 modes.
- Mobile or low-end performance tuning; desktop-first like v2.
- Automating the depth bake or re-extraction; regenerating the asset is a manual studio visit.
- Multi-view AI generation or photogrammetry (considered and rejected in favor of depth relief plus procedural back).
- Any strand-level animation (the `strand` ids are recorded for the future, not used in v1).
