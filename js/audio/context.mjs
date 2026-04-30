/**
 * ═══════════════════════════════════════════════════════════════
 *  Audio Bounded Context
 * ═══════════════════════════════════════════════════════════════
 *
 *  Owns: ambient background music, scroll-triggered section cues,
 *        mute/unmute toggle (localStorage-persisted).
 *
 *  Design constraints:
 *    - Self-hosted audio only (CSP: media-src 'self')
 *    - First user interaction = autoplay gate + implicit consent
 *    - Web Audio API for all synthesis and playback
 *    - Respects prefers-reduced-motion (no cues when set)
 *    - Gracefully silent when /audio/ambient.mp3 is absent
 *
 *  Domain Events emitted:
 *    - AUDIO_UNLOCKED (first user interaction)
 *    - AUDIO_MUTED_CHANGED { muted: boolean }
 *
 *  Domain Events consumed:
 *    - SECTION_REVEALED { section } → plays section enter cue
 */

import { bus, DomainEvents } from '../shared/event-bus.mjs';
import { Contexts } from '../shared/types.mjs';

// ── Constants ───────────────────────────────────────────────
const STORAGE_KEY   = 'yegor-audio-muted';
const NAV_STATE_KEY = 'yegor-audio-nav';
const AMBIENT_SRCS  = ['/audio/ambient.mp3', '/audio/ambient.ogg'];

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// iOS Safari cannot resume AudioContext outside user gestures; beforeunload is also unreliable on iOS.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isMobile = isIOS || /Android/i.test(navigator.userAgent);
// Mobile speakers need more headroom — 1.6× makes sequencer and ambient audible at mid system volume.
const VOL_SCALE   = isMobile ? 1.6 : 1.0;
const AMBIENT_VOL = 0.25 * VOL_SCALE;
const CUE_VOL     = 0.10 * VOL_SCALE;  // section bell chime — clearly audible

// ── Navigation continuity — detect cross-page navigation within 5s ──
const _navState = (() => {
  try {
    const s = JSON.parse(sessionStorage.getItem(NAV_STATE_KEY));
    if (s && typeof s.savedAt === 'number' && Date.now() - s.savedAt < 5000) return s;
    return null;
  } catch { return null; }
})();
const isContinuation = _navState !== null;

// ── State ───────────────────────────────────────────────────
let actx             = null;
let masterGain       = null;
let ambientGain      = null;
let sfxGain          = null;   // independent of ambient mute — SFX always audible when sfxEnabled
let ambientSource    = null;
let ambientBuffer    = null;
let isUnlocked       = false;
let wasJustUnlocked  = false;
let isMuted          = localStorage.getItem(STORAGE_KEY) === '1';
let _seqTimer        = null;

// ── Per-section bell cooldown (for re-scroll cues) ─────────
const _sectionCooldowns = new Set();

// ── AudioContext lifecycle ──────────────────────────────────

function initSync() {
  actx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = actx.createGain();
  masterGain.gain.value = isMuted ? 0 : 1;
  masterGain.connect(actx.destination);

  ambientGain = actx.createGain();
  ambientGain.gain.value = AMBIENT_VOL;
  ambientGain.connect(masterGain);

  // SFX routes directly to destination, bypassing masterGain mute
  sfxGain = actx.createGain();
  sfxGain.gain.value = 1.0;
  sfxGain.connect(actx.destination);

  // iOS Safari requires a real audio buffer scheduled synchronously within the user
  // gesture to fully unlock the engine. resume() alone is not sufficient on iOS.
  const silentBuf = actx.createBuffer(1, 1, actx.sampleRate);
  const silentSrc = actx.createBufferSource();
  silentSrc.buffer = silentBuf;
  silentSrc.connect(actx.destination);
  silentSrc.start(0);
}

async function unlockAudio({ continuation = false } = {}) {
  if (isUnlocked) return;
  isUnlocked = true;
  wasJustUnlocked = !continuation;

  try {
    initSync();

    // Chrome suspends AudioContext on tab hide and sometimes during power-save; auto-resume.
    actx.onstatechange = () => {
      if (isUnlocked && actx && actx.state === 'suspended') actx.resume().catch(() => {});
    };

    if (actx.state !== 'running') await actx.resume();
    // iOS Safari can lag before reflecting state=running after resume() resolves;
    // wait one frame before checking so we don't bail out prematurely.
    if (isIOS && actx.state !== 'running') {
      await new Promise(r => setTimeout(r, 80));
    }
    if (actx.state !== 'running') {
      // Autoplay still blocked — clean up and let the next user gesture retry
      isUnlocked = false;
      wasJustUnlocked = false;
      try { actx.close(); } catch {}
      actx = null; masterGain = null; ambientGain = null; sfxGain = null;
      return;
    }

    document.getElementById('audio-toggle')?.classList.add('audio-unlocked');
    bus.emit(DomainEvents.AUDIO_UNLOCKED);

    const offset = continuation && _navState ? _navState.offset : 0;
    loadAndStartAmbient(offset);
    if (!isMuted) {
      if (!continuation) playPageJingle();
      startSequencer();
    }
  } catch (err) {
    console.warn('[Audio] Context init failed:', err);
    isUnlocked = false;
    wasJustUnlocked = false;
    try { if (actx) actx.close(); } catch {}
    actx = null; masterGain = null; ambientGain = null; sfxGain = null;
  }
}

async function loadAndStartAmbient(offset = 0) {
  for (const src of AMBIENT_SRCS) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      ambientBuffer = await actx.decodeAudioData(buf);
      startAmbient(offset);
      return;
    } catch { /* try next format */ }
  }
}

function startAmbient(offset = 0) {
  if (!ambientBuffer || ambientSource) return;
  ambientSource = actx.createBufferSource();
  ambientSource.buffer = ambientBuffer;
  ambientSource.loop = true;
  ambientSource.connect(ambientGain);
  ambientSource.start(0, offset % ambientBuffer.duration);
}

// ── Section cue — piano bell arpeggio ──────────────────────
// Three staggered notes (C5-E5-G5) with harmonic overtones for bell texture.

function playSectionCue() {
  if (!actx || isMuted || reduceMotion) return;
  const t = actx.currentTime;
  const NOTES = [523.25, 659.25, 783.99]; // C5, E5, G5

  NOTES.forEach((freq, i) => {
    const nt = t + i * 0.13;

    const osc = actx.createOscillator();
    const env = actx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.connect(env);
    env.connect(masterGain);
    env.gain.setValueAtTime(0, nt);
    env.gain.linearRampToValueAtTime(CUE_VOL, nt + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, nt + 0.9);
    osc.start(nt);
    osc.stop(nt + 0.9);

    // 2nd harmonic for bell shimmer
    const osc2 = actx.createOscillator();
    const env2 = actx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;
    osc2.connect(env2);
    env2.connect(masterGain);
    env2.gain.setValueAtTime(0, nt);
    env2.gain.linearRampToValueAtTime(CUE_VOL * 0.28, nt + 0.006);
    env2.gain.exponentialRampToValueAtTime(0.001, nt + 0.5);
    osc2.start(nt);
    osc2.stop(nt + 0.5);
  });
}

// ── Page entry jingle — 5-note pentatonic ascending ────────
// Plays once on first audio unlock. Quiet, like opening a Minecraft world.

function playPageJingle() {
  if (!actx || isMuted || reduceMotion) return;
  const NOTES = [261.63, 329.63, 392, 440, 523.25]; // C4-E4-G4-A4-C5
  const t = actx.currentTime + 0.08;

  NOTES.forEach((freq, i) => {
    const nt = t + i * 0.11;
    const osc = actx.createOscillator();
    const env = actx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.connect(env);
    env.connect(masterGain);
    env.gain.setValueAtTime(0, nt);
    env.gain.linearRampToValueAtTime(0.055, nt + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, nt + 0.65);
    osc.start(nt);
    osc.stop(nt + 0.65);
  });
}

// ── Multi-Song Sequencer ─────────────────────────────────────
// Five melodic songs that rotate automatically, each paired with a visual theme:
//   "Swamp"   — G major 80 BPM  (cyan,    signature)
//   "Nocturne"— A minor 70 BPM  (purple,  melancholic)
//   "Ember"   — D major 90 BPM  (amber,   bright)
//   "Dawn"    — E major 75 BPM  (sky,     hopeful ascending)
//   "Abyss"   — F# minor 62 BPM (magenta, deep haunting)
// Each song is 32 beats; a short rest separates consecutive songs.

const SEQ_LOOKAHEAD = 0.15;
const SEQ_TICK_MS   = 80;

const SONGS = [
  { name: 'Swamp', theme: 'swamp', bpm: 80,
    melody: [
      [7,1],[11,1],[14,1],[11,0.5],[9,0.5],
      [7,2],[4,1],[7,1],
      [9,1],[7,1],[4,1],[2,1],
      [-5,4],
      [14,1],[11,1],[9,2],
      [9,1],[7,1],[11,1],[9,1],
      [7,1.5],[4,0.5],[2,2],
      [-5,2],[2,2],
    ],
    chords: [
      [-17,-13,-10,-5,-1],
      [-20,-13,-8,-5,-1],
      [-24,-17,-12,-8,-5],
      [-22,-15,-10,-6,-3],
    ],
    bass: [-17,-20,-24,-22],
  },
  { name: 'Nocturne', theme: 'nocturne', bpm: 70,
    melody: [
      [9,2],[12,1],[16,1],
      [12,1],[9,1],[7,2],
      [5,1],[7,1],[9,2],
      [-3,4],
      [16,1],[12,1],[9,1],[7,1],
      [9,1],[12,1],[14,1],[12,1],
      [9,1.5],[7,0.5],[5,2],
      [-8,2],[2,2],
    ],
    chords: [
      [-15,-8,-3,0,4],
      [-19,-12,-7,-3,0],
      [-24,-17,-12,-8,-5],
      [-17,-10,-5,-1,2],
    ],
    bass: [-15,-19,-24,-17],
  },
  { name: 'Ember', theme: 'ember', bpm: 90,
    melody: [
      [2,1],[6,1],[9,1],[11,1],
      [14,2],[11,1],[9,1],
      [6,1],[9,1],[11,1],[9,1],
      [6,4],
      [14,1],[13,1],[11,1],[9,1],
      [11,2],[9,1],[11,1],
      [14,1],[11,1],[9,1],[6,1],
      [2,2],[-10,2],
    ],
    chords: [
      [-22,-15,-10,-6,-3],
      [-15,-8,-3,1,4],
      [-13,-6,-1,2,6],
      [-17,-10,-5,-1,2],
    ],
    bass: [-22,-15,-13,-17],
  },
  { name: 'Dawn', theme: 'dawn', bpm: 75,
    melody: [
      [4,1],[8,1],[11,1],[13,1],
      [16,2],[13,1],[11,1],
      [8,1],[11,1],[13,1],[16,1],
      [11,4],
      [4,1],[6,1],[8,2],
      [11,1],[9,1],[8,1],[4,1],
      [6,2],[4,1.5],[1,0.5],
      [-8,2],[4,2],
    ],
    chords: [
      [-20,-16,-13,-8,-4],
      [-15,-11,-8,-3,1],
      [-13,-9,-6,-1,3],
      [-23,-16,-11,-4,1],
    ],
    bass: [-20,-15,-13,-23],
  },
  { name: 'Abyss', theme: 'abyss', bpm: 62,
    melody: [
      [18,2],[16,1],[14,1],
      [13,2],[11,2],
      [9,1],[8,1],[6,2],
      [-6,4],
      [13,1.5],[11,0.5],[9,2],
      [8,1],[6,1],[8,1],[9,1],
      [13,2],[11,2],
      [6,2],[1,2],
    ],
    chords: [
      [-18,-15,-11,-6,-3],
      [-13,-10,-6,-1,2],
      [-15,-11,-8,-3,1],
      [-20,-16,-13,-8,-4],
    ],
    bass: [-18,-13,-15,-20],
  },
];

function _semToHz(n) { return 261.63 * Math.pow(2, n / 12); }

const FADE_IN_BEATS  = 6;
const FADE_OUT_BEATS = 8;
function _mixFade() {
  const fadeIn  = Math.min(1, _seqBeatsSinceStart / FADE_IN_BEATS);
  const beatsLeft = _seqSongBeats - _seqBeatsSinceStart;
  const fadeOut = Math.min(1, beatsLeft / FADE_OUT_BEATS);
  return Math.max(0.05, Math.min(fadeIn, fadeOut));
}

function _seqPiano(freq, t, beats, beatS, fade = 1) {
  if (!actx) return;
  const dur = beats * beatS;
  const V   = 0.072 * VOL_SCALE * fade;
  const atk = 0.006;

  const o1 = actx.createOscillator(), e1 = actx.createGain();
  o1.type = 'sine'; o1.frequency.value = freq;
  o1.connect(e1); e1.connect(masterGain);
  e1.gain.setValueAtTime(0, t);
  e1.gain.linearRampToValueAtTime(V, t + atk);
  e1.gain.exponentialRampToValueAtTime(V * 0.28, t + Math.min(dur * 0.55, 0.85));
  e1.gain.exponentialRampToValueAtTime(0.0005, t + dur * 0.92);
  o1.start(t); o1.stop(t + dur);

  // 2nd harmonic — warmth / bell shimmer
  const o2 = actx.createOscillator(), e2 = actx.createGain();
  o2.type = 'triangle'; o2.frequency.value = freq * 2;
  o2.connect(e2); e2.connect(masterGain);
  e2.gain.setValueAtTime(0, t);
  e2.gain.linearRampToValueAtTime(V * 0.13, t + atk);
  e2.gain.exponentialRampToValueAtTime(0.0005, t + Math.min(dur * 0.35, 0.32));
  o2.start(t); o2.stop(t + Math.min(dur * 0.35, 0.32) + 0.01);
}

function _seqPad(semitones, t, beatS, fade = 1) {
  if (!actx) return;
  const dur = beatS * 4;
  const padV = 0.016 * VOL_SCALE * fade;
  semitones.forEach(n => {
    const o = actx.createOscillator(), e = actx.createGain();
    o.type = 'sine'; o.frequency.value = _semToHz(n);
    o.connect(e); e.connect(masterGain);
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(padV, t + 0.2);
    e.gain.setValueAtTime(padV, t + dur - 0.4);
    e.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.start(t); o.stop(t + dur + 0.01);
  });
}

function _seqBass(n, t, fade = 1) {
  if (!actx) return;
  const o = actx.createOscillator(), e = actx.createGain();
  o.type = 'sine'; o.frequency.value = _semToHz(n);
  o.connect(e); e.connect(masterGain);
  e.gain.setValueAtTime(0, t);
  e.gain.linearRampToValueAtTime(0.09 * VOL_SCALE * fade, t + 0.010);
  e.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  o.start(t); o.stop(t + 0.56);
}

let _seqNoteIdx         = 0;
let _seqNextT           = 0;
let _seqBeats           = 0;
let _seqLastBar         = -1;
let _seqSongIdx         = 0;
let _seqBeatsSinceStart = 0;
let _seqSongBeats       = 0;

function startSequencer() {
  if (_seqTimer !== null) return;
  _seqNextT           = actx.currentTime + 0.5;
  _seqBeats           = 0;
  _seqNoteIdx         = 0;
  _seqLastBar         = -1;
  _seqSongIdx         = 0;
  _seqBeatsSinceStart = 0;
  _seqSongBeats       = SONGS[0].melody.reduce((s, [, b]) => s + b, 0);
  bus.emit(DomainEvents.THEME_CHANGED, { theme: SONGS[0].theme, name: SONGS[0].name });
  _seqTick();
}

function stopSequencer() {
  clearTimeout(_seqTimer);
  _seqTimer = null;
}

function _seqTick() {
  if (!actx || isMuted) { _seqTimer = null; return; }

  const horizon = actx.currentTime + SEQ_LOOKAHEAD;
  while (_seqNextT < horizon) {
    const song  = SONGS[_seqSongIdx];
    const beatS = 60 / song.bpm;
    const [sem, beats] = song.melody[_seqNoteIdx];
    const bar = Math.floor(_seqBeats / 4);
    const fade = _mixFade();

    if (bar !== _seqLastBar) {
      const ci = bar % song.chords.length;
      _seqPad(song.chords[ci], _seqNextT, beatS, fade);
      _seqBass(song.bass[ci], _seqNextT, fade);
      _seqLastBar = bar;
    }

    _seqPiano(_semToHz(sem), _seqNextT, beats, beatS, fade);
    _seqNextT          += beats * beatS;
    _seqBeats          += beats;
    _seqBeatsSinceStart += beats;
    _seqNoteIdx++;

    if (_seqNoteIdx >= song.melody.length) {
      _seqNextT  += 0.3 + Math.random() * 0.3;
      _seqSongIdx = (_seqSongIdx + 1) % SONGS.length;
      _seqNoteIdx = 0;
      _seqBeats   = 0;
      _seqLastBar = -1;
      _seqBeatsSinceStart = 0;
      _seqSongBeats = SONGS[_seqSongIdx].melody.reduce((s, [, b]) => s + b, 0);
      bus.emit(DomainEvents.THEME_CHANGED, { theme: SONGS[_seqSongIdx].theme, name: SONGS[_seqSongIdx].name });
    }
  }

  _seqTimer = setTimeout(_seqTick, SEQ_TICK_MS);
}

// ── SFX — Button click sounds ───────────────────────────────
// Minecraft-style "pop": short pitched oscillator + high-frequency noise bite.
// Routed through masterGain so mute is respected.

const SFX_KEY  = 'yegor-sfx';
let sfxEnabled = localStorage.getItem(SFX_KEY) !== '0';

function playSFXClick() {
  if (!actx || !sfxEnabled) return;
  const t  = actx.currentTime;

  // Pitched pop (square → drops in pitch quickly)
  const osc = actx.createOscillator();
  const env = actx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(440, t + 0.03);
  osc.connect(env);
  env.connect(sfxGain);  // bypasses masterGain mute
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.18, t + 0.003);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  osc.start(t);
  osc.stop(t + 0.09);

  // Noise bite for "click" texture
  const sr  = actx.sampleRate;
  const n   = Math.ceil(sr * 0.012);
  const buf = actx.createBuffer(1, n, sr);
  const d   = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);

  const nSrc = actx.createBufferSource();
  nSrc.buffer = buf;
  const hp  = actx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 3500;
  const nEnv = actx.createGain();
  nEnv.gain.setValueAtTime(0.09, t);
  nEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
  nSrc.connect(hp); hp.connect(nEnv); nEnv.connect(sfxGain);  // bypasses masterGain mute
  nSrc.start(t);
}

// ── SFX — Link/button hover ─────────────────────────────────
// Very soft high ting — like Minecraft UI selection highlight.

let _lastHoverMs = 0;
function playHoverSound() {
  if (!actx || !sfxEnabled) return;
  const now = Date.now();
  if (now - _lastHoverMs < 80) return; // throttle rapid hover chains
  _lastHoverMs = now;

  const t   = actx.currentTime;
  const osc = actx.createOscillator();
  const env = actx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1320;
  osc.connect(env);
  env.connect(sfxGain);  // bypasses masterGain mute
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.038, t + 0.003);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.start(t);
  osc.stop(t + 0.12);
}

function setSFX(on) {
  sfxEnabled = on;
  localStorage.setItem(SFX_KEY, on ? '1' : '0');
  updateSFXUI();
}

function updateSFXUI() {
  const btn = document.getElementById('sfx-toggle');
  if (!btn) return;
  btn.classList.toggle('sfx-off', !sfxEnabled);
  btn.setAttribute('aria-label', sfxEnabled ? 'Disable click sounds' : 'Enable click sounds');
  btn.setAttribute('title', sfxEnabled ? 'Click sounds: ON' : 'Click sounds: OFF');
}

function addPixelBurst(el) {
  if (!el || el.closest('#audio-toggle, #sfx-toggle')) return;
  el.classList.remove('btn-sfx-flash');
  void el.offsetWidth;
  el.classList.add('btn-sfx-flash');
  el.addEventListener('animationend', () => el.classList.remove('btn-sfx-flash'), { once: true });
}

// ── Mute control ────────────────────────────────────────────

function setMuted(val) {
  isMuted = val;
  localStorage.setItem(STORAGE_KEY, val ? '1' : '0');

  if (masterGain && actx) {
    const t = actx.currentTime;
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setTargetAtTime(val ? 0 : 1, t, 0.25);
  }

  if (val) {
    stopSequencer();
  } else if (isUnlocked) {
    startSequencer();
  }

  updateToggleUI();
  bus.emit(DomainEvents.AUDIO_MUTED_CHANGED, { muted: val });
}

// ── Toggle UI ───────────────────────────────────────────────

function updateToggleUI() {
  const btn = document.getElementById('audio-toggle');
  if (!btn) return;

  let label, title;
  if (!isUnlocked) {
    label = 'Enable ambient audio';
    title = 'Enable audio';
  } else {
    label = isMuted ? 'Unmute ambient audio' : 'Mute ambient audio';
    title = isMuted ? 'Unmute' : 'Mute';
  }
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', title);
  btn.classList.toggle('muted', isMuted);

  btn.querySelector('.audio-icon-on').style.display  = isMuted ? 'none'  : '';
  btn.querySelector('.audio-icon-off').style.display = isMuted ? 'block' : '';
}

// ── Navigation state persistence ────────────────────────────

function saveNavState() {
  if (!isUnlocked) return;
  const offset = (ambientBuffer && actx)
    ? actx.currentTime % ambientBuffer.duration
    : 0;
  try {
    sessionStorage.setItem(NAV_STATE_KEY, JSON.stringify({
      savedAt: Date.now(),
      offset,
    }));
  } catch {}
}

// ── Boot ────────────────────────────────────────────────────

export async function boot() {
  // Save playback position when navigating away so the next page can resume.
  // pagehide is used alongside beforeunload because iOS Safari doesn't fire beforeunload reliably.
  window.addEventListener('beforeunload', saveNavState);
  window.addEventListener('pagehide', saveNavState);

  // Resume AudioContext when tab comes back into focus (browsers may suspend it).
  // iOS Safari blocks actx.resume() outside a user gesture — hook the next touchstart instead.
  document.addEventListener('visibilitychange', () => {
    if (!isUnlocked || !actx || document.hidden || actx.state !== 'suspended') return;
    if (isIOS) {
      document.addEventListener('touchstart', () => actx.resume().catch(() => {}),
        { passive: true, once: true });
    } else {
      actx.resume().catch(() => {});
    }
  });

  const GATE_EVENTS = ['click', 'touchstart', 'keydown'];
  const onFirstInteraction = () => {
    unlockAudio({ continuation: isContinuation }).then(() => {
      if (isUnlocked) {
        GATE_EVENTS.forEach(ev => document.removeEventListener(ev, onFirstInteraction));
      }
      // If unlock failed (isUnlocked still false), listeners stay registered for retry
    });
  };
  GATE_EVENTS.forEach(ev =>
    document.addEventListener(ev, onFirstInteraction, { passive: true })
  );

  // If navigating from another page in this session, try auto-resume immediately.
  // Chrome preserves sticky user activation across same-origin navigations, so
  // AudioContext.resume() may succeed without requiring a new user gesture.
  // Skip on iOS — auto-resume without a gesture is never allowed there.
  if (isContinuation && !isIOS) {
    setTimeout(() => {
      if (!isUnlocked) {
        unlockAudio({ continuation: true }).catch(() => {});
      }
    }, 50);
  }

  // Ambient mute toggle
  document.addEventListener('click', e => {
    if (e.target.closest('#audio-toggle')) {
      if (wasJustUnlocked) {
        wasJustUnlocked = false;
        updateToggleUI();
        return;
      }
      setMuted(!isMuted);
    }
  });

  // SFX toggle
  document.addEventListener('click', e => {
    if (e.target.closest('#sfx-toggle')) setSFX(!sfxEnabled);
  });

  // SFX + pixel burst on every button/chip click
  document.addEventListener('click', e => {
    const target = e.target.closest('button, .ai-prompt-chip, [role="button"]');
    if (!target) return;
    if (target.closest('#audio-toggle, #sfx-toggle')) return;
    if (isUnlocked) playSFXClick();
    addPixelBurst(target);
  }, { passive: true });

  // Hover sound on interactive elements
  document.addEventListener('mouseover', e => {
    if (!isUnlocked) return;
    const target = e.target.closest('a, button, .ai-prompt-chip, [role="button"]');
    if (!target || target.closest('#audio-toggle, #sfx-toggle')) return;
    playHoverSound();
  }, { passive: true });

  // Section reveal → bell arpeggio cue (first-time reveal)
  bus.on(DomainEvents.SECTION_REVEALED, () => {
    if (isUnlocked) playSectionCue();
  });

  // Section scrolled → bell cue on every scroll-through (2.5s cooldown per section)
  bus.on(DomainEvents.SECTION_SCROLLED, ({ section }) => {
    if (!isUnlocked || _sectionCooldowns.has(section)) return;
    _sectionCooldowns.add(section);
    setTimeout(() => _sectionCooldowns.delete(section), 2500);
    playSectionCue();
  });

  updateToggleUI();
  updateSFXUI();

  bus.emit(DomainEvents.CONTEXT_LOADED, { context: Contexts.AUDIO });
}

// ── Song skip ────────────────────────────────────────────────
// Force-advance to the next song on the next sequencer tick.

export function skipSong() {
  if (!_seqTimer) return;
  _seqNoteIdx = SONGS[_seqSongIdx]?.melody.length ?? 0;
}
