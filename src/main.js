/* ============================================================
   main.js — bootstrap and screen flow.

   Everything DOM-shaped lives here: which overlay is up, the
   settings, persistence, and unlocking audio on the first
   gesture. The Game itself never touches a screen element.
   ============================================================ */

import { Game } from './game.js';
import { Input } from './core/input.js';
import { HUD } from './ui/hud.js';
import { Loop } from './core/loop.js';
import { audio } from './core/audio.js';

const $ = id => document.getElementById(id);

const dom = {
  canvas: $('game'), hud: $('hud'),
  score: $('score'), comboWrap: $('comboWrap'), comboText: $('comboText'), comboFill: $('comboFill'),
  airMeter: $('airMeter'), airFill: $('airFill'), boostFill: $('boostFill'),
  zoneName: $('zoneName'), healthFill: $('healthFill'), healthPct: $('healthPct'),
  toastLayer: $('toastLayer'), depthTag: $('depthTag'),
  stickZone: $('stickZone'), stickBase: $('stickBase'), stickKnob: $('stickKnob'),
  btnSonar: $('btnSonar'), btnBoost: $('btnBoost'), btnPause: $('btnPause'),
  titleScreen: $('titleScreen'), howScreen: $('howScreen'),
  pauseScreen: $('pauseScreen'), overScreen: $('overScreen'), boot: $('boot'),
  btnPlay: $('btnPlay'), btnHow: $('btnHow'), btnHowClose: $('btnHowClose'),
  btnAudio: $('btnAudio'), btnResume: $('btnResume'), btnQuit: $('btnQuit'),
  btnAgain: $('btnAgain'), btnMenu: $('btnMenu'),
  volMusic: $('volMusic'), volSfx: $('volSfx'), optQuality: $('optQuality'),
  bestLine: $('bestLine'),
  pScore: $('pScore'), pTrash: $('pTrash'), pSaved: $('pSaved'),
  overTitle: $('overTitle'), overSub: $('overSub'),
  rScore: $('rScore'), rTrash: $('rTrash'), rSaved: $('rSaved'),
  rDepth: $('rDepth'), rCombo: $('rCombo'), rHealth: $('rHealth'), rBest: $('rBest'),
};

/* ============================================================
   Persistence
   ============================================================ */

const STORE = 'abyssal.v1';
const defaults = { best: 0, music: 65, sfx: 85, quality: 'high', sound: true, plays: 0 };
let save = { ...defaults };

try {
  const raw = localStorage.getItem(STORE);
  if (raw) save = { ...defaults, ...JSON.parse(raw) };
} catch (e) { /* private mode, or no storage — defaults are fine */ }

const persist = () => {
  try { localStorage.setItem(STORE, JSON.stringify(save)); } catch (e) { /* ignore */ }
};

/* ============================================================
   Quality auto-detection
   ============================================================ */

function guessQuality() {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const px = window.innerWidth * window.innerHeight * (window.devicePixelRatio || 1) ** 2;
  if (mem <= 2 || cores <= 2) return 'low';
  if (px > 4.2e6 && cores <= 4) return 'med';
  return 'high';
}
if (!localStorage.getItem(STORE)) save.quality = guessQuality();

/* ============================================================
   Boot
   ============================================================ */

const input = new Input(dom.canvas, dom);
const hud = new HUD(dom);
const game = new Game(dom.canvas, dom, hud, input);

game.renderer.setQuality(save.quality);
audio.musicVol = save.music / 100;
audio.sfxVol = save.sfx / 100;
audio.enabled = save.sound;

let screen = 'title';

/* --- screen helpers --------------------------------------------- */

const SCREENS = {
  title: dom.titleScreen, how: dom.howScreen,
  pause: dom.pauseScreen, over: dom.overScreen,
};

/** Pass 'none' to clear every overlay and show the game. */
function showScreen(name) {
  screen = name;
  for (const [key, el] of Object.entries(SCREENS)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function refreshBestLine() {
  dom.bestLine.textContent = save.best > 0
    ? `PERSONAL BEST  ${save.best.toLocaleString('en-US')}`
    : 'NO DIVE LOGGED YET';
}
refreshBestLine();

/* ============================================================
   Audio unlock — browsers require a gesture
   ============================================================ */

let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  audio.init();
  audio.resume();
  audio.setEnabled(save.sound);
  audio.setMusicVolume(save.music / 100);
  audio.setSfxVolume(save.sfx / 100);
  audio.startMusic();
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, unlockAudio, { once: false, passive: true });
}

/* ============================================================
   Buttons
   ============================================================ */

const tap = (el, fn, sound = 'tap') => {
  if (!el) return;
  el.addEventListener('click', e => {
    e.preventDefault();
    unlockAudio();
    audio.ui(sound);
    fn(e);
  });
};

tap(dom.btnPlay, () => {
  save.plays++;
  persist();
  showScreen('none');
  game.beginRun();
});

tap(dom.btnHow, () => showScreen('how'));
tap(dom.btnHowClose, () => showScreen('title'), 'back');

tap(dom.btnAudio, () => {
  save.sound = !save.sound;
  audio.setEnabled(save.sound);
  dom.btnAudio.textContent = 'Sound: ' + (save.sound ? 'On' : 'Off');
  dom.btnAudio.setAttribute('aria-pressed', String(save.sound));
  persist();
});
dom.btnAudio.textContent = 'Sound: ' + (save.sound ? 'On' : 'Off');

tap(dom.btnPause, () => doPause());
tap(dom.btnResume, () => doResume());

tap(dom.btnQuit, () => {
  game.toAttract();
  showScreen('title');
  refreshBestLine();
}, 'back');

tap(dom.btnAgain, () => {
  showScreen('none');
  game.beginRun();
});

tap(dom.btnMenu, () => {
  game.toAttract();
  showScreen('title');
  refreshBestLine();
}, 'back');

function doPause() {
  if (game.state !== 'playing') return;
  game.pause();
  dom.pScore.textContent = Math.round(game.score).toLocaleString('en-US');
  dom.pTrash.textContent = game.collected;
  dom.pSaved.textContent = game.rescued;
  showScreen('pause');
}

function doResume() {
  showScreen('none');
  game.resume();
  audio.resume();
}

/* --- settings --------------------------------------------------- */

dom.volMusic.value = save.music;
dom.volSfx.value = save.sfx;
dom.volMusic.addEventListener('input', () => {
  save.music = +dom.volMusic.value;
  audio.setMusicVolume(save.music / 100);
  persist();
});
dom.volSfx.addEventListener('input', () => {
  save.sfx = +dom.volSfx.value;
  audio.setSfxVolume(save.sfx / 100);
  persist();
});

for (const b of dom.optQuality.querySelectorAll('button')) {
  b.classList.toggle('on', b.dataset.q === save.quality);
  b.addEventListener('click', () => {
    save.quality = b.dataset.q;
    for (const o of dom.optQuality.querySelectorAll('button')) o.classList.remove('on');
    b.classList.add('on');
    game.renderer.setQuality(save.quality);
    audio.ui();
    persist();
  });
}

/* ============================================================
   Results
   ============================================================ */

const ENDINGS = {
  drowned: {
    title: 'Out of breath',
    subs: [
      'The surface was closer than it looked.',
      'Even dolphins have to come up for air.',
      'One more push and you would have made it.',
    ],
  },
};

game.onGameOver = (s) => {
  const end = ENDINGS[s.reason] || { title: 'Dive complete', subs: ['The water is a little clearer now.'] };
  dom.overTitle.textContent = end.title;
  dom.overSub.textContent = end.subs[(Math.random() * end.subs.length) | 0];

  dom.rScore.textContent = s.score.toLocaleString('en-US');
  dom.rTrash.textContent = s.trash;
  dom.rSaved.textContent = s.rescued;
  dom.rDepth.textContent = s.deepest + 'm';
  dom.rCombo.textContent = 'x' + s.bestCombo;
  dom.rHealth.textContent = s.health + '%';

  const isBest = s.score > save.best;
  dom.rBest.classList.toggle('hidden', !isBest);
  if (isBest) { save.best = s.score; persist(); }

  showScreen('over');
};

/* ============================================================
   Global keys
   ============================================================ */

addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 'm') {
    save.sound = !save.sound;
    audio.setEnabled(save.sound);
    dom.btnAudio.textContent = 'Sound: ' + (save.sound ? 'On' : 'Off');
    persist();
  }
  if (k === 'escape' || k === 'p') {
    if (game.state === 'playing') doPause();
    else if (game.state === 'paused') doResume();
  }
  if (k === 'enter' && (screen === 'title' || screen === 'over')) {
    unlockAudio(); audio.ui();
    showScreen('none');
    game.beginRun();
  }
});

/* ============================================================
   Lifecycle
   ============================================================ */

let resizeTimer = null;
const onResize = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => game.resize(), 90);
};
addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);
if (window.visualViewport) visualViewport.addEventListener('resize', onResize);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (game.state === 'playing') doPause();
    audio.suspend();
  } else if (unlocked && save.sound && game.state !== 'paused') {
    audio.resume();
  }
});

/* ============================================================
   Run
   ============================================================ */

const loop = new Loop({
  update: (dt) => {
    // The sim keeps ticking behind the title so attract mode lives.
    game.update(dt);
  },
  render: (dt) => {
    game.render(dt);
  },
});

// One frame before revealing, so the first thing seen is the ocean.
game.resize();
game.update(1 / 120);
game.render(1 / 120);

requestAnimationFrame(() => {
  dom.boot.style.transition = 'opacity .6s ease';
  dom.boot.style.opacity = '0';
  setTimeout(() => dom.boot.classList.add('hidden'), 620);
  loop.start();
});

/* Expose a small handle for debugging from the console. */
window.ABYSSAL = { game, audio, loop, save };
