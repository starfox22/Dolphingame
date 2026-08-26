/* ============================================================
   camera.js — follow rig.

   Three behaviours layered on a critically-damped follow:
     · look-ahead along the velocity vector, so you see where you
       are going rather than where you have been
     · speed zoom-out, which does most of the work of making fast
       swimming feel fast
     · trauma-based shake, squared so small bumps stay subtle
   ============================================================ */

import { clamp, clamp01, lerp, damp } from '../core/math.js';

export class Camera {
  constructor(x = 0, y = 0) {
    this.x = x; this.y = y;
    this.zoom = 1;
    this.targetZoom = 1;
    this.shakeX = 0; this.shakeY = 0;
    this.trauma = 0;
    this._t = 0;
    this.leadX = 0; this.leadY = 0;
  }

  addTrauma(v) { this.trauma = clamp01(this.trauma + v); }

  snapTo(x, y) { this.x = x; this.y = y; this.leadX = 0; this.leadY = 0; }

  update(dt, target, renderer, world) {
    this._t += dt;

    /* --- look-ahead --------------------------------------------- */
    const lead = 0.30;
    const maxLead = 240;
    let lx = clamp(target.vx * lead, -maxLead, maxLead);
    let ly = clamp(target.vy * lead * 0.75, -maxLead * 0.8, maxLead * 0.8);
    this.leadX = damp(this.leadX, lx, 0.06, dt);
    this.leadY = damp(this.leadY, ly, 0.06, dt);

    let tx = target.x + this.leadX;
    let ty = target.y + this.leadY;

    /* --- when airborne, pull the frame up so the arc reads ------- */
    if (target.submerged < 0.6) {
      ty -= (1 - target.submerged) * 90;
    }

    /* --- follow -------------------------------------------------- */
    // Slightly looser vertically: bobbing shouldn't jitter the frame.
    this.x = damp(this.x, tx, 0.13, dt);
    this.y = damp(this.y, ty, 0.10, dt);

    /* --- zoom ---------------------------------------------------- */
    const sp = clamp01(target.speed / 740);
    this.targetZoom = lerp(1.12, 0.84, sp * sp);
    // Pull in a touch in the pitch dark so the light pool feels close.
    const depth01 = clamp01(this.y / world.maxDepth);
    this.targetZoom *= lerp(1, 1.06, clamp01((depth01 - 0.6) / 0.4));
    this.zoom = damp(this.zoom, this.targetZoom, 0.045, dt);

    /* --- keep the view inside the world -------------------------- */
    const s = renderer.baseScale * this.zoom;
    const halfW = renderer.W / 2 / s;
    const halfH = renderer.H / 2 / s;
    this.x = clamp(this.x, halfW * 0.35, world.width - halfW * 0.35);
    // Allow plenty of sky, but don't fly off into empty blue.
    this.y = clamp(this.y, -halfH * 0.55, world.maxDepth - halfH * 0.30);

    /* --- shake --------------------------------------------------- */
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const sh = this.trauma * this.trauma;
    if (sh > 0.0001) {
      const t = this._t * 46;
      const mag = sh * 22 * renderer.dpr * renderer.q.scale;
      this.shakeX = Math.sin(t * 1.13) * Math.sin(t * 0.37) * mag;
      this.shakeY = Math.sin(t * 0.91 + 1.7) * Math.sin(t * 0.51) * mag;
    } else {
      this.shakeX = 0; this.shakeY = 0;
    }
  }
}
