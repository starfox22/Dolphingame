/* ============================================================
   dolphin.js — the player.

   PHYSICS
   Two regimes with a smooth handoff at the waterline.

   Underwater the body is modelled as a hydrofoil: velocity is
   split into a forward component (low drag — it slips through
   the water) and a lateral component (high drag — the flank
   resists sideslip). That single asymmetry is what makes the
   swim feel like a swim instead of an asteroid, because it turns
   every steer into an arc that scrubs speed honestly.

   Thrust pulses with the tail beat rather than applying
   continuously, so acceleration surges the way a real fluke
   stroke does.

   Above water the dolphin is a ballistic body with almost no
   drag, holding whatever momentum it left the surface with.

   ANIMATION
   The spine is generated analytically each frame: walk backward
   from the nose, accumulating a heading that bends by (a) the
   travelling undulation wave and (b) the current turn rate, so
   the body banks into corners. Then a radius profile is swept
   along the spine to build the silhouette.
   ============================================================ */

import {
  TAU, clamp, clamp01, lerp, damp, dampAngle, angleDelta,
  smoothstep, mixRGB, rgb, rgba,
} from '../core/math.js';

/* --- tuning ------------------------------------------------------- */
const LEN            = 122;     // nose-to-fluke, world units
const SEGS           = 17;
const MAX_R          = 18.5;

const THRUST         = 1180;    // forward force while stroking
const BOOST_MUL      = 2.15;
const DRAG_FWD       = 0.0016;  // quadratic, along the body axis
const DRAG_LAT       = 0.030;   // quadratic, across the body axis
const DRAG_LIN       = 0.55;    // linear, keeps the glide finite
const TURN_RATE      = 5.6;     // rad/s at low speed
const TURN_AT_SPEED  = 2.4;     // rad/s once moving fast
const BUOYANCY       = 26;      // gentle lift so idling drifts upward
const GRAVITY        = 980;
const AIR_DRAG       = 0.00016;

const MAX_AIR        = 34;      // seconds of breath
const AIR_DEEP_MUL   = 1.40;    // the deep costs more air
const BOOST_DRAIN    = 0.62;    // per second
const BOOST_REFILL   = 0.30;

export class Dolphin {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.heading = 0;
    this.angVel = 0;

    this.tailPhase = 0;
    this.tailRate = 3.0;
    this.stroke = 0;             // 0..1 envelope of the current beat

    this.submerged = 1;          // 1 under, 0 airborne (smoothed)
    this.wasUnder = true;
    this.airborneTime = 0;

    this.air = 1;                // 0..1
    this.boost = 1;              // 0..1 stamina
    this.boosting = false;
    this.speed = 0;

    this.flipAccum = 0;          // radians of aerial rotation
    this.flips = 0;              // completed this jump
    this.invuln = 0;
    this.hitFlash = 0;
    this.glowPulse = 0;          // set on collect, feeds the bloom pass

    this.spine = [];
    for (let i = 0; i < SEGS; i++) this.spine.push({ x, y, a: 0, r: 0 });

    this.followers = [];         // rescued animals trailing behind

    /* callbacks the game fills in */
    this.onSplash = null;        // (power, exiting)
    this.onBubble = null;        // (x, y)
    this.onImpact = null;        // (power, x, y)
    this.onFlip = null;          // (count)
  }

  get length() { return LEN; }
  get radius() { return MAX_R; }

  /** Nose position, used for pickups and sonar origin. */
  nose(out = {}) {
    out.x = this.x + Math.cos(this.heading) * LEN * 0.42;
    out.y = this.y + Math.sin(this.heading) * LEN * 0.42;
    return out;
  }

  /** Fluke position, where the wake comes from. */
  tail(out = {}) {
    const s = this.spine[SEGS - 1];
    out.x = s.x; out.y = s.y;
    return out;
  }

  /* ---------------------------------------------------------- */
  /* Simulation                                                  */
  /* ---------------------------------------------------------- */

  /**
   * @param input  {x,y} normalised intent, magnitude 0..1
   * @param boost  boolean, hold to sprint
   * @param world  for terrain collision and currents
   * @param surfaceY function(x) -> world y of the waterline
   */
  update(dt, input, boost, world, surfaceY) {
    const surf = surfaceY(this.x);
    const under = this.y > surf;

    /* ---- waterline crossing ---------------------------------- */
    if (under !== this.wasUnder) {
      const power = clamp01(Math.hypot(this.vx, this.vy) / 620);
      if (this.onSplash) this.onSplash(power, !under);
      if (!under) {
        this.airborneTime = 0;
        this.flipAccum = 0;
        this.flips = 0;
      } else if (this.flips > 0 && this.onFlip) {
        this.onFlip(this.flips);
      }
      this.wasUnder = under;
    }

    // Smooth 0..1 so audio and rendering can crossfade rather than pop.
    const targetSub = under ? 1 : 0;
    this.submerged = damp(this.submerged, targetSub, 0.35, dt);

    const inLen = Math.hypot(input.x, input.y);

    if (under) this._swim(dt, input, inLen, boost, world, surf);
    else       this._fly(dt, input, inLen, boost);

    /* ---- integrate ------------------------------------------- */
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.speed = Math.hypot(this.vx, this.vy);

    /* ---- world bounds: soft walls, not hard stops -------------- */
    const margin = 120;
    const right = (world.width || 14000) - margin;
    if (this.x < margin) {
      this.x = margin;
      if (this.vx < 0) this.vx *= -0.32;
    } else if (this.x > right) {
      this.x = right;
      if (this.vx > 0) this.vx *= -0.32;
    }
    if (this.y > (world.maxDepth || 2600) - 30) {
      this.y = (world.maxDepth || 2600) - 30;
      if (this.vy > 0) this.vy *= -0.25;
    }

    /* ---- seabed collision ------------------------------------ */
    if (under) this._collideFloor(dt, world);

    /* ---- air and stamina ------------------------------------- */
    this._resources(dt, under, boost, surf);

    /* ---- tail beat ------------------------------------------- */
    // Faster, deeper beats while thrusting; a slow idle sway otherwise.
    const effort = under ? clamp01(inLen * (boost && this.boost > 0 ? 1.5 : 1)) : 0.25;
    this.tailRate = damp(this.tailRate, 1.5 + effort * 5.6 + clamp01(this.speed / 700) * 2.2, 0.2, dt);
    this.tailPhase += this.tailRate * dt;
    this.stroke = Math.sin(this.tailPhase);

    if (this.invuln > 0) this.invuln -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt * 2.6;
    if (this.glowPulse > 0) this.glowPulse -= dt * 2.2;

    this._solveSpine(dt);
    this._updateFollowers(dt);
  }

  _swim(dt, input, inLen, boost, world, surf) {
    /* --- steering ------------------------------------------------ */
    if (inLen > 0.05) {
      const target = Math.atan2(input.y, input.x);
      // Turning gets lazier at speed: a fast body cannot pivot.
      const agility = lerp(TURN_RATE, TURN_AT_SPEED, clamp01(this.speed / 560));
      const d = angleDelta(this.heading, target);
      const maxStep = agility * dt;
      const step = clamp(d, -maxStep, maxStep);
      this.heading += step;
      this.angVel = damp(this.angVel, step / dt, 0.25, dt);
    } else {
      this.angVel = damp(this.angVel, 0, 0.12, dt);
    }

    /* --- thrust, pulsed by the tail beat -------------------------- */
    const canBoost = boost && this.boost > 0.02;
    this.boosting = canBoost && inLen > 0.05;
    // |sin| gives two power strokes per cycle, like a real fluke.
    const beat = 0.55 + 0.45 * Math.abs(Math.sin(this.tailPhase));
    const power = THRUST * inLen * beat * (this.boosting ? BOOST_MUL : 1);
    this.vx += Math.cos(this.heading) * power * dt;
    this.vy += Math.sin(this.heading) * power * dt;

    /* --- anisotropic drag ---------------------------------------- */
    const cs = Math.cos(this.heading), sn = Math.sin(this.heading);
    let fwd = this.vx * cs + this.vy * sn;        // along the body
    let lat = -this.vx * sn + this.vy * cs;       // across the body

    fwd -= fwd * Math.abs(fwd) * DRAG_FWD * dt;
    lat -= lat * Math.abs(lat) * DRAG_LAT * dt;
    fwd -= fwd * DRAG_LIN * dt;
    lat -= lat * DRAG_LIN * 3.2 * dt;

    this.vx = fwd * cs - lat * sn;
    this.vy = fwd * sn + lat * cs;

    /* --- buoyancy: stronger the closer you are to the surface ----- */
    const depth = this.y - surf;
    const nearSurface = clamp01(1 - depth / 420);
    this.vy -= (BUOYANCY * 0.4 + BUOYANCY * nearSurface) * dt;

    /* --- ambient current ------------------------------------------ */
    const cur = world.currentAt(this.x, this.y, world.time);
    this.vx += cur.x * dt;
    this.vy += cur.y * dt;

    /* --- exhaled bubbles ------------------------------------------ */
    this._bubbleTimer = (this._bubbleTimer || 0) - dt;
    if (this._bubbleTimer <= 0) {
      this._bubbleTimer = this.boosting ? 0.045 : lerp(0.9, 0.22, clamp01(this.speed / 500));
      if (this.onBubble) {
        const t = this.tail();
        this.onBubble(t.x, t.y, this.boosting ? 1.4 : 0.8);
      }
    }
  }

  _fly(dt, input, inLen, boost) {
    this.airborneTime += dt;
    this.boosting = false;

    this.vy += GRAVITY * dt;
    const sp = Math.hypot(this.vx, this.vy);
    const d = sp * sp * AIR_DRAG * dt;
    if (sp > 0.001) { this.vx -= (this.vx / sp) * d; this.vy -= (this.vy / sp) * d; }

    // Default: nose follows the trajectory, which is what makes a
    // breach read as a real arc rather than a floating sprite.
    const ballistic = Math.atan2(this.vy, this.vx);

    if (inLen > 0.35) {
      // Deliberate input overrides and spins the body — this is the
      // trick system. Rotation accrues toward a flip bonus.
      const target = Math.atan2(input.y, input.x);
      const before = this.heading;
      this.heading = dampAngle(this.heading, target, 0.22, dt);
      this.flipAccum += Math.abs(angleDelta(before, this.heading));
      if (this.flipAccum >= TAU) { this.flipAccum -= TAU; this.flips++; }
    } else {
      this.heading = dampAngle(this.heading, ballistic, 0.16, dt);
    }
    this.angVel = damp(this.angVel, 0, 0.2, dt);
  }

  _collideFloor(dt, world) {
    const fy = world.floorAt(this.x);
    const clearance = MAX_R * 0.9;
    if (this.y > fy - clearance) {
      const n = world.floorNormal(this.x);
      const pen = this.y - (fy - clearance);
      this.x += n.x * pen;
      this.y += n.y * pen;

      const vn = this.vx * n.x + this.vy * n.y;
      if (vn < 0) {
        const impact = -vn;
        // Slide along the seabed, keeping tangential speed.
        this.vx -= n.x * vn * 1.35;
        this.vy -= n.y * vn * 1.35;
        this.vx *= 0.82; this.vy *= 0.82;
        if (impact > 120 && this.onImpact) this.onImpact(clamp01(impact / 520), this.x, this.y);
      }
    }
  }

  _resources(dt, under, boostHeld, surf) {
    // Breathing starts as soon as the blowhole clears the water, not
    // only once the whole animal is airborne — otherwise skimming the
    // surface feels unfairly like drowning.
    const breathing = !under || (this.y - MAX_R * 0.75) <= surf;
    if (!breathing) {
      const depthFactor = 1 + clamp01(this.y / 2200) * (AIR_DEEP_MUL - 1);
      const exertion = this.boosting ? 1.9 : (0.75 + clamp01(this.speed / 700) * 0.6);
      this.air -= (dt / MAX_AIR) * depthFactor * exertion;
      if (this.air < 0) this.air = 0;
    } else {
      // Breaching refills fast — that's the reward for the jump.
      this.air = Math.min(1, this.air + dt * 1.9);
    }

    if (this.boosting) {
      this.boost = Math.max(0, this.boost - BOOST_DRAIN * dt);
    } else if (!boostHeld) {
      this.boost = Math.min(1, this.boost + BOOST_REFILL * dt);
    }
  }

  /* ---------------------------------------------------------- */
  /* Spine + silhouette                                          */
  /* ---------------------------------------------------------- */

  /** Body half-thickness at normalised position s along the spine. */
  static profile(s) {
    // The beak stays deliberately thin and the melon swells fast: that
    // step is the single silhouette cue that separates "dolphin" from
    // "generic fish", and it is worth spending polygons on.
    if (s < 0.045) return MAX_R * (0.10 + smoothstep(s / 0.045) * 0.16);            // beak tip
    if (s < 0.10)  return MAX_R * lerp(0.26, 0.34, smoothstep((s - 0.045) / 0.055)); // beak
    if (s < 0.20)  return MAX_R * lerp(0.34, 0.90, smoothstep((s - 0.10) / 0.10));   // melon
    if (s < 0.38)  return MAX_R * lerp(0.90, 1.0,  smoothstep((s - 0.20) / 0.18));   // shoulders
    if (s < 0.74)  return MAX_R * lerp(1.0, 0.38,  smoothstep((s - 0.38) / 0.36));   // taper
    if (s < 0.93)  return MAX_R * lerp(0.38, 0.11, smoothstep((s - 0.74) / 0.19));   // peduncle
    return MAX_R * lerp(0.11, 0.04, smoothstep((s - 0.93) / 0.07));
  }

  _solveSpine(dt) {
    const segLen = LEN / (SEGS - 1);
    // Undulation is small at the head and large at the fluke — that
    // asymmetry is the difference between "dolphin" and "eel".
    const swimAmt = clamp01(0.25 + this.speed / 420) * lerp(0.55, 1.25, clamp01(this.tailRate / 7));
    const airAmt = 1 - this.submerged;
    const amp = lerp(0.30, 0.06, airAmt) * swimAmt;

    // Turn lag: the body trails the head through a corner.
    const bank = clamp(-this.angVel * 0.085, -0.16, 0.16);

    let x = this.x + Math.cos(this.heading) * LEN * 0.42;
    let y = this.y + Math.sin(this.heading) * LEN * 0.42;
    let a = this.heading;

    for (let i = 0; i < SEGS; i++) {
      const s = i / (SEGS - 1);
      const n = this.spine[i];
      n.x = x; n.y = y; n.a = a; n.s = s;
      n.r = Dolphin.profile(s);

      // Travelling wave down the body, growing toward the tail.
      const waveGain = Math.pow(s, 1.7);
      const bend = Math.sin(this.tailPhase - s * 3.4) * amp * waveGain + bank;
      a += bend;

      x -= Math.cos(a) * segLen;
      y -= Math.sin(a) * segLen;
    }
  }

  /* ---------------------------------------------------------- */
  /* Rescued animals trailing along                              */
  /* ---------------------------------------------------------- */

  /** Max animals trailing at once. Past this the oldest peels off and
   *  heads for open water — a line of twenty looks absurd and costs
   *  draw time for nothing. Returns the departing one, if any. */
  static MAX_FOLLOWERS = 5;

  addFollower(kind) {
    const last = this.followers[this.followers.length - 1];
    this.followers.push({
      kind,
      x: last ? last.x : this.x - 60,
      y: last ? last.y : this.y + 30,
      a: this.heading,
      phase: Math.random() * TAU,
      wob: 0.6 + Math.random() * 0.8,
    });
    return this.followers.length > Dolphin.MAX_FOLLOWERS
      ? this.followers.shift()
      : null;
  }

  _updateFollowers(dt) {
    let tx = this.x, ty = this.y;
    const gap = 62;
    for (let i = 0; i < this.followers.length; i++) {
      const f = this.followers[i];
      const dx = tx - f.x, dy = ty - f.y;
      const d = Math.hypot(dx, dy) || 1;
      // Chase the slot behind the target, arriving smoothly.
      const desiredX = tx - (dx / d) * gap;
      const desiredY = ty - (dy / d) * gap;
      f.x = damp(f.x, desiredX, 0.14, dt);
      f.y = damp(f.y, desiredY, 0.14, dt);
      f.a = dampAngle(f.a, Math.atan2(dy, dx), 0.2, dt);
      f.phase += dt * (2 + f.wob);
      tx = f.x; ty = f.y;
    }
  }

  /* ---------------------------------------------------------- */
  /* Rendering                                                   */
  /* ---------------------------------------------------------- */

  /**
   * @param ctx   main scene context (world transform applied)
   * @param gctx  glow buffer context (world transform applied)
   * @param rn    renderer, for the caustic tile
   * @param depth01 0..1 depth of the dolphin, for lighting
   */
  draw(ctx, gctx, rn, depth01, t) {
    const sp = this.spine;

    /* --- build the two flanks --- */
    const top = [], bot = [];
    for (let i = 0; i < SEGS; i++) {
      const n = sp[i];
      const px = -Math.sin(n.a), py = Math.cos(n.a);
      top.push({ x: n.x - px * n.r, y: n.y - py * n.r });
      bot.push({ x: n.x + px * n.r, y: n.y + py * n.r });
    }

    ctx.save();

    /* --- speed blur ghosts while boosting --- */
    if (this.boosting && this.speed > 240) {
      ctx.globalAlpha = 0.16;
      for (let k = 1; k <= 2; k++) {
        const o = k * 9;
        ctx.save();
        ctx.translate(-Math.cos(this.heading) * o, -Math.sin(this.heading) * o);
        this._bodyPath(ctx, top, bot);
        ctx.fillStyle = 'rgba(150,220,255,0.6)';
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    /* --- pectoral fins (far side, drawn under the body) --- */
    this._pectoral(ctx, sp, -1, 0.55);

    /* --- fluke --- */
    this._fluke(ctx, sp);

    /* --- dorsal fin --- */
    this._dorsal(ctx, sp);

    /* --- body --- */
    this._bodyPath(ctx, top, bot);

    // Countershading: dark above, pale below, oriented to the body.
    const mid = sp[Math.floor(SEGS * 0.34)];
    const px = -Math.sin(mid.a), py = Math.cos(mid.a);
    const R = MAX_R * 1.25;
    const g = ctx.createLinearGradient(
      mid.x - px * R, mid.y - py * R,
      mid.x + px * R, mid.y + py * R
    );
    // Keep the back genuinely dark at every depth — washing it out in
    // the shallows was what made the body read as a flat white fish.
    const lightBoost = (1 - depth01) * 0.28;
    const dark  = mixRGB([16, 27, 45], [38, 62, 92], lightBoost);
    const midC  = mixRGB([52, 84, 116], [86, 128, 164], lightBoost);
    const belly = mixRGB([188, 208, 220], [232, 244, 250], lightBoost);
    g.addColorStop(0.00, rgb(dark));
    g.addColorStop(0.30, rgb(mixRGB(dark, midC, 0.75)));
    g.addColorStop(0.52, rgb(midC));
    g.addColorStop(0.66, rgb(mixRGB(midC, belly, 0.55)));
    g.addColorStop(0.80, rgb(mixRGB(midC, belly, 0.94)));
    g.addColorStop(1.00, rgb(belly));
    ctx.fillStyle = g;
    ctx.fill();

    /* --- caustic dapple across the back, near the surface --- */
    const causticAmt = clamp01(1 - depth01 * 3.2) * this.submerged;
    if (causticAmt > 0.02 && rn.causticTile) {
      ctx.save();
      this._bodyPath(ctx, top, bot);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = causticAmt * 0.20;
      const sc = 0.35;
      ctx.translate(this.x, this.y);
      ctx.rotate(this.heading * 0.3);
      ctx.scale(sc, sc);
      ctx.drawImage(rn.causticTile,
        ((-t * 26) % 256) - 256 - 200, ((t * 9) % 256) - 256 - 200,
        256 * 3, 256 * 3);
      ctx.restore();
    }

    /* --- dorsal rim light --- */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    ctx.moveTo(top[0].x, top[0].y);
    for (let i = 1; i < top.length; i++) ctx.lineTo(top[i].x, top[i].y);
    ctx.strokeStyle = `rgba(190,240,255,${0.22 + (1 - depth01) * 0.30})`;
    ctx.lineWidth = 1.9;
    ctx.stroke();
    ctx.restore();

    /* --- specular streak along the shoulder --- */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const a0 = sp[2], a1 = sp[6];
    const sg = ctx.createLinearGradient(a0.x, a0.y, a1.x, a1.y);
    sg.addColorStop(0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, `rgba(255,255,255,${0.18 + (1 - depth01) * 0.18})`);
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = sg;
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(a0.x - Math.sin(a0.a) * a0.r * 0.55, a0.y + Math.cos(a0.a) * a0.r * 0.55);
    for (let i = 3; i <= 7; i++) {
      const n = sp[i];
      ctx.lineTo(n.x - Math.sin(n.a) * n.r * 0.55, n.y + Math.cos(n.a) * n.r * 0.55);
    }
    ctx.stroke();
    ctx.restore();

    /* --- near-side pectoral, over the body --- */
    this._pectoral(ctx, sp, 1, 1);

    /* --- face: mouth line and eye --- */
    const h = sp[1];
    ctx.strokeStyle = 'rgba(20,34,50,0.55)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    const m0 = sp[0], m1 = sp[2];
    ctx.moveTo(m0.x + Math.sin(m0.a) * m0.r * 0.3, m0.y - Math.cos(m0.a) * m0.r * 0.3);
    ctx.quadraticCurveTo(
      lerp(m0.x, m1.x, 0.5) + Math.sin(m0.a) * 4.2,
      lerp(m0.y, m1.y, 0.5) - Math.cos(m0.a) * 4.2 + 1.4,
      m1.x + Math.sin(m1.a) * m1.r * 0.42,
      m1.y - Math.cos(m1.a) * m1.r * 0.42
    );
    ctx.stroke();

    const eye = sp[2];
    const ex = eye.x - Math.sin(eye.a) * eye.r * 0.28 + Math.cos(eye.a) * 1.5;
    const ey = eye.y + Math.cos(eye.a) * eye.r * 0.28 + Math.sin(eye.a) * 1.5;
    ctx.fillStyle = '#0a1420';
    ctx.beginPath(); ctx.arc(ex, ey, 1.9, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(ex - 0.6, ey - 0.6, 0.72, 0, TAU); ctx.fill();

    /* --- blowhole --- */
    const bh = sp[3];
    ctx.fillStyle = 'rgba(22,38,54,0.6)';
    ctx.beginPath();
    ctx.ellipse(bh.x - Math.sin(bh.a) * bh.r * 0.82, bh.y + Math.cos(bh.a) * bh.r * 0.82,
                1.9, 1.1, bh.a, 0, TAU);
    ctx.fill();

    ctx.restore();

    /* --- glow contributions --- */
    if (gctx) {
      // Always a faint aura so the dolphin never disappears into the dark.
      const aura = 0.045 + depth01 * 0.15 + this.glowPulse * 0.32 + (this.boosting ? 0.12 : 0);
      const gg = gctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, LEN * 0.85);
      gg.addColorStop(0, `rgba(170,235,255,${aura})`);
      gg.addColorStop(1, 'rgba(120,200,255,0)');
      gctx.fillStyle = gg;
      gctx.beginPath(); gctx.arc(this.x, this.y, LEN * 0.85, 0, TAU); gctx.fill();

      if (this.hitFlash > 0) {
        gctx.fillStyle = `rgba(255,90,110,${this.hitFlash * 0.7})`;
        gctx.beginPath(); gctx.arc(this.x, this.y, LEN * 0.7, 0, TAU); gctx.fill();
      }
    }

    /* --- damage flash overlay --- */
    if (this.hitFlash > 0) {
      ctx.save();
      this._bodyPath(ctx, top, bot);
      ctx.fillStyle = `rgba(255,120,130,${this.hitFlash * 0.6})`;
      ctx.fill();
      ctx.restore();
    }

    this._drawFollowers(ctx, gctx, t);
  }

  _bodyPath(ctx, top, bot) {
    ctx.beginPath();
    ctx.moveTo(top[0].x, top[0].y);
    for (let i = 1; i < top.length - 1; i++) {
      const a = top[i], b = top[i + 1];
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    const tl = top[top.length - 1], bl = bot[bot.length - 1];
    ctx.lineTo((tl.x + bl.x) / 2, (tl.y + bl.y) / 2);
    for (let i = bot.length - 1; i > 1; i--) {
      const a = bot[i], b = bot[i - 1];
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    ctx.quadraticCurveTo(bot[1].x, bot[1].y, bot[0].x, bot[0].y);
    ctx.closePath();
  }

  _dorsal(ctx, sp) {
    const i = 5;
    const n = sp[i], m = sp[i + 1], k = sp[i + 2];
    const px = -Math.sin(n.a), py = Math.cos(n.a);
    const bx = n.x - px * n.r * 0.85, by = n.y - py * n.r * 0.85;
    const tx = m.x - px * (n.r + 21), ty = m.y - py * (n.r + 21);
    const ex = k.x - px * k.r * 0.7,  ey = k.y - py * k.r * 0.7;

    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(
      bx - px * 12 + Math.cos(n.a) * 3, by - py * 12 + Math.sin(n.a) * 3,
      tx - Math.cos(n.a) * 5, ty - Math.sin(n.a) * 5
    );
    ctx.quadraticCurveTo(
      lerp(tx, ex, 0.5) - px * 3, lerp(ty, ey, 0.5) - py * 3,
      ex, ey
    );
    ctx.closePath();
    const g = ctx.createLinearGradient(bx, by, tx, ty);
    g.addColorStop(0, 'rgb(46,72,100)');
    g.addColorStop(1, 'rgb(24,40,60)');
    ctx.fillStyle = g;
    ctx.fill();
  }

  _pectoral(ctx, sp, side, alpha) {
    const n = sp[4];
    const px = -Math.sin(n.a) * side, py = Math.cos(n.a) * side;
    // Fins scull opposite the tail beat — small detail, big life.
    const flap = Math.sin(this.tailPhase * 0.9 + (side > 0 ? 0 : 0.6)) * 0.28;
    const ang = n.a + Math.PI * 0.42 * side + flap * side;
    const len = 31;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(n.x + px * n.r * 0.55, n.y + py * n.r * 0.55);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.55, -3.5 * side, len, 1.5 * side);
    ctx.quadraticCurveTo(len * 0.5, 5.5 * side, 0, 5 * side);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, side > 0 ? 'rgb(72,106,138)' : 'rgb(38,60,86)');
    g.addColorStop(1, side > 0 ? 'rgb(40,64,92)' : 'rgb(24,40,62)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  _fluke(ctx, sp) {
    const n = sp[SEGS - 1], m = sp[SEGS - 3];
    const a = Math.atan2(n.y - m.y, n.x - m.x);
    const px = -Math.sin(a), py = Math.cos(a);
    const span = 27, back = 13;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(n.x - Math.cos(a) * 4, n.y - Math.sin(a) * 4);
    // Upper lobe
    ctx.quadraticCurveTo(
      n.x - px * span * 0.55 + Math.cos(a) * 2, n.y - py * span * 0.55 + Math.sin(a) * 2,
      n.x - px * span + Math.cos(a) * back, n.y - py * span + Math.sin(a) * back
    );
    ctx.quadraticCurveTo(
      n.x - px * span * 0.38 + Math.cos(a) * 4, n.y - py * span * 0.38 + Math.sin(a) * 4,
      n.x + Math.cos(a) * 3, n.y + Math.sin(a) * 3
    );
    // Lower lobe
    ctx.quadraticCurveTo(
      n.x + px * span * 0.38 + Math.cos(a) * 4, n.y + py * span * 0.38 + Math.sin(a) * 4,
      n.x + px * span + Math.cos(a) * back, n.y + py * span + Math.sin(a) * back
    );
    ctx.quadraticCurveTo(
      n.x + px * span * 0.55 + Math.cos(a) * 2, n.y + py * span * 0.55 + Math.sin(a) * 2,
      n.x - Math.cos(a) * 4, n.y - Math.sin(a) * 4
    );
    ctx.closePath();
    const g = ctx.createLinearGradient(
      n.x - px * span, n.y - py * span,
      n.x + px * span, n.y + py * span
    );
    g.addColorStop(0, 'rgb(30,50,74)');
    g.addColorStop(0.5, 'rgb(56,86,116)');
    g.addColorStop(1, 'rgb(30,50,74)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  _drawFollowers(ctx, gctx, t) {
    for (const f of this.followers) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.a);
      if (f.kind === 'turtle')      this._drawTurtle(ctx, f, t);
      else if (f.kind === 'seal')   this._drawSeal(ctx, f, t);
      else                          this._drawFishBuddy(ctx, f, t);
      ctx.restore();
      if (gctx) {
        gctx.fillStyle = 'rgba(140,255,200,0.10)';
        gctx.beginPath(); gctx.arc(f.x, f.y, 30, 0, TAU); gctx.fill();
      }
    }
  }

  _drawTurtle(ctx, f, t) {
    const flip = Math.sin(f.phase) * 0.5;
    ctx.fillStyle = 'rgb(58,92,68)';
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.rotate(s * (0.5 + flip * s * 0.6));
      ctx.beginPath();
      ctx.ellipse(-2, s * 9, 12, 4.5, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(-3, -3, 1, 0, 0, 15);
    g.addColorStop(0, 'rgb(120,160,96)');
    g.addColorStop(1, 'rgb(52,84,58)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, 15, 11, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(28,48,34,0.7)';
    ctx.lineWidth = 1;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.ellipse(i * 6, 0, 3.4, 6.5, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgb(96,132,82)';
    ctx.beginPath(); ctx.ellipse(15, 0, 5.5, 4.2, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#0d1a14';
    ctx.beginPath(); ctx.arc(17.5, -1.4, 1.1, 0, TAU); ctx.fill();
  }

  _drawSeal(ctx, f, t) {
    const wob = Math.sin(f.phase) * 0.2;
    ctx.save();
    ctx.rotate(wob * 0.3);
    const g = ctx.createLinearGradient(0, -9, 0, 9);
    g.addColorStop(0, 'rgb(96,102,110)');
    g.addColorStop(1, 'rgb(178,182,188)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, 19, 8.5, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-18, 0);
    ctx.lineTo(-27, -7 + wob * 6);
    ctx.lineTo(-27, 7 + wob * 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgb(112,118,126)';
    ctx.beginPath(); ctx.ellipse(17, -1, 7, 6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#0b1016';
    ctx.beginPath(); ctx.arc(20, -2.6, 1.3, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(23.5, -0.4, 1.0, 0, TAU); ctx.fill();
    ctx.restore();
  }

  _drawFishBuddy(ctx, f, t) {
    const wag = Math.sin(f.phase * 2) * 0.5;
    ctx.fillStyle = 'rgb(240,180,90)';
    ctx.beginPath(); ctx.ellipse(0, 0, 11, 6, 0, 0, TAU); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(-18, -6 + wag * 5);
    ctx.lineTo(-18, 6 + wag * 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#101820';
    ctx.beginPath(); ctx.arc(6, -1.4, 1.1, 0, TAU); ctx.fill();
  }
}

export { LEN as DOLPHIN_LEN, MAX_AIR };
