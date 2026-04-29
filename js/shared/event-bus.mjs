/**
 * ═══════════════════════════════════════════════════════════════
 *  EventBus — Shared Kernel / Domain Event Infrastructure
 * ═══════════════════════════════════════════════════════════════
 *
 *  The backbone of the DDD architecture. All bounded contexts
 *  communicate exclusively through domain events, never by
 *  direct function calls or window globals.
 *
 *  Usage:
 *    import { bus, DomainEvents } from './shared/event-bus.mjs';
 *    bus.on(DomainEvents.SECTION_SCROLLED, ({ section }) => { ... });
 *    bus.emit(DomainEvents.DEMO_LAUNCHED, { demo: 'snake' });
 */

// ── Domain Event Catalog ────────────────────────────────────
// Every event in the system is declared here. No magic strings.
export const DomainEvents = Object.freeze({

  // ── Portfolio Context ──
  SECTION_SCROLLED:       'portfolio:section.scrolled',
  SECTION_REVEALED:       'portfolio:section.revealed',
  PROJECT_VIEWED:         'portfolio:project.viewed',
  NAV_LINK_CLICKED:       'portfolio:nav.clicked',
  CONTACT_INITIATED:      'portfolio:contact.initiated',
  BLOG_POST_OPENED:       'portfolio:blog.opened',

  // ── Playground Context ──
  DEMO_LAUNCHED:          'playground:demo.launched',
  DEMO_STOPPED:           'playground:demo.stopped',
  SCREENSAVER_ACTIVATED:  'playground:screensaver.activated',
  SCREENSAVER_DISMISSED:  'playground:screensaver.dismissed',
  GAME_SCORE_UPDATED:     'playground:game.score',
  TERMINAL_COMMAND:       'playground:terminal.command',
  WINDOW_OPENED:          'playground:window.opened',
  WINDOW_CLOSED:          'playground:window.closed',

  // ── Chat Context ──
  CHAT_STARTED:           'chat:started',
  CHAT_MESSAGE_SENT:      'chat:message.sent',
  CHAT_RESPONSE_RECEIVED: 'chat:response.received',
  CHAT_MODEL_LOADED:      'chat:model.loaded',
  CHAT_MODEL_PROGRESS:    'chat:model.progress',
  VOICE_INPUT_STARTED:    'chat:voice.started',
  VOICE_INPUT_ENDED:      'chat:voice.ended',
  VOICE_TRANSCRIBED:      'chat:voice.transcribed',
  TTS_STARTED:            'chat:tts.started',
  TTS_ENDED:              'chat:tts.ended',

  // ── Audio Context ──
  AUDIO_UNLOCKED:         'audio:unlocked',
  AUDIO_MUTED_CHANGED:    'audio:muted.changed',

  // ── Cross-Context (Shared Kernel) ──
  APP_READY:              'app:ready',
  APP_IDLE:               'app:idle',
  APP_ACTIVE:             'app:active',
  CAPABILITY_DETECTED:    'app:capability.detected',
  SECURITY_VIOLATION:     'app:security.violation',
  THEME_CHANGED:          'app:theme.changed',
  CONTEXT_LOADED:         'app:context.loaded',
  CONTEXT_ERROR:          'app:context.error',
});


// ── Event Bus Implementation ────────────────────────────────

class EventBusImpl {
  #listeners   = new Map();   // event → Set<{handler, once, context}>
  #history     = [];          // last N events for debugging
  #historyMax  = 50;
  #middlewares = [];          // pre-emit hooks

  /**
   * Subscribe to a domain event.
   * @param {string}   event    - One of DomainEvents.*
   * @param {Function} handler  - (payload, meta) => void
   * @param {object}   [opts]   - { once: bool, context: string }
   * @returns {Function} unsubscribe function
   */
  on(event, handler, opts = {}) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    const entry = { handler, once: !!opts.once, context: opts.context || 'unknown' };
    this.#listeners.get(event).add(entry);

    // Return unsubscribe
    return () => this.#listeners.get(event)?.delete(entry);
  }

  /** Subscribe once, auto-unsubscribe after first delivery. */
  once(event, handler, opts = {}) {
    return this.on(event, handler, { ...opts, once: true });
  }

  /**
   * Emit a domain event to all subscribers.
   * @param {string} event   - One of DomainEvents.*
   * @param {object} payload - Event data
   */
  emit(event, payload = {}) {
    const meta = Object.freeze({
      event,
      timestamp: performance.now(),
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    // Run middlewares (logging, security, etc.)
    for (const mw of this.#middlewares) {
      const result = mw(event, payload, meta);
      if (result === false) return; // middleware can veto
    }

    // Record history
    this.#history.push({ event, payload, meta });
    if (this.#history.length > this.#historyMax) this.#history.shift();

    // Deliver to subscribers
    const subs = this.#listeners.get(event);
    if (!subs || subs.size === 0) return;

    const toRemove = [];
    for (const entry of subs) {
      try {
        entry.handler(payload, meta);
      } catch (err) {
        console.error(`[EventBus] Error in handler for ${event}:`, err);
      }
      if (entry.once) toRemove.push(entry);
    }
    for (const entry of toRemove) subs.delete(entry);
  }

  /**
   * Add middleware that runs before every emit.
   * Return false from middleware to cancel the event.
   */
  use(middleware) {
    this.#middlewares.push(middleware);
  }

  /** Get recent event history (for debugging). */
  get history() {
    return [...this.#history];
  }

  /** Remove all listeners (for testing / teardown). */
  clear() {
    this.#listeners.clear();
    this.#history.length = 0;
  }

  /** Get subscriber count for an event. */
  listenerCount(event) {
    return this.#listeners.get(event)?.size || 0;
  }
}


// ── Singleton Export ─────────────────────────────────────────
// One bus per application. All contexts share it.
export const bus = new EventBusImpl();

// Debug middleware (only in dev)
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  bus.use((event, payload) => {
    console.debug(`%c[Event] ${event}`, 'color:#64ffda;font-weight:bold', payload);
  });
}

export default bus;
