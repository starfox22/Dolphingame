/* ============================================================
   game.js — orchestration.

   Owns the simulation state machine, scoring, and the draw
   order. Every subsystem is dumb on its own; this is where they
   are wired into a game.

   States:
     attract  — AI dolphin swims behind the title screen
     playing  — the run
     paused   — frozen, overlay up
     over     — results

   Draw order matters a lot for the look, and is documented
   inline at `render()`.
   ============================================================ */

import { clamp01, lerp, damp, TAU } from './core/math.js';
import { Renderer } from './render/renderer.js';
import { Camera } from './render/camera.js';
import { World, MAX_DEPTH, zoneAt } from './world/world.js';
import { Dolphin } from './entities/dolphin.js';
import { TrashField, KIND } from './entities/trash.js';
import { Wildlife } from './entities/wildlife.js';
import { Particles } from './systems/particles.js';
import { audio } from './core/audio.js';

const DROWN_LIMIT   = 9.5;    // seconds of held breath past empty
const COMBO_WINDOW  = 3.4;
const SONAR_CD      = 1.5;
const SONAR_REACH   = 760;
const HEAL_TARGET   = 200;    // trash items for a fully healed ocean
const METERS_PER_UNIT = 0.25;

export class Game {
  constructor(canvas, dom, hud, input) {
    this.canvas = canvas;
    this.dom = dom;
    this.hud = hud;
    this.input = input;

    this.renderer = new Renderer(canvas);
    this.cam = new Camera();
    this.particles = new Particles(1500);

    this.state = 'attract';
    this.time = 0;
    this.onGameOver = null;

    this.sonars = [];
    this.hints = new Set();

    this._newWorld(Date.now() & 0xffff);
    this._resetRun();
    this.cam.snapTo(this.dolphin.x, this.dolphin.y);
  }

  /* ---------------------------------------------------------- */
  /* Setup                                                       */
  /* ---------------------------------------------------------- */

  _newWorld(seed) {
    this.world = new World(seed);
    this.trash = new TrashField(this.world, seed ^ 0x1234);
    this.wildlife = new Wildlife(this.world, seed ^ 0xabcd);
  }

  _resetRun() {
    const startX = 900;
    const startY = Math.min(220, this.world.floorAt(startX) - 200);

    this.dolphin = new Dolphin(startX, startY);
    this._wireDolphin();

    this.score = 0;
    this.displayScore = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 1;
    this.collected = 0;
    this.rescued = 0;
    this.deepest = 0;
    this.drown = 0;
    this.runTime = 0;
    this.sonarCd = 0;
    this.stunned = 0;
    this.health = 0;
    this.warnTimer = 0;
    this.sonars.length = 0;
    this.particles.clear();
    this.world.health = 0;
    this.hints.clear();
    this._zone = undefined;
    this._ambientSeeded = false;
  }

  _wireDolphin() {
    const d = this.dolphin;

    d.onSplash = (power, exiting) => {
      const y = this.renderer.surfaceY(d.x, this.time);
      audio.splash(power, exiting);
      this.cam.addTrauma(0.12 + power * 0.3);
      const n = Math.round(14 + power * 40);
      for (let i = 0; i < n; i++) {
        this.particles.foam(
          d.x + (Math.random() - 0.5) * 44, y,
          d.vx * 0.35 + (Math.random() - 0.5) * 130,
          -Math.abs(d.vy) * 0.34 - Math.random() * 130
        );
      }
      for (let i = 0; i < 8; i++) {
        this.particles.bubble(d.x + (Math.random() - 0.5) * 40, y + 12 + Math.random() * 40, d.vx * 0.1, 0, 1.2);
      }
      if (exiting) {
        this.renderer.splashLens(0.55 + power * 0.6);
        this.renderer.addFlash(0.06 + power * 0.1);
      } else {
        this.renderer.splashLens(0.3 + power * 0.35);
      }
    };

    d.onBubble = (x, y, size) => {
      this.particles.bubble(x, y, -d.vx * 0.05, -d.vy * 0.05, size);
      if (Math.random() < 0.14) audio.bubble();
    };

    d.onImpact = (power, x, y) => {
      this.cam.addTrauma(power * 0.5);
      for (let i = 0; i < 6 + power * 14; i++) this.particles.silt(x, y + 8, d.vx * 0.2, 0);
      if (power > 0.35) audio.hurt();
    };

    d.onFlip = (count) => {
      const pts = 180 * count * count;
      this._award(pts);
      this.hud.toast(count > 1 ? `${count}× SPIN!  +${pts}` : `SPIN!  +${pts}`, 'gold');
      audio.rescue();
      this.renderer.addFlash(0.14);
    };
  }

  /* ---------------------------------------------------------- */
  /* Lifecycle                                                   */
  /* ---------------------------------------------------------- */

  beginRun() {
    this._newWorld((Math.random() * 0xffff) | 0);
    this._resetRun();
    this.cam.snapTo(this.dolphin.x, this.dolphin.y);
    this.cam.zoom = 1.1;
    this.state = 'playing';
    this.hud.show(true);
    this.hud.setZone(zoneAt(this.dolphin.y).name);
    audio.startMusic();
    this._seedAmbient();
  }

  toAttract() {
    this.state = 'attract';
    this.hud.show(false);
  }

  pause()  { if (this.state === 'playing') { this.state = 'paused'; audio.suspend(); } }
  resume() { if (this.state === 'paused')  { this.state = 'playing'; audio.resume(); } }

  endRun(reason) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.hud.show(false);
    this.renderer.setTint([10, 20, 40], 0.5);
    if (this.onGameOver) this.onGameOver(this.stats(reason));
  }

  stats(reason = '') {
    return {
      reason,
      score: Math.round(this.score),
      trash: this.collected,
      rescued: this.rescued,
      deepest: Math.round(this.deepest * METERS_PER_UNIT),
      bestCombo: this.bestCombo,
      health: Math.round(this.health * 100),
      time: this.runTime,
    };
  }

  resize() { this.renderer.resize(); }

  /* ---------------------------------------------------------- */
  /* Simulation                                                  */
  /* ---------------------------------------------------------- */

  update(dt) {
    this.time += dt;
    const t = this.time;
    if (this.state === 'paused' || this.state === 'over') {
      // Keep the world breathing behind the overlay, but freeze play.
      this.world.update(dt * 0.25);
      return;
    }

    const d = this.dolphin;
    const attract = this.state === 'attract';

    /* ---- input ------------------------------------------------ */
    let move, boost;
    if (attract) {
      const ai = this._attractAI(dt);
      move = ai.move; boost = ai.boost;
    } else {
      const scr = this.renderer.worldToScreen(this.cam, d.x, d.y);
      move = this.input.update(scr);
      boost = this.input.boost;
      if (this.input.consumeSonar()) this._ping();
      this.runTime += dt;
    }

    // Stun from a sting: you keep drifting but lose your stroke.
    if (this.stunned > 0) {
      this.stunned -= dt;
      move = { x: move.x * 0.2, y: move.y * 0.2 };
      boost = false;
    }

    /* ---- simulate --------------------------------------------- */
    this.world.update(dt);
    const surfaceY = (x) => this.renderer.surfaceY(x, t);
    d.update(dt, move, boost, this.world, surfaceY);

    if (boost && d.boosting) {
      audio.boost();
      if (Math.random() < dt * 26) {
        const tl = d.tail();
        this.particles.ring(tl.x, tl.y, d.heading, 0.8 + Math.random() * 0.6);
      }
    }

    this.cam.update(dt, d, this.renderer, this.world);
    const bounds = this.renderer.viewBounds(this.cam, 200);

    this.wildlife.update(dt, t, d, bounds, this.cam);
    this.particles.update(dt, this.world, bounds);
    this._updateAmbient(dt, bounds);
    this._updateSonar(dt);

    const events = this.trash.update(dt, t, d, bounds, this.particles);
    if (!attract) this._handleEvents(events);
    else if (events.length) {
      // Attract mode still consumes items so the demo stays lively,
      // but nothing is scored.
      for (const e of events) if (e.type === 'collect') audio.collect(0);
    }

    if (!attract) {
      this._hazards(dt);
      this._resources(dt);
      this._zones();
    }

    /* ---- score readout eases toward the true value ------------- */
    this.displayScore = damp(this.displayScore, this.score, 0.18, dt);

    /* ---- combo decay ------------------------------------------ */
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }

    /* ---- audio mix -------------------------------------------- */
    const depth01 = clamp01(d.y / MAX_DEPTH);
    const urgency = clamp01(1 - d.air * 2.2) * 0.7 + clamp01(d.speed / 800) * 0.3;
    audio.setEnvironment(d.submerged, depth01, attract ? 0.1 : urgency);
    audio.update(dt);

    if (!attract) this._hud();
  }

  /* ---- events ------------------------------------------------- */

  _handleEvents(events) {
    const d = this.dolphin;
    for (const e of events) {
      if (e.type === 'collect') {
        this.combo++;
        this.comboTimer = COMBO_WINDOW;
        const mult = this.multiplier;
        this.bestCombo = Math.max(this.bestCombo, mult);
        this.collected++;
        this._award(e.item.k.points * mult);
        audio.collect(this.combo, e.item.k.points >= 34);
        d.glowPulse = Math.min(1, d.glowPulse + 0.5);
        if (e.item.k === KIND.NET || e.item.k === KIND.DRUM) {
          this.hud.toast(`${e.item.k.label}  +${e.item.k.points * mult}`, 'gold');
          this.cam.addTrauma(0.1);
        }
        if (this.combo === 8) this.hud.toast('COMBO CHAIN!', 'gold');
      } else if (e.type === 'rescue') {
        this.rescued++;
        const mult = this.multiplier;
        this._award(e.animal.k.points * mult);
        audio.rescue();
        this.hud.toast(`${e.animal.k.label} freed!  +${e.animal.k.points * mult}`, 'gold');
        this.renderer.addFlash(0.2);
        this.renderer.setTint([255, 220, 160], 0.16);
        this.cam.addTrauma(0.18);
        d.addFollower(e.animal.k.id);
        // Rescues restore a real chunk of breath — mercy, and a hook.
        d.air = Math.min(1, d.air + 0.22);
      }
      this._recomputeHealth();
    }
  }

  get multiplier() { return Math.min(10, 1 + Math.floor(this.combo / 3)); }

  _award(points) { this.score += points; }

  _recomputeHealth() {
    const raw = (this.collected + this.rescued * 6) / HEAL_TARGET;
    const prev = this.health;
    // Front-load the curve so the first pickups visibly matter.
    this.health = clamp01(1 - Math.pow(1 - clamp01(raw), 1.6));
    this.world.health = this.health;

    for (const step of [0.25, 0.5, 0.75, 1]) {
      if (prev < step && this.health >= step) {
        this.hud.toast(
          step >= 1 ? 'THE OCEAN IS CLEAN' : `OCEAN HEALTH ${Math.round(step * 100)}%`,
          'aqua'
        );
        audio.zone();
        this.renderer.setTint([120, 255, 220], 0.14);
      }
    }
  }

  /* ---- hazards ------------------------------------------------ */

  _hazards(dt) {
    const d = this.dolphin;
    if (d.invuln > 0) return;

    const jelly = this.wildlife.stingCheck(d);
    if (jelly) {
      d.invuln = 1.6;
      d.hitFlash = 1;
      this.stunned = 0.75;
      d.air = Math.max(0, d.air - 0.10);
      // Knock the dolphin away from the bell.
      const a = Math.atan2(d.y - jelly.y, d.x - jelly.x);
      d.vx += Math.cos(a) * 210;
      d.vy += Math.sin(a) * 210;
      this.combo = 0;
      audio.hurt();
      this.cam.addTrauma(0.42);
      this.renderer.setTint([200, 120, 255], 0.24);
      this.hud.toast('STUNG!', 'warn');
      this.particles.burst(d.x, d.y, 14, { speed: 150, col: [220, 150, 255], life: 0.7 });
      return;
    }

    const sludge = this.wildlife.sludgeCheck(d, this.health);
    if (sludge) {
      // No knockback — sludge is a slow drain that punishes lingering.
      d.air = Math.max(0, d.air - dt * 0.075);
      if (Math.random() < dt * 12) {
        this.particles.grime(d.x + (Math.random() - 0.5) * 70, d.y + (Math.random() - 0.5) * 60);
      }
      if (!this._sludgeToast || this.time - this._sludgeToast > 6) {
        this._sludgeToast = this.time;
        this.hud.toast('TOXIC RUNOFF', 'warn');
        this.renderer.setTint([90, 110, 40], 0.16);
      }
    }
  }

  /* ---- air, drowning, hints ----------------------------------- */

  _resources(dt) {
    const d = this.dolphin;

    if (d.air <= 0) {
      this.drown += dt;
      const k = clamp01(this.drown / DROWN_LIMIT);
      this.renderer.setTint([10, 24, 48], 0.10 + k * 0.28);
      if (!this.hints.has('drown')) {
        this.hints.add('drown');
        this.hud.toast('OUT OF AIR — SURFACE NOW', 'warn');
      }
      this.warnTimer -= dt;
      if (this.warnTimer <= 0) {
        this.warnTimer = lerp(0.7, 0.22, k);
        audio.warn(k);
        this.cam.addTrauma(0.08 + k * 0.1);
      }
      if (this.drown >= DROWN_LIMIT) { this.endRun('drowned'); return; }
    } else {
      if (this.drown > 0) {
        this.drown = Math.max(0, this.drown - dt * 4);
        if (this.drown === 0) this.hints.delete('drown');
      }
      if (d.air < 0.28) {
        this.warnTimer -= dt;
        if (this.warnTimer <= 0) {
          this.warnTimer = lerp(1.1, 0.5, clamp01(1 - d.air / 0.28));
          audio.warn(clamp01(1 - d.air / 0.28) * 0.6);
        }
        if (!this.hints.has('air')) {
          this.hints.add('air');
          this.hud.toast('LOW AIR — HEAD FOR THE SURFACE', 'warn');
        }
      } else {
        this.hints.delete('air');
      }
    }

    /* ---- contextual first-time coaching ---- */
    if (!this.hints.has('t_boost') && this.runTime > 7) {
      this.hints.add('t_boost');
      this.hud.toast(this.input.hasTouch ? 'HOLD ⚡ TO BOOST' : 'HOLD SHIFT TO BOOST', 'aqua');
    }
    if (!this.hints.has('t_sonar') && this.runTime > 17) {
      this.hints.add('t_sonar');
      this.hud.toast(this.input.hasTouch ? 'TAP 📡 TO ECHOLOCATE' : 'PRESS SPACE TO ECHOLOCATE', 'aqua');
    }
    if (!this.hints.has('t_breach') && d.y > 700 && this.runTime > 26) {
      this.hints.add('t_breach');
      this.hud.toast('BOOST STRAIGHT UP TO BREACH', 'aqua');
    }

    this.deepest = Math.max(this.deepest, d.y);
  }

  _zones() {
    const z = zoneAt(this.dolphin.y);
    if (z.name !== this._zone) {
      const first = this._zone !== undefined;
      this._zone = z.name;
      this.hud.setZone(z.name);
      if (first) audio.zone();
    }
  }

  /* ---- sonar -------------------------------------------------- */

  _ping() {
    if (this.sonarCd > 0) return;
    this.sonarCd = SONAR_CD;
    const n = this.dolphin.nose();
    this.sonars.push({ x: n.x, y: n.y, r: 20, life: 1, max: SONAR_REACH });
    audio.sonar();
    this.dom.btnSonar?.classList.add('cooling');
  }

  _updateSonar(dt) {
    if (this.sonarCd > 0) {
      this.sonarCd -= dt;
      if (this.sonarCd <= 0) this.dom.btnSonar?.classList.remove('cooling');
    }
    for (let i = this.sonars.length - 1; i >= 0; i--) {
      const s = this.sonars[i];
      s.life -= dt / 1.35;
      const prev = s.r;
      s.r = s.max * (1 - Math.pow(1 - (1 - s.life), 2));
      // Reveal the annulus swept this frame, not the whole disc.
      if (s.r > prev) this.trash.reveal(s.x, s.y, s.r);
      if (s.life <= 0) this.sonars.splice(i, 1);
    }
  }

  /* ---- ambient particulate ------------------------------------ */

  _seedAmbient() {
    const b = this.renderer.viewBounds(this.cam, 400);
    for (let i = 0; i < 140; i++) {
      this.particles.snow(
        lerp(b.x0, b.x1, Math.random()),
        lerp(Math.max(b.y0, 10), b.y1, Math.random())
      );
    }
    this._ambientSeeded = true;
  }

  _updateAmbient(dt, b) {
    const q = this.renderer.q.particles;
    const depth01 = clamp01(this.cam.y / MAX_DEPTH);

    // Everything below is suspended *in water*, so nothing may spawn
    // above the waterline: drifting motes in the sky read as dust on
    // the screen and break the illusion instantly.
    const top = Math.max(b.y0, 8);
    const bot = b.y1;
    if (bot <= top) return;
    const randX = () => lerp(b.x0, b.x1, Math.random());
    const randY = () => lerp(top, bot, Math.random());

    // Marine snow everywhere, denser in mid-water.
    this._snowAcc = (this._snowAcc || 0) + dt * 26 * q;
    while (this._snowAcc >= 1) {
      this._snowAcc--;
      this.particles.snow(randX(), Math.max(b.y0 - 20, 10));
    }

    // Bioluminescent plankton, only meaningful in the dark.
    if (depth01 > 0.4) {
      this._plankAcc = (this._plankAcc || 0) + dt * (depth01 - 0.4) * 44 * q;
      while (this._plankAcc >= 1) {
        this._plankAcc--;
        this.particles.plankton(randX(), randY());
      }
    }

    // Suspended filth, which literally clears up as you clean.
    const filth = clamp01(1 - this.health * 1.3);
    if (filth > 0.02) {
      this._grimeAcc = (this._grimeAcc || 0) + dt * filth * 16 * q;
      while (this._grimeAcc >= 1) {
        this._grimeAcc--;
        this.particles.grime(randX(), randY());
      }
    }
  }

  /* ---- attract-mode AI ---------------------------------------- */

  _attractAI(dt) {
    const d = this.dolphin;
    this._aiTimer = (this._aiTimer || 0) - dt;

    // Breathe first, always.
    if (d.air < 0.42) {
      const want = Math.atan2(-1, Math.sin(this.time * 0.4) * 0.55);
      return { move: { x: Math.cos(want), y: Math.sin(want) }, boost: d.air < 0.3 };
    }

    // Otherwise chase the nearest bit of litter.
    if (!this._aiTarget || !this._aiTarget.alive || this._aiTimer <= 0) {
      this._aiTimer = 3;
      let best = null, bestD = 1e9;
      for (const it of this.trash.near(d.x, 1100)) {
        const dd = Math.hypot(it.x - d.x, it.y - d.y);
        if (dd < bestD) { bestD = dd; best = it; }
      }
      this._aiTarget = best;
    }

    const tgt = this._aiTarget;
    if (tgt && tgt.alive) {
      let ax = tgt.x - d.x, ay = tgt.y - d.y;
      // Steer up off the seabed so the demo doesn't plough the sand.
      const fy = this.world.floorAt(d.x);
      if (d.y > fy - 90) ay -= 160;
      const l = Math.hypot(ax, ay) || 1;
      return { move: { x: ax / l, y: ay / l }, boost: l > 420 };
    }

    const a = Math.sin(this.time * 0.23) * 0.6;
    return { move: { x: Math.cos(a), y: Math.sin(a) * 0.4 }, boost: false };
  }

  /* ---- HUD ---------------------------------------------------- */

  _hud() {
    const d = this.dolphin;
    this.hud.setScore(Math.round(this.displayScore));
    this.hud.setAir(d.air);
    this.hud.setBoost(d.boost);
    this.hud.setCombo(this.multiplier, this.comboTimer / COMBO_WINDOW);
    this.hud.setHealth(this.health);
    this.hud.setDepth(Math.max(0, d.y * METERS_PER_UNIT));
  }

  /* ---------------------------------------------------------- */
  /* Render                                                      */
  /* ---------------------------------------------------------- */

  render(dt) {
    const rn = this.renderer;
    const ctx = rn.ctx;
    const gctx = rn.gctx;
    const cam = this.cam;
    const t = this.time;
    const d = this.dolphin;

    rn.clearGlow();
    const bounds = rn.viewBounds(cam, 220);
    const depth01 = clamp01(d.y / MAX_DEPTH);

    /* 1 — sky + water column ---------------------------------- */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // How much water sits between the camera and the sky, for Snell's window.
    const camSub = clamp01(cam.y / 110);
    rn.drawBackground(cam, MAX_DEPTH, t, this.health, camSub);

    /* 2 — god rays (behind everything solid) ------------------ */
    rn.drawGodRays(cam, MAX_DEPTH, t);

    /* 3 — world space ----------------------------------------- */
    rn.pushWorld(cam);
    rn.pushWorldGlow(cam);

    this.world.drawBackdrop(ctx, cam, bounds);
    this.wildlife.drawBack(ctx, bounds, t);
    this.world.drawProps(ctx, gctx, cam, bounds, 1);
    this.world.drawTerrain(ctx, cam, bounds);
    this.world.drawProps(ctx, gctx, cam, bounds, 0);
    this.wildlife.drawMid(ctx, gctx, bounds, t, this.health);
    this.trash.draw(ctx, gctx, bounds, t, this.health);

    this._drawSonar(ctx, gctx);

    this.particles.draw(ctx, gctx, bounds, t);
    d.draw(ctx, gctx, rn, depth01, t);

    rn.popWorldGlow();
    rn.popWorld();

    /* 4 — caustics over the scene ----------------------------- */
    rn.drawCaustics(cam, MAX_DEPTH, t);

    /* 5 — the waterline --------------------------------------- */
    rn.drawSurface(cam, t);

    /* 6 — bloom ------------------------------------------------ */
    rn.drawBloom(1);

    /* 7 — grade ------------------------------------------------ */
    rn.drawGrade(cam, MAX_DEPTH, d.submerged, dt);

    /* 8 — drowning tunnel vision ------------------------------- */
    if (this.drown > 0) this._drawDrown(ctx, rn);
  }

  _drawSonar(ctx, gctx) {
    for (const s of this.sonars) {
      const a = Math.pow(s.life, 1.5);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(140,255,235,${a * 0.55})`;
      ctx.lineWidth = 3 + a * 4;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.stroke();
      ctx.strokeStyle = `rgba(210,255,250,${a * 0.3})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 0.86, 0, TAU); ctx.stroke();
      ctx.restore();
      if (gctx) {
        gctx.strokeStyle = `rgba(140,255,235,${a * 0.45})`;
        gctx.lineWidth = 6;
        gctx.beginPath(); gctx.arc(s.x, s.y, s.r, 0, TAU); gctx.stroke();
      }
    }
  }

  _drawDrown(ctx, rn) {
    const k = clamp01(this.drown / DROWN_LIMIT);
    const W = rn.W, H = rn.H;
    // Heartbeat throb on the tunnel so the pressure is felt, not read.
    const beat = 1 + Math.sin(this.time * 7) * 0.03 * k;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const inner = Math.max(W, H) * (0.56 - k * 0.42) * beat;
    const g = ctx.createRadialGradient(W / 2, H / 2, inner * 0.42, W / 2, H / 2, inner);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(2,6,14,${0.55 + k * 0.42})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}
