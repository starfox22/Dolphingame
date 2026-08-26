/* ============================================================
   hud.js — thin wrapper over the DOM overlay.

   Kept deliberately dumb: the game pushes values in, this file
   only decides how to show them. Writes are guarded so we don't
   touch the DOM (and trigger style recalculation) on frames where
   nothing changed.
   ============================================================ */

import { clamp01 } from '../core/math.js';

export class HUD {
  constructor(dom) {
    this.d = dom;
    this._score = -1;
    this._air = -1;
    this._boost = -1;
    this._combo = -1;
    this._health = -1;
    this._depth = -1;
    this._zone = '';
    this._lowAir = false;
    this._toasts = 0;
  }

  setScore(v) {
    if (v === this._score) return;
    const jump = v > this._score;
    this._score = v;
    this.d.score.textContent = v.toLocaleString('en-US');
    if (jump) {
      this.d.score.classList.remove('pop');
      // Force a reflow so the animation restarts on every gain.
      void this.d.score.offsetWidth;
      this.d.score.classList.add('pop');
    }
  }

  setAir(v) {
    const q = Math.round(v * 100);
    if (q === this._air) return;
    this._air = q;
    this.d.airFill.style.transform = `scaleY(${clamp01(v)})`;
    const low = v < 0.25;
    if (low !== this._lowAir) {
      this._lowAir = low;
      this.d.airMeter.classList.toggle('low', low);
    }
  }

  setBoost(v) {
    const q = Math.round(v * 100);
    if (q === this._boost) return;
    this._boost = q;
    this.d.boostFill.style.transform = `scaleY(${clamp01(v)})`;
  }

  setCombo(mult, frac) {
    const on = mult > 1;
    if (mult !== this._combo) {
      this._combo = mult;
      this.d.comboText.textContent = 'x' + mult;
      this.d.comboWrap.classList.toggle('on', on);
    }
    if (on) this.d.comboFill.style.transform = `scaleX(${clamp01(frac)})`;
  }

  setHealth(v) {
    const q = Math.round(v * 100);
    if (q === this._health) return;
    this._health = q;
    this.d.healthFill.style.width = q + '%';
    this.d.healthPct.textContent = q + '%';
  }

  setDepth(m) {
    const q = Math.round(m / 5) * 5;
    if (q === this._depth) return;
    this._depth = q;
    this.d.depthTag.textContent = q + 'm';
  }

  setZone(name) {
    if (name === this._zone) return;
    this._zone = name;
    this.d.zoneName.textContent = name;
    this.d.zoneName.classList.remove('flash');
    void this.d.zoneName.offsetWidth;
    this.d.zoneName.classList.add('flash');
  }

  toast(text, cls = 'aqua') {
    // Cap the stack: a burst of pickups shouldn't wallpaper the screen.
    if (this._toasts > 4) return;
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.textContent = text;
    this.d.toastLayer.appendChild(el);
    this._toasts++;
    setTimeout(() => { el.remove(); this._toasts--; }, 2500);
  }

  show(on) {
    this.d.hud.classList.toggle('hidden', !on);
    this.d.hud.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
}
