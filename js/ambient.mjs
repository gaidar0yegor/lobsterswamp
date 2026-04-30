/**
 * Ambient layer entry point for secondary pages.
 * Boots: audio context (music + SFX) + Three.js particle background.
 * Keeps the full DDD event bus so audio/context.mjs works unchanged.
 */

import { boot as bootAudio, skipSong } from './audio/context.mjs';
import { createScene }                 from './shared/three-adapter.mjs';
import { bus, DomainEvents }           from './shared/event-bus.mjs';

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Base hue for particle/line color — updated on each theme change
let _themeHue = 0.47;
const THEME_HUES = { swamp: 0.47, nocturne: 0.75, ember: 0.07, dawn: 0.55, abyss: 0.88, wager: 0.0 };

async function initParticles() {
  if (reduceMotion) return;
  const canvas = document.getElementById('scene-bg');
  if (!canvas) return;

  let handle;
  try {
    handle = await createScene({
      canvas,
      camera: { fov: 55, near: 0.1, far: 250, z: 60 },
      options: { antialias: false, alpha: true },
    });
  } catch (err) {
    console.warn('[Ambient] 3D scene failed:', err);
    return;
  }

  const THREE = handle.THREE;
  const isMobile = window.innerWidth < 768;

  handle.renderer.setClearColor(0x000000, 0);
  handle.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

  // Layer 1: far violet drift
  const FAR_COUNT = isMobile ? 200 : 600;
  const farPos = new Float32Array(FAR_COUNT * 3);
  const farVel = [];
  for (let i = 0; i < FAR_COUNT; i++) {
    farPos[i * 3]     = (Math.random() - 0.5) * 120;
    farPos[i * 3 + 1] = (Math.random() - 0.5) * 120;
    farPos[i * 3 + 2] = -30 - Math.random() * 40;
    farVel.push({ x: (Math.random() - 0.5) * 0.001, y: (Math.random() - 0.5) * 0.001 });
  }
  const farGeo = new THREE.BufferGeometry();
  farGeo.setAttribute('position', new THREE.BufferAttribute(farPos, 3));
  handle.add(new THREE.Points(farGeo, new THREE.PointsMaterial({
    color: 0xa78bfa, size: 2.0, transparent: true, opacity: 0.06,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  })));

  // Layer 2: mid cyan core
  const COUNT = isMobile ? 500 : 1500;
  const positions = new Float32Array(COUNT * 3);
  const velocities = [];
  const spread = 80;
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3]     = (Math.random() - 0.5) * spread;
    positions[i * 3 + 1] = (Math.random() - 0.5) * spread;
    positions[i * 3 + 2] = (Math.random() - 0.5) * spread * 0.4;
    velocities.push({
      x: (Math.random() - 0.5) * 0.004,
      y: (Math.random() - 0.5) * 0.004,
      z: (Math.random() - 0.5) * 0.001,
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x64ffda, size: 1.0, transparent: true, opacity: 0.1,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  handle.add(points);

  // Layer 3: near white sparkles
  const NEAR_COUNT = isMobile ? 60 : 150;
  const nearPos = new Float32Array(NEAR_COUNT * 3);
  const nearVel = [];
  for (let i = 0; i < NEAR_COUNT; i++) {
    nearPos[i * 3]     = (Math.random() - 0.5) * 50;
    nearPos[i * 3 + 1] = (Math.random() - 0.5) * 50;
    nearPos[i * 3 + 2] = 10 + Math.random() * 20;
    nearVel.push({ x: (Math.random() - 0.5) * 0.008, y: (Math.random() - 0.5) * 0.008 });
  }
  const nearGeo = new THREE.BufferGeometry();
  nearGeo.setAttribute('position', new THREE.BufferAttribute(nearPos, 3));
  handle.add(new THREE.Points(nearGeo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.6, transparent: true, opacity: 0.15,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  })));

  // Connecting lines
  const lineCount = Math.min(COUNT, 250);
  const lineGeo = new THREE.BufferGeometry();
  const linePos = new Float32Array(lineCount * 2 * 3);
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x64ffda, transparent: true, opacity: 0.025,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  handle.add(new THREE.LineSegments(lineGeo, lineMat));

  // Ambient orbs
  const orbMesh = new THREE.Mesh(
    new THREE.SphereGeometry(18, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x64ffda, transparent: true, opacity: 0.012, side: THREE.BackSide })
  );
  orbMesh.position.set(15, -10, -20);
  handle.add(orbMesh);

  const orb2Mesh = new THREE.Mesh(
    new THREE.SphereGeometry(14, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.008, side: THREE.BackSide })
  );
  orb2Mesh.position.set(-20, 15, -15);
  handle.add(orb2Mesh);

  // Input influence
  let mouseX = 0, mouseY = 0;
  document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth  - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  let scrollProgress = 0;
  window.addEventListener('scroll', () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    scrollProgress = max > 0 ? window.scrollY / max : 0;
  }, { passive: true });

  // Frame loop
  let time = 0;
  const posArr  = geo.attributes.position.array;
  const fp      = farGeo.attributes.position.array;
  const np      = nearGeo.attributes.position.array;
  const lp      = lineGeo.attributes.position.array;

  handle.onFrame((_, camera) => {
    time += 0.002;

    // Mid particles + lines
    let lineIdx = 0;
    for (let i = 0; i < COUNT; i++) {
      posArr[i*3]   += velocities[i].x;
      posArr[i*3+1] += velocities[i].y;
      posArr[i*3+2] += velocities[i].z;
      if (posArr[i*3]   >  spread/2) posArr[i*3]   = -spread/2;
      if (posArr[i*3]   < -spread/2) posArr[i*3]   =  spread/2;
      if (posArr[i*3+1] >  spread/2) posArr[i*3+1] = -spread/2;
      if (posArr[i*3+1] < -spread/2) posArr[i*3+1] =  spread/2;

      if (lineIdx < lineCount * 2) {
        for (let j = i + 1; j < Math.min(i + 4, COUNT); j++) {
          const dx = posArr[i*3] - posArr[j*3];
          const dy = posArr[i*3+1] - posArr[j*3+1];
          if (dx*dx + dy*dy < 20 && lineIdx < lineCount*2) {
            const li = lineIdx * 3;
            lp[li]   = posArr[i*3];   lp[li+1] = posArr[i*3+1]; lp[li+2] = posArr[i*3+2];
            lp[li+3] = posArr[j*3];   lp[li+4] = posArr[j*3+1]; lp[li+5] = posArr[j*3+2];
            lineIdx++;
          }
        }
      }
    }
    for (let k = lineIdx; k < lineCount; k++) {
      const li = k * 6;
      lp[li] = lp[li+1] = lp[li+2] = lp[li+3] = lp[li+4] = lp[li+5] = 0;
    }
    geo.attributes.position.needsUpdate = true;
    lineGeo.attributes.position.needsUpdate = true;

    // Far layer
    for (let i = 0; i < FAR_COUNT; i++) {
      fp[i*3]   += farVel[i].x;
      fp[i*3+1] += farVel[i].y;
      if (fp[i*3]   >  60) fp[i*3]   = -60;
      if (fp[i*3]   < -60) fp[i*3]   =  60;
      if (fp[i*3+1] >  60) fp[i*3+1] = -60;
      if (fp[i*3+1] < -60) fp[i*3+1] =  60;
    }
    farGeo.attributes.position.needsUpdate = true;

    // Near sparkles
    for (let i = 0; i < NEAR_COUNT; i++) {
      np[i*3]   += nearVel[i].x;
      np[i*3+1] += nearVel[i].y;
      if (np[i*3]   >  25) np[i*3]   = -25;
      if (np[i*3]   < -25) np[i*3]   =  25;
      if (np[i*3+1] >  25) np[i*3+1] = -25;
      if (np[i*3+1] < -25) np[i*3+1] =  25;
    }
    nearGeo.attributes.position.needsUpdate = true;

    // Orb drift
    orbMesh.position.x  =  15 + Math.sin(time * 0.30)     * 5;
    orbMesh.position.y  = -10 + Math.cos(time * 0.20)     * 3;
    orb2Mesh.position.x = -20 + Math.sin(time * 0.25 + 2) * 4;
    orb2Mesh.position.y =  15 + Math.cos(time * 0.35)     * 4;

    // Camera sway
    camera.position.x += ( mouseX * 4 - camera.position.x) * 0.008;
    camera.position.y += (-mouseY * 4 - camera.position.y) * 0.008;
    camera.position.z  = 60 - scrollProgress * 20;
    points.rotation.y  = time * 0.06;

    // Color shift on scroll, anchored to current theme hue
    const hue = _themeHue + scrollProgress * 0.08;
    mat.color.setHSL(hue, 0.6, 0.55);
    lineMat.color.setHSL(hue, 0.6, 0.55);
  });

  handle.start();
}

async function boot() {
  await bootAudio();

  // Theme change: swap body class + particle hue + indicator label
  bus.on(DomainEvents.THEME_CHANGED, ({ theme, name }) => {
    _themeHue = THEME_HUES[theme] ?? 0.47;
    document.body.className = document.body.className.replace(/\btheme-\S+/g, '').trim();
    if (theme !== 'swamp') document.body.classList.add(`theme-${theme}`);
    const ind = document.getElementById('theme-indicator');
    if (ind) {
      ind.querySelector('.theme-name').textContent = name;
      ind.classList.add('visible');
    }
  });

  // Indicator click → skip to next song
  document.getElementById('theme-indicator')
    ?.addEventListener('click', skipSong);

  initParticles().catch(err => console.warn('[Ambient] Particles failed:', err));
}

boot();
