import * as THREE from 'three';

// Web Audio API Synthesizer for Gunshots, Explosions & Reloads (zero external assets needed)
const audioCtx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
  ? new (window.AudioContext || window.webkitAudioContext)()
  : null;

export function playSound(type = 'rifle') {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const now = audioCtx.currentTime;
  if (type === 'explosion') {
    const bufferSize = audioCtx.sampleRate * 0.5;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (audioCtx.sampleRate * 0.14));
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(320, now);
    noise.connect(filter).connect(audioCtx.destination);
    noise.start(now);
    return;
  }

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type === 'sniper' ? 'sawtooth' : 'square';
  const startFreq = type === 'sniper' ? 190 : type === 'pistol' ? 320 : 240;
  osc.frequency.setValueAtTime(startFreq, now);
  osc.frequency.exponentialRampToValueAtTime(45, now + 0.09);

  gain.gain.setValueAtTime(0.18, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}

export function createWeaponViewModel(weaponId, colorHex = 0x2b2d2f) {
  const group = new THREE.Group();
  const metalMat = new THREE.MeshStandardMaterial({ color: colorHex, metalness: 0.65, roughness: 0.35 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x151719, roughness: 0.8 });

  if (weaponId === 'carlGustaf') {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 1.05, 12), metalMat);
    tube.rotation.x = Math.PI / 2;
    group.add(tube);
  } else if (weaponId === 'pistol9mm') {
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.055, 0.24), metalMat);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.055), gripMat);
    grip.position.set(0, -0.07, 0.07);
    grip.rotation.x = 0.2;
    group.add(slide, grip);
  } else {
    const isSniper = ['svd', 'trg42', 'vidhwansak'].includes(weaponId);
    const barrelLen = isSniper ? 0.78 : 0.55;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.08, 0.38), metalMat);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, barrelLen, 8), metalMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.015, -barrelLen / 2 - 0.1);

    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.14, 0.07), gripMat);
    mag.position.set(0, -0.09, -0.04);
    mag.rotation.x = -0.18;

    group.add(body, barrel, mag);

    if (isSniper) {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.24, 10), gripMat);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.068, -0.02);
      group.add(scope);
    }
  }

  // Muzzle flash sphere
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0xffb703 })
  );
  flash.position.set(0, 0.015, -0.65);
  flash.visible = false;
  flash.name = 'muzzleFlash';
  group.add(flash);

  group.position.set(0.24, -0.22, -0.45);
  return group;
}
