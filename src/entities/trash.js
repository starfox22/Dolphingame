/* ============================================================
   trash.js — what you are here to remove, and who you are here
   to free.

   Trash sits on the seabed or drifts in the column. Everything
   is drawn procedurally; nothing is a sprite. Items within a
   short radius of the nose get pulled in, which makes sweeping
   along the bottom feel like vacuuming rather than pixel-hunting.
   ============================================================ */

import { RNG } from '../core/rng.js';
import { TAU, clamp, clamp01, smoothstep, rgba, rgb } from '../core/math.js';

export const KIND = {
  BOTTLE:  { id: 'BOTTLE',  points: 10,  r: 11, label: 'Bottle',      col: [140, 210, 225] },
  CAN:     { id: 'CAN',     points: 14,  r: 10, label: 'Can',         col: [200, 200, 208] },
  BAG:     { id: 'BAG',     points: 12,  r: 15, label: 'Plastic bag', col: [225, 235, 240] },
  RINGS:   { id: 'RINGS',   points: 22,  r: 13, label: 'Six-pack rings', col: [230, 225, 130] },
  TYRE:    { id: 'TYRE',    points: 34,  r: 20, label: 'Tyre',        col: [ 60,  60,  66] },
  DRUM:    { id: 'DRUM',    points: 48,  r: 22, label: 'Toxic drum',  col: [190, 170,  60] },
  NET:     { id: 'NET',     points: 60,  r: 28, label: 'Ghost net',   col: [180, 200, 190] },
  MICRO:   { id: 'MICRO',   points: 6,   r: 7,  label: 'Microplastic',col: [235, 180, 200] },
};

const KIND_LIST = Object.values(KIND);

export class Trash {
  constructor(kind, x, y, rng, onFloor) {
    this.k = kind;
    this.x = x; this.y = y;
    this.hx = x; this.hy = y;          // home position, for the bob
    this.vx = 0; this.vy = 0;
    this.rot = rng.float(0, TAU);
    this.spin = rng.gauss(0, 0.25);
    this.phase = rng.float(0, TAU);
    this.seed = rng.float(0, 100);
    this.onFloor = onFloor;
    this.alive = true;
    this.collected = 0;                // 0..1 collection animation
    this.pull = 0;                     // magnet strength once close
    this.revealed = 0;                 // 0..1, raised by sonar in the dark
    this.scale = rng.float(0.85, 1.2);
  }

  get radius() { return this.k.r * this.scale; }

  update(dt, t, world) {
    if (!this.alive) return;

    if (this.k === KIND.BAG) {
      // Bags never settle — they wander the column like the real thing.
      this.hx += Math.sin(t * 0.31 + this.phase) * 9 * dt;
      this.hy += Math.cos(t * 0.22 + this.phase * 1.7) * 7 * dt;
      this.rot += Math.sin(t * 0.6 + this.phase) * 0.4 * dt;
    }

    const bobAmp = this.onFloor ? 1.4 : 4.5;
    this.x = this.hx + Math.sin(t * 0.7 + this.phase) * bobAmp;
    this.y = this.hy + Math.cos(t * 0.55 + this.phase * 1.3) * bobAmp * 0.7;
    if (!this.onFloor) this.rot += this.spin * dt * 0.4;
  }

  draw(ctx, gctx, t, health) {
    const s = this.scale;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rot);
    ctx.scale(s, s);

    switch (this.k.id) {
      case 'BOTTLE':  this._bottle(ctx); break;
      case 'CAN':     this._can(ctx); break;
      case 'BAG':     this._bag(ctx, t); break;
      case 'RINGS':   this._rings(ctx); break;
      case 'TYRE':    this._tyre(ctx); break;
      case 'DRUM':    this._drum(ctx); break;
      case 'NET':     this._net(ctx, t); break;
      case 'MICRO':   this._micro(ctx); break;
    }
    ctx.restore();

    // Sonar highlight — a soft ring that says "here, this one".
    if (this.revealed > 0.01 && gctx) {
      gctx.strokeStyle = `rgba(120,255,230,${this.revealed * 0.85})`;
      gctx.lineWidth = 2.4;
      gctx.beginPath();
      gctx.arc(this.x, this.y, this.radius + 8 + (1 - this.revealed) * 22, 0, TAU);
      gctx.stroke();
      gctx.fillStyle = `rgba(120,255,230,${this.revealed * 0.22})`;
      gctx.beginPath(); gctx.arc(this.x, this.y, this.radius + 4, 0, TAU); gctx.fill();
    }
  }

  /* --- individual item art --- */

  _bottle(ctx) {
    const g = ctx.createLinearGradient(-8, 0, 8, 0);
    g.addColorStop(0, 'rgba(90,150,160,0.75)');
    g.addColorStop(0.45, 'rgba(170,225,230,0.85)');
    g.addColorStop(1, 'rgba(70,120,135,0.75)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-4, -13);
    ctx.lineTo(4, -13);
    ctx.lineTo(4, -8);
    ctx.quadraticCurveTo(8, -5, 8, 2);
    ctx.lineTo(8, 11);
    ctx.quadraticCurveTo(8, 14, 5, 14);
    ctx.lineTo(-5, 14);
    ctx.quadraticCurveTo(-8, 14, -8, 11);
    ctx.lineTo(-8, 2);
    ctx.quadraticCurveTo(-8, -5, -4, -8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(-5.5, -2, 1.8, 12);
    ctx.fillStyle = 'rgba(70,110,120,0.9)';
    ctx.fillRect(-4.6, -15, 9.2, 3);
  }

  _can(ctx) {
    const g = ctx.createLinearGradient(-7, 0, 7, 0);
    g.addColorStop(0, 'rgb(110,116,124)');
    g.addColorStop(0.4, 'rgb(214,220,228)');
    g.addColorStop(1, 'rgb(96,102,112)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-7, -11, 14, 22, 2.5) : ctx.rect(-7, -11, 14, 22);
    ctx.fill();
    ctx.fillStyle = 'rgba(190,70,60,0.7)';
    ctx.fillRect(-7, -3, 14, 6);
    ctx.strokeStyle = 'rgba(60,66,72,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, -11, 7, 2.2, 0, 0, TAU); ctx.stroke();
    // A crushed dent, so no two cans read as pristine.
    ctx.fillStyle = 'rgba(70,76,84,0.45)';
    ctx.beginPath(); ctx.ellipse(2, 4, 4, 2.5, 0.5, 0, TAU); ctx.fill();
  }

  _bag(ctx, t) {
    const w = Math.sin(t * 1.6 + this.phase) * 3;
    ctx.fillStyle = 'rgba(232,242,246,0.62)';
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-11, -6 + w * 0.3);
    ctx.quadraticCurveTo(-14, 4, -7, 12);
    ctx.quadraticCurveTo(0, 16 + w, 8, 11);
    ctx.quadraticCurveTo(14, 3, 10, -6 - w * 0.3);
    ctx.quadraticCurveTo(6, -10, 3, -5);
    ctx.quadraticCurveTo(0, -12, -3, -5);
    ctx.quadraticCurveTo(-7, -11, -11, -6 + w * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(200,225,235,0.5)';
    ctx.beginPath();
    ctx.moveTo(-5, -2); ctx.quadraticCurveTo(0, 6 + w * 0.5, 5, -1);
    ctx.stroke();
  }

  _rings(ctx) {
    ctx.strokeStyle = 'rgba(236,228,140,0.85)';
    ctx.lineWidth = 2.2;
    for (let i = 0; i < 6; i++) {
      const cx = (i % 3 - 1) * 8.5;
      const cy = (i < 3 ? -4.5 : 4.5);
      ctx.beginPath(); ctx.arc(cx, cy, 4.1, 0, TAU); ctx.stroke();
    }
  }

  _tyre(ctx) {
    const g = ctx.createRadialGradient(-4, -5, 3, 0, 0, 20);
    g.addColorStop(0, 'rgb(78,78,84)');
    g.addColorStop(1, 'rgb(26,26,30)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 19, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(0, 0, 9.5, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(12,12,16,0.75)';
    ctx.lineWidth = 2.6;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 11, Math.sin(a) * 11);
      ctx.lineTo(Math.cos(a) * 18, Math.sin(a) * 18);
      ctx.stroke();
    }
  }

  _drum(ctx) {
    const g = ctx.createLinearGradient(-14, 0, 14, 0);
    g.addColorStop(0, 'rgb(96,84,30)');
    g.addColorStop(0.4, 'rgb(196,176,64)');
    g.addColorStop(1, 'rgb(88,78,28)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-13, -19, 26, 38, 3) : ctx.rect(-13, -19, 26, 38);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,52,18,0.85)';
    ctx.lineWidth = 2;
    for (const y of [-9, 0, 9]) {
      ctx.beginPath(); ctx.moveTo(-13, y); ctx.lineTo(13, y); ctx.stroke();
    }
    // Hazard trefoil, roughed in.
    ctx.fillStyle = 'rgba(30,26,10,0.8)';
    ctx.beginPath(); ctx.arc(0, 0, 3.2, 0, TAU); ctx.fill();
    for (let i = 0; i < 3; i++) {
      const a = i * TAU / 3 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 8, a - 0.42, a + 0.42);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = 'rgba(150,180,70,0.35)';
    ctx.beginPath(); ctx.ellipse(11, -14, 6, 9, 0.4, 0, TAU); ctx.fill();
  }

  _net(ctx, t) {
    const sway = Math.sin(t * 0.8 + this.phase) * 2.4;
    ctx.strokeStyle = 'rgba(196,214,206,0.62)';
    ctx.lineWidth = 1.1;
    const R = 26;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 7, -R * 0.8);
      ctx.quadraticCurveTo(i * 7 + sway, 0, i * 7 + sway * 1.6, R * 0.8);
      ctx.stroke();
    }
    for (let j = -3; j <= 3; j++) {
      ctx.beginPath();
      ctx.moveTo(-R * 0.85, j * 7);
      ctx.quadraticCurveTo(sway, j * 7 + sway * 0.5, R * 0.85, j * 7);
      ctx.stroke();
    }
    // Floats along the head rope.
    ctx.fillStyle = 'rgba(220,120,90,0.8)';
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath(); ctx.arc(i * 10, -R * 0.85, 2.6, 0, TAU); ctx.fill();
    }
  }

  _micro(ctx) {
    const cols = ['rgba(240,150,180,0.85)', 'rgba(150,210,240,0.85)',
                  'rgba(245,225,140,0.85)', 'rgba(190,240,190,0.85)'];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + this.seed;
      const r = 2 + (i % 4) * 1.6;
      ctx.fillStyle = cols[i % 4];
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * r * 1.6, Math.sin(a) * r * 1.3, 1.5, 1.0, a, 0, TAU);
      ctx.fill();
    }
  }
}

/* ============================================================
   Trapped animals
   ============================================================ */

export const RESCUE = {
  TURTLE: { id: 'turtle', points: 220, r: 26, label: 'Turtle',  cut: 0.75 },
  SEAL:   { id: 'seal',   points: 260, r: 28, label: 'Seal',    cut: 0.9  },
  FISH:   { id: 'fish',   points: 180, r: 24, label: 'Reef fish', cut: 0.6 },
};

export class Trapped {
  constructor(kind, x, y, rng) {
    this.k = kind;
    this.x = x; this.y = y;
    this.hx = x; this.hy = y;
    this.phase = rng.float(0, TAU);
    this.struggle = 0;
    this.progress = 0;        // 0..1 cutting progress
    this.freed = false;
    this.alive = true;
    this.revealed = 0;
    this.pulse = 0;
    this.a = rng.float(-0.3, 0.3);
  }

  get radius() { return this.k.r; }

  update(dt, t) {
    if (!this.alive) return;
    // Struggle bursts: mostly still, then a sudden thrash. Reads as
    // distress far better than a constant wiggle.
    this.struggle = Math.max(0, this.struggle - dt * 1.4);
    if (Math.random() < dt * 0.55) this.struggle = 1;
    const s = this.struggle;
    this.x = this.hx + Math.sin(t * 9 + this.phase) * 2.6 * s;
    this.y = this.hy + Math.cos(t * 11 + this.phase) * 2.0 * s;
    this.a += Math.sin(t * 7 + this.phase) * 0.9 * s * dt;
    this.pulse = (this.pulse + dt * 2) % 1;

    // Cutting decays if you swim away, so it needs a committed pass.
    if (!this.freed && this.progress > 0) this.progress = Math.max(0, this.progress - dt * 0.25);
  }

  draw(ctx, gctx, t) {
    if (!this.alive) return;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.a);

    if (this.k === RESCUE.TURTLE) this._turtle(ctx, t);
    else if (this.k === RESCUE.SEAL) this._seal(ctx, t);
    else this._fish(ctx, t);

    // The trap itself, drawn over the animal.
    this._trap(ctx, t);
    ctx.restore();

    /* --- distress beacon: a slow pulsing ring, always visible --- */
    const beacon = 0.35 + 0.35 * Math.sin(t * 2.2 + this.phase);
    if (gctx) {
      gctx.strokeStyle = `rgba(255,190,120,${0.25 + beacon * 0.3 + this.revealed * 0.5})`;
      gctx.lineWidth = 2.6;
      gctx.beginPath();
      gctx.arc(this.x, this.y, this.radius + 12 + beacon * 9, 0, TAU);
      gctx.stroke();
    }

    /* --- cutting progress arc --- */
    if (this.progress > 0.01) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120,255,220,0.95)';
      ctx.lineWidth = 3.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius + 14, -Math.PI / 2, -Math.PI / 2 + this.progress * TAU);
      ctx.stroke();
      ctx.restore();
      if (gctx) {
        gctx.strokeStyle = 'rgba(120,255,220,0.8)';
        gctx.lineWidth = 4;
        gctx.beginPath();
        gctx.arc(this.x, this.y, this.radius + 14, -Math.PI / 2, -Math.PI / 2 + this.progress * TAU);
        gctx.stroke();
      }
    }
  }

  _turtle(ctx, t) {
    const f = Math.sin(t * 6 + this.phase) * this.struggle;
    ctx.fillStyle = 'rgb(62,96,70)';
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.rotate(s * (0.55 + f * 0.4 * s));
      ctx.beginPath(); ctx.ellipse(-3, s * 13, 15, 5.5, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(-4, -4, 2, 0, 0, 20);
    g.addColorStop(0, 'rgb(126,166,100)');
    g.addColorStop(1, 'rgb(54,86,60)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 15, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(30,52,36,0.7)';
    ctx.lineWidth = 1.2;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath(); ctx.ellipse(i * 8, 0, 4.4, 9, 0, 0, TAU); ctx.stroke();
    }
    ctx.fillStyle = 'rgb(100,138,86)';
    ctx.beginPath(); ctx.ellipse(20, 0, 7, 5.4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#0d1a14';
    ctx.beginPath(); ctx.arc(23, -1.8, 1.3, 0, TAU); ctx.fill();
  }

  _seal(ctx, t) {
    const f = Math.sin(t * 7 + this.phase) * this.struggle;
    const g = ctx.createLinearGradient(0, -11, 0, 11);
    g.addColorStop(0, 'rgb(88,94,102)');
    g.addColorStop(1, 'rgb(172,176,182)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, 23, 10.5, 0, 0, TAU); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-21, 0);
    ctx.lineTo(-31, -8 + f * 6);
    ctx.lineTo(-31, 8 + f * 6);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgb(104,110,118)';
    ctx.beginPath(); ctx.ellipse(21, -1, 8, 7, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#0b1016';
    ctx.beginPath(); ctx.arc(24, -3, 1.5, 0, TAU); ctx.fill();
  }

  _fish(ctx, t) {
    const f = Math.sin(t * 10 + this.phase) * this.struggle;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + this.phase;
      const rx = Math.cos(a) * 12, ry = Math.sin(a) * 9;
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(a + f * 0.4);
      ctx.fillStyle = ['rgb(250,180,70)', 'rgb(120,200,240)', 'rgb(240,120,150)', 'rgb(180,240,160)'][i];
      ctx.beginPath(); ctx.ellipse(0, 0, 8, 4.4, 0, 0, TAU); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-7, 0); ctx.lineTo(-13, -4); ctx.lineTo(-13, 4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  _trap(ctx, t) {
    const cut = this.progress;
    ctx.save();
    ctx.globalAlpha = 1 - cut * 0.55;
    if (this.k === RESCUE.TURTLE) {
      ctx.strokeStyle = 'rgba(240,232,150,0.95)';
      ctx.lineWidth = 2.6;
      for (let i = 0; i < 4; i++) {
        const cx = (i % 2 ? 1 : -1) * 9;
        const cy = (i < 2 ? -6 : 7);
        ctx.beginPath(); ctx.arc(cx, cy, 6.5, 0, TAU); ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(-16, -10); ctx.quadraticCurveTo(0, -16, 16, -9);
      ctx.stroke();
    } else {
      // Ghost netting wrapped around the animal.
      ctx.strokeStyle = 'rgba(214,228,222,0.8)';
      ctx.lineWidth = 1.3;
      for (let i = -4; i <= 4; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 7, -17);
        ctx.quadraticCurveTo(i * 7 + Math.sin(t + i) * 3, 0, i * 7, 17);
        ctx.stroke();
      }
      for (let j = -2; j <= 2; j++) {
        ctx.beginPath();
        ctx.moveTo(-30, j * 8);
        ctx.quadraticCurveTo(0, j * 8 + Math.sin(t * 1.3 + j) * 3, 30, j * 8);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/* ============================================================
   Field manager — spawning, culling and collection
   ============================================================ */

export class TrashField {
  constructor(world, seed = 777) {
    this.world = world;
    this.rng = new RNG(seed);
    this.items = [];
    this.trapped = [];
    this.totalSpawned = 0;
    this.collectedCount = 0;
    this.rescuedCount = 0;
    this._populate();
  }

  _populate() {
    const r = this.rng;
    const W = this.world.width;

    /* --- seabed litter, denser near the outfall pipes --- */
    for (let x = 200; x < W - 200; x += 45 + r.float(0, 90)) {
      const fy = this.world.floorAt(x);
      const depth01 = fy / this.world.maxDepth;

      const pick = r.weighted([
        { w: 26, k: KIND.BOTTLE },
        { w: 22, k: KIND.CAN },
        { w: 14, k: KIND.RINGS },
        { w: 12, k: KIND.MICRO },
        { w: 10 + depth01 * 8, k: KIND.TYRE },
        { w: 5 + depth01 * 12, k: KIND.DRUM },
        { w: 4 + depth01 * 8, k: KIND.NET },
      ]).k;

      const y = fy - pick.r * 0.75 - r.float(0, 8);
      this.items.push(new Trash(pick, x, y, r, true));
    }

    /* --- drifting litter through the water column --- */
    for (let i = 0; i < 260; i++) {
      const x = r.float(200, W - 200);
      const fy = this.world.floorAt(x);
      const y = r.float(40, Math.max(120, fy - 60));
      const pick = r.weighted([
        { w: 40, k: KIND.BAG },
        { w: 22, k: KIND.BOTTLE },
        { w: 14, k: KIND.MICRO },
        { w: 8,  k: KIND.RINGS },
        { w: 6,  k: KIND.NET },
      ]).k;
      this.items.push(new Trash(pick, x, y, r, false));
    }

    this.items.sort((a, b) => a.hx - b.hx);
    this.totalSpawned = this.items.length;

    /* --- trapped animals, spread out so each is an event --- */
    const count = 26;
    for (let i = 0; i < count; i++) {
      const x = 500 + (i / count) * (W - 1000) + r.gauss(0, 220);
      const fy = this.world.floorAt(x);
      const kind = r.weighted([
        { w: 4, k: RESCUE.TURTLE },
        { w: 3, k: RESCUE.SEAL },
        { w: 3, k: RESCUE.FISH },
      ]).k;
      const y = r.bool(0.55) ? fy - 46 - r.float(0, 30) : r.float(140, Math.max(200, fy - 120));
      this.trapped.push(new Trapped(kind, clamp(x, 300, W - 300), y, r));
    }
    this.trapped.sort((a, b) => a.hx - b.hx);

    this._rebuildBuckets();
  }

  _rebuildBuckets() {
    this.bucketSize = 600;
    this.buckets = new Map();
    for (const it of this.items) {
      if (!it.alive) continue;
      const b = Math.floor(it.hx / this.bucketSize);
      if (!this.buckets.has(b)) this.buckets.set(b, []);
      this.buckets.get(b).push(it);
    }
  }

  *near(x, range) {
    const b0 = Math.floor((x - range) / this.bucketSize);
    const b1 = Math.floor((x + range) / this.bucketSize);
    for (let b = b0; b <= b1; b++) {
      const arr = this.buckets.get(b);
      if (!arr) continue;
      for (const it of arr) if (it.alive) yield it;
    }
  }

  get remaining() { return this.totalSpawned - this.collectedCount; }
  get cleanRatio() { return this.totalSpawned ? this.collectedCount / this.totalSpawned : 0; }

  /**
   * Advance everything in view and resolve pickups.
   * Returns a list of events for the game layer to score and sound.
   */
  update(dt, t, dolphin, bounds, particles) {
    const events = [];
    const nose = dolphin.nose();
    const grabR = 46;
    const magnetR = 132;

    for (const it of this.near(dolphin.x, 900)) {
      it.update(dt, t, this.world);
      if (it.revealed > 0) it.revealed = Math.max(0, it.revealed - dt * 0.32);

      const dx = nose.x - it.x, dy = nose.y - it.y;
      const d = Math.hypot(dx, dy);

      if (d < magnetR) {
        // Ease in the pull so items lean toward you before they leap.
        const pull = smoothstep(1 - d / magnetR);
        it.pull = pull;
        const k = pull * pull * 620 * dt;
        it.hx += (dx / (d || 1)) * k;
        it.hy += (dy / (d || 1)) * k;
      } else if (it.pull > 0) {
        it.pull = Math.max(0, it.pull - dt * 2);
      }

      if (d < grabR + it.radius * 0.5) {
        it.alive = false;
        this.collectedCount++;
        events.push({ type: 'collect', item: it, x: it.x, y: it.y });
        particles.burst(it.x, it.y, 9, {
          speed: 130, col: it.k.col, life: 0.5, r: 1.8,
          vx: dolphin.vx * 0.12, vy: dolphin.vy * 0.12,
        });
        particles.burst(it.x, it.y, 5, { speed: 60, col: [255, 255, 255], life: 0.35, r: 1.2 });
      }
    }

    /* --- rescues --- */
    for (const tr of this.trapped) {
      if (!tr.alive) continue;
      if (tr.hx < bounds.x0 - 700 || tr.hx > bounds.x1 + 700) continue;
      tr.update(dt, t);
      if (tr.revealed > 0) tr.revealed = Math.max(0, tr.revealed - dt * 0.32);

      const d = Math.min(
        Math.hypot(nose.x - tr.x, nose.y - tr.y),
        Math.hypot(dolphin.x - tr.x, dolphin.y - tr.y)
      );
      if (d < tr.radius + 56) {
        // Cutting is faster if you're moving — you're slicing with speed.
        // Tuned so one committed pass at speed nearly frees an animal and a
        // second finishes it, while stopping alongside frees it in ~0.5 s.
        const rate = (1.5 + clamp01(dolphin.speed / 420) * 0.9) / tr.k.cut;
        tr.progress = Math.min(1, tr.progress + dt * rate);
        if (Math.random() < dt * 22) {
          particles.spark(tr.x + (Math.random() - 0.5) * 40, tr.y + (Math.random() - 0.5) * 40,
            { speed: 40, col: [180, 255, 230], life: 0.4, r: 1.2 });
        }
        if (tr.progress >= 1 && !tr.freed) {
          tr.freed = true;
          tr.alive = false;
          this.rescuedCount++;
          events.push({ type: 'rescue', animal: tr, x: tr.x, y: tr.y });
          particles.burst(tr.x, tr.y, 26, { speed: 190, col: [255, 220, 150], life: 1.0, r: 2.4 });
          for (let i = 0; i < 8; i++) particles.heart(tr.x + (Math.random() - 0.5) * 40, tr.y);
        }
      }
    }

    // `near()` already skips dead items, so a rebuild is only ever a
    // compaction. Doing it per pickup walked all 400+ items several
    // times a second during a combo; once every few seconds is plenty.
    this._compactTimer = (this._compactTimer || 0) - dt;
    if (this._compactTimer <= 0) { this._compactTimer = 5; this._rebuildBuckets(); }
    return events;
  }

  draw(ctx, gctx, bounds, t, health) {
    for (const it of this.items) {
      if (!it.alive) continue;
      if (it.x < bounds.x0 - 60 || it.x > bounds.x1 + 60) continue;
      if (it.y < bounds.y0 - 60 || it.y > bounds.y1 + 60) continue;
      it.draw(ctx, gctx, t, health);
    }
    for (const tr of this.trapped) {
      if (!tr.alive) continue;
      if (tr.x < bounds.x0 - 80 || tr.x > bounds.x1 + 80) continue;
      if (tr.y < bounds.y0 - 80 || tr.y > bounds.y1 + 80) continue;
      tr.draw(ctx, gctx, t);
    }
  }

  /** Sonar sweep: light up everything inside the expanding ring. */
  reveal(x, y, radius) {
    let hits = 0;
    for (const it of this.near(x, radius + 60)) {
      if (Math.hypot(it.x - x, it.y - y) < radius) { it.revealed = 1; hits++; }
    }
    for (const tr of this.trapped) {
      if (!tr.alive) continue;
      if (Math.hypot(tr.x - x, tr.y - y) < radius) { tr.revealed = 1; hits++; }
    }
    return hits;
  }
}
