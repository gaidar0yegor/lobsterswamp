/**
 * ═══════════════════════════════════════════════════════════════
 *  Audio Bounded Context
 * ═══════════════════════════════════════════════════════════════
 *
 *  Owns: ambient background music, scroll-triggered section cues,
 *        mute/unmute toggle (localStorage-persisted),
 *        per-song visual theme changes.
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
 *    - THEME_CHANGED { theme: string, name: string }
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

// ── Self-inject audio controls when not present in page HTML ─
// Pages can omit the button markup; boot() will create it.
function injectControlsIfNeeded() {
  if (!document.getElementById('audio-toggle')) {
    const btn = document.createElement('button');
    btn.id = 'audio-toggle';
    btn.setAttribute('aria-label', 'Enable ambient audio');
    btn.setAttribute('title', 'Enable audio');
    btn.innerHTML =
      '<svg class="audio-icon-on" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z' +
        'M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>' +
      '</svg>' +
      '<svg class="audio-icon-off" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 ' +
        '2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71z' +
        'M4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25A6.916 6.916 0 0 1 14 18.98v2.06A9.01 9.01 0 0 0 ' +
        '17.54 19l2.19 2.19L21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>' +
      '</svg>';
    document.body.appendChild(btn);
  }
  if (!document.getElementById('sfx-toggle')) {
    const btn = document.createElement('button');
    btn.id = 'sfx-toggle';
    btn.setAttribute('aria-label', 'Disable click sounds');
    btn.setAttribute('title', 'Click sounds: ON');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>' +
      '</svg>';
    document.body.appendChild(btn);
  }
}

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// iOS Safari cannot resume AudioContext outside user gestures; beforeunload is also unreliable on iOS.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isMobile = isIOS || /Android/i.test(navigator.userAgent);
// Mobile speakers need more headroom — 1.6× makes sequencer and ambient audible at mid system volume.
const VOL_SCALE   = isMobile ? 1.6 : 1.0;
const AMBIENT_VOL = 0.25 * VOL_SCALE;
const CUE_VOL     = 0.04 * VOL_SCALE;  // section bell chime — subtle scroll cue

// ── Navigation continuity — detect cross-page navigation within same session ──
// 30-minute window: any page-to-page navigation in a typical session is a continuation.
const _navState = (() => {
  try {
    const s = JSON.parse(sessionStorage.getItem(NAV_STATE_KEY));
    if (s && typeof s.savedAt === 'number' && Date.now() - s.savedAt < 1800000) return s;
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
let _seqSuspendRetries = 0;

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

    // Auto-resume if the browser suspends the context after we set it up
    // (Chrome's autoplay policy can suspend async after resume() resolves).
    actx.onstatechange = () => {
      if (!actx || isMuted || isIOS) return;
      if (actx.state === 'suspended') {
        actx.resume().catch(() => {});
      } else if (actx.state === 'running' && _seqTimer === null) {
        // Context auto-resumed (tab regained focus) — restart sequencer if stopped.
        startSequencer();
      }
    };

    document.getElementById('audio-toggle')?.classList.add('audio-unlocked');
    document.getElementById('audio-hint')?.classList.add('audio-hint-hidden');
    bus.emit(DomainEvents.AUDIO_UNLOCKED);

    const offset = continuation && _navState ? _navState.offset : 0;
    loadAndStartAmbient(offset, continuation);
    if (!isMuted) {
      if (!continuation) playPageJingle();
      startSequencer(continuation ? _navState : null);
    }
  } catch (err) {
    console.warn('[Audio] Context init failed:', err);
    // Reset so the next user gesture or backoff attempt can retry
    isUnlocked = false;
    wasJustUnlocked = false;
    try { actx?.close(); } catch {}
    actx = null; masterGain = null; ambientGain = null; sfxGain = null;
  }
}

async function loadAndStartAmbient(offset = 0, continuation = false) {
  for (const src of AMBIENT_SRCS) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      ambientBuffer = await actx.decodeAudioData(buf);
      startAmbient(offset, continuation);
      return;
    } catch { /* try next format */ }
  }
}

function startAmbient(offset = 0, continuation = false) {
  if (!ambientBuffer || ambientSource) return;
  ambientSource = actx.createBufferSource();
  ambientSource.buffer = ambientBuffer;
  ambientSource.loop = true;
  ambientSource.connect(ambientGain);
  // Fade in gently on continuation to avoid abrupt audio pop on page transition
  if (continuation) {
    ambientGain.gain.setValueAtTime(0, actx.currentTime);
    ambientGain.gain.linearRampToValueAtTime(AMBIENT_VOL, actx.currentTime + 0.6);
  }
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
// Five melodic songs that rotate automatically, each paired with a visual theme.
// Minecraft-style: each song is 96 beats (64–93 s depending on BPM), with sparse
// melodies and rests that breathe. null semitone = rest (pads/bass still play).
// Between songs: SONG_GAP_MIN_S–SONG_GAP_MAX_S seconds of silence.
//   "Swamp"    — G major  80 BPM  (cyan,    signature,   72 s)
//   "Nocturne" — A minor  70 BPM  (purple,  melancholic, 82 s)
//   "Ember"    — D major  90 BPM  (amber,   bright,      64 s)
//   "Dawn"     — E major  75 BPM  (sky,     hopeful,     77 s)
//   "Abyss"    — F# minor 62 BPM  (magenta, haunting,    93 s)

const SEQ_LOOKAHEAD  = 0.15;
const SEQ_TICK_MS    = 80;
const SONG_GAP_MIN_S = 15;  // seconds of silence between songs (Minecraft-style)
const SONG_GAP_MAX_S = 35;

const SONGS = [
  { name: 'Swamp', theme: 'swamp', bpm: 80,
    melody: [
      // Intro — open silence, single notes breathe
      [null,4],
      [7,2],[null,2],
      [11,1],[null,3],
      [14,2],[11,1],[null,1],
      // First phrase
      [9,2],[null,2],
      [7,3],[null,1],
      [4,1],[7,1],[null,2],
      [null,4],
      // Low bridge
      [-5,4],
      [null,4],
      [2,2],[4,2],
      [null,4],
      // Development
      [7,1],[11,1],[14,1],[null,1],
      [14,2],[11,2],
      [9,1],[null,1],[7,1],[null,1],
      [null,4],
      // Build — E5 peak
      [11,1],[14,1],[16,2],
      [14,1],[11,1],[9,2],
      [7,1.5],[4,0.5],[2,2],
      [null,4],
      // Resolution
      [7,2],[null,2],
      [-5,4],
      [null,4],
      [11,2],[null,2],
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
      // Intro
      [null,4],
      [9,2],[null,2],
      [12,2],[null,2],
      [null,4],
      // First phrase
      [9,1],[12,1],[16,2],
      [12,1],[9,1],[7,2],
      [null,4],
      [5,2],[null,2],
      // Low bridge
      [-3,4],
      [null,4],
      [2,1],[5,1],[null,2],
      [null,4],
      // Development
      [9,1],[null,1],[12,1],[null,1],
      [16,2],[null,2],
      [12,1],[9,1],[7,2],
      [null,4],
      // Build — D5 peak
      [5,2],[7,2],
      [9,1],[12,1],[14,2],
      [12,2],[9,2],
      [null,4],
      // Resolution
      [9,2],[null,2],
      [-3,4],
      [null,4],
      [7,2],[null,2],
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
      // Intro
      [null,2],[2,2],
      [6,1],[null,3],
      [9,2],[null,2],
      [null,4],
      // First phrase — D major arpeggio
      [2,1],[6,1],[9,2],
      [11,2],[9,1],[null,1],
      [6,1],[null,1],[9,1],[null,1],
      [null,4],
      // Low
      [-10,4],
      [null,4],
      [2,2],[4,2],
      [null,4],
      // Development
      [9,1],[11,1],[14,1],[null,1],
      [13,2],[11,2],
      [9,1],[null,1],[6,1],[null,1],
      [null,4],
      // Build
      [6,1],[9,1],[11,2],
      [14,2],[11,1],[9,1],
      [6,1.5],[4,0.5],[2,2],
      [null,4],
      // Resolution
      [9,2],[null,2],
      [2,4],
      [null,4],
      [6,2],[null,2],
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
      // Intro — hopeful
      [null,4],
      [4,2],[null,2],
      [8,1],[null,3],
      [11,2],[8,1],[null,1],
      // First phrase
      [13,2],[11,1],[null,1],
      [8,3],[null,1],
      [4,1],[6,1],[null,2],
      [null,4],
      // Low
      [-8,4],
      [null,4],
      [-1,2],[4,2],
      [null,4],
      // Development
      [4,1],[8,1],[11,1],[null,1],
      [13,2],[16,2],
      [13,1],[11,1],[8,2],
      [null,4],
      // Build — E5 peak
      [11,1],[13,1],[16,2],
      [16,1],[13,1],[11,2],
      [8,1.5],[6,0.5],[4,2],
      [null,4],
      // Resolution
      [11,2],[null,2],
      [-8,4],
      [null,4],
      [4,2],[null,2],
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
      // Intro — deep silence then sudden F#5 peak
      [null,4],[null,2],[18,2],
      [16,2],[null,4],[null,2],
      // Descend
      [13,2],[null,2],
      [11,2],[null,2],
      [9,2],[null,2],
      [null,4],
      // Low bridge
      [-6,4],
      [null,4],
      [1,2],[null,4],[null,2],
      // Development
      [13,1.5],[11,0.5],[9,2],
      [8,2],[null,2],
      [6,1],[8,1],[9,1],[null,1],
      [null,4],
      // Build
      [11,2],[13,2],
      [16,2],[null,2],
      [13,2],[11,2],
      [null,4],
      // Resolution
      [9,2],[null,2],
      [-6,4],
      [null,4],
      [6,2],[null,2],
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

// Crossfade multiplier — smoothly fades notes in at song start and out at song end.
// FADE_IN_BEATS and FADE_OUT_BEATS set the ramp length; value is always [0.05, 1].
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
  const V   = (0.072 + (Math.random() * 0.012 - 0.006)) * VOL_SCALE * fade;
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

let _seqNoteIdx        = 0;
let _seqNextT          = 0;
let _seqBeats          = 0;
let _seqLastBar        = -1;
let _seqSongIdx        = 0;
let _seqPlaylist       = [];
let _seqBeatsSinceStart = 0;  // beats elapsed in current song (for crossfade)
let _seqSongBeats       = 0;  // total beats in current song (for crossfade)

// Returns next song index, never repeating the current song back-to-back.
// Shuffles the remaining songs each time the playlist is exhausted.
function _nextSongIdx(currentIdx) {
  if (_seqPlaylist.length === 0) {
    const indices = SONGS.map((_, i) => i).filter(i => i !== currentIdx);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    _seqPlaylist = indices;
  }
  return _seqPlaylist.shift();
}

function startSequencer(nav = null) {
  if (_seqTimer !== null) return;
  if (nav && typeof nav.seqSongIdx === 'number') {
    // Continuation: restore saved song position.
    // Resume guard: reject positions with < 16 beats remaining to avoid
    // "a few notes then a long gap" — worse UX than starting the song fresh.
    _seqNextT   = actx.currentTime + 0.15;
    _seqSongIdx = nav.seqSongIdx % SONGS.length;
    const song     = SONGS[_seqSongIdx];
    const sameSong = (nav.seqSongIdx % SONGS.length) === _seqSongIdx;
    let resumeIdx = (sameSong && typeof nav.seqNoteIdx === 'number') ? nav.seqNoteIdx : 0;
    if (resumeIdx >= song.melody.length) {
      resumeIdx = 0;
    } else if (resumeIdx > 0) {
      let beatsUsed = 0;
      for (let i = 0; i < resumeIdx; i++) beatsUsed += song.melody[i][1];
      const totalBeats = song.melody.reduce((s, [, b]) => s + b, 0);
      if (totalBeats - beatsUsed < 16) resumeIdx = 0;
    }
    _seqNoteIdx = resumeIdx;
    if (resumeIdx === 0) {
      _seqBeats          = 0;
      _seqLastBar        = -1;
      _seqBeatsSinceStart = 0;
    } else {
      _seqBeats          = (sameSong && typeof nav.seqBeats   === 'number') ? nav.seqBeats   : 0;
      _seqLastBar        = (sameSong && typeof nav.seqLastBar === 'number') ? nav.seqLastBar : -1;
      _seqBeatsSinceStart = (sameSong && typeof nav.seqBeatsSinceStart === 'number') ? nav.seqBeatsSinceStart : 0;
    }
    _seqSongBeats = SONGS[_seqSongIdx].melody.reduce((s, [, b]) => s + b, 0);
  } else {
    // Fresh start: always begin with Swamp (song 0)
    _seqNextT    = actx.currentTime + 0.5;
    _seqSongIdx  = 0;
    _seqNoteIdx  = 0;
    _seqBeats    = 0;
    _seqLastBar  = -1;
    _seqPlaylist = [];
    _seqBeatsSinceStart = 0;
    _seqSongBeats = SONGS[0].melody.reduce((s, [, b]) => s + b, 0);
  }
  bus.emit(DomainEvents.THEME_CHANGED, { theme: SONGS[_seqSongIdx].theme, name: SONGS[_seqSongIdx].name });
  _seqTick();
}

function stopSequencer() {
  clearTimeout(_seqTimer);
  _seqTimer = null;
  _seqSuspendRetries = 0;
}

function _seqTick() {
  if (!actx || isMuted) { _seqTimer = null; return; }

  // Don't schedule into a suspended context — currentTime is frozen, which
  // would cause a burst of notes all at once when the context eventually resumes.
  if (actx.state === 'suspended') {
    if (++_seqSuspendRetries >= 30) {
      // Context stuck suspended for ~9.6s — stop sequencer but keep context alive.
      // onstatechange or visibilitychange will restart when the tab regains focus.
      _seqSuspendRetries = 0;
      _seqTimer = null;
      return;
    }
    actx.resume().catch(() => {});
    _seqTimer = setTimeout(_seqTick, SEQ_TICK_MS * 4);
    return;
  }
  _seqSuspendRetries = 0;

  // After suspension recovery, resync if scheduled position drifted far behind current
  // time (e.g. actx.currentTime jumped after a long context pause in some browsers).
  if (_seqNextT < actx.currentTime - 2) {
    _seqNextT          = actx.currentTime + 0.1;
    _seqSongIdx        = 0;
    _seqNoteIdx        = 0;
    _seqBeats          = 0;
    _seqLastBar        = -1;
    _seqBeatsSinceStart = 0;
    _seqSongBeats      = SONGS[0].melody.reduce((s, [, b]) => s + b, 0);
    bus.emit(DomainEvents.THEME_CHANGED, { theme: SONGS[0].theme, name: SONGS[0].name });
  }

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

    if (sem !== null) _seqPiano(_semToHz(sem), _seqNextT, beats, beatS, fade);
    _seqNextT          += beats * beatS;
    _seqBeats          += beats;
    _seqBeatsSinceStart += beats;
    _seqNoteIdx++;

    if (_seqNoteIdx >= song.melody.length) {
      // Minecraft-style silence between songs — 15–35 s of breathing room.
      // The sequencer keeps polling every few seconds via the adaptive tick so
      // it wakes up on time for the next song.
      _seqNextT  += SONG_GAP_MIN_S + Math.random() * (SONG_GAP_MAX_S - SONG_GAP_MIN_S);
      _seqSongIdx = _nextSongIdx(_seqSongIdx);
      _seqNoteIdx = 0;
      _seqBeats   = 0;
      _seqLastBar = -1;
      _seqBeatsSinceStart = 0;
      _seqSongBeats = SONGS[_seqSongIdx].melody.reduce((s, [, b]) => s + b, 0);
      bus.emit(DomainEvents.THEME_CHANGED, { theme: SONGS[_seqSongIdx].theme, name: SONGS[_seqSongIdx].name });
    }
  }

  // Poll slowly during silence (saves CPU), fast when actively scheduling.
  const ahead = _seqNextT - actx.currentTime;
  const tickMs = ahead > 30 ? 5000 : ahead > 10 ? 2000 : SEQ_TICK_MS;
  _seqTimer = setTimeout(_seqTick, tickMs);
}

// ── SFX — Button click sounds ───────────────────────────────
// Minecraft-style "pop": short pitched oscillator + high-frequency noise bite.
// Routed through sfxGain so ambient mute does not silence click feedback.

const SFX_KEY  = 'yegor-sfx';
let sfxEnabled = localStorage.getItem(SFX_KEY) !== '0';

function playSFXClick() {
  if (!actx || !sfxEnabled || isMuted) return;
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
  if (!actx || !sfxEnabled || isMuted) return;
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
      seqSongIdx:         _seqSongIdx,
      seqNoteIdx:         _seqNoteIdx,
      seqBeats:           _seqBeats,
      seqLastBar:         _seqLastBar,
      seqBeatsSinceStart: _seqBeatsSinceStart,
    }));
  } catch {}
}

// ── Boot ────────────────────────────────────────────────────

export async function boot() {
  // Inject audio controls into the DOM if the page HTML doesn't include them.
  injectControlsIfNeeded();

  // Save playback position when navigating away so the next page can resume.
  // pagehide is used alongside beforeunload because iOS Safari doesn't fire beforeunload reliably.
  window.addEventListener('beforeunload', saveNavState);
  window.addEventListener('pagehide', saveNavState);

  // Resume AudioContext when tab comes back into focus (browsers may suspend it).
  // iOS Safari blocks actx.resume() outside a user gesture — hook the next touchstart instead.
  document.addEventListener('visibilitychange', () => {
    if (!isUnlocked || !actx || document.hidden || actx.state !== 'suspended') return;
    const doResume = () => {
      actx.resume().then(() => {
        if (!isMuted && _seqTimer === null && actx && actx.state === 'running') {
          startSequencer();
        }
      }).catch(() => {});
    };
    if (isIOS) {
      document.addEventListener('touchstart', doResume, { passive: true, once: true });
    } else {
      doResume();
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

  // Continuation: user navigated from a page where audio was already active.
  // Chrome's sticky user activation can transfer across same-origin navigations,
  // but the window is short and page load (parsing, CDN scripts, module eval)
  // adds latency. Retry with backoff so slow-loading pages still catch the
  // activation window — attempts at 0, 100, 350, 800, 2000ms.
  if (isContinuation && !isMuted && !isIOS) {
    const resumeWithBackoff = async () => {
      for (const delay of [0, 100, 350, 800, 2000]) {
        if (isUnlocked) break;
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        await unlockAudio({ continuation: true }).catch(() => {});
      }
    };
    resumeWithBackoff();
  } else if (!isIOS && !isMuted) {
    // Non-continuation: backoff attempts — Chrome may allow autoplay after DOMContentLoaded
    // settles and the media engagement index is checked (can take a few hundred ms).
    const tryAutoStart = async () => {
      for (const delay of [0, 200, 700, 2000]) {
        if (isUnlocked) break;
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        await unlockAudio({ continuation: false }).catch(() => {});
      }
    };
    tryAutoStart();
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
