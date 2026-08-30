// lib/rng.mjs -- seeded RNG with named sub-streams (DESIGN.md section 3.6).
//
// xoshiro128** over an FNV-1a seed hash. Every draw in gen-corpus.mjs comes
// from a stream forked by a stable label (e.g. `rng.fork('memory:41732')`),
// never from sequential draws off one shared stream. That is what lets a
// memory or query be generated in any order -- or lazily, one at a time, as
// the 10M tier requires -- and still land on the exact same content: the
// stream for id 41732 depends only on its own label, not on how many draws
// happened before it.

// FNV-1a: a small, fast, well-distributed string hash. Only used to turn a
// seed string into one 32-bit integer; xoshiro's own state comes from
// splitmix32 below, not from this hash directly.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashString(s) {
  return fnv1a(String(s));
}

// splitmix32 expands one 32-bit seed into four well-mixed state words for
// xoshiro128** -- xoshiro's own state must not start from a low-entropy
// value (like the raw FNV hash) or its first few outputs correlate.
function splitmix32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z;
  };
}

function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

class Rng {
  constructor(seedStr) {
    this._seedStr = seedStr;
    const sm = splitmix32(hashString(seedStr));
    this._s = [sm(), sm(), sm(), sm()];
    // All-zero state is xoshiro's one invalid state (it never leaves zero).
    // Astronomically unlikely from splitmix32, but cheap to guard.
    if (!(this._s[0] | this._s[1] | this._s[2] | this._s[3])) this._s[0] = 1;
  }

  // xoshiro128** core step: advances state, returns the next 32-bit output.
  u32() {
    const s = this._s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result >>> 0;
  }

  // Double in [0, 1) with full 53-bit mantissa precision, built from two
  // 32-bit draws (standard xoshiro-family technique).
  float() {
    const hi = this.u32() >>> 5; // 27 bits
    const lo = this.u32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  // Inclusive integer in [lo, hi].
  int(lo, hi) {
    const range = hi - lo + 1;
    return lo + Math.floor(this.float() * range);
  }

  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }

  // n distinct elements, without replacement, in draw order.
  sample(arr, n) {
    const pool = arr.slice();
    const out = [];
    const count = Math.min(n, pool.length);
    for (let i = 0; i < count; i++) {
      const idx = this.int(0, pool.length - 1);
      out.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return out;
  }

  shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // Standard normal via Box-Muller; used by synth-vectors.mjs for jitter/drift.
  gauss() {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.float();
    while (v === 0) v = this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // A fresh, independent stream keyed by this stream's seed plus `label`.
  // Adding a new field to a record's generation only adds a new fork call
  // elsewhere -- it never shifts what an existing fork produces, which is
  // the property that keeps a seed's output stable across code edits.
  fork(label) {
    return new Rng(`${this._seedStr}::${label}`);
  }
}

export function makeRng(seed) {
  return new Rng(String(seed));
}
