/**
 * ═══════════════════════════════════════════════════════════════
 *  Domain Types — Shared Kernel
 * ═══════════════════════════════════════════════════════════════
 *
 *  Ubiquitous Language for the portfolio system.
 *  Every bounded context imports and speaks these types.
 *  No context defines its own ad-hoc data shapes.
 */

// ── Value Objects ───────────────────────────────────────────

/** @typedef {'active'|'experiment'|'archived'|'nda'} ProjectStatus */

/**
 * A tech skill with proficiency.
 * @param {string} name
 * @param {string} category - 'backend'|'mobile'|'data'|'ai'|'blockchain'|'infra'
 */
export function Skill(name, category) {
  return Object.freeze({ name, category });
}

// ── Entities ────────────────────────────────────────────────

/**
 * Project entity — the core domain object for the Work section.
 */
export class Project {
  /** @param {object} props */
  constructor({ id, title, subtitle, description, stack, status, url, caseStudyUrl }) {
    this.id           = id;
    this.title        = title;
    this.subtitle     = subtitle || '';
    this.description  = description;
    this.stack        = stack || [];          // string[]
    this.status       = status || 'active';   // ProjectStatus
    this.url          = url || null;
    this.caseStudyUrl = caseStudyUrl || null;
  }
}

/**
 * Blog post entity — metadata for the Blog section.
 */
export class BlogPost {
  constructor({ slug, title, excerpt, date, tags, readTime }) {
    this.slug     = slug;
    this.title    = title;
    this.excerpt  = excerpt || '';
    this.date     = date;        // ISO string
    this.tags     = tags || [];  // string[]
    this.readTime = readTime || '5 min';
  }

  get url() { return `/blog/${this.slug}/`; }
}

/**
 * Demo entity — an interactive experience in the Playground.
 */
export class Demo {
  /**
   * @param {object} props
   * @param {'game'|'viz'|'tool'} props.type
   */
  constructor({ id, title, type, scriptPath, canvasId, windowId }) {
    this.id         = id;
    this.title      = title;
    this.type       = type;
    this.scriptPath = scriptPath;  // path to lazy-load
    this.canvasId   = canvasId || null;
    this.windowId   = windowId || null;
  }
}

/**
 * ChatMessage — a single message in the AI conversation.
 */
export class ChatMessage {
  constructor({ role, content, timestamp }) {
    this.role      = role;       // 'user'|'assistant'|'system'
    this.content   = content;
    this.timestamp = timestamp || Date.now();
  }
}

/**
 * Conversation aggregate — holds the full chat state.
 */
export class Conversation {
  #messages = [];

  get messages() { return [...this.#messages]; }
  get length()   { return this.#messages.length; }

  addMessage(role, content) {
    const msg = new ChatMessage({ role, content });
    this.#messages.push(msg);
    return msg;
  }

  clear() { this.#messages.length = 0; }
}


// ── Enumerations ────────────────────────────────────────────

/** Bounded context identifiers. */
export const Contexts = Object.freeze({
  PORTFOLIO:  'portfolio',
  PLAYGROUND: 'playground',
  CHAT:       'chat',
  AUDIO:      'audio',
});

/** Screensaver modes. */
export const ScreensaverMode = Object.freeze({
  GAME_OF_LIFE: 'gol',
  MATRIX:       'matrix',
  STARS:        'stars',
  SNAKE:        'snake',
});

/** Browser capability flags detected at boot. */
export class Capabilities {
  constructor() {
    this.webgpu        = false;
    this.sharedWorker  = typeof SharedWorker !== 'undefined';
    this.webgl2        = false;
    this.speechSynth   = 'speechSynthesis' in window;
    this.speechRecog   = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
    this.wasm          = typeof WebAssembly !== 'undefined';
    this.cores         = navigator.hardwareConcurrency || 2;
    this.lowEnd        = false;  // set by detection
  }
}

export default {
  Project, BlogPost, Demo, ChatMessage, Conversation,
  Contexts, ScreensaverMode, Capabilities, Skill,
};
