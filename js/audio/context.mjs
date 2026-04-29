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
const AMBIENT_SRCS  = ['/audio/ambient.mp3', '/audio/ambient.ogg'];
const AMBIENT_VOL   = 0.22;   // ambient sits well under any foreground content
const CUE_VOL       = 0.05;   // section enter chime — subtle

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── State ───────────────────────────────────────────────────
let actx          = null;
let masterGain    = null;
let ambientGain   = null;
let ambientSource = null;
let ambientBuffer = null;
let isUnlocked       = false;
let wasJustUnlocked  = false; // true during the same tick that first-unlock fires
let isMuted          = localStorage.getItem(STORAGE_KEY) === '1';

// ── AudioContext lifecycle ──────────────────────────────────

function initSync() {
  // Synchronous setup — called before any async work so that
  // the click delegation handler (which fires right after) can
  // immediately read actx / masterGain.
  actx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = actx.createGain();
  masterGain.gain.value = isMuted ? 0 : 1;
  masterGain.connect(actx.destination);

  ambientGain = actx.createGain();
  ambientGain.gain.value = AMBIENT_VOL;
  ambientGain.connect(masterGain);
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
  // No audio file present — cues still work, ambient just silent
}

function startAmbient() {
  if (!ambientBuffer || ambientSource) return;
  ambientSource = actx.createBufferSource();
  ambientSource.buffer = ambientBuffer;
  ambientSource.loop = true;
  ambientSource.connect(ambientGain);
  ambientSource.start(0);
}

// ── Synthesized section cue ─────────────────────────────────
// Soft sine sweep: C5 → C4 over 350ms. Barely audible — a whisper.

function playSectionCue() {
  if (!actx || isMuted || reduceMotion) return;
  const t = actx.currentTime;

  const osc = actx.createOscillator();
  const env = actx.createGain();
  osc.connect(env);
  env.connect(masterGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(523.25, t);              // C5
  osc.frequency.exponentialRampToValueAtTime(261.63, t + 0.25); // C4

  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(CUE_VOL, t + 0.04);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

  osc.start(t);
  osc.stop(t + 0.35);
}

// ── SFX — Button click sounds ───────────────────────────────
// Synthesized tick using Web Audio API noise burst. No file needed.
// ON by default; user can toggle off via #sfx-toggle.

const SFX_KEY  = 'yegor-sfx';
let sfxEnabled = localStorage.getItem(SFX_KEY) !== '0'; // default ON

function playSFXClick() {
  if (!actx || !sfxEnabled) return;
  const t  = actx.currentTime;
  const sr = actx.sampleRate;
  const n  = Math.ceil(sr * 0.02);              // 20 ms noise burst
  const b  = actx.createBuffer(1, n, sr);
  const d  = b.getChannelData(0);
  for (let i = 0; i < n; i++)
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 4) * 0.35;

  const src = actx.createBufferSource(); src.buffer = b;
  const bp  = actx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 2000; bp.Q.value = 1.2;
  const g   = actx.createGain();
  g.gain.setValueAtTime(0.3, t);

  src.connect(bp); bp.connect(g); g.connect(actx.destination);
  src.start(t);
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
  void el.offsetWidth;   // reflow to restart animation
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
  // First-interaction gate: unlocks AudioContext (browser autoplay policy)
  // and acts as implicit user consent for the audio experience.
  const GATE_EVENTS = ['click', 'touchstart', 'keydown'];
  const onFirstInteraction = () => {
    unlockAudio();
    GATE_EVENTS.forEach(ev => document.removeEventListener(ev, onFirstInteraction));
  };
  GATE_EVENTS.forEach(ev =>
    document.addEventListener(ev, onFirstInteraction, { passive: true })
  );

  // Ambient mute toggle
  document.addEventListener('click', e => {
    if (e.target.closest('#audio-toggle')) {
      if (wasJustUnlocked) {
        wasJustUnlocked = false; // consume: this click was the unlock, don't also mute
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

  // Section reveal → section enter cue
  bus.on(DomainEvents.SECTION_REVEALED, () => {
    if (isUnlocked) playSectionCue();
  });

  // Initialise button appearances
  updateToggleUI();
  updateSFXUI();

  bus.emit(DomainEvents.CONTEXT_LOADED, { context: Contexts.AUDIO });
}
