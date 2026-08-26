/* ============================================================
   math.js — small numeric toolkit shared by every system.
   ============================================================ */

export const TAU = Math.PI * 2;
export const clamp  = (v, a, b) => v < a ? a : v > b ? b : v;
export const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
export const lerp   = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a || 1);
export const remap  = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const smoothstep = t => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = t => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };

/** Frame-rate independent exponential approach. `rate` = how much of the
 *  gap is closed per second (0..1). */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.pow(1 - rate, dt * 60));

/** Shortest signed angular difference b - a, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export const lerpAngle = (a, b, t) => a + angleDelta(a, b) * t;
export const dampAngle = (a, b, rate, dt) => a + angleDelta(a, b) * (1 - Math.pow(1 - rate, dt * 60));

export const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };
export const dist  = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

/* --- easing --- */
export const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
export const easeOutQuint = t => 1 - Math.pow(1 - t, 5);
export const easeInCubic  = t => t * t * t;
export const easeInOutSine = t => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeOutBack  = t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
export const easeOutElastic = t =>
  t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - .75) * (TAU / 3)) + 1;

/* ============================================================
   Value noise — cheap, smooth, deterministic. Used for terrain,
   currents, drift and every "organic" wobble in the game.
   ============================================================ */

const PERM = new Uint8Array(512);
{
  // Fixed permutation so the world looks identical across reloads
  // for a given seed, without depending on Math.random at import time.
  let s = 1337;
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const grad1 = h => (h & 1 ? 1 : -1) * (1 + (h >> 1 & 7) * 0.125);

/** 1D gradient noise in roughly [-1, 1]. */
export function noise1(x) {
  const xi = Math.floor(x) & 255;
  const xf = x - Math.floor(x);
  const u = fade(xf);
  const a = grad1(PERM[xi]) * xf;
  const b = grad1(PERM[xi + 1]) * (xf - 1);
  return lerp(a, b, u) * 1.4;
}

const grad2 = (h, x, y) => {
  switch (h & 7) {
    case 0: return  x + y; case 1: return  x - y;
    case 2: return -x + y; case 3: return -x - y;
    case 4: return  x;     case 5: return -x;
    case 6: return  y;     default: return -y;
  }
};

/** 2D gradient noise in roughly [-1, 1]. */
export function noise2(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[X] + Y],       ab = PERM[PERM[X] + Y + 1];
  const ba = PERM[PERM[X + 1] + Y],   bb = PERM[PERM[X + 1] + Y + 1];
  const x1 = lerp(grad2(aa, xf, yf),     grad2(ba, xf - 1, yf),     u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

/** Fractal Brownian motion over noise1. */
export function fbm1(x, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise1(x * freq) * amp;
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}

/** Fractal Brownian motion over noise2. */
export function fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}

/* --- colour helpers ------------------------------------------------ */

/** Mix two [r,g,b] arrays. */
export function mixRGB(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}
export const rgb  = c => `rgb(${c[0]},${c[1]},${c[2]})`;
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Sample a gradient defined as [{ at:number, color:[r,g,b] }, …] (sorted). */
export function sampleRamp(ramp, t) {
  if (t <= ramp[0].at) return ramp[0].color;
  const last = ramp[ramp.length - 1];
  if (t >= last.at) return last.color;
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i].at) {
      const a = ramp[i - 1], b = ramp[i];
      return mixRGB(a.color, b.color, invLerp(a.at, b.at, t));
    }
  }
  return last.color;
}
