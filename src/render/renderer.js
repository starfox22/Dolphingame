/* ============================================================
   renderer.js — layered Canvas2D pipeline.

   Passes, in order:
     1. sky / water column      (depth-graded background)
     2. god rays                (additive volumetric shafts)
     3. world + entities        (drawn by the game)
     4. caustics                (additive animated dapple)
     5. surface plane           (from below: a rippling mirror)
     6. bloom                   (quarter-res blur of the glow buffer)
     7. grade                   (depth tint, vignette, lens water)

   Emissive things are drawn twice: once normally, once into the
   quarter-resolution `glow` buffer, which then gets blurred and
   added back. That is the whole bloom trick and it is cheap
   enough to hold 60 fps on a mid-range phone.
   ============================================================ */

import { clamp01, lerp, sampleRamp, rgba, rgb, TAU, smoothstep } from '../core/math.js';

/* Water colour by normalised depth. Hand-tuned so the transition
   from turquoise to abyssal indigo reads as continuous. */
const WATER_RAMP = [
  { at: 0.00, color: [ 96, 216, 226] },
  { at: 0.08, color: [ 52, 178, 202] },
  { at: 0.20, color: [ 26, 132, 172] },
  { at: 0.38, color: [ 16,  86, 133] },
  { at: 0.56, color: [ 10,  52,  94] },
  { at: 0.74, color: [  7,  30,  62] },
  { at: 0.88, color: [  5,  17,  38] },
  { at: 1.00, color: [  3,   9,  22] },
];

const QUALITY = {
  low:  { scale: 0.72, rays: 6,  bloom: false, caustics: 1, dprCap: 1.5, particles: 0.5 },
  med:  { scale: 0.9,  rays: 10, bloom: true,  caustics: 2, dprCap: 2.0, particles: 0.8 },
  high: { scale: 1.0,  rays: 16, bloom: true,  caustics: 2, dprCap: 2.0, particles: 1.0 },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    this.quality = 'high';
    this.q = QUALITY.high;

    this.W = 1; this.H = 1;       // backing-store pixels
    this.CW = 1; this.CH = 1;     // css pixels
    this.dpr = 1;

    /* quarter-res additive glow buffer */
    this.glow = document.createElement('canvas');
    this.gctx = this.glow.getContext('2d');
    this.glowScale = 0.25;

    /* scratch buffer for blur ping-pong */
    this.tmp = document.createElement('canvas');
    this.tctx = this.tmp.getContext('2d');

    this.causticTile = null;
    this.foamTile = null;
    this._buildTiles();

    this.supportsFilter = (() => {
      const c = document.createElement('canvas').getContext('2d');
      c.filter = 'blur(2px)';
      return c.filter === 'blur(2px)';
    })();

    this.lensWater = 0;   // droplets on the "camera" after a breach
    this.flash = 0;       // white flash amount
    this.tint = null;     // {color:[r,g,b], a:number} transient screen tint

    this.resize();
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.quality = name;
    this.q = QUALITY[name];
    this.resize();
  }

  resize() {
    const cw = Math.max(1, this.canvas.clientWidth  || window.innerWidth);
    const ch = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.q.dprCap);

    this.CW = cw; this.CH = ch; this.dpr = dpr;
    const W = Math.round(cw * dpr * this.q.scale);
    const H = Math.round(ch * dpr * this.q.scale);
    if (W === this.W && H === this.H) return;

    this.W = W; this.H = H;
    this.canvas.width = W;
    this.canvas.height = H;

    this.glow.width  = Math.max(1, Math.round(W * this.glowScale));
    this.glow.height = Math.max(1, Math.round(H * this.glowScale));
    this.tmp.width   = this.glow.width;
    this.tmp.height  = this.glow.height;

    // World units per device pixel at zoom 1. The geometric mean of
    // the two axis ratios keeps a roughly constant *area* of ocean on
    // screen, which behaves sanely from a tall phone in portrait to an
    // ultrawide monitor — neither axis alone gets to dominate.
    this.baseScale = Math.sqrt((W / 1150) * (H / 740));
  }

  /* ---------------------------------------------------------- */
  /* Procedural textures, generated once                         */
  /* ---------------------------------------------------------- */

  _buildTiles() {
    /* --- caustics: interference of a few sine waves, thresholded
       into bright filaments and blurred a touch. --- */
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const cx = c.getContext('2d');
    const img = cx.createImageData(S, S);
    const d = img.data;

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S * TAU, v = y / S * TAU;
        // Sum of rotated waves — wrapping in both axes so it tiles.
        let n = 0;
        n += Math.sin(u * 2 + Math.sin(v * 1) * 1.6);
        n += Math.sin(v * 3 - Math.sin(u * 2) * 1.2);
        n += Math.sin((u + v) * 2 + Math.cos(u * 3) * 0.9);
        n += Math.sin((u - v) * 3) * 0.7;
        n /= 3.7;
        // Sharp ridges: the bright edges are what read as caustics.
        let a = Math.pow(clamp01(1 - Math.abs(n) * 1.55), 3.2);
        const i = (y * S + x) * 4;
        d[i] = 210; d[i + 1] = 255; d[i + 2] = 250;
        d[i + 3] = (a * 255) | 0;
      }
    }
    cx.putImageData(img, 0, 0);

    // Soften with one blurred re-draw so the filaments glow.
    const c2 = document.createElement('canvas');
    c2.width = c2.height = S;
    const cx2 = c2.getContext('2d');
    try { cx2.filter = 'blur(1.4px)'; } catch (e) { /* older engine */ }
    cx2.drawImage(c, 0, 0);
    cx2.filter = 'none';
    cx2.globalAlpha = 0.55;
    cx2.drawImage(c, 0, 0);
    this.causticTile = c2;

    /* --- foam: soft speckle used along the waterline --- */
    const F = 128;
    const f = document.createElement('canvas');
    f.width = f.height = F;
    const fx = f.getContext('2d');
    for (let i = 0; i < 340; i++) {
      const x = Math.random() * F, y = Math.random() * F;
      const r = Math.random() * 3 + 0.6;
      const g = fx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      fx.fillStyle = g;
      fx.beginPath(); fx.arc(x, y, r, 0, TAU); fx.fill();
    }
    this.foamTile = f;
    this.causticPattern = null;   // built lazily against the live ctx
  }

  /* ---------------------------------------------------------- */
  /* Camera transform                                            */
  /* ---------------------------------------------------------- */

  /** Screen px per world unit for the current camera. */
  scaleOf(cam) { return this.baseScale * cam.zoom; }

  worldToScreen(cam, wx, wy, out = {}) {
    const s = this.scaleOf(cam);
    out.x = (wx - cam.x) * s + this.W / 2 + cam.shakeX;
    out.y = (wy - cam.y) * s + this.H / 2 + cam.shakeY;
    return out;
  }

  screenToWorld(cam, sx, sy, out = {}) {
    const s = this.scaleOf(cam);
    out.x = (sx - this.W / 2 - cam.shakeX) / s + cam.x;
    out.y = (sy - this.H / 2 - cam.shakeY) / s + cam.y;
    return out;
  }

  /** World-space rect currently visible, padded for off-screen culling. */
  viewBounds(cam, pad = 120) {
    const s = this.scaleOf(cam);
    const hw = this.W / 2 / s + pad;
    const hh = this.H / 2 / s + pad;
    return { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hh, y1: cam.y + hh };
  }

  /** Apply the camera so subsequent draws can use world coordinates. */
  pushWorld(cam) {
    const ctx = this.ctx;
    const s = this.scaleOf(cam);
    ctx.save();
    ctx.translate(this.W / 2 + cam.shakeX, this.H / 2 + cam.shakeY);
    ctx.scale(s, s);
    ctx.translate(-cam.x, -cam.y);
  }
  popWorld() { this.ctx.restore(); }

  pushWorldGlow(cam) {
    const g = this.gctx;
    const s = this.scaleOf(cam) * this.glowScale;
    g.save();
    g.translate(this.glow.width / 2 + cam.shakeX * this.glowScale,
                this.glow.height / 2 + cam.shakeY * this.glowScale);
    g.scale(s, s);
    g.translate(-cam.x, -cam.y);
  }
  popWorldGlow() { this.gctx.restore(); }

  /* ---------------------------------------------------------- */
  /* Pass 1 — sky and water column                               */
  /* ---------------------------------------------------------- */

  /**
   * @param cam       camera
   * @param maxDepth  world depth that maps to ramp position 1.0
   * @param t         seconds
   * @param sunAngle  0..1 across the sky, drives shaft direction
   */
  drawBackground(cam, maxDepth, t, healed = 0, camSubmerged = 0) {
    const ctx = this.ctx;
    const s = this.scaleOf(cam);
    const H = this.H, W = this.W;

    // Depth (world y) at the top and bottom edges of the viewport.
    const yTop = cam.y - H / 2 / s;
    const yBot = cam.y + H / 2 / s;

    ctx.globalCompositeOperation = 'source-over';

    // --- above the waterline: sky ---
    if (yTop < 0) {
      const skyBottom = Math.min(H, (0 - yTop) * s);
      this._drawSky(0, skyBottom, t, cam, camSubmerged);
    }

    // --- below the waterline: the water column ---
    const waterTopPx = Math.max(0, (0 - yTop) * s);
    if (waterTopPx < H) {
      const g = ctx.createLinearGradient(0, waterTopPx, 0, H);
      const steps = 10;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const wy = lerp(Math.max(0, yTop), yBot, f);
        let col = sampleRamp(WATER_RAMP, clamp01(wy / maxDepth));
        // A healed ocean reads warmer and clearer near the surface.
        if (healed > 0) {
          const boost = healed * (1 - clamp01(wy / maxDepth)) * 0.5;
          col = [
            Math.min(255, col[0] + boost * 22),
            Math.min(255, col[1] + boost * 40),
            Math.min(255, col[2] + boost * 26),
          ];
        }
        g.addColorStop(f, rgb(col));
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, waterTopPx, W, H - waterTopPx);

      // Subtle horizontal banding: thermoclines / suspended silt.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const phase = t * (0.012 + i * 0.006) + i * 2.1;
        const wy = (Math.sin(phase) * 0.5 + 0.5) * maxDepth * 0.85 + maxDepth * 0.05;
        const py = (wy - yTop) * s;
        if (py < -200 || py > H + 200) continue;
        const band = ctx.createLinearGradient(0, py - 160, 0, py + 160);
        band.addColorStop(0, 'rgba(120,220,235,0)');
        band.addColorStop(0.5, `rgba(120,220,235,${0.035 - i * 0.008})`);
        band.addColorStop(1, 'rgba(120,220,235,0)');
        ctx.fillStyle = band;
        ctx.fillRect(0, py - 160, W, 320);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  _drawSky(y0, y1, t, cam, submergedCam) {
    const ctx = this.ctx, W = this.W;
    const h = y1 - y0;
    const g = ctx.createLinearGradient(0, y0 - h * 1.4, 0, y1);
    g.addColorStop(0.00, '#05203f');
    g.addColorStop(0.30, '#17557e');
    g.addColorStop(0.60, '#4e9db5');
    g.addColorStop(0.84, '#93cfd4');
    g.addColorStop(1.00, '#c4e6e4');
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, W, h);

    // Sun, parked high and slightly off-centre.
    const sunX = W * 0.72 - cam.x * 0.02;
    const sunY = y1 - h * 1.05;
    ctx.globalCompositeOperation = 'lighter';
    const sg = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.9 + 60);
    sg.addColorStop(0, 'rgba(255,252,236,0.55)');
    sg.addColorStop(0.10, 'rgba(240,246,255,0.20)');
    sg.addColorStop(0.36, 'rgba(210,235,255,0.06)');
    sg.addColorStop(1, 'rgba(190,225,255,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, y0 - h, W, h * 2.4);
    ctx.globalCompositeOperation = 'source-over';

    /* --- clouds ---------------------------------------------------
       Built from stacked radial gradients rather than hard ellipses.
       Three or four soft lobes per cloud is enough to stop them
       reading as the geometric primitives they actually are. */
    const scale = Math.max(0.6, Math.min(W, this.H) / 900);
    for (let i = 0; i < 3; i++) {
      const spd = 0.018 + i * 0.011;
      const yy = y1 - h * (0.78 - i * 0.2);
      const period = W * 0.78 + 260;
      const off = (((-cam.x * spd + t * (1.6 + i * 0.9)) % period) + period) % period;
      const alpha = (0.30 - i * 0.075);
      const r = (70 + i * 24) * scale;
      for (let k = -1; k < 3; k++) {
        this._cloud(ctx, off + k * period - period * 0.5, yy + Math.sin(k * 2.7 + i) * h * 0.05,
                    r * (0.8 + ((k + 2) % 3) * 0.22), alpha);
      }
    }

    /* --- gulls: three or four strokes, but the sky stops feeling
           like a gradient the moment something is alive in it --- */
    this._gulls(ctx, y0, y1, t, cam, scale);

    /* --- horizon haze: distance always desaturates --- */
    const haze = ctx.createLinearGradient(0, y1 - h * 0.34, 0, y1);
    haze.addColorStop(0, 'rgba(214,238,240,0)');
    haze.addColorStop(1, 'rgba(214,238,240,0.55)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, y1 - h * 0.34, W, h * 0.34);

    /* --- Snell's window ------------------------------------------
       Seen from under the water the sky is compressed, dimmed and
       tinted by the column above you. Without this the surface reads
       as a hole in the world rather than a boundary. */
    if (submergedCam > 0.01) {
      ctx.fillStyle = `rgba(34,116,142,${0.42 * submergedCam})`;
      ctx.fillRect(0, y0, W, h);
      ctx.globalCompositeOperation = 'lighter';
      const glare = ctx.createLinearGradient(0, y1 - h * 0.5, 0, y1);
      glare.addColorStop(0, 'rgba(180,240,255,0)');
      glare.addColorStop(1, `rgba(200,248,255,${0.22 * submergedCam})`);
      ctx.fillStyle = glare;
      ctx.fillRect(0, y1 - h * 0.5, W, h * 0.5);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  _gulls(ctx, y0, y1, t, cam, scale) {
    const h = y1 - y0;
    ctx.save();
    ctx.strokeStyle = 'rgba(48,72,92,0.42)';
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const seed = i * 7.31;
      const spd = 16 + (i % 3) * 9;
      const period = this.W + 500;
      const x = (((t * spd + seed * 220 - cam.x * 0.05) % period) + period) % period - 250;
      const y = y1 - h * (0.42 + Math.sin(t * 0.3 + seed) * 0.16 + (i % 3) * 0.14);
      if (y < y0 - 20) continue;
      const w = (7 + (i % 3) * 3) * scale;
      // Wings beat out of phase with each other so the flock isn't a metronome.
      const flap = Math.sin(t * (2.6 + i * 0.4) + seed) * 0.55;
      ctx.lineWidth = Math.max(1, 1.3 * scale);
      ctx.beginPath();
      ctx.moveTo(x - w, y + flap * w * 0.5);
      ctx.quadraticCurveTo(x - w * 0.35, y - w * 0.34 + flap * w * 0.2, x, y);
      ctx.quadraticCurveTo(x + w * 0.35, y - w * 0.34 + flap * w * 0.2, x + w, y + flap * w * 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** One cloud: a handful of soft lobes, no hard edge anywhere. */
  _cloud(ctx, x, y, r, alpha) {
    const lobes = [
      [0, 0, 1.0], [-r * 0.72, r * 0.12, 0.66], [r * 0.78, r * 0.08, 0.74],
      [-r * 0.3, -r * 0.2, 0.6], [r * 0.34, -r * 0.16, 0.56],
    ];
    for (const [ox, oy, k] of lobes) {
      const rr = r * k;
      const g = ctx.createRadialGradient(x + ox, y + oy - rr * 0.12, 0, x + ox, y + oy, rr);
      g.addColorStop(0, `rgba(255,255,255,${alpha})`);
      g.addColorStop(0.45, `rgba(248,252,255,${alpha * 0.5})`);
      g.addColorStop(1, 'rgba(240,248,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x + ox, y + oy, rr * 1.5, rr * 0.62, 0, 0, TAU);
      ctx.fill();
    }
  }

  /* ---------------------------------------------------------- */
  /* Pass 2 — volumetric god rays                                */
  /* ---------------------------------------------------------- */

  drawGodRays(cam, maxDepth, t) {
    const n = this.q.rays;
    if (n <= 0) return;
    const ctx = this.ctx;
    const s = this.scaleOf(cam);
    const surfaceY = (0 - cam.y) * s + this.H / 2 + cam.shakeY;
    if (surfaceY > this.H + 40) return;      // surface is below the view

    const reach = maxDepth * 0.55 * s;       // how far light penetrates, in px
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < n; i++) {
      const seed = i * 12.9898;
      // Shafts drift slowly and breathe in width — never a static fan.
      const drift = Math.sin(t * 0.09 + seed) * 0.5 + Math.sin(t * 0.031 + seed * 2.3) * 0.5;
      const xNorm = ((i + 0.5) / n + drift * 0.035) % 1;
      const x = xNorm * this.W * 1.35 - this.W * 0.17 - cam.x * s * 0.06;

      const tilt = 0.16 + Math.sin(seed) * 0.1;
      const w = (11 + Math.sin(t * 0.23 + seed * 1.7) * 5 + (i % 4) * 9) * this.dpr * this.q.scale;
      const alpha = (0.042 + Math.sin(t * 0.17 + seed * 3.1) * 0.020) *
                    clamp01(1 - cam.y / (maxDepth * 0.7));
      if (alpha <= 0.002) continue;

      const g = ctx.createLinearGradient(x, surfaceY, x + reach * tilt, surfaceY + reach);
      g.addColorStop(0, `rgba(190,255,250,${alpha * 1.5})`);
      g.addColorStop(0.35, `rgba(150,240,255,${alpha * 0.75})`);
      g.addColorStop(1, 'rgba(120,220,255,0)');
      ctx.fillStyle = g;

      ctx.beginPath();
      ctx.moveTo(x - w * 0.5, surfaceY);
      ctx.lineTo(x + w * 0.5, surfaceY);
      ctx.lineTo(x + reach * tilt + w * 3.4, surfaceY + reach);
      ctx.lineTo(x + reach * tilt - w * 2.8, surfaceY + reach);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------- */
  /* Pass 4 — caustics                                           */
  /* ---------------------------------------------------------- */

  drawCaustics(cam, maxDepth, t) {
    const layers = this.q.caustics;
    if (!layers) return;
    const ctx = this.ctx;
    const s = this.scaleOf(cam);
    const surfaceY = (0 - cam.y) * s + this.H / 2 + cam.shakeY;

    // Caustics only exist where sunlight still reaches.
    const depthFade = clamp01(1 - cam.y / (maxDepth * 0.40));
    if (depthFade <= 0.01 || surfaceY > this.H) return;

    if (!this.causticPattern) {
      this.causticPattern = ctx.createPattern(this.causticTile, 'repeat');
    }

    // How far below the surface the dapple is still visible, in px.
    const reach = Math.min(this.H * 1.4, maxDepth * 0.34 * s);
    const top = Math.max(0, surfaceY);
    const bottom = Math.min(this.H, surfaceY + reach);
    if (bottom <= top) return;

    /* The dapple has to fade out with depth rather than stop on a line.
       It is drawn in horizontal bands of decreasing alpha to do that.

       The obvious shortcut — one fill, then a `destination-out` gradient
       to erase the bottom of it — is wrong here: these caustics composite
       straight onto the scene, so erasing punches a hole through
       everything already drawn and leaves a hard seam across the frame.
       Banding costs a few extra pattern fills and composites correctly. */
    const BANDS = 5;
    for (let b = 0; b < BANDS; b++) {
      // Alpha at the middle of this band, easing to nothing at `bottom`.
      const bandAlpha = 1 - smoothstep((b + 0.5) / BANDS);
      if (bandAlpha < 0.015) continue;

      const y0 = top + (bottom - top) * (b / BANDS);
      const y1 = top + (bottom - top) * ((b + 1) / BANDS);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, this.W, y1 - y0 + 1);   // +1 px so bands can't hairline
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';

      for (let l = 0; l < layers; l++) {
        const sc = (l === 0 ? 0.9 : 1.55) * this.dpr * this.q.scale;
        const spd = l === 0 ? 1 : -0.62;
        const a = (l === 0 ? 0.085 : 0.05) * depthFade * bandAlpha;

        ctx.save();
        ctx.globalAlpha = a;
        // Vertical squash: light bands stretch as they descend.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(0, surfaceY);
        ctx.scale(sc, sc * 2.1);
        ctx.translate(
          (-cam.x * s * 0.35 + t * 11 * spd) / sc,
          (Math.sin(t * 0.4 + l) * 5 + t * 2.4 * spd) / (sc * 2.1)
        );
        ctx.fillStyle = this.causticPattern;
        ctx.fillRect(-300, -20, this.W / sc + 600, reach / (sc * 2.1) + 300);
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ---------------------------------------------------------- */
  /* Pass 5 — the water surface                                  */
  /* ---------------------------------------------------------- */

  /**
   * Seen from below the surface is a bright, rippling ceiling with
   * total-internal-reflection shimmer. Seen from above it is a
   * horizon of wave crests. We draw whichever side we're on.
   */
  drawSurface(cam, t) {
    const ctx = this.ctx;
    const s = this.scaleOf(cam);
    const sy = (0 - cam.y) * s + this.H / 2 + cam.shakeY;
    if (sy < -220 || sy > this.H + 220) return;

    const W = this.W;
    const amp = 5 * this.dpr * this.q.scale;
    const segs = Math.max(24, Math.min(90, Math.round(W / 22)));

    // Sample the wave once so the fill, the rim and the foam agree.
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const px = (i / segs) * W;
      const wx = (px - W / 2) / s + cam.x;
      const y = sy + this._waveAt(wx, t) * amp;
      pts.push({ x: px, y });
    }

    ctx.save();

    /* --- underside glow: the bright "ceiling" --- */
    ctx.globalCompositeOperation = 'lighter';
    const under = ctx.createLinearGradient(0, sy - amp, 0, sy + 90 * this.dpr * this.q.scale);
    under.addColorStop(0, 'rgba(215,255,252,0.5)');
    under.addColorStop(0.25, 'rgba(150,240,255,0.20)');
    under.addColorStop(1, 'rgba(120,220,255,0)');
    ctx.fillStyle = under;
    ctx.beginPath();
    ctx.moveTo(0, this.H);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(W, this.H);
    ctx.closePath();
    ctx.fill();

    /* --- the bright meniscus line itself --- */
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = 'rgba(230,255,255,0.75)';
    ctx.lineWidth = 2.0 * this.dpr * this.q.scale;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 6 * this.dpr * this.q.scale;
    ctx.globalAlpha = 0.45;
    ctx.stroke();
    ctx.globalAlpha = 1;

    /* --- crest sparkle: short bright dashes riding the wave --- */
    for (let i = 0; i < pts.length - 1; i += 2) {
      const p = pts[i];
      const spark = Math.sin(p.x * 0.05 + t * 3.1) * Math.sin(p.x * 0.017 - t * 1.7);
      if (spark > 0.72) {
        ctx.globalAlpha = (spark - 0.72) * 3;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        const r = 1.6 * this.dpr * this.q.scale;
        ctx.fillRect(p.x - r, p.y - r, r * 2.4, r * 1.4);
      }
    }
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  /** Shared wave function — everything that touches the surface uses it. */
  _waveAt(wx, t) {
    return Math.sin(wx * 0.011 + t * 1.05) * 0.55
         + Math.sin(wx * 0.027 - t * 1.7) * 0.28
         + Math.sin(wx * 0.061 + t * 2.6) * 0.14;
  }
  /** Public: world-space y of the surface at world x. */
  surfaceY(wx, t) { return this._waveAt(wx, t) * 5; }

  /* ---------------------------------------------------------- */
  /* Pass 6 — bloom                                              */
  /* ---------------------------------------------------------- */

  clearGlow() {
    const g = this.gctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.glow.width, this.glow.height);
  }

  drawBloom(strength = 1) {
    if (!this.q.bloom) return;
    const ctx = this.ctx;
    const gw = this.glow.width, gh = this.glow.height;

    // Blur the glow buffer. `filter` when available, otherwise a
    // downsample/upsample round-trip that bilinear-blurs for free.
    if (this.supportsFilter) {
      this.tctx.setTransform(1, 0, 0, 1, 0, 0);
      this.tctx.clearRect(0, 0, gw, gh);
      this.tctx.filter = `blur(${Math.max(2, gw * 0.012)}px)`;
      this.tctx.drawImage(this.glow, 0, 0);
      this.tctx.filter = 'none';
    } else {
      this.tctx.setTransform(1, 0, 0, 1, 0, 0);
      this.tctx.clearRect(0, 0, gw, gh);
      this.tctx.imageSmoothingEnabled = true;
      this.tctx.drawImage(this.glow, 0, 0, gw, gh, 0, 0, gw * 0.25, gh * 0.25);
      this.tctx.drawImage(this.tmp, 0, 0, gw * 0.25, gh * 0.25, 0, 0, gw, gh);
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.55 * strength;
    ctx.drawImage(this.tmp, 0, 0, this.W, this.H);
    ctx.globalAlpha = 0.24 * strength;   // second, wider pass = softer halo
    ctx.drawImage(this.tmp, -this.W * 0.006, -this.H * 0.006, this.W * 1.012, this.H * 1.012);
    ctx.restore();
  }

  /* ---------------------------------------------------------- */
  /* Pass 7 — grade                                              */
  /* ---------------------------------------------------------- */

  drawGrade(cam, maxDepth, submerged, dt) {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const depth01 = clamp01(cam.y / maxDepth);

    /* --- depth desaturation: the deep swallows warm light --- */
    if (depth01 > 0.25) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(4,12,30,${(depth01 - 0.25) * 0.42})`;
      ctx.fillRect(0, 0, W, H);
    }

    /* --- transient tint (damage, rescue bloom, zone change) --- */
    if (this.tint && this.tint.a > 0.001) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba(this.tint.color, this.tint.a);
      ctx.fillRect(0, 0, W, H);
      this.tint.a *= Math.pow(0.02, dt);
    }

    /* --- white flash --- */
    if (this.flash > 0.001) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.6})`;
      ctx.fillRect(0, 0, W, H);
      this.flash *= Math.pow(0.008, dt);
    }

    /* --- vignette --- */
    ctx.globalCompositeOperation = 'source-over';
    if (!this._vignette || this._vigW !== W) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.30,
                                         W / 2, H / 2, Math.max(W, H) * 0.76);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.62, 'rgba(0,0,0,0.16)');
      g.addColorStop(1, 'rgba(2,8,18,0.62)');
      this._vignette = g; this._vigW = W;
    }
    ctx.fillStyle = this._vignette;
    ctx.fillRect(0, 0, W, H);

    /* --- water on the lens after a breach --- */
    if (this.lensWater > 0.002) {
      this._drawLensWater(ctx, this.lensWater);
      this.lensWater -= dt * 0.85;
    }

    ctx.restore();
  }

  _drawLensWater(ctx, amt) {
    if (!this._drops) {
      this._drops = [];
      for (let i = 0; i < 15; i++) {
        // Weighted toward the top and the edges, the way water actually
        // clings to a lens — an even scatter reads as dirt, not spray.
        const edge = Math.random() < 0.55;
        this._drops.push({
          x: edge ? (Math.random() < 0.5 ? Math.random() * 0.22 : 0.78 + Math.random() * 0.22)
                  : Math.random(),
          y: Math.pow(Math.random(), 1.8) * 0.85,
          r: 0.004 + Math.random() * 0.014,
          sq: 0.6 + Math.random() * 0.9,
        });
      }
    }
    const W = this.W, H = this.H;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const d of this._drops) {
      const x = d.x * W, y = d.y * H * (0.2 + 0.8 * (1 - amt * 0.3));
      const r = d.r * Math.min(W, H) * (0.7 + amt * 0.6);
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${0.13 * amt})`);
      g.addColorStop(0.55, `rgba(190,240,255,${0.045 * amt})`);
      g.addColorStop(1, 'rgba(160,220,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * d.sq, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------- */
  /* Helpers for the game layer                                  */
  /* ---------------------------------------------------------- */

  /** Add a transient full-screen tint. */
  setTint(color, a) { this.tint = { color, a }; }
  addFlash(v) { this.flash = Math.min(1, this.flash + v); }
  splashLens(v) { this.lensWater = Math.min(1.0, this.lensWater + v * 0.7); }

}

export { WATER_RAMP, QUALITY };
