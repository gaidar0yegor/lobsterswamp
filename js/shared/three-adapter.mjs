/**
 * ═══════════════════════════════════════════════════════════════
 *  Three.js Adapter — Anti-Corruption Layer (Shared Kernel)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Wraps Three.js r128 so domain code never directly imports
 *  the library. If we upgrade Three.js versions, only this
 *  adapter changes — all bounded contexts stay untouched.
 *
 *  Also handles: canvas creation, resize, render loop, cleanup.
 */

let _three = null;  // lazy-loaded Three.js reference

/**
 * Get the Three.js library (lazy loads from CDN if needed).
 * @returns {Promise<THREE>}
 */
export async function getThree() {
  if (_three) return _three;

  // Three.js loaded via <script> tag → already on window
  if (window.THREE) {
    _three = window.THREE;
    return _three;
  }

  // Wait on an existing (likely async) CDN tag if present.
  // This avoids a second network fetch when index.html has already
  // scheduled the r128 script with SRI.
  const existing = document.getElementById('three-js-cdn');
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => {
        _three = window.THREE;
        if (_three) resolve(_three);
        else reject(new Error('Three.js loaded but window.THREE missing'));
      }, { once: true });
      existing.addEventListener('error',
        () => reject(new Error('Three.js CDN tag failed')),
        { once: true });
    });
  }

  // Fallback: dynamic import from CDN (shouldn't happen in prod)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    s.onload = () => { _three = window.THREE; resolve(_three); };
    s.onerror = () => reject(new Error('Failed to load Three.js'));
    document.head.appendChild(s);
  });
}


/**
 * Create a managed scene with camera, renderer, and auto-resize.
 * Returns a handle that bounded contexts use — never raw Three objects.
 *
 * @param {object} opts
 * @param {string|HTMLCanvasElement} opts.canvas - Canvas element or ID
 * @param {object} [opts.camera]   - { fov, near, far }
 * @param {object} [opts.options]  - WebGLRenderer options
 * @returns {Promise<SceneHandle>}
 */
export async function createScene(opts = {}) {
  const THREE = await getThree();

  const canvas = typeof opts.canvas === 'string'
    ? document.getElementById(opts.canvas)
    : opts.canvas;

  if (!canvas) throw new Error(`Canvas not found: ${opts.canvas}`);

  const camOpts = opts.camera || {};
  const w = canvas.clientWidth  || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;

  const camera = new THREE.PerspectiveCamera(
    camOpts.fov  || 60,
    w / h,
    camOpts.near || 0.1,
    camOpts.far  || 1000
  );
  camera.position.set(0, 0, camOpts.z || 30);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    ...opts.options,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);

  const scene = new THREE.Scene();

  // Auto-resize
  let resizeRaf = null;
  const onResize = () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      const nw = canvas.clientWidth  || window.innerWidth;
      const nh = canvas.clientHeight || window.innerHeight;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
      resizeRaf = null;
    });
  };
  window.addEventListener('resize', onResize, { passive: true });

  // Render loop
  let animId = null;
  let running = false;
  const frameCallbacks = [];

  function loop() {
    if (!running) return;
    for (const cb of frameCallbacks) cb(scene, camera, renderer);
    renderer.render(scene, camera);
    animId = requestAnimationFrame(loop);
  }

  /** @type {SceneHandle} */
  const handle = {
    scene,
    camera,
    renderer,
    THREE,

    /** Add an object to the scene. */
    add(obj)    { scene.add(obj); },
    /** Remove an object from the scene. */
    remove(obj) { scene.remove(obj); },

    /** Register a per-frame callback. */
    onFrame(cb) { frameCallbacks.push(cb); },

    /** Start the render loop. */
    start() {
      if (running) return;
      running = true;
      animId = requestAnimationFrame(loop);
    },

    /** Stop the render loop. */
    stop() {
      running = false;
      if (animId) cancelAnimationFrame(animId);
      animId = null;
    },

    /** Full cleanup — call when context is destroyed. */
    dispose() {
      this.stop();
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
      frameCallbacks.length = 0;
    },

    get running() { return running; },
  };

  return handle;
}


export default { getThree, createScene };
