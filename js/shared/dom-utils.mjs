/**
 * ═══════════════════════════════════════════════════════════════
 *  DOM Utilities — Shared Kernel
 * ═══════════════════════════════════════════════════════════════
 *
 *  Centralized DOM helpers so bounded contexts don't each
 *  reinvent getElementById / querySelector / event delegation.
 *
 *  Caches queries. Provides a shared event delegation system.
 */

// ── Element Cache ───────────────────────────────────────────
const _cache = new Map();

/**
 * Get element by ID (cached).
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export function getEl(id) {
  if (_cache.has(id)) {
    const el = _cache.get(id);
    if (el.isConnected) return el;
    _cache.delete(id);  // stale reference
  }
  const el = document.getElementById(id);
  if (el) _cache.set(id, el);
  return el;
}

/**
 * Query selector (not cached — use for dynamic content).
 * @param {string} selector
 * @param {Element} [root=document]
 */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * Query selector all.
 * @param {string} selector
 * @param {Element} [root=document]
 * @returns {Element[]}
 */
export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

// ── Event Delegation ────────────────────────────────────────

const _delegates = new Map();  // rootEl → Map<eventType, [{selector, handler}]>

/**
 * Delegate event handling — attach once on a root, match children.
 * @param {Element|string} root      - Root element or ID
 * @param {string}         eventType - 'click', 'mouseenter', etc.
 * @param {string}         selector  - CSS selector to match
 * @param {Function}       handler   - (event, matchedEl) => void
 * @returns {Function} teardown function
 */
export function delegate(root, eventType, selector, handler) {
  const rootEl = typeof root === 'string' ? getEl(root) : root;
  if (!rootEl) return () => {};

  if (!_delegates.has(rootEl)) {
    _delegates.set(rootEl, new Map());
  }
  const eventMap = _delegates.get(rootEl);

  if (!eventMap.has(eventType)) {
    eventMap.set(eventType, []);
    rootEl.addEventListener(eventType, (e) => {
      const rules = eventMap.get(eventType);
      for (const rule of rules) {
        const match = e.target.closest(rule.selector);
        if (match && rootEl.contains(match)) {
          rule.handler(e, match);
        }
      }
    }, { passive: eventType !== 'click' });
  }

  const rule = { selector, handler };
  eventMap.get(eventType).push(rule);

  return () => {
    const arr = eventMap.get(eventType);
    const idx = arr.indexOf(rule);
    if (idx >= 0) arr.splice(idx, 1);
  };
}

// ── Scroll Observer ─────────────────────────────────────────

/**
 * IntersectionObserver wrapper for scroll-reveal patterns.
 * @param {string|Element[]} targets  - Selector string or element array
 * @param {Function}         callback - (entry) => void
 * @param {object}           [opts]   - IntersectionObserver options
 * @returns {Function} disconnect function
 */
export function onVisible(targets, callback, opts = {}) {
  const elements = typeof targets === 'string' ? qsa(targets) : targets;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        callback(entry);
        if (opts.once !== false) observer.unobserve(entry.target);
      }
    }
  }, {
    threshold: opts.threshold || 0.15,
    rootMargin: opts.rootMargin || '0px 0px -60px 0px',
  });

  for (const el of elements) observer.observe(el);

  return () => observer.disconnect();
}


// ── Script Loader ───────────────────────────────────────────

const _loadedScripts = new Set();

/**
 * Dynamically load a legacy IIFE script (for backward compat).
 * @param {string} src - Script path (e.g., 'js/snake.js')
 * @returns {Promise<void>}
 */
export function loadScript(src) {
  if (_loadedScripts.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => { _loadedScripts.add(src); resolve(); };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Check if a legacy script is already loaded.
 */
export function isScriptLoaded(src) {
  return _loadedScripts.has(src);
}

// ── Animation Scheduler ─────────────────────────────────────

const _animations = new Map();

/**
 * Register a named animation loop. Prevents duplicates.
 * @param {string}   name     - Unique animation ID
 * @param {Function} frameFn  - (timestamp) => void
 * @returns {{ start: Function, stop: Function }}
 */
export function createAnimation(name, frameFn) {
  if (_animations.has(name)) return _animations.get(name);

  let rafId = null;
  let running = false;

  function loop(ts) {
    if (!running) return;
    frameFn(ts);
    rafId = requestAnimationFrame(loop);
  }

  const handle = {
    start() {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    },
    get running() { return running; },
  };

  _animations.set(name, handle);
  return handle;
}

export default { getEl, qs, qsa, delegate, onVisible, loadScript, createAnimation };
