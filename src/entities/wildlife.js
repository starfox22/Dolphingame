/* ============================================================
   wildlife.js — everything alive that isn't the player.

   The ocean has to feel inhabited or cleaning it means nothing.
   Schools flee, jellyfish drift and sting, rays glide past in
   the parallax, and once in a while a whale crosses the trench
   below you. Population scales with ocean health, so a cleaner
   sea is visibly busier.
   ============================================================ */

import { RNG } from '../core/rng.js';
import { TAU, clamp, clamp01, lerp, damp, dampAngle, rgba, rgb } from '../core/math.js';
import { PROP } from '../world/world.js';

/* ============================================================
   Fish schools
   ============================================================ */

const SCHOOL_PALETTES = [
  { body: [252, 186,  84], fin: [255, 226, 150] },
  { body: [120, 206, 246], fin: [190, 236, 255] },
  { body: [246, 128, 158], fin: [255, 196, 210] },
  { body: [150, 234, 178], fin: [206, 255, 220] },
  { body: [186, 158, 250], fin: [226, 210, 255] },
];

class School {
  constructor(x, y, rng, world) {
    this.hx = x; this.hy = y;
    this.x = x; this.y = y;
    this.world = world;
    this.pal = rng.pick(SCHOOL_PALETTES);
    this.n = rng.int(9, 26);
    this.spread = 34 + rng.float(0, 60);
    this.size = 3.2 + rng.float(0, 3.4);
    this.roam = 200 + rng.float(0, 420);
    this.phase = rng.float(0, TAU);
    this.speed = 26 + rng.float(0, 34);
    this.a = rng.float(0, TAU);
    this.flee = 0;
    this.fish = [];
    for (let i = 0; i < this.n; i++) {
      this.fish.push({
        ox: rng.gauss(0, this.spread),
        oy: rng.gauss(0, this.spread * 0.55),
        x, y, a: 0,
        ph: rng.float(0, TAU),
        s: 0.7 + rng.float(0, 0.7),
      });
    }
  }

  update(dt, t, dolphin) {
    // Wander: the school centre traces a slow lissajous around home.
    const w = t * 0.14 + this.phase;
    let tx = this.hx + Math.sin(w) * this.roam;
    let ty = this.hy + Math.sin(w * 1.7 + 1.2) * this.roam * 0.32;

    // Flee: a dolphin at speed scatters them, then they re-form.
    const dx = this.x - dolphin.x, dy = this.y - dolphin.y;
    const d = Math.hypot(dx, dy);
    if (d < 320) {
      const push = (1 - d / 320);
      this.flee = Math.max(this.flee, push);
      tx += (dx / (d || 1)) * push * 480;
      ty += (dy / (d || 1)) * push * 480;
    }
    this.flee = Math.max(0, this.flee - dt * 0.7);

    const spd = this.speed * (1 + this.flee * 4.5);
    const ang = Math.atan2(ty - this.y, tx - this.x);
    this.a = dampAngle(this.a, ang, 0.1, dt);
    this.x += Math.cos(this.a) * spd * dt;
    this.y += Math.sin(this.a) * spd * dt;

    // Keep the school off the seabed and under the surface.
    const fy = this.world.floorAt(this.x);
    if (this.y > fy - 40) this.y = damp(this.y, fy - 60, 0.1, dt);
    if (this.y < 30) this.y = damp(this.y, 60, 0.1, dt);

    const jitter = 1 + this.flee * 2.2;
    for (const f of this.fish) {
      f.ph += dt * (5 + this.flee * 9) * f.s;
      const tX = this.x + f.ox * jitter + Math.sin(f.ph * 0.6) * 5;
      const tY = this.y + f.oy * jitter + Math.cos(f.ph * 0.5) * 5;
      const nx = damp(f.x, tX, 0.12, dt);
      const ny = damp(f.y, tY, 0.12, dt);
      const mvx = nx - f.x, mvy = ny - f.y;
      if (Math.abs(mvx) + Math.abs(mvy) > 0.001) {
        f.a = dampAngle(f.a, Math.atan2(mvy, mvx), 0.25, dt);
      }
      f.x = nx; f.y = ny;
    }
  }

  draw(ctx, health) {
    const body = this.pal.body, fin = this.pal.fin;
    // Bleached fish in a sick ocean; full colour once it's clean.
    const sat = 0.62 + clamp01(health) * 0.38;
    const bc = `rgba(${lerp(150, body[0], sat) | 0},${lerp(150, body[1], sat) | 0},${lerp(150, body[2], sat) | 0},0.95)`;
    const fc = `rgba(${lerp(170, fin[0], sat) | 0},${lerp(170, fin[1], sat) | 0},${lerp(170, fin[2], sat) | 0},0.8)`;

    for (const f of this.fish) {
      const s = this.size * f.s;
      const wag = Math.sin(f.ph * 2.2) * 0.6;
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.a);
      ctx.fillStyle = fc;
      ctx.beginPath();
      ctx.moveTo(-s * 1.5, 0);
      ctx.lineTo(-s * 3.0, -s * 1.1 + wag * s);
      ctx.lineTo(-s * 3.0, s * 1.1 + wag * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = bc;
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 2, s * 0.95, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.ellipse(s * 0.9, -s * 0.25, s * 0.28, s * 0.28, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }
}

/* ============================================================
   Jellyfish — beautiful, and they sting
   ============================================================ */

class Jelly {
  constructor(x, y, rng) {
    this.x = x; this.y = y;
    this.hy = y;
    this.r = 15 + rng.float(0, 20);
    this.phase = rng.float(0, TAU);
    this.rate = 0.7 + rng.float(0, 0.6);
    this.drift = rng.gauss(0, 8);
    this.hue = rng.pick([[190, 130, 255], [255, 140, 200], [130, 220, 255]]);
    this.tentacles = rng.int(6, 11);
    this.pulse = 0;
    this.alive = true;
  }

  get radius() { return this.r * 0.9; }

  update(dt, t) {
    this.pulse = (Math.sin(t * this.rate * TAU * 0.5 + this.phase) + 1) * 0.5;
    // Jet propulsion: they surge on the contraction and coast after.
    const jet = Math.pow(this.pulse, 3);
    this.y -= jet * 26 * dt;
    this.y += 12 * dt;
    this.x += (this.drift + Math.sin(t * 0.2 + this.phase) * 6) * dt;
  }

  draw(ctx, gctx, t) {
    const squash = 1 - this.pulse * 0.24;
    const r = this.r;
    const c = this.hue;
    ctx.save();
    ctx.translate(this.x, this.y);

    // Tentacles first, so the bell overlaps them.
    ctx.strokeStyle = rgba(c, 0.34);
    ctx.lineWidth = 1.5;
    for (let i = 0; i < this.tentacles; i++) {
      const ox = (i / (this.tentacles - 1) - 0.5) * r * 1.5;
      const len = r * (1.9 + (i % 3) * 0.7) * (1 + this.pulse * 0.2);
      ctx.beginPath();
      ctx.moveTo(ox, r * 0.4 * squash);
      ctx.quadraticCurveTo(
        ox + Math.sin(t * 1.6 + i + this.phase) * 9, r * 0.4 + len * 0.55,
        ox + Math.sin(t * 1.2 + i * 1.4 + this.phase) * 15, r * 0.4 + len
      );
      ctx.stroke();
    }

    // Bell.
    const g = ctx.createRadialGradient(0, -r * 0.3, r * 0.1, 0, 0, r * 1.15);
    g.addColorStop(0, rgba(c, 0.55));
    g.addColorStop(0.6, rgba(c, 0.24));
    g.addColorStop(1, rgba(c, 0.03));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.86 * squash, 0, Math.PI, TAU);
    ctx.ellipse(0, 0, r, r * 0.34, 0, 0, Math.PI);
    ctx.fill();

    ctx.strokeStyle = rgba(c, 0.6);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.86 * squash, 0, Math.PI, TAU);
    ctx.stroke();
    ctx.restore();

    if (gctx) {
      const a = 0.13 + this.pulse * 0.14;
      gctx.fillStyle = rgba(c, a);
      gctx.beginPath(); gctx.arc(this.x, this.y, r * 1.9, 0, TAU); gctx.fill();
    }
  }
}

/* ============================================================
   Manta rays — parallax spectacle
   ============================================================ */

class Ray {
  constructor(x, y, rng) {
    this.x = x; this.y = y;
    this.hy = y;
    this.span = 60 + rng.float(0, 110);
    this.dir = rng.sign();
    this.speed = 30 + rng.float(0, 30);
    this.phase = rng.float(0, TAU);
    this.depthPar = 0.55 + rng.float(0, 0.3);   // drawn behind the play layer
  }

  update(dt, t, world) {
    this.x += this.speed * this.dir * dt;
    this.y = this.hy + Math.sin(t * 0.24 + this.phase) * 44;
    if (this.x < -400) this.x = world.width + 300;
    if (this.x > world.width + 400) this.x = -300;
  }

  draw(ctx, t) {
    const flap = Math.sin(t * 1.5 + this.phase);
    const s = this.span;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(this.dir, 1);
    ctx.globalAlpha = 0.5;

    const g = ctx.createLinearGradient(0, -s * 0.3, 0, s * 0.3);
    g.addColorStop(0, 'rgb(38,60,84)');
    g.addColorStop(1, 'rgb(16,30,48)');
    ctx.fillStyle = g;

    ctx.beginPath();
    ctx.moveTo(s * 0.42, 0);
    ctx.quadraticCurveTo(s * 0.1, -s * 0.20, -s * 0.5, -s * 0.30 + flap * s * 0.20);
    ctx.quadraticCurveTo(-s * 0.16, -s * 0.02, -s * 0.20, 0);
    ctx.quadraticCurveTo(-s * 0.16, s * 0.02, -s * 0.5, s * 0.30 - flap * s * 0.20);
    ctx.quadraticCurveTo(s * 0.1, s * 0.20, s * 0.42, 0);
    ctx.closePath();
    ctx.fill();

    // Tail.
    ctx.strokeStyle = 'rgba(20,34,52,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-s * 0.2, 0);
    ctx.quadraticCurveTo(-s * 0.5, flap * 6, -s * 0.78, flap * 12);
    ctx.stroke();
    ctx.restore();
  }
}

/* ============================================================
   Sludge — the pollution you are undoing
   ============================================================ */

class Sludge {
  constructor(x, y, rng) {
    this.x = x; this.y = y;
    this.r = 60 + rng.float(0, 90);
    this.phase = rng.float(0, TAU);
    this.blobs = [];
    for (let i = 0; i < 7; i++) {
      this.blobs.push({
        ox: rng.gauss(0, this.r * 0.45),
        oy: rng.gauss(0, this.r * 0.32),
        r: this.r * (0.4 + rng.float(0, 0.45)),
        ph: rng.float(0, TAU),
      });
    }
  }

  get radius() { return this.r * 0.72; }

  draw(ctx, t, health) {
    const a = clamp01(1 - health * 1.2);
    if (a < 0.02) return;
    ctx.save();
    ctx.globalAlpha = a;
    for (const b of this.blobs) {
      const x = this.x + b.ox + Math.sin(t * 0.35 + b.ph) * 9;
      const y = this.y + b.oy + Math.cos(t * 0.28 + b.ph) * 7;
      const g = ctx.createRadialGradient(x, y, b.r * 0.1, x, y, b.r);
      g.addColorStop(0, 'rgba(78,86,40,0.55)');
      g.addColorStop(0.6, 'rgba(58,68,36,0.26)');
      g.addColorStop(1, 'rgba(46,56,32,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, b.r, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
}

/* ============================================================
   The whale — a scheduled moment of awe
   ============================================================ */

class Whale {
  constructor(world, rng) {
    this.world = world;
    this.rng = rng;
    this.active = false;
    this.cool = 26 + rng.float(0, 40);
    this.x = 0; this.y = 0;
    this.len = 620;
    this.dir = 1;
    this.phase = 0;
  }

  trigger(camX, camY) {
    this.active = true;
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.x = camX - this.dir * 1500;
    this.y = camY + 420 + Math.random() * 320;
    this.y = clamp(this.y, 500, this.world.maxDepth - 260);
    this.phase = 0;
    this.speed = 62 + Math.random() * 30;
  }

  update(dt, t, camX, camY) {
    if (!this.active) {
      this.cool -= dt;
      if (this.cool <= 0) { this.cool = 55 + Math.random() * 70; this.trigger(camX, camY); }
      return false;
    }
    this.x += this.speed * this.dir * dt;
    this.phase += dt;
    this.y += Math.sin(this.phase * 0.25) * 9 * dt;
    if (Math.abs(this.x - camX) > 2600) this.active = false;
    return this.active;
  }

  draw(ctx, t) {
    if (!this.active) return;
    const L = this.len, H = L * 0.22;
    const sway = Math.sin(this.phase * 0.9) * 0.10;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(this.dir, 1);
    ctx.rotate(sway * 0.3);
    ctx.globalAlpha = 0.38;

    const g = ctx.createLinearGradient(0, -H, 0, H);
    g.addColorStop(0, 'rgb(24,42,64)');
    g.addColorStop(1, 'rgb(10,20,36)');
    ctx.fillStyle = g;

    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0);
    ctx.quadraticCurveTo(L * 0.24, -H, -L * 0.1, -H * 0.86);
    ctx.quadraticCurveTo(-L * 0.36, -H * 0.5, -L * 0.46, -H * 0.16);
    ctx.quadraticCurveTo(-L * 0.62, -H * 0.9 + sway * 90, -L * 0.66, -H * 0.5 + sway * 90);
    ctx.quadraticCurveTo(-L * 0.52, 0, -L * 0.66, H * 0.5 + sway * 90);
    ctx.quadraticCurveTo(-L * 0.62, H * 0.9 + sway * 90, -L * 0.46, H * 0.16);
    ctx.quadraticCurveTo(-L * 0.3, H * 0.72, 0, H * 0.78);
    ctx.quadraticCurveTo(L * 0.3, H * 0.7, L * 0.5, 0);
    ctx.closePath();
    ctx.fill();

    // Throat pleats.
    ctx.strokeStyle = 'rgba(60,90,120,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const x = L * 0.36 - i * L * 0.055;
      ctx.beginPath();
      ctx.moveTo(x, H * 0.12);
      ctx.quadraticCurveTo(x - 8, H * 0.5, x - 14, H * 0.7);
      ctx.stroke();
    }
    // Pectoral.
    ctx.fillStyle = 'rgba(18,34,54,0.9)';
    ctx.beginPath();
    ctx.moveTo(L * 0.12, H * 0.5);
    ctx.quadraticCurveTo(L * 0.02, H * 1.25, -L * 0.14, H * 1.35);
    ctx.quadraticCurveTo(-L * 0.02, H * 0.85, L * 0.06, H * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/* ============================================================
   Manager
   ============================================================ */

export class Wildlife {
  constructor(world, seed = 3131) {
    this.world = world;
    this.rng = new RNG(seed);
    this.schools = [];
    this.jellies = [];
    this.rays = [];
    this.sludges = [];
    this.crabs = [];
    this.whale = new Whale(world, this.rng);
    this.time = 0;
    this._populate();
  }

  _populate() {
    const r = this.rng, W = this.world.width;

    for (let x = 300; x < W - 300; x += 340 + r.float(0, 460)) {
      const fy = this.world.floorAt(x);
      const y = r.float(90, Math.max(160, fy - 90));
      this.schools.push(new School(x, y, r, this.world));
    }

    for (let x = 420; x < W - 300; x += 240 + r.float(0, 420)) {
      const fy = this.world.floorAt(x);
      const y = r.float(180, Math.max(260, fy - 60));
      this.jellies.push(new Jelly(x, y, r));
    }

    for (let i = 0; i < 14; i++) {
      const x = r.float(0, W);
      this.rays.push(new Ray(x, r.float(360, this.world.maxDepth * 0.72), r));
    }

    // Sludge clusters sit near the outfall pipes.
    for (const p of this.world.props) {
      if (p.kind === PROP.PIPE) {
        for (let i = 0; i < 3; i++) {
          this.sludges.push(new Sludge(p.x + r.gauss(60, 90), p.y - r.float(10, 90), r));
        }
      }
    }

    for (let x = 200; x < W - 200; x += 400 + r.float(0, 700)) {
      this.crabs.push({
        x, y: this.world.floorAt(x) - 6,
        ph: r.float(0, TAU), dir: r.sign(), s: 0.8 + r.float(0, 0.8),
        t: r.float(0, 4),
      });
    }
  }

  update(dt, t, dolphin, bounds, cam) {
    this.time = t;
    const near = (x) => x > bounds.x0 - 900 && x < bounds.x1 + 900;

    for (const s of this.schools) if (near(s.x)) s.update(dt, t, dolphin);

    for (const j of this.jellies) {
      if (!near(j.x)) continue;
      j.update(dt, t);
      const fy = this.world.floorAt(j.x);
      if (j.y > fy - 40) j.y = fy - 40;
      if (j.y < 90) j.y = 90;
    }

    for (const rr of this.rays) rr.update(dt, t, this.world);

    for (const c of this.crabs) {
      if (!near(c.x)) continue;
      c.t -= dt;
      if (c.t <= 0) { c.t = 1.4 + Math.random() * 3.4; c.dir *= -1; }
      c.x += c.dir * 16 * dt;
      c.y = this.world.floorAt(c.x) - 5;
      c.ph += dt * 8;
    }

    this.whale.update(dt, t, cam.x, cam.y);
  }

  /** Jellyfish the dolphin is currently touching. */
  stingCheck(dolphin) {
    const nose = dolphin.nose();
    for (const j of this.jellies) {
      if (Math.abs(j.x - dolphin.x) > 200) continue;
      const d = Math.min(
        Math.hypot(j.x - dolphin.x, j.y - dolphin.y),
        Math.hypot(j.x - nose.x, j.y - nose.y)
      );
      if (d < j.radius + 20) return j;
    }
    return null;
  }

  /** Sludge cloud the dolphin is inside, if any. */
  sludgeCheck(dolphin, health) {
    if (health > 0.85) return null;
    for (const s of this.sludges) {
      if (Math.abs(s.x - dolphin.x) > 300) continue;
      if (Math.hypot(s.x - dolphin.x, s.y - dolphin.y) < s.radius) return s;
    }
    return null;
  }

  /** Behind the play layer: rays, whale. */
  drawBack(ctx, bounds, t) {
    this.whale.draw(ctx, t);
    for (const r of this.rays) {
      if (r.x < bounds.x0 - 400 || r.x > bounds.x1 + 400) continue;
      if (r.y < bounds.y0 - 300 || r.y > bounds.y1 + 300) continue;
      r.draw(ctx, t);
    }
  }

  /** In the play layer: schools, jellies, sludge, crabs. */
  drawMid(ctx, gctx, bounds, t, health) {
    for (const s of this.sludges) {
      if (s.x < bounds.x0 - 300 || s.x > bounds.x1 + 300) continue;
      s.draw(ctx, t, health);
    }
    for (const c of this.crabs) {
      if (c.x < bounds.x0 - 60 || c.x > bounds.x1 + 60) continue;
      if (c.y < bounds.y0 - 60 || c.y > bounds.y1 + 60) continue;
      this._crab(ctx, c);
    }
    for (const s of this.schools) {
      if (s.x < bounds.x0 - 500 || s.x > bounds.x1 + 500) continue;
      if (s.y < bounds.y0 - 400 || s.y > bounds.y1 + 400) continue;
      s.draw(ctx, health);
    }
    for (const j of this.jellies) {
      if (j.x < bounds.x0 - 200 || j.x > bounds.x1 + 200) continue;
      if (j.y < bounds.y0 - 200 || j.y > bounds.y1 + 200) continue;
      j.draw(ctx, gctx, t);
    }
  }

  _crab(ctx, c) {
    const s = 5 * c.s;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(c.dir, 1);
    ctx.strokeStyle = 'rgb(150,64,48)';
    ctx.lineWidth = 1.3;
    for (let i = -1; i <= 1; i++) {
      const lift = Math.sin(c.ph + i * 2) * 2;
      for (const sg of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(i * s * 0.6, 0);
        ctx.lineTo(i * s * 0.6 + sg * s * 0.9, -lift);
        ctx.lineTo(i * s * 0.6 + sg * s * 1.4, 2);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgb(186,78,58)';
    ctx.beginPath(); ctx.ellipse(0, -s * 0.5, s * 1.2, s * 0.8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgb(210,96,72)';
    for (const sg of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(sg * s * 1.5, -s * 0.7, s * 0.55, s * 0.4, sg * 0.5, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#100';
    ctx.beginPath(); ctx.arc(-s * 0.4, -s * 0.9, 0.9, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(s * 0.4, -s * 0.9, 0.9, 0, TAU); ctx.fill();
    ctx.restore();
  }
}

export { School, Jelly, Ray, Sludge, Whale };
