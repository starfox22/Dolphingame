/* ============================================================
   world.js — the ocean itself.

   Coordinates: x runs left→right across a finite sea, y is depth
   with 0 at the waterline and positive downward. The seabed is a
   sampled height curve; everything that sits on the bottom is
   placed against it at generation time.

   The world also carries the "healing" state. Every prop has a
   grime factor that fades as ocean health rises, which is the
   whole emotional payoff of the game: the place you are cleaning
   visibly comes back to life.
   ============================================================ */

import { RNG } from '../core/rng.js';
import { TAU, clamp, clamp01, lerp, smoothstep, fbm1, noise1, mixRGB, rgb, rgba } from '../core/math.js';

export const WORLD_W = 14000;
export const MAX_DEPTH = 2600;

export const ZONES = [
  { at: 0,    name: 'SUNLIT SHALLOWS', tint: [ 90, 220, 220] },
  { at: 380,  name: 'CORAL GARDENS',   tint: [ 70, 200, 210] },
  { at: 820,  name: 'THE KELP FOREST', tint: [ 40, 160, 170] },
  { at: 1300, name: 'TWILIGHT REEF',   tint: [ 24, 100, 140] },
  { at: 1820, name: 'THE MIDNIGHT SHELF', tint: [ 14,  56,  98] },
  { at: 2250, name: 'ABYSSAL TRENCH',  tint: [  8,  26,  56] },
];

export function zoneAt(depth) {
  let z = ZONES[0];
  for (const s of ZONES) if (depth >= s.at) z = s;
  return z;
}

/* Coral palettes — first entry is the polluted/bleached look,
   second is the healthy one. Healing lerps between them. */
const CORAL_COLORS = [
  { sick: [128, 120, 104], well: [255, 118,  96] },
  { sick: [118, 116, 108], well: [255, 176,  84] },
  { sick: [110, 114, 110], well: [180, 120, 255] },
  { sick: [122, 122, 112], well: [ 92, 226, 190] },
  { sick: [126, 118, 106], well: [255, 108, 168] },
  { sick: [114, 118, 114], well: [120, 190, 255] },
];

const PROP = {
  KELP: 0, FAN: 1, TUBE: 2, BRAIN: 3, ROCK: 4, ANEMONE: 5,
  WRECK: 6, PIPE: 7, GLOW_POD: 8, URCHIN: 9, SEAGRASS: 10, ARCH: 11,
};

export class World {
  constructor(seed = 4242) {
    this.rng = new RNG(seed);
    this.seed = seed;
    this.width = WORLD_W;
    this.maxDepth = MAX_DEPTH;
    this.health = 0;         // 0..1 — drives every "healing" visual
    this.time = 0;

    this._buildTerrain();
    this._buildProps();
    this._buildBackdrop();
  }

  /* ---------------------------------------------------------- */
  /* Terrain                                                     */
  /* ---------------------------------------------------------- */

  _buildTerrain() {
    this.step = 40;
    this.n = Math.ceil(WORLD_W / this.step) + 1;
    this.floor = new Float32Array(this.n);

    for (let i = 0; i < this.n; i++) {
      const x = i * this.step;
      const u = x / WORLD_W;

      // Large-scale basin: shallow shelves at both ends, deep in
      // the middle-right, so swimming outward means going deeper.
      const basin = 640 + Math.sin(u * Math.PI * 0.92) * 900 + u * 620;

      // Ridges and trenches on top of the basin.
      const ridges = fbm1(x * 0.00055 + 11.3, 4) * 380;
      const detail = fbm1(x * 0.0032 + 71.9, 3) * 92;

      // Occasional dramatic trench — a hard, narrow dip.
      const tr = noise1(x * 0.00021 + 5.5);
      const trench = tr > 0.52 ? Math.pow((tr - 0.52) / 0.48, 1.6) * 620 : 0;

      this.floor[i] = clamp(basin + ridges + detail + trench, 260, MAX_DEPTH - 40);
    }

    // A couple of smoothing passes so the dolphin never catches on
    // single-sample spikes.
    for (let pass = 0; pass < 2; pass++) {
      const cp = this.floor.slice();
      for (let i = 1; i < this.n - 1; i++) {
        this.floor[i] = (cp[i - 1] + cp[i] * 2 + cp[i + 1]) * 0.25;
      }
    }
  }

  /** Seabed depth at world x, linearly interpolated. */
  floorAt(x) {
    const f = clamp(x, 0, WORLD_W - 1) / this.step;
    const i = f | 0;
    const j = Math.min(i + 1, this.n - 1);
    return lerp(this.floor[i], this.floor[j], f - i);
  }

  /** Outward surface normal of the seabed at x (unit vector). */
  floorNormal(x) {
    const d = 18;
    const dy = this.floorAt(x + d) - this.floorAt(x - d);
    const len = Math.hypot(2 * d, dy) || 1;
    return { x: dy / len, y: -(2 * d) / len };
  }

  /* ---------------------------------------------------------- */
  /* Props                                                       */
  /* ---------------------------------------------------------- */

  _buildProps() {
    const r = this.rng;
    this.props = [];

    for (let x = 60; x < WORLD_W - 60; ) {
      const fy = this.floorAt(x);
      const depth01 = fy / MAX_DEPTH;
      const slope = Math.abs(this.floorAt(x + 40) - this.floorAt(x - 40)) / 80;

      // Which flora belongs at this depth?
      const table = [];
      table.push({ w: 26 * (1 - depth01) + 4, k: PROP.KELP });
      table.push({ w: 22 * smoothstep(1 - Math.abs(depth01 - 0.22) * 3), k: PROP.FAN });
      table.push({ w: 16 * smoothstep(1 - Math.abs(depth01 - 0.3) * 3), k: PROP.TUBE });
      table.push({ w: 14 * smoothstep(1 - Math.abs(depth01 - 0.18) * 3), k: PROP.BRAIN });
      table.push({ w: 18, k: PROP.ROCK });
      table.push({ w: 12 * (1 - depth01 * 0.6), k: PROP.ANEMONE });
      table.push({ w: 10 * (1 - depth01), k: PROP.SEAGRASS });
      table.push({ w: 26 * Math.pow(depth01, 3), k: PROP.GLOW_POD });
      table.push({ w: 8 * depth01, k: PROP.URCHIN });

      const pick = r.weighted(table.filter(t => t.w > 0.1));
      const kind = pick ? pick.k : PROP.ROCK;

      // Steep faces get rocks, not gardens.
      const finalKind = slope > 1.5 && kind !== PROP.ROCK && r.bool(0.6) ? PROP.ROCK : kind;

      this.props.push(this._makeProp(finalKind, x, fy, depth01, r));
      x += 14 + r.float(0, 48);
    }

    // Landmarks: a wreck, some arches, and industrial outfall pipes.
    const landmarkCount = 16;
    for (let i = 0; i < landmarkCount; i++) {
      const x = 400 + (i / landmarkCount) * (WORLD_W - 800) + r.gauss(0, 180);
      const fy = this.floorAt(x);
      const kind = r.weighted([
        { w: 3, k: PROP.WRECK },
        { w: 4, k: PROP.ARCH },
        { w: 3, k: PROP.PIPE },
      ]).k;
      this.props.push(this._makeProp(kind, x, fy, fy / MAX_DEPTH, r));
    }

    this.props.sort((a, b) => a.x - b.x);

    // Bucket by x for cheap view culling.
    this.bucketSize = 500;
    this.buckets = new Map();
    for (const p of this.props) {
      const b = Math.floor(p.x / this.bucketSize);
      if (!this.buckets.has(b)) this.buckets.set(b, []);
      this.buckets.get(b).push(p);
    }
  }

  _makeProp(kind, x, y, depth01, r) {
    const p = {
      kind, x, y,
      seed: r.float(0, 1000),
      scale: 1,
      grime: clamp01(0.45 + r.float(0, 0.55)),
      pal: CORAL_COLORS[r.int(0, CORAL_COLORS.length)],
      sway: r.float(0.5, 1.5),
      phase: r.float(0, TAU),
      layer: r.bool(0.35) ? 1 : 0,     // 1 = slightly behind, adds depth
    };
    switch (kind) {
      case PROP.KELP:
        p.h = 120 + r.float(0, 320) * (1 - depth01 * 0.55);
        p.segs = Math.max(5, Math.round(p.h / 34));
        p.thick = 3 + r.float(0, 4);
        break;
      case PROP.SEAGRASS:
        p.h = 30 + r.float(0, 60);
        p.blades = r.int(6, 14);
        break;
      case PROP.FAN:
        p.h = 40 + r.float(0, 110);
        p.spread = r.float(0.6, 1.5);
        p.ribs = r.int(6, 13);
        p.tiltA = r.gauss(0, 0.35);
        break;
      case PROP.TUBE:
        p.count = r.int(3, 8);
        p.h = 22 + r.float(0, 60);
        break;
      case PROP.BRAIN:
        p.rad = 16 + r.float(0, 34);
        break;
      case PROP.ROCK:
        p.rad = 20 + r.float(0, 90);
        p.pts = r.int(7, 12);
        break;
      case PROP.ANEMONE:
        p.rad = 9 + r.float(0, 16);
        p.arms = r.int(11, 22);
        break;
      case PROP.URCHIN:
        p.rad = 8 + r.float(0, 12);
        p.spines = r.int(14, 24);
        break;
      case PROP.GLOW_POD:
        p.rad = 6 + r.float(0, 14);
        p.pods = r.int(3, 8);
        p.h = 30 + r.float(0, 70);
        break;
      case PROP.WRECK:
        p.len = 220 + r.float(0, 260);
        p.tilt = r.gauss(0, 0.22);
        break;
      case PROP.ARCH:
        p.w = 150 + r.float(0, 220);
        p.h = 90 + r.float(0, 160);
        break;
      case PROP.PIPE:
        p.len = 90 + r.float(0, 150);
        p.rad = 14 + r.float(0, 16);
        break;
    }
    return p;
  }

  /** Parallax silhouettes far behind the playfield. */
  _buildBackdrop() {
    const r = new RNG(this.seed ^ 0x5f5f);
    this.backLayers = [];
    for (let l = 0; l < 3; l++) {
      const pts = [];
      const par = 0.30 + l * 0.20;               // parallax factor
      const span = WORLD_W * par + 4000;
      const step = 260 - l * 60;
      for (let x = -2000; x < span + 2000; x += step) {
        const base = 900 + l * 260;
        const h = base + fbm1(x * 0.0009 + l * 33, 3) * (520 - l * 120);
        pts.push({ x, y: clamp(h, 380, MAX_DEPTH) });
      }
      this.backLayers.push({ par, pts, alpha: 0.55 - l * 0.13 });
    }
  }

  /* ---------------------------------------------------------- */
  /* Update                                                      */
  /* ---------------------------------------------------------- */

  update(dt) { this.time += dt; }

  /** Current flowing through the water at a point — pushes the dolphin. */
  currentAt(x, y, t) {
    const s = 0.0012;
    const a = noise1(x * s + y * s * 0.6 + t * 0.05) * Math.PI * 2;
    const strength = 12 + noise1(x * 0.0004 - t * 0.02) * 16;
    const depthGain = clamp01(y / 600);
    return {
      x: Math.cos(a) * strength * depthGain,
      y: Math.sin(a) * strength * 0.45 * depthGain,
    };
  }

  /* ---------------------------------------------------------- */
  /* Drawing                                                     */
  /* ---------------------------------------------------------- */

  /** Colour of a prop, blended from bleached to vivid by health. */
  _propColor(p) {
    const heal = clamp01(this.health * 1.25 - p.grime * 0.35);
    return mixRGB(p.pal.sick, p.pal.well, heal);
  }

  drawBackdrop(ctx, cam, bounds) {
    for (let l = this.backLayers.length - 1; l >= 0; l--) {
      const layer = this.backLayers[l];
      const par = layer.par;
      // Parallax by shifting sample space; the layer is drawn in
      // world coords so the camera transform still applies.
      const ox = cam.x * (1 - par);
      const oy = cam.y * (1 - par) * 0.25;

      ctx.beginPath();
      const x0 = bounds.x0 - 400, x1 = bounds.x1 + 400;
      const vis = [];
      for (const pt of layer.pts) {
        const wx = pt.x + ox;
        if (wx < x0 - 800 || wx > x1 + 800) continue;
        vis.push({ x: wx, y: pt.y + oy });
      }
      if (vis.length < 2) continue;
      // Midpoint-quadratic smoothing: the sample step is coarse enough
      // that straight segments would show as facets on a distant ridge.
      ctx.moveTo(vis[0].x, vis[0].y);
      for (let i = 1; i < vis.length - 1; i++) {
        const a = vis[i], b = vis[i + 1];
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      ctx.lineTo(vis[vis.length - 1].x, vis[vis.length - 1].y);
      ctx.lineTo(bounds.x1 + 800, MAX_DEPTH + 400);
      ctx.lineTo(bounds.x0 - 800, MAX_DEPTH + 400);
      ctx.closePath();

      const g = ctx.createLinearGradient(0, 500, 0, MAX_DEPTH);
      const heal = this.health;
      g.addColorStop(0, `rgba(${12 + heal * 16},${58 + heal * 26},${86 + heal * 10},${layer.alpha})`);
      g.addColorStop(1, `rgba(3,14,32,${layer.alpha})`);
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  drawTerrain(ctx, cam, bounds) {
    const step = this.step;
    const i0 = Math.max(0, Math.floor((bounds.x0 - step) / step));
    const i1 = Math.min(this.n - 1, Math.ceil((bounds.x1 + step) / step));

    ctx.beginPath();
    ctx.moveTo(i0 * step, this.floor[i0]);
    for (let i = i0; i <= i1; i++) ctx.lineTo(i * step, this.floor[i]);
    ctx.lineTo(i1 * step, MAX_DEPTH + 600);
    ctx.lineTo(i0 * step, MAX_DEPTH + 600);
    ctx.closePath();

    const heal = this.health;
    const g = ctx.createLinearGradient(0, Math.max(200, bounds.y0), 0, MAX_DEPTH + 200);
    g.addColorStop(0, `rgb(${72 + heal * 30},${80 + heal * 36},${66 + heal * 18})`);
    g.addColorStop(0.42, `rgb(${34 + heal * 14},${44 + heal * 18},${48 + heal * 8})`);
    g.addColorStop(1, 'rgb(5,11,22)');
    ctx.fillStyle = g;
    ctx.fill();

    // Lit rim along the seabed edge — reads as sunlight grazing sand.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(i0 * step, this.floor[i0]);
    for (let i = i0; i <= i1; i++) ctx.lineTo(i * step, this.floor[i]);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(${140 + heal * 60},${190 + heal * 40},${170 + heal * 40},0.20)`;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = `rgba(200,240,225,0.14)`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // Strata: bands of older sediment following the floor contour.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(i0 * step, this.floor[i0]);
    for (let i = i0; i <= i1; i++) ctx.lineTo(i * step, this.floor[i]);
    ctx.lineTo(i1 * step, MAX_DEPTH + 600);
    ctx.lineTo(i0 * step, MAX_DEPTH + 600);
    ctx.closePath();
    ctx.clip();
    for (let band = 1; band <= 4; band++) {
      const drop = band * 46 + band * band * 9;
      ctx.beginPath();
      ctx.moveTo(i0 * step, this.floor[i0] + drop);
      for (let i = i0; i <= i1; i++) {
        ctx.lineTo(i * step, this.floor[i] + drop + noise1(i * 0.13 + band * 7) * 12);
      }
      ctx.strokeStyle = band % 2 ? 'rgba(255,246,220,0.045)' : 'rgba(0,0,0,0.09)';
      ctx.lineWidth = 5 + band * 2.5;
      ctx.stroke();
    }

    // Sediment speckle so the floor isn't a flat gradient.
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = '#e6f0d8';
    for (let i = i0; i <= i1; i++) {
      const x = i * step;
      const y = this.floor[i];
      for (let k = 0; k < 3; k++) {
        const n = noise1(x * 0.05 + k * 31.7);
        if (n > 0.1) {
          const r = 0.9 + n * 2.0;
          ctx.fillRect(x + n * 32 + k * 11, y + 3 + n * 26 + k * 9, r, r);
        }
      }
    }
    ctx.restore();
  }

  /** Iterate props overlapping the view. */
  *visibleProps(bounds) {
    const b0 = Math.floor((bounds.x0 - 400) / this.bucketSize);
    const b1 = Math.floor((bounds.x1 + 400) / this.bucketSize);
    for (let b = b0; b <= b1; b++) {
      const arr = this.buckets.get(b);
      if (!arr) continue;
      for (const p of arr) yield p;
    }
  }

  drawProps(ctx, gctx, cam, bounds, layer) {
    const t = this.time;
    for (const p of this.visibleProps(bounds)) {
      if (p.layer !== layer) continue;
      if (p.y < bounds.y0 - 500 || p.y > bounds.y1 + 500) continue;

      ctx.save();
      if (layer === 1) ctx.globalAlpha = 0.62;
      switch (p.kind) {
        case PROP.KELP:     this._kelp(ctx, p, t); break;
        case PROP.SEAGRASS: this._seagrass(ctx, p, t); break;
        case PROP.FAN:      this._fan(ctx, p, t); break;
        case PROP.TUBE:     this._tube(ctx, p, t); break;
        case PROP.BRAIN:    this._brain(ctx, p, t); break;
        case PROP.ROCK:     this._rock(ctx, p); break;
        case PROP.ANEMONE:  this._anemone(ctx, gctx, p, t); break;
        case PROP.URCHIN:   this._urchin(ctx, p); break;
        case PROP.GLOW_POD: this._glowPod(ctx, gctx, p, t); break;
        case PROP.WRECK:    this._wreck(ctx, p); break;
        case PROP.ARCH:     this._arch(ctx, p); break;
        case PROP.PIPE:     this._pipe(ctx, gctx, p, t); break;
      }
      ctx.restore();
    }
  }

  /* ---- individual prop renderers ---- */

  _swayAt(p, t, k) {
    // k = 0 at the holdfast, 1 at the tip.
    return Math.sin(t * 0.7 * p.sway + p.phase + k * 1.9) * (10 + k * 26) * k;
  }

  _kelp(ctx, p, t) {
    const col = this._propColor(p);
    const green = mixRGB([56, 74, 48], [72, 168, 96], clamp01(this.health));
    const segs = p.segs;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    const pts = [];
    for (let i = 1; i <= segs; i++) {
      const k = i / segs;
      const x = p.x + this._swayAt(p, t, k);
      const y = p.y - p.h * k;
      pts.push({ x, y, k });
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(green, 0.92);
    ctx.lineWidth = p.thick;
    ctx.stroke();

    // Blades: little leaves alternating along the stalk.
    ctx.fillStyle = rgba(mixRGB(green, [140, 220, 140], 0.35), 0.7);
    for (let i = 0; i < pts.length; i += 2) {
      const q = pts[i];
      const dir = i % 4 === 0 ? 1 : -1;
      const bl = 12 + q.k * 22;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.quadraticCurveTo(q.x + dir * bl, q.y - bl * 0.5, q.x + dir * bl * 0.4, q.y - bl * 1.2);
      ctx.quadraticCurveTo(q.x + dir * bl * 0.15, q.y - bl * 0.5, q.x, q.y);
      ctx.fill();
    }
  }

  _seagrass(ctx, p, t) {
    const green = mixRGB([64, 82, 54], [96, 190, 110], clamp01(this.health));
    ctx.strokeStyle = rgba(green, 0.78);
    ctx.lineCap = 'round';
    for (let i = 0; i < p.blades; i++) {
      const ox = (i / p.blades - 0.5) * 26;
      const h = p.h * (0.6 + ((i * 37) % 10) / 14);
      ctx.beginPath();
      ctx.moveTo(p.x + ox, p.y);
      ctx.quadraticCurveTo(
        p.x + ox + Math.sin(t * 1.1 + p.phase + i) * 8, p.y - h * 0.6,
        p.x + ox + Math.sin(t * 1.1 + p.phase + i) * 16, p.y - h
      );
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  _fan(ctx, p, t) {
    const col = this._propColor(p);
    const wob = Math.sin(t * 0.55 * p.sway + p.phase) * 0.07;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tiltA + wob);
    ctx.strokeStyle = rgba(col, 0.85);
    ctx.lineCap = 'round';
    for (let i = 0; i < p.ribs; i++) {
      const a = -Math.PI / 2 + (i / (p.ribs - 1) - 0.5) * p.spread;
      const len = p.h * (0.65 + 0.35 * Math.cos((i / (p.ribs - 1) - 0.5) * Math.PI));
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(Math.cos(a) * len * 0.4, Math.sin(a) * len * 0.55,
                           Math.cos(a) * len, Math.sin(a) * len);
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
    // Webbing between the ribs.
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let i = 0; i < p.ribs; i++) {
      const a = -Math.PI / 2 + (i / (p.ribs - 1) - 0.5) * p.spread;
      const len = p.h * (0.65 + 0.35 * Math.cos((i / (p.ribs - 1) - 0.5) * Math.PI));
      ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    }
    ctx.closePath();
    ctx.fillStyle = rgb(col);
    ctx.fill();
    ctx.restore();
  }

  _tube(ctx, p, t) {
    const col = this._propColor(p);
    for (let i = 0; i < p.count; i++) {
      const ox = (i / Math.max(1, p.count - 1) - 0.5) * 34;
      const h = p.h * (0.5 + ((i * 53) % 9) / 12);
      const lean = Math.sin(t * 0.5 + p.phase + i) * 3;
      ctx.beginPath();
      ctx.moveTo(p.x + ox - 4, p.y);
      ctx.quadraticCurveTo(p.x + ox - 4 + lean, p.y - h * 0.6, p.x + ox - 3 + lean, p.y - h);
      ctx.lineTo(p.x + ox + 3 + lean, p.y - h);
      ctx.quadraticCurveTo(p.x + ox + 4 + lean, p.y - h * 0.6, p.x + ox + 4, p.y);
      ctx.closePath();
      ctx.fillStyle = rgba(col, 0.88);
      ctx.fill();
      ctx.fillStyle = rgba([255, 255, 255], 0.16);
      ctx.beginPath();
      ctx.ellipse(p.x + ox + lean, p.y - h, 3.4, 1.5, 0, 0, TAU);
      ctx.fill();
    }
  }

  _brain(ctx, p) {
    const col = this._propColor(p);
    const r = p.rad;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - r * 0.55, r, r * 0.72, 0, Math.PI, TAU);
    ctx.closePath();
    const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.9, r * 0.1, p.x, p.y - r * 0.5, r * 1.2);
    g.addColorStop(0, rgb(mixRGB(col, [255, 255, 255], 0.3)));
    g.addColorStop(1, rgb(mixRGB(col, [0, 0, 0], 0.35)));
    ctx.fillStyle = g;
    ctx.fill();
    // Grooves.
    ctx.strokeStyle = rgba(mixRGB(col, [0, 0, 0], 0.5), 0.5);
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 5; i++) {
      const yy = p.y - r * 0.2 - i * r * 0.2;
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.9, yy);
      ctx.quadraticCurveTo(p.x, yy - r * 0.16, p.x + r * 0.9, yy);
      ctx.stroke();
    }
  }

  _rock(ctx, p) {
    const r = p.rad;
    const heal = this.health;
    ctx.beginPath();
    for (let i = 0; i <= p.pts; i++) {
      const a = Math.PI + (i / p.pts) * Math.PI;
      const rr = r * (0.62 + noise1(p.seed + i * 1.7) * 0.5);
      const x = p.x + Math.cos(a) * rr;
      const y = p.y + Math.sin(a) * rr * 0.85;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(p.x, p.y - r, p.x, p.y);
    g.addColorStop(0, `rgb(${58 + heal * 14},${70 + heal * 20},${74 + heal * 10})`);
    g.addColorStop(1, 'rgb(20,28,36)');
    ctx.fillStyle = g;
    ctx.fill();
    // Algae fuzz on top once the water is healthy.
    if (heal > 0.2) {
      ctx.globalAlpha = (heal - 0.2) * 0.5;
      ctx.strokeStyle = 'rgb(96,180,110)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.7, p.y - r * 0.42);
      ctx.quadraticCurveTo(p.x, p.y - r * 0.72, p.x + r * 0.7, p.y - r * 0.4);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  _anemone(ctx, gctx, p, t) {
    const col = this._propColor(p);
    const heal = clamp01(this.health);
    for (let i = 0; i < p.arms; i++) {
      const a = -Math.PI / 2 + (i / (p.arms - 1) - 0.5) * 2.5;
      const wig = Math.sin(t * 1.6 + p.phase + i * 0.7) * 0.22;
      const len = p.rad * (1.1 + 0.5 * Math.cos((i / p.arms - 0.5) * Math.PI));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(
        p.x + Math.cos(a + wig) * len * 0.5, p.y + Math.sin(a + wig) * len * 0.5,
        p.x + Math.cos(a + wig * 2) * len, p.y + Math.sin(a + wig * 2) * len
      );
      ctx.strokeStyle = rgba(col, 0.7);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    if (gctx && heal > 0.3) {
      gctx.fillStyle = rgba(col, (heal - 0.3) * 0.14);
      gctx.beginPath(); gctx.arc(p.x, p.y - p.rad * 0.4, p.rad * 1.1, 0, TAU); gctx.fill();
    }
  }

  _urchin(ctx, p) {
    const r = p.rad;
    ctx.strokeStyle = 'rgba(58,42,72,0.92)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < p.spines; i++) {
      const a = Math.PI + (i / p.spines) * Math.PI;
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(a) * r * 0.4, p.y + Math.sin(a) * r * 0.4);
      ctx.lineTo(p.x + Math.cos(a) * r * 1.9, p.y + Math.sin(a) * r * 1.9);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgb(72,48,88)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - r * 0.2, r * 0.75, r * 0.55, 0, Math.PI, TAU);
    ctx.fill();
  }

  _glowPod(ctx, gctx, p, t) {
    // Bioluminescent stalks: the only real light source in the deep.
    const pulse = 0.55 + 0.45 * Math.sin(t * 1.1 + p.phase);
    const col = [120, 235, 255];
    for (let i = 0; i < p.pods; i++) {
      const k = (i + 1) / p.pods;
      const ox = Math.sin(p.seed + i * 2.1) * 22;
      const y = p.y - p.h * k;
      const x = p.x + ox + Math.sin(t * 0.6 + p.phase + k * 2) * 6;
      const r = p.rad * (0.4 + k * 0.6) * (0.85 + pulse * 0.3);

      ctx.strokeStyle = 'rgba(70,120,130,0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(p.x + ox * 0.4, p.y - p.h * k * 0.6, x, y);
      ctx.stroke();

      // Hot core, soft halo — a flat disc reads as a bubble, not light.
      const lg = ctx.createRadialGradient(x, y, 0, x, y, r * 1.5);
      lg.addColorStop(0, `rgba(226,255,255,${0.75 + pulse * 0.25})`);
      lg.addColorStop(0.3, rgba(col, 0.55 + pulse * 0.3));
      lg.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, TAU); ctx.fill();
      if (gctx) {
        gctx.fillStyle = rgba(col, 0.14 * pulse + 0.05);
        gctx.beginPath(); gctx.arc(x, y, r * 1.5, 0, TAU); gctx.fill();
      }
    }
  }

  _wreck(ctx, p) {
    const L = p.len, H = L * 0.28;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt);
    // Hull.
    ctx.beginPath();
    ctx.moveTo(-L / 2, -H);
    ctx.quadraticCurveTo(-L * 0.56, 0, -L * 0.32, 6);
    ctx.lineTo(L * 0.36, 6);
    ctx.quadraticCurveTo(L * 0.56, -2, L * 0.5, -H);
    ctx.quadraticCurveTo(0, -H * 1.32, -L / 2, -H);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -H * 1.3, 0, 8);
    g.addColorStop(0, 'rgb(54,58,54)');
    g.addColorStop(1, 'rgb(16,22,26)');
    ctx.fillStyle = g;
    ctx.fill();
    // Ribs showing through a broken hull.
    ctx.strokeStyle = 'rgba(10,14,18,0.85)';
    ctx.lineWidth = 3;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(i * L * 0.12, -H * 1.05);
      ctx.lineTo(i * L * 0.12, 4);
      ctx.stroke();
    }
    // Mast.
    ctx.strokeStyle = 'rgb(40,44,42)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-L * 0.1, -H);
    ctx.lineTo(-L * 0.16, -H - L * 0.55);
    ctx.stroke();
    // Encrusting life reclaiming it — grows in as the ocean heals.
    const heal = clamp01(this.health);
    if (heal > 0.05) {
      ctx.globalAlpha = heal * 0.8;
      for (let i = 0; i < 14; i++) {
        const x = (i / 13 - 0.5) * L * 0.94;
        const y = -H * (0.9 + Math.sin(i * 3.1) * 0.25);
        ctx.fillStyle = rgb(mixRGB([90, 110, 90], CORAL_COLORS[i % 6].well, heal));
        ctx.beginPath(); ctx.arc(x, y, 3 + (i % 4) * 2.2, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  _arch(ctx, p) {
    const heal = this.health;
    ctx.beginPath();
    ctx.moveTo(p.x - p.w / 2, p.y);
    ctx.lineTo(p.x - p.w / 2, p.y - p.h * 0.45);
    ctx.quadraticCurveTo(p.x, p.y - p.h * 1.55, p.x + p.w / 2, p.y - p.h * 0.45);
    ctx.lineTo(p.x + p.w / 2, p.y);
    ctx.lineTo(p.x + p.w / 2 - 26, p.y);
    ctx.lineTo(p.x + p.w / 2 - 26, p.y - p.h * 0.4);
    ctx.quadraticCurveTo(p.x, p.y - p.h * 1.12, p.x - p.w / 2 + 26, p.y - p.h * 0.4);
    ctx.lineTo(p.x - p.w / 2 + 26, p.y);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, p.y - p.h * 1.5, 0, p.y);
    g.addColorStop(0, `rgb(${52 + heal * 16},${64 + heal * 22},${68 + heal * 12})`);
    g.addColorStop(1, 'rgb(14,22,30)');
    ctx.fillStyle = g;
    ctx.fill();
  }

  _pipe(ctx, gctx, p, t) {
    // Industrial outfall: the thing that made the mess.
    ctx.save();
    ctx.translate(p.x, p.y);

    // Cylindrical shading so it reads as a pipe, not a painted plank.
    const body = ctx.createLinearGradient(0, -p.rad, 0, p.rad);
    body.addColorStop(0.00, 'rgb(30,33,32)');
    body.addColorStop(0.32, 'rgb(84,88,82)');
    body.addColorStop(0.55, 'rgb(60,64,60)');
    body.addColorStop(1.00, 'rgb(22,25,24)');
    ctx.fillStyle = body;
    ctx.fillRect(-p.len, -p.rad, p.len, p.rad * 2);

    // Rust streaks running down the underside.
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = 'rgb(112,64,34)';
    for (let i = 0; i < 5; i++) {
      const x = -p.len * (0.12 + i * 0.19);
      ctx.fillRect(x, p.rad * 0.1, 3 + (i % 3), p.rad * 0.9);
    }
    ctx.globalAlpha = 1;

    // Flange rings.
    ctx.fillStyle = 'rgb(46,50,48)';
    for (let i = 1; i < 4; i++) {
      const x = -p.len * (i / 4);
      ctx.fillRect(x - 3, -p.rad * 1.18, 6, p.rad * 2.36);
    }

    // Dark mouth with a lip.
    ctx.fillStyle = 'rgb(52,56,52)';
    ctx.beginPath(); ctx.ellipse(0, 0, p.rad * 0.42, p.rad * 1.12, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgb(10,12,12)';
    ctx.beginPath(); ctx.ellipse(0, 0, p.rad * 0.3, p.rad * 0.86, 0, 0, TAU); ctx.fill();
    // Sludge plume, which dries up entirely once the ocean is clean.
    const spill = clamp01(1 - this.health * 1.15);
    if (spill > 0.02) {
      ctx.globalAlpha = spill * 0.4;
      const g = ctx.createRadialGradient(6, 0, 2, 40, 0, 70);
      g.addColorStop(0, 'rgba(86,92,44,0.9)');
      g.addColorStop(1, 'rgba(60,66,38,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(34 + Math.sin(t * 0.6) * 4, Math.sin(t * 0.9) * 5, 52, 26, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

export { PROP };
