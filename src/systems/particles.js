/* ============================================================
   particles.js — one pooled system for every small moving thing.

   Pooling matters here: at high quality there can be ~1400 live
   particles, and allocating those per frame would sawtooth the
   GC straight through the frame budget on mobile.
   ============================================================ */

import { TAU, clamp01 } from '../core/math.js';
import { RNG } from '../core/rng.js';

const rng = new RNG(9182);

export const P = {
  BUBBLE:   0,
  SNOW:     1,   // marine snow, drifting down forever
  SPARK:    2,   // collect burst
  SILT:     3,   // kicked up off the seabed
  PLANKTON: 4,   // bioluminescent motes in the deep
  RING:     5,   // vortex ring from a boost
  FOAM:     6,   // splash droplets
  GRIME:    7,   // pollution particulate, removed as the ocean heals
  HEART:    8,   // rescue hearts
};

class Particle {
  constructor() { this.alive = false; }
}

export class Particles {
  constructor(max = 1600) {
    this.pool = new Array(max);
    for (let i = 0; i < max; i++) this.pool[i] = new Particle();
    this.max = max;
    this.cursor = 0;
    this.live = 0;
  }

  _spawn() {
    // Ring-buffer allocation: if we wrap onto a live particle we
    // simply recycle it. Oldest-out is the right eviction policy
    // for ambience.
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.max;
      if (!p.alive) { p.alive = true; this.live++; return p; }
    }
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    return p;
  }

  clear() {
    for (const p of this.pool) p.alive = false;
    this.live = 0;
  }

  /* ---------------------------------------------------------- */
  /* Emitters                                                    */
  /* ---------------------------------------------------------- */

  bubble(x, y, vx = 0, vy = 0, size = 1) {
    const p = this._spawn();
    p.t = P.BUBBLE;
    p.x = x; p.y = y;
    p.vx = vx + rng.gauss(0, 8);
    p.vy = vy - 22 - rng.float(0, 26);
    p.r = (1.6 + rng.float(0, 3.4)) * size;
    p.life = p.maxLife = 2.2 + rng.float(0, 2.6);
    p.a = 0.55 + rng.float(0, 0.35);
    p.wob = rng.float(0, TAU);
    p.wobF = 1.4 + rng.float(0, 2.4);
    return p;
  }

  snow(x, y) {
    const p = this._spawn();
    p.t = P.SNOW;
    p.x = x; p.y = y;
    p.vx = rng.gauss(0, 4);
    p.vy = 5 + rng.float(0, 12);
    p.r = 0.5 + rng.float(0, 1.9);
    p.life = p.maxLife = 14 + rng.float(0, 16);
    p.a = 0.1 + rng.float(0, 0.35);
    p.wob = rng.float(0, TAU);
    p.wobF = 0.3 + rng.float(0, 0.7);
    return p;
  }

  plankton(x, y) {
    const p = this._spawn();
    p.t = P.PLANKTON;
    p.x = x; p.y = y;
    p.vx = rng.gauss(0, 3);
    p.vy = rng.gauss(0, 3);
    p.r = 0.7 + rng.float(0, 1.6);
    p.life = p.maxLife = 8 + rng.float(0, 10);
    p.a = 0.5 + rng.float(0, 0.5);
    p.wob = rng.float(0, TAU);
    p.wobF = 0.8 + rng.float(0, 1.8);
    p.hue = rng.bool(0.7) ? 0 : 1;      // 0 = cyan, 1 = violet
    p.pulse = rng.float(0.4, 1.4);
    return p;
  }

  spark(x, y, opts = {}) {
    const p = this._spawn();
    const spd = opts.speed ?? 90;
    const a = opts.angle ?? rng.float(0, TAU);
    p.t = P.SPARK;
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * spd * rng.float(0.4, 1.3) + (opts.vx || 0);
    p.vy = Math.sin(a) * spd * rng.float(0.4, 1.3) + (opts.vy || 0);
    p.r = opts.r ?? (1.2 + rng.float(0, 2.2));
    p.life = p.maxLife = opts.life ?? (0.5 + rng.float(0, 0.7));
    p.a = 1;
    p.col = opts.col || [190, 255, 245];
    p.drag = opts.drag ?? 2.4;
    return p;
  }

  silt(x, y, vx = 0, vy = 0) {
    const p = this._spawn();
    p.t = P.SILT;
    p.x = x; p.y = y;
    p.vx = vx + rng.gauss(0, 22);
    p.vy = vy + rng.gauss(-6, 16);
    p.r = 4 + rng.float(0, 12);
    p.life = p.maxLife = 1.4 + rng.float(0, 2.2);
    p.a = 0.30 + rng.float(0, 0.2);
    p.col = [150, 138, 110];
    return p;
  }

  ring(x, y, angle, size = 1) {
    const p = this._spawn();
    p.t = P.RING;
    p.x = x; p.y = y;
    p.ang = angle;
    p.r = 5 * size;
    p.grow = (28 + rng.float(0, 22)) * size;
    p.life = p.maxLife = 0.9 + rng.float(0, 0.5);
    p.a = 0.5;
    p.vx = -Math.cos(angle) * 24;
    p.vy = -Math.sin(angle) * 24;
    return p;
  }

  foam(x, y, vx, vy) {
    const p = this._spawn();
    p.t = P.FOAM;
    p.x = x; p.y = y;
    p.vx = vx + rng.gauss(0, 60);
    p.vy = vy + rng.gauss(-40, 50);
    p.r = 1.4 + rng.float(0, 3.6);
    p.life = p.maxLife = 0.7 + rng.float(0, 1.0);
    p.a = 0.95;
    return p;
  }

  grime(x, y) {
    const p = this._spawn();
    p.t = P.GRIME;
    p.x = x; p.y = y;
    p.vx = rng.gauss(0, 5);
    p.vy = rng.gauss(0, 4);
    p.r = 0.8 + rng.float(0, 1.9);
    p.life = p.maxLife = 10 + rng.float(0, 12);
    p.a = 0.10 + rng.float(0, 0.13);
    p.wob = rng.float(0, TAU);
    p.wobF = 0.4 + rng.float(0, 0.6);
    return p;
  }

  heart(x, y) {
    const p = this._spawn();
    p.t = P.HEART;
    p.x = x; p.y = y;
    p.vx = rng.gauss(0, 16);
    p.vy = -30 - rng.float(0, 28);
    p.r = 5 + rng.float(0, 5);
    p.life = p.maxLife = 1.4 + rng.float(0, 0.8);
    p.a = 1;
    p.wob = rng.float(0, TAU);
    return p;
  }

  /** Radial burst helper used by collects, rescues and impacts. */
  burst(x, y, count, opts = {}) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + rng.gauss(0, 0.25);
      this.spark(x, y, { ...opts, angle: a });
    }
  }

  /* ---------------------------------------------------------- */
  /* Simulation                                                  */
  /* ---------------------------------------------------------- */

  update(dt, world, bounds) {
    const pad = 260;
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;

      p.life -= dt;
      if (p.life <= 0) { p.alive = false; this.live--; continue; }

      switch (p.t) {
        case P.BUBBLE: {
          p.wob += p.wobF * dt;
          // Bubbles accelerate as they rise and expand slightly.
          p.vy -= 46 * dt;
          if (p.vy < -150) p.vy = -150;
          p.vx += Math.sin(p.wob) * 26 * dt;
          p.vx *= Math.pow(0.2, dt);
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.y <= 0) { p.alive = false; this.live--; }   // popped at the surface
          break;
        }
        case P.SNOW:
        case P.GRIME: {
          p.wob += p.wobF * dt;
          p.x += (p.vx + Math.sin(p.wob) * 6) * dt;
          p.y += p.vy * dt;
          break;
        }
        case P.PLANKTON: {
          p.wob += p.wobF * dt;
          p.x += (p.vx + Math.sin(p.wob) * 9) * dt;
          p.y += (p.vy + Math.cos(p.wob * 0.7) * 7) * dt;
          break;
        }
        case P.SPARK: {
          const d = Math.pow(1 / (1 + p.drag), dt * 4);
          p.vx *= d; p.vy *= d;
          p.vy += 12 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          break;
        }
        case P.SILT: {
          p.vx *= Math.pow(0.06, dt);
          p.vy *= Math.pow(0.06, dt);
          p.vy -= 3 * dt;
          p.r += 14 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          break;
        }
        case P.RING: {
          p.r += p.grow * dt;
          p.vx *= Math.pow(0.1, dt); p.vy *= Math.pow(0.1, dt);
          p.x += p.vx * dt; p.y += p.vy * dt;
          break;
        }
        case P.FOAM: {
          p.vy += 260 * dt;             // real gravity: these are in air
          p.vx *= Math.pow(0.45, dt);
          p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.y > 2 && p.vy > 0) { p.alive = false; this.live--; }
          break;
        }
        case P.HEART: {
          p.wob += 3.4 * dt;
          p.vy += 8 * dt;
          p.x += (p.vx + Math.sin(p.wob) * 22) * dt;
          p.y += p.vy * dt;
          break;
        }
      }

      // Cull anything that has wandered well out of view.
      if (bounds && (p.x < bounds.x0 - pad || p.x > bounds.x1 + pad ||
                     p.y < bounds.y0 - pad || p.y > bounds.y1 + pad)) {
        if (p.t === P.SNOW || p.t === P.PLANKTON || p.t === P.GRIME) {
          p.alive = false; this.live--;
        }
      }
    }
  }

  /* ---------------------------------------------------------- */
  /* Drawing                                                     */
  /* ---------------------------------------------------------- */

  /**
   * Two-target draw: `ctx` is the main scene, `gctx` the glow buffer.
   * Emissive particle types write to both.
   */
  draw(ctx, gctx, bounds, t) {
    const pad = 60;
    ctx.save();

    /* ---- pass A: non-additive (silt, grime) ---- */
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;
      if (p.t !== P.SILT && p.t !== P.GRIME) continue;
      if (p.y < 0) continue;              // suspended matter, not airborne
      if (p.x < bounds.x0 - pad || p.x > bounds.x1 + pad ||
          p.y < bounds.y0 - pad || p.y > bounds.y1 + pad) continue;

      const k = clamp01(p.life / p.maxLife);
      if (p.t === P.SILT) {
        const a = p.a * k * k;
        ctx.fillStyle = `rgba(${p.col[0]},${p.col[1]},${p.col[2]},${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      } else {
        const a = p.a * Math.min(1, k * 4);
        ctx.fillStyle = `rgba(74,78,54,${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      }
    }

    /* ---- pass B: additive (everything luminous) ---- */
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;
      if (p.t === P.SILT || p.t === P.GRIME) continue;
      if (p.x < bounds.x0 - pad || p.x > bounds.x1 + pad ||
          p.y < bounds.y0 - pad || p.y > bounds.y1 + pad) continue;

      const k = clamp01(p.life / p.maxLife);

      switch (p.t) {
        case P.BUBBLE: {
          const a = p.a * Math.min(1, k * 3);
          ctx.strokeStyle = `rgba(220,255,255,${a * 0.75})`;
          ctx.lineWidth = 0.9;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
          ctx.fillStyle = `rgba(190,245,255,${a * 0.16})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
          // Specular pip — tiny, but it's what makes them read as glass.
          ctx.fillStyle = `rgba(255,255,255,${a * 0.85})`;
          ctx.beginPath(); ctx.arc(p.x - p.r * 0.34, p.y - p.r * 0.34, p.r * 0.24, 0, TAU); ctx.fill();
          break;
        }
        case P.SNOW: {
          if (p.y < 0) break;
          ctx.fillStyle = `rgba(206,240,255,${p.a * Math.min(1, k * 6)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
          break;
        }
        case P.PLANKTON: {
          if (p.y < 0) break;
          const pulse = 0.45 + 0.55 * Math.sin(t * p.pulse * 2.4 + p.wob);
          const a = p.a * Math.min(1, k * 3) * pulse;
          const col = p.hue ? '190,150,255' : '120,255,240';
          const r = p.r * (1 + pulse * 0.5);
          ctx.fillStyle = `rgba(${col},${a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
          if (gctx) {
            gctx.fillStyle = `rgba(${col},${a * 0.9})`;
            gctx.beginPath(); gctx.arc(p.x, p.y, r * 2.6, 0, TAU); gctx.fill();
          }
          break;
        }
        case P.SPARK: {
          const a = k * k;
          const c = p.col;
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + k * 0.9), 0, TAU); ctx.fill();
          if (gctx) {
            gctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a * 0.85})`;
            gctx.beginPath(); gctx.arc(p.x, p.y, p.r * 3.4 * (0.4 + k), 0, TAU); gctx.fill();
          }
          break;
        }
        case P.RING: {
          const a = p.a * k * k;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.ang);
          ctx.strokeStyle = `rgba(200,250,255,${a})`;
          ctx.lineWidth = 1.6 * (0.4 + k);
          ctx.beginPath();
          ctx.ellipse(0, 0, p.r * 0.42, p.r, 0, 0, TAU);
          ctx.stroke();
          ctx.restore();
          break;
        }
        case P.FOAM: {
          const a = Math.min(1, k * 2.2);
          ctx.fillStyle = `rgba(255,255,255,${a * 0.9})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
          if (gctx) {
            gctx.fillStyle = `rgba(220,250,255,${a * 0.16})`;
            gctx.beginPath(); gctx.arc(p.x, p.y, p.r * 1.3, 0, TAU); gctx.fill();
          }
          break;
        }
        case P.HEART: {
          const a = k * k;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.scale(p.r / 8, p.r / 8);
          ctx.fillStyle = `rgba(255,150,170,${a})`;
          ctx.beginPath();
          ctx.moveTo(0, 3);
          ctx.bezierCurveTo(-6, -2, -4, -7, 0, -4);
          ctx.bezierCurveTo(4, -7, 6, -2, 0, 3);
          ctx.fill();
          ctx.restore();
          if (gctx) {
            gctx.fillStyle = `rgba(255,150,170,${a * 0.6})`;
            gctx.beginPath(); gctx.arc(p.x, p.y, p.r * 1.8, 0, TAU); gctx.fill();
          }
          break;
        }
      }
    }

    ctx.restore();
  }
}
