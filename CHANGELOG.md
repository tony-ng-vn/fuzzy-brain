# Changelog

New updates and changes to Fuzzy Brain.

---

## v0.3.0

Jul 8, 2026

**UI**

- Added a dark mode / light mode switch in the header. The switch themes the chrome only (header, panels, buttons, tooltips, forms); the sky itself (the face and map point clouds) stays a deliberate always-dark space in both modes.
- Defaults to the OS color-scheme preference on first visit, then remembers an explicit choice; the theme is set before first paint, so there is no flash of the wrong theme on load.

---

## v0.2.0

Jul 8, 2026

**Face**

- Added the anamorphic face-reveal view: a 3D point cloud built from a real photo, where each node lights exactly one point in the actual face.
- Strung faint connection lines between lit points, so existing whys stay visible in the face view too.
- Made the face view the default view on load; the map is one toggle away.

**Map**

- Rebuilt the map as a 3D force graph with drag-to-rotate orbit controls and scroll to zoom.
- Restored springy drag physics so pulling a node visibly drags its connections along.
- Eased the camera toward a clicked node while its detail panel opens.

**UI**

- Removed the animated galaxy background in favor of a solid night sky.
- Added a motion pass: a tweened camera snap on "front", slow idle drift on the face view, staggered fades on load, a breathing halo on the selected node, and hover tooltips with a brief of the node body.
- Made all movement respect `prefers-reduced-motion`; buttons now acknowledge presses with a subtle scale.

**Tools**

- Added `tools/face-scatter.html`, a local, offline studio that turns a photo into the face-reveal point cloud, with a live 3D preview and tunable spacing, scatter depth, brightness, and contrast.
- Committed the ratified portrait asset (3,809 points).

**Docs**

- Wrote the face-reveal design spec, covering the full path from MediaPipe face landmarks to the final anamorphic-scatter approach.

---

## v0.1.2

Jul 7, 2026

**Docs**

- Proposed "The Ratified Galaxy" brain architecture: a machine-suggests, human-decides model for connections and abstraction layers. Not yet approved for build.

---

## v0.1.1

Jul 4, 2026

**Docs**

- Documented the ritual: nodes are raw capture, not polished artifacts.

---

## v0.1.0

Jul 2, 2026

**Data**

- Added the Polygres data layer: schema, a connection pool cached across dev reloads, and `GET /api/health` and `GET /api/graph`.
- Added integration tests that run against the real database inside rolled-back transactions.

**Map**

- Built the first map: a force-directed 2D graph with glow, a detail panel, and a type legend.

**API**

- Added in-app node creation: an add-node panel and `POST /api/nodes`.
- Allowed `127.0.0.1` as a dev origin.
- Made node type optional, so untyped capture stays first-class.

**UI**

- Added the animated galaxy background (removed in v0.2.0).
