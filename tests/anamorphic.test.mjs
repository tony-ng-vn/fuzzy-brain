import test from "node:test";
import assert from "node:assert/strict";
import { PARK_DIST, rayBakePositions } from "../tools/space/anamorphic.mjs";

// Build a flat position array of grid points with depth scatter:
// x,y on a grid in [-0.8, 0.8], z scattered in [-0.9, 0.9].
function scatteredGrid() {
  const pts = [];
  let k = 0;
  for (let gy = -0.8; gy <= 0.8; gy += 0.2) {
    for (let gx = -0.8; gx <= 0.8; gx += 0.2) {
      const z = ((k * 37) % 19) / 10 - 0.9; // deterministic pseudo-scatter
      pts.push(gx, gy, z);
      k++;
    }
  }
  return new Float32Array(pts);
}

test("ray bake projects every dot back onto its grid cell from the park viewpoint", () => {
  const pos = scatteredGrid();
  const original = Float32Array.from(pos);
  rayBakePositions(pos, PARK_DIST);
  for (let i = 0; i < pos.length; i += 3) {
    const z = pos[i + 2];
    // Perspective projection from a camera at (0, 0, PARK_DIST) looking at the
    // origin maps (x, y, z) to (x / (D - z), y / (D - z)). After the bake that
    // must equal the projection of the original grid point at z = 0.
    assert.ok(Math.abs(pos[i] / (PARK_DIST - z) - original[i] / PARK_DIST) < 1e-6);
    assert.ok(Math.abs(pos[i + 1] / (PARK_DIST - z) - original[i + 1] / PARK_DIST) < 1e-6);
  }
});

test("dots on the portrait plane (z = 0) are untouched", () => {
  const pos = new Float32Array([0.5, -0.3, 0, -0.8, 0.8, 0]);
  const original = Float32Array.from(pos);
  rayBakePositions(pos, PARK_DIST);
  assert.deepEqual(Array.from(pos), Array.from(original));
});

test("depth values are preserved; only x and y move", () => {
  const pos = scatteredGrid();
  const original = Float32Array.from(pos);
  rayBakePositions(pos, PARK_DIST);
  for (let i = 2; i < pos.length; i += 3) assert.equal(pos[i], original[i]);
});

test("bake returns the same array it was given, mutated in place", () => {
  const pos = new Float32Array([0.4, 0.4, 0.9]);
  assert.equal(rayBakePositions(pos, PARK_DIST), pos);
  assert.ok(pos[0] < 0.4); // pulled inward: dot is nearer the camera
});

test("a dot behind the plane (z < 0) is pushed outward, one in front pulled inward", () => {
  const pos = new Float32Array([0.8, 0, -0.9, 0.8, 0, 0.9]);
  rayBakePositions(pos, PARK_DIST);
  assert.ok(pos[0] > 0.8, "behind the plane: farther from camera, scaled up");
  assert.ok(pos[3] < 0.8, "in front of the plane: nearer the camera, scaled down");
});
