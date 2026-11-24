import * as THREE from 'three';
import { getTerrainHeight, MAP_HALF_SIZE } from './terrain.js';

export function createSoldierMesh(team = 'bharat', callsign = 'Soldier') {
  const group = new THREE.Group();
  const uniformColor = team === 'bharat' ? 0x4b5d3b : 0x5c3a32; // Olive Drab vs Opfor
  const vestColor = team === 'bharat' ? 0x2d3824 : 0x2b2424;

  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.72, 0.32),
    new THREE.MeshStandardMaterial({ color: uniformColor, roughness: 0.85 })
  );
  torso.position.y = 1.05;
  torso.castShadow = true;

  const vest = new THREE.Mesh(
    new THREE.BoxGeometry(0.58, 0.45, 0.36),
    new THREE.MeshStandardMaterial({ color: vestColor, roughness: 0.7 })
  );
  vest.position.y = 1.12;

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 10, 10),
    new THREE.MeshStandardMaterial({ color: 0xc69c72, roughness: 0.7 })
  );
  head.position.y = 1.62;
  head.castShadow = true;

  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
    new THREE.MeshStandardMaterial({ color: vestColor, roughness: 0.6 })
  );
  helmet.position.y = 1.65;

  const legs = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.7, 0.28),
    new THREE.MeshStandardMaterial({ color: uniformColor, roughness: 0.9 })
  );
  legs.position.y = 0.35;
  legs.castShadow = true;

  group.add(torso, vest, head, helmet, legs);
  group.userData = { callsign, team };
  return group;
}

export class LocalPlayerController {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.x = 0;
    this.y = 0;
    this.z = -90;
    this.vy = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.stance = 'stand'; // stand | crouch | prone
    this.lean = 0;         // -1 | 0 | 1
    this.thirdPerson = false;
    this.ads = false;
    this.grounded = true;
    this.keys = {};
    this.locked = false;

    this._bindEvents();
  }

  _bindEvents() {
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyC') this.stance = this.stance === 'crouch' ? 'stand' : 'crouch';
      if (e.code === 'KeyZ') this.stance = this.stance === 'prone' ? 'stand' : 'prone';
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
      const sens = this.ads ? 0.0012 : 0.0022;
      this.yaw -= e.movementX * sens;
      this.pitch = Math.max(-1.42, Math.min(1.42, this.pitch - e.movementY * sens));
    });
  }

  update(dt, boost = 0, moveSpeedMult = 1.0, skipCamera = false) {
    // Lean Q/E
    this.lean = (this.keys.KeyE ? 1 : 0) - (this.keys.KeyQ ? 1 : 0);

    const sprinting = !!this.keys.ShiftLeft && this.stance === 'stand' && !this.ads;
    let baseSpeed = 6.2 * moveSpeedMult;
    if (this.stance === 'crouch') baseSpeed *= 0.62;
    if (this.stance === 'prone') baseSpeed *= 0.34;
    if (sprinting) baseSpeed *= 1.48;
    if (boost > 20) baseSpeed *= 1.12; // BGMI energy drink speed boost

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

    const len = Math.hypot(mx, mz);
    if (len > 0) {
      this.x += (mx / len) * baseSpeed * dt;
      this.z += (mz / len) * baseSpeed * dt;
    }

    this.x = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, this.x));
    this.z = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, this.z));

    const groundY = getTerrainHeight(this.x, this.z);
    if (this.keys.Space && this.grounded && this.stance === 'stand') {
      this.vy = 6.8;
      this.grounded = false;
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

      const targetFov = this.ads ? 44 : 74;
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
