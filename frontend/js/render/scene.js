// The WebGL renderer, scene, camera and lights.
import * as THREE from 'three';
import { SKY_HORIZON } from './world.js';

export function createStage({ canvas, quality, width, height, devicePixelRatio = globalThis.devicePixelRatio || 1 }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: quality.antialias,
    powerPreference: 'high-performance',
    stencil: false
  });
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_HORIZON);
  scene.fog = new THREE.FogExp2(SKY_HORIZON, quality.fogDensity);

  const camera = new THREE.PerspectiveCamera(74, width / height, 0.1, quality.far);
  camera.rotation.order = 'YXZ';
  scene.add(camera); // the weapon model is a child of the camera, so the camera must be in the scene

  scene.add(new THREE.HemisphereLight(0xdbeafe, 0x3f3f46, 0.85));
  const sun = new THREE.DirectionalLight(0xfffbeb, 1.15);
  sun.castShadow = quality.shadows;
  if (quality.shadows) {
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const cam = sun.shadow.camera;
    cam.left = -50;
    cam.right = 50;
    cam.top = 50;
    cam.bottom = -50;
    cam.near = 10;
    cam.far = 320;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.05;
  }
  scene.add(sun);
  scene.add(sun.target);

  let scale = 1;
  let w = width;
  let h = height;
  const apply = () => {
    renderer.setPixelRatio(Math.max(0.5, Math.min(devicePixelRatio, quality.pixelRatio) * scale));
    renderer.setSize(w, h, false); // the canvas is sized by CSS
  };
  apply();

  return {
    renderer,
    scene,
    camera,
    sun,
    resize(width2, height2) {
      w = Math.max(1, width2);
      h = Math.max(1, height2);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      apply();
    },
    /** Lower (or restore) the render resolution: 1 = full. */
    setScale(s) {
      scale = s;
      apply();
    },
    /** Keep the shadow-casting sun centred on the player (snapped, so shadows do not shimmer). */
    followSun(x, y, z) {
      const sx = Math.round(x / 4) * 4;
      const sz = Math.round(z / 4) * 4;
      sun.target.position.set(sx, y, sz);
      sun.position.set(sx + 60, y + 110, sz - 40);
    },
    render() {
      renderer.render(scene, camera);
    },
    dispose() {
      renderer.dispose();
      try {
        renderer.forceContextLoss?.();
      } catch { /* already lost */ }
    }
  };
}
