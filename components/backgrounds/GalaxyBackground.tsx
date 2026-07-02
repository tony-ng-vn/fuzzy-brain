"use client";

import { useEffect, useRef } from "react";

// A slowly rotating spiral galaxy behind the brain map. Stars sit on three
// log-spiral arms plus a core bulge, the whole plane tilted and turning as
// one body so the arms hold their shape. Honors prefers-reduced-motion by
// rendering a single static frame.
export default function GalaxyBackground() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // Seeded so every mount produces the same sky.
    const rand = mulberry32(20260702);
    const ARMS = 3;
    const stars = Array.from({ length: 520 }, (_, i) => {
      const inCore = rand() < 0.22;
      const r = inCore ? Math.pow(rand(), 2) * 0.1 : 0.08 + Math.pow(rand(), 0.7) * 0.55;
      const arm = i % ARMS;
      const angle = inCore
        ? rand() * Math.PI * 2
        : r * 7 + arm * ((Math.PI * 2) / ARMS) + (rand() - 0.5) * 0.5;
      return {
        r,
        angle,
        size: 0.4 + rand() * 1.1,
        base: 0.1 + rand() * 0.35,
        phase: rand() * Math.PI * 2,
        twinkle: 0.5 + rand() * 1.5,
        warm: rand() < 0.12,
      };
    });

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const rot = t * 0.015; // one revolution in about seven minutes
      ctx.fillStyle = "#000005";
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const scale = Math.max(w, h) * 0.75;

      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 0.45);
      glow.addColorStop(0, "rgba(90, 110, 190, 0.10)");
      glow.addColorStop(0.4, "rgba(60, 70, 140, 0.05)");
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      for (const s of stars) {
        const a = s.angle + rot;
        const x = cx + Math.cos(a) * s.r * scale;
        const y = cy + Math.sin(a) * s.r * scale * 0.62; // tilt of the galactic plane
        ctx.globalAlpha = s.base * (0.7 + 0.3 * Math.sin(s.phase + t * s.twinkle));
        ctx.fillStyle = s.warm ? "#ffd9a0" : "#cfe0ff";
        ctx.beginPath();
        ctx.arc(x, y, s.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} style={{ position: "absolute", inset: 0, zIndex: 0 }} />;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
