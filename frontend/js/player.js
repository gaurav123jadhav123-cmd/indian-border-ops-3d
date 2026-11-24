import * as THREE from 'three';
import { getTerrainHeight, MAP_HALF_SIZE } from './terrain.js';

function createCamoTexture(baseHex, accent1, accent2) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 128, 128);
  const colors = [accent1, accent2];
  for (let i = 0; i < 65; i++) {
    ctx.fillStyle = colors[i % 2];
    ctx.beginPath();
    ctx.ellipse(
      Math.random() * 128,
      Math.random() * 128,
      6 + Math.random() * 14,
      4 + Math.random() * 10,
      Math.random() * Math.PI,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

const bharatCamoTex = typeof document !== 'undefined'
  ? createCamoTexture('#4b5d3b', '#334027', '#6b5b3e')
  : null;
const opforCamoTex = typeof document !== 'undefined'
  ? createCamoTexture('#54463d', '#382e28', '#242220')
  : null;

export function createSoldierMesh(team = 'bharat', callsign = 'Soldier') {
  const group = new THREE.Group();
  const isBharat = team === 'bharat';
  const bduMat = new THREE.MeshStandardMaterial({
    map: isBharat ? bharatCamoTex : opforCamoTex,
    roughness: 0.86
  });
  const gearMat = new THREE.MeshStandardMaterial({
    color: isBharat ? 0x2a3322 : 0x262426,
    roughness: 0.72
  });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x1a1918, roughness: 0.9 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc29368, roughness: 0.72 });
  const visorMat = new THREE.MeshStandardMaterial({
    color: isBharat ? 0x1e293b : 0x451a1a,
    metalness: 0.85,
    roughness: 0.15
  });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x1f2429, metalness: 0.7, roughness: 0.35 });

  // Articulated Left & Right Legs + Combat Boots
  const makeLeg = (xOffset) => {
    const leg = new THREE.Group();
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.095, 0.42, 8), bduMat);
    thigh.position.y = -0.21;
    const knee = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.18), gearMat);
    knee.position.set(0, -0.42, 0.02);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.36, 8), bduMat);
    shin.position.y = -0.60;
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.13, 0.25), bootMat);
    boot.position.set(0, -0.80, -0.04);
    leg.add(thigh, knee, shin, boot);
    leg.position.set(xOffset, 0.87, 0);
    leg.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return leg;
  };
  const leftLeg = makeLeg(-0.14);
  const rightLeg = makeLeg(0.14);
  leftLeg.name = 'leftLeg';
  rightLeg.name = 'rightLeg';

  // Torso + Plate Carrier Tactical Vest + Pouches + Belt
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.58, 0.26), bduMat);
  torso.position.y = 1.16;
  torso.castShadow = true;

  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.44, 0.31), gearMat);
  vest.position.y = 1.18;
  vest.castShadow = true;

  for (let i = -1; i <= 1; i++) {
    const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.16, 0.07), gearMat);
    pouch.position.set(i * 0.13, 1.06, -0.18);
    group.add(pouch);
  }

  // Team Armband / Patch
  const patch = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.08, 0.08),
    new THREE.MeshStandardMaterial({ color: isBharat ? 0xff9933 : 0xef4444 })
  );
  patch.position.set(-0.27, 1.32, 0);

  // Head + Balaclava + Goggles + ACH Helmet + NVG Mount
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.12, 8), skinMat);
  neck.position.y = 1.49;

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), skinMat);
  head.position.y = 1.63;
  head.castShadow = true;

  const mask = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.145, 0.16, 10), gearMat);
  mask.position.y = 1.56;

  const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.075, 0.12), visorMat);
  goggles.position.set(0, 1.65, -0.11);

  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.195, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.58),
    gearMat
  );
  helmet.position.y = 1.67;
  helmet.castShadow = true;

  const nvgMount = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.05), gunMat);
  nvgMount.position.set(0, 1.74, -0.18);

  // Arms + Held 3D Rifle
  const leftArm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.46, 8), bduMat);
  leftArm.position.set(-0.29, 1.22, -0.12);
  leftArm.rotation.x = Math.PI * 0.35;
  leftArm.rotation.z = -0.25;

  const rightArm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.46, 8), bduMat);
  rightArm.position.set(0.29, 1.22, -0.12);
  rightArm.rotation.x = Math.PI * 0.35;
  rightArm.rotation.z = 0.25;

  const rifle = new THREE.Group();
  const rBody = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.48), gunMat);
  const rBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.45, 8), gunMat);
  rBarrel.rotation.x = Math.PI / 2;
  rBarrel.position.set(0, 0.02, -0.44);
  const rMag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.07), gunMat);
  rMag.position.set(0, -0.1, -0.05);
  rMag.rotation.x = -0.2;
  rifle.add(rBody, rBarrel, rMag);
  rifle.position.set(0.12, 1.15, -0.34);

  group.add(
    leftLeg, rightLeg, torso, vest, patch,
    neck, head, mask, goggles, helmet, nvgMount,
    leftArm, rightArm, rifle
  );
  group.userData = { callsign, team, walkPhase: 0 };
  return group;
}

export function animateSoldierMesh(mesh, isMoving, dt) {
  const leftLeg = mesh.getObjectByName('leftLeg');
  const rightLeg = mesh.getObjectByName('rightLeg');
  if (!leftLeg || !rightLeg) return;
  if (isMoving) {
    mesh.userData.walkPhase = (mesh.userData.walkPhase || 0) + dt * 10;
    const swing = Math.sin(mesh.userData.walkPhase) * 0.55;
    leftLeg.rotation.x = swing;
    rightLeg.rotation.x = -swing;
  } else {
    leftLeg.rotation.x *= 0.8;
    rightLeg.rotation.x *= 0.8;
  }
}

export class LocalPlayerController {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.x = 0;
    this.y = 0;
    this.z = -68;
    this.vy = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.stance = 'stand';
    this.lean = 0;
    this.thirdPerson = false;
    this.ads = false;
    this.grounded = true;
    this.keys = {};
    this.locked = false;
    this.virtualMoveX = 0;
    this.virtualMoveY = 0;
    this.virtualJump = false;

    this._bindEvents();
  }

  _isTypingInInput() {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  _bindEvents() {
    window.addEventListener('keydown', (e) => {
      if (this._isTypingInInput()) return;
      this.keys[e.code] = true;
      if (e.code === 'KeyC') this.toggleCrouch();
      if (e.code === 'KeyZ') this.toggleProne();
      if (e.code === 'KeyV') this.thirdPerson = !this.thirdPerson;
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.domElement;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.addLookDelta(e.movementX, e.movementY);
    });
  }

  addLookDelta(dx, dy) {
    const sens = this.ads ? 0.0014 : 0.0028;
    this.yaw -= dx * sens;
    this.pitch = Math.max(-1.42, Math.min(1.42, this.pitch - dy * sens));
  }

  toggleCrouch() {
    this.stance = this.stance === 'crouch' ? 'stand' : 'crouch';
  }

  toggleProne() {
    this.stance = this.stance === 'prone' ? 'stand' : 'prone';
  }

  triggerJump() {
    if (this.grounded && this.stance === 'stand') {
      this.vy = 6.8;
      this.grounded = false;
    }
  }

  update(dt, boost = 0, moveSpeedMult = 1.0, skipCamera = false) {
    const keyLean = (this.keys.KeyE ? 1 : 0) - (this.keys.KeyQ ? 1 : 0);
    if (keyLean !== 0) this.lean = keyLean;
    else if (!this._mobileLean) this.lean = 0;

    const sprinting = (!!this.keys.ShiftLeft || this.virtualMoveY > 0.85) && this.stance === 'stand' && !this.ads;
    let baseSpeed = 6.5 * moveSpeedMult;
    if (this.stance === 'crouch') baseSpeed *= 0.62;
    if (this.stance === 'prone') baseSpeed *= 0.34;
    if (sprinting) baseSpeed *= 1.48;
    if (boost > 20) baseSpeed *= 1.12;

    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);

    let mx = 0;
    let mz = 0;
    if (this.keys.KeyW) { mx += forwardX; mz += forwardZ; }
    if (this.keys.KeyS) { mx -= forwardX; mz -= forwardZ; }
    if (this.keys.KeyD) { mx += rightX; mz += rightZ; }
    if (this.keys.KeyA) { mx -= rightX; mz -= rightZ; }

    if (Math.abs(this.virtualMoveX) > 0.08 || Math.abs(this.virtualMoveY) > 0.08) {
      mx += forwardX * this.virtualMoveY + rightX * this.virtualMoveX;
      mz += forwardZ * this.virtualMoveY + rightZ * this.virtualMoveX;
    }

    const len = Math.hypot(mx, mz);
    if (len > 0) {
      this.x += (mx / len) * baseSpeed * dt;
      this.z += (mz / len) * baseSpeed * dt;
    }

    this.x = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, this.x));
    this.z = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, this.z));

    const groundY = getTerrainHeight(this.x, this.z);
    if (this.keys.Space || this.virtualJump) {
      this.triggerJump();
      this.virtualJump = false;
    }

    this.vy -= 18 * dt;
    this.y += this.vy * dt;
    if (this.y <= groundY) {
      this.y = groundY;
      this.vy = 0;
      this.grounded = true;
    }

    if (!skipCamera) {
      const eyeHeight = this.stance === 'prone' ? 0.48 : this.stance === 'crouch' ? 1.12 : 1.65;
      const leanOffset = this.lean * 0.45;
      const camX = this.x + rightX * leanOffset;
      const camZ = this.z + rightZ * leanOffset;
      const camY = this.y + eyeHeight;

      if (this.thirdPerson) {
        this.camera.position.set(
          camX - forwardX * 3.8,
          camY + 0.9 - Math.sin(this.pitch) * 1.4,
          camZ - forwardZ * 3.8
        );
      } else {
        this.camera.position.set(camX, camY, camZ);
      }

      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
      this.camera.rotation.z = -this.lean * 0.14;

      const targetFov = this.ads ? 42 : 74;
      if (Math.abs(this.camera.fov - targetFov) > 0.5) {
        this.camera.fov += (targetFov - this.camera.fov) * 0.25;
        this.camera.updateProjectionMatrix();
      }
    }

    return {
      x: this.x,
      y: this.y,
      z: this.z,
      yaw: this.yaw,
      pitch: this.pitch,
      stance: this.stance,
      lean: this.lean,
      sprinting
    };
  }
}
