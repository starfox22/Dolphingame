/* ============================================================
   rng.js — seeded pseudo-random. Deterministic worlds, and no
   surprise divergence between the visual and logic layers.
   ============================================================ */

export class RNG {
  constructor(seed = 12345) { this.seed(seed); }

  seed(s) {
    // splitmix-ish state init so nearby seeds decorrelate quickly
    this._s = (s >>> 0) || 1;
    for (let i = 0; i < 4; i++) this.next();
    return this;
  }

  /** mulberry32 — fast, good enough distribution, 32-bit state. */
  next() {
    this._s = (this._s + 0x6D2B79F5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(a = 1, b) { return b === undefined ? this.next() * a : a + this.next() * (b - a); }
  int(a, b)       { return Math.floor(this.float(a, b)); }
  bool(p = 0.5)   { return this.next() < p; }
  sign()          { return this.next() < 0.5 ? -1 : 1; }
  pick(arr)       { return arr[(this.next() * arr.length) | 0]; }

  /** Weighted pick from [{ w:number, … }]. */
  weighted(items) {
    let total = 0;
    for (const it of items) total += it.w;
    let r = this.next() * total;
    for (const it of items) { r -= it.w; if (r <= 0) return it; }
    return items[items.length - 1];
  }

  /** Approximately gaussian via central limit — plenty good for jitter. */
  gauss(mean = 0, sd = 1) {
    const u = (this.next() + this.next() + this.next() + this.next()) / 2 - 1;
    return mean + u * sd * 1.46;
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** Shared instance for throwaway visual jitter that need not be reproducible. */
export const rand = new RNG((Math.random() * 1e9) | 0);
