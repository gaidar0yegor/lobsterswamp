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
 *  Minecraft ambient aesthetic:
 *    - Cave reverb via synthetic convolver impulse response
 *    - Piano plucks in C minor pentatonic (C418-style note box)
 *    - Random ambient notes timed like Minecraft's music system
 *    - Note-block-style SFX click (G5 sine, 80ms)
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
const AMBIENT_SRCS  = ['/audio/ambient.mp3', '/audio/ambient.ogg'];
const AMBIENT_VOL   = 0.18;

// C minor pentatonic across C3–C5 (C18-inspired note palette)
const MC_PENTATONIC = [130.81, 155.56, 174.61, 196.00, 233.08,
                       261.63, 311.13, 349.23, 392.00, 466.16, 523.25];

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── State ───────────────────────────────────────────────────
let actx             = null;
let masterGain       = null;
let ambientGain      = null;
let caveReverb       = null;
let reverbGain       = null;
let ambientSource    = null;
let ambientBuffer    = null;
let ambientPluckTimer = null;
let isUnlocked       = false;
let wasJustUnlocked  = false;
let isMuted          = localStorage.getItem(STORAGE_KEY) === '1';

// ── Cave reverb ─────────────────────────────────────────────
// Synthetic impulse response: random-noise with exponential decay.
// Approximates the spacious, damp echo of a Minecraft cave.

function buildCaveReverb() {
  const convolver = actx.createConvolver();
  const sr  = actx.sampleRate;
  const len = Math.round(sr * 2.8);
  const ir  = actx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
    }
  }
  convolver.buffer = ir;
  return convolver;
}

// ── AudioContext lifecycle ──────────────────────────────────

function initSync() {
  actx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = actx.createGain();
  masterGain.gain.value = isMuted ? 0 : 1;
  masterGain.connect(actx.destination);

  // Reverb chain: caveReverb → reverbGain → masterGain
  caveReverb = buildCaveReverb();
  reverbGain = actx.createGain();
  reverbGain.gain.value = 0.35;
  caveReverb.connect(reverbGain);
  reverbGain.connect(masterGain);

  // Ambient sits low in the mix; feeds both dry and reverb sends
  ambientGain = actx.createGain();
  ambientGain.gain.value = AMBIENT_VOL;
  ambientGain.connect(masterGain);   // dry path
  ambientGain.connect(caveReverb);   // wet path → cave echo
}

async function unlockAudio() {
  if (isUnlocked) return;
  isUnlocked = true;
  wasJustUnlocked = true;

  try {
    initSync();
    if (actx.state === 'suspended') await actx.resume();

    document.getElementById('audio-toggle')?.classList.add('audio-unlocked');
    bus.emit(DomainEvents.AUDIO_UNLOCKED);

    loadAndStartAmbient();
    if (!reduceMotion) scheduleAmbientPlucks();
  } catch (err) {
    console.warn('[Audio] Context init failed:', err);
  }
}

async function loadAndStartAmbient() {
  for (const src of AMBIENT_SRCS) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      ambientBuffer = await actx.decodeAudioData(buf);
      startAmbient();
      return;
    } catch { /* try next format */ }
  }
  // No file present — synthesized plucks still play
}

function startAmbient() {
  if (!ambientBuffer || ambientSource) return;
  ambientSource = actx.createBufferSource();
  ambientSource.buffer = ambientBuffer;
  ambientSource.loop = true;
  ambientSource.connect(ambientGain);
  ambientSource.start(0);
}

// ── Piano pluck (C418 style) ────────────────────────────────
// Sine wave with fast piano attack, slow exponential decay.
// Fully wet — routes only through caveReverb for maximum space.

function playPianoPluck(freq, vol = 0.10) {
  if (!actx || !caveReverb || isMuted) return;
  const t = actx.currentTime;

  const osc = actx.createOscillator();
  const env = actx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;

  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vol, t + 0.008);          // 8ms attack
  env.gain.exponentialRampToValueAtTime(vol * 0.28, t + 0.14); // decay
  env.gain.exponentialRampToValueAtTime(0.001, t + 1.8);     // long release

  osc.connect(env);
  env.connect(caveReverb);
  osc.start(t);
  osc.stop(t + 1.8);
}

// ── Random ambient plucks ───────────────────────────────────
// Mirrors Minecraft's music system: sparse, irregular notes that
// feel like they come from the cave itself. 10–35s between notes.

function scheduleAmbientPlucks() {
  const delay = 10000 + Math.random() * 25000;
  ambientPluckTimer = setTimeout(() => {
    if (isUnlocked && !isMuted) {
      const freq = MC_PENTATONIC[Math.floor(Math.random() * MC_PENTATONIC.length)];
      playPianoPluck(freq, 0.05 + Math.random() * 0.04);
    }
    scheduleAmbientPlucks();
  }, delay);
}

// ── Synthesized section cue ─────────────────────────────────
// Random C minor pentatonic pluck — like a Minecraft note block
// triggered by entering a new area.

function playSectionCue() {
  if (!actx || isMuted || reduceMotion) return;
  const freq = MC_PENTATONIC[3 + Math.floor(Math.random() * 5)]; // C4–Bb4 range
  playPianoPluck(freq, 0.08);
}

// ── SFX — Button click sounds ───────────────────────────────
// G5 sine pluck — mimics Minecraft's harp note block.
// ON by default; user can toggle off via #sfx-toggle.

const SFX_KEY  = 'yegor-sfx';
let sfxEnabled = localStorage.getItem(SFX_KEY) !== '0';

function playSFXClick() {
  if (!actx || !sfxEnabled) return;
  const t = actx.currentTime;

  const osc = actx.createOscillator();
  const env = actx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 783.99; // G5 — Minecraft harp note block

  env.gain.setValueAtTime(0.18, t);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

  osc.connect(env);
  env.connect(actx.destination);
  osc.start(t);
  osc.stop(t + 0.08);
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

  if (val && ambientPluckTimer) {
    clearTimeout(ambientPluckTimer);
    ambientPluckTimer = null;
  } else if (!val && isUnlocked && !ambientPluckTimer && !reduceMotion) {
    scheduleAmbientPlucks();
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

// ── Boot ────────────────────────────────────────────────────

export async function boot() {
  const GATE_EVENTS = ['click', 'touchstart', 'keydown'];
  const onFirstInteraction = () => {
    unlockAudio();
    GATE_EVENTS.forEach(ev => document.removeEventListener(ev, onFirstInteraction));
  };
  GATE_EVENTS.forEach(ev =>
    document.addEventListener(ev, onFirstInteraction, { passive: true })
  );

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

  document.addEventListener('click', e => {
    if (e.target.closest('#sfx-toggle')) setSFX(!sfxEnabled);
  });

  document.addEventListener('click', e => {
    const target = e.target.closest('button, .ai-prompt-chip, [role="button"]');
    if (!target) return;
    if (target.closest('#audio-toggle, #sfx-toggle')) return;
    if (isUnlocked) playSFXClick();
    addPixelBurst(target);
  }, { passive: true });

  bus.on(DomainEvents.SECTION_REVEALED, () => {
    if (isUnlocked) playSectionCue();
  });

  updateToggleUI();
  updateSFXUI();

  bus.emit(DomainEvents.CONTEXT_LOADED, { context: Contexts.AUDIO });
}
