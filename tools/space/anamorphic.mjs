// The anamorphic bake for the space's park viewpoint.
//
// The studio scatters dots straight along z, which only lines up under an
// orthographic camera (a viewpoint at infinity). The space's parked camera is
// a real perspective camera sitting PARK_DIST out on the portrait's axis, so
// each dot must be moved along the ray from that viewpoint instead: scale x,y
// by (D - z) / D. From the park point the cloud then projects exactly back
// onto the flat grid; from anywhere else it reads as scattered chaos.

export const PARK_DIST = 14;

export function rayBakePositions(positions, dist = PARK_DIST) {
  for (let i = 0; i < positions.length; i += 3) {
    const s = (dist - positions[i + 2]) / dist;
    positions[i] *= s;
    positions[i + 1] *= s;
  }
  return positions;
}
