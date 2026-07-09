// Works around a latent crash in three's OrbitControls.onPointerUp.
//
// In its "one pointer still down" branch, onPointerUp reads
// `this._pointerPositions[pointerId].x`. That entry only exists once the pointer
// has MOVED while the control was enabled (_trackPointer records it on
// pointermove). react-force-graph disables OrbitControls during a node drag and
// wires DragControls to forward the terminating pointerup / pointercancel /
// pointerleave straight into OrbitControls.onPointerUp -- so the pointer was
// never tracked and the read lands on `undefined`. It is reachable with a plain
// mouse: even the cursor leaving the canvas fires pointerleave. Upstream three
// bug; we harden the map's own control instance rather than patch three.
//
// The fix wraps `_pointerPositions` in a Proxy that returns a zeroed position
// for any numeric pointer id the control never recorded, so the read finds
// {x:0,y:0} instead of undefined. three only ever touches .x / .y / .set on
// these values (verified against OrbitControls in three@0.185), and the fallback
// is stored back on first access, so genuine multi-pointer tracking still works.
// Remove once three guards onPointerUp upstream.

type PointerPos = { x: number; y: number; set(x: number, y: number): void };

function makePointerPos(): PointerPos {
  return {
    x: 0,
    y: 0,
    set(x: number, y: number) {
      this.x = x;
      this.y = y;
    },
  };
}

const GUARDED = Symbol("orbit-pointer-guard");

// Wrap the control's _pointerPositions map so a never-tracked pointer resolves
// to a zeroed position instead of undefined. Idempotent and best-effort: returns
// true when the control ends up guarded, false when the value is not a control
// with the expected shape (so a library change quietly no-ops instead of
// throwing). Exported for unit testing without a browser.
export function guardOrbitPointerPositions(controls: unknown): boolean {
  if (!controls || typeof controls !== "object") return false;
  const c = controls as Record<PropertyKey, unknown>;
  if (c[GUARDED]) return true;

  const positions = c._pointerPositions;
  if (positions === null || typeof positions !== "object") return false;

  c._pointerPositions = new Proxy(positions as Record<string, PointerPos>, {
    get(target, key) {
      if (typeof key === "string" && /^\d+$/.test(key) && !(key in target)) {
        target[key] = makePointerPos();
      }
      return Reflect.get(target, key);
    },
  });
  c[GUARDED] = true;
  return true;
}
