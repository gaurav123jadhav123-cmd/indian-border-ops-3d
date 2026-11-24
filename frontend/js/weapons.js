import * as THREE from 'three';

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
  const metalMat = new THREE.MeshStandardMaterial({ color: colorHex, metalness: 0.75, roughness: 0.28 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x14171a, metalness: 0.4, roughness: 0.6 });
  const polymerMat = new THREE.MeshStandardMaterial({ color: 0x222629, roughness: 0.8 });

  if (weaponId === 'carlGustaf') {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 1.1, 14), metalMat);
    tube.rotation.x = Math.PI / 2;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.16, 14), darkMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.z = -0.35;
    group.add(tube, collar);
  } else if (weaponId === 'pistol9mm') {
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.052, 0.25), metalMat);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.22), polymerMat);
    frame.position.set(0, -0.035, 0.01);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.12, 0.055), polymerMat);
    grip.position.set(0, -0.08, 0.075);
    grip.rotation.x = 0.22;
    group.add(slide, frame, grip);
  } else {
    const isSniper = ['svd', 'trg42', 'vidhwansak'].includes(weaponId);
    const barrelLen = isSniper ? 0.82 : 0.56;

    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.078, 0.36), metalMat);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.018, 0.34), darkMat);
    rail.position.set(0, 0.046, -0.02);

    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.064, 0.28), polymerMat);
    handguard.position.set(0, 0.005, -0.28);

    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.095, 0.24), polymerMat);
    stock.position.set(0, -0.015, 0.26);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, barrelLen, 10), darkMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.015, -barrelLen / 2 - 0.14);

    const muzzleBrake = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.018, 0.06, 10), metalMat);
    muzzleBrake.rotation.x = Math.PI / 2;
    muzzleBrake.position.set(0, 0.015, -barrelLen - 0.14);

    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.15, 0.072), darkMat);
    mag.position.set(0, -0.095, -0.05);
    mag.rotation.x = -0.22;

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.11, 0.05), polymerMat);
    grip.position.set(0, -0.075, 0.09);
    grip.rotation.x = 0.28;

    group.add(receiver, rail, handguard, stock, barrel, muzzleBrake, mag, grip);

    // Optic / Holographic Sight
    const opticBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, isSniper ? 0.26 : 0.11, 12),
      darkMat
    );
    opticBody.rotation.x = Math.PI / 2;
    opticBody.position.set(0, 0.075, -0.03);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.019, 12),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45 })
    );
    lens.position.set(0, 0.075, isSniper ? 0.105 : 0.03);
    group.add(opticBody, lens);
  }

  // Muzzle Flash + Dynamic Light
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.065, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffc300 })
  );
  flash.position.set(0, 0.015, -0.78);
  flash.visible = false;
  flash.name = 'muzzleFlash';

  const flashLight = new THREE.PointLight(0xffaa00, 3.5, 14);
  flashLight.position.set(0, 0.05, -0.8);
  flashLight.visible = false;
  flashLight.name = 'muzzleLight';

  group.add(flash, flashLight);
  group.position.set(0.24, -0.22, -0.45);
  return group;
}
