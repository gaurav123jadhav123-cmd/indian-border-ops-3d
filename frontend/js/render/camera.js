// Decides where the camera is: your eyes, behind your shoulder, or on a drone. Also smooths the
// zoom (field of view) and adds shake from explosions.
import * as THREE from 'three';
import { forwardFromAngles, getEyePosition, getTerrainHeight, raycastWorld } from '../shared/world.js';

const BASE_FOV = 74;

export class CameraRig {
  constructor({ camera, effects }) {
    this.camera = camera;
    this.effects = effects;
    this.fov = BASE_FOV;
    this.dronePos = new THREE.Vector3();
    this.hasDronePos = false;
    this.deadFor = 0;
    this.position = { x: 0, y: 0, z: 0 };
  }

  /** frame: see render/index.js. Returns the camera position in world space. */
  update(dt, f) {
    const cam = this.camera;
    const shake = this.effects ? this.effects.shakeOffset() : { x: 0, y: 0, roll: 0 };
    let targetFov = BASE_FOV;
    let px;
    let py;
    let pz;
    let pitch;
    let yaw;
    let roll = 0;

    if (f.view === 'drone' && f.drone) {
      const d = f.drone;
      const k = 1 - Math.exp(-dt * 20);
      if (!this.hasDronePos) {
        this.dronePos.set(d.pos.x, d.pos.y, d.pos.z);
        this.hasDronePos = true;
      } else {
        this.dronePos.x += (d.pos.x - this.dronePos.x) * k;
        this.dronePos.y += (d.pos.y - this.dronePos.y) * k;
        this.dronePos.z += (d.pos.z - this.dronePos.z) * k;
      }
      const fwd = forwardFromAngles(d.yaw, d.pitch);
      if (d.mode === 'fpv') {
        px = this.dronePos.x + fwd.x * 0.25;
        py = this.dronePos.y + fwd.y * 0.25;
        pz = this.dronePos.z + fwd.z * 0.25;
        targetFov = 92;
      } else {
        px = this.dronePos.x - fwd.x * 3.5;
        py = this.dronePos.y - fwd.y * 3.5 + 1.4;
        pz = this.dronePos.z - fwd.z * 3.5;
        targetFov = 70;
      }
      yaw = d.yaw;
      pitch = d.pitch;
    } else {
      this.hasDronePos = false;
      const p = f.pose;
      const eye = getEyePosition(p);
      yaw = p.yaw;
      pitch = p.pitch + (f.kick || 0);
      roll = -p.lean * 0.14;
      px = eye.x;
      py = eye.y;
      pz = eye.z;

      if (!f.alive) {
        // fall to the ground where you died
        this.deadFor += dt;
        const ground = getTerrainHeight(p.x, p.z) + 0.3;
        py = Math.max(ground, eye.y - this.deadFor * 2.4);
        roll = Math.min(0.9, this.deadFor * 1.2);
      } else {
        this.deadFor = 0;
        if (f.view === 'third') {
          const fx = -Math.sin(yaw);
          const fz = -Math.cos(yaw);
          let dx = -fx * 3.8;
          let dy = 0.9 - Math.sin(p.pitch) * 1.4;
          let dz = -fz * 3.8;
          const len = Math.hypot(dx, dy, dz);
          dx /= len;
          dy /= len;
          dz /= len;
          // do not let the camera end up inside a hill or a bunker
          const hit = raycastWorld(eye.x, eye.y, eye.z, dx, dy, dz, len);
          const t = hit ? Math.max(0.6, hit.dist - 0.35) : len;
          px = eye.x + dx * t;
          py = eye.y + dy * t;
          pz = eye.z + dz * t;
        }
        if (f.weapon && p.ads) targetFov = f.weapon.adsFov;
        else if (p.sprinting) targetFov = BASE_FOV + 4;
      }
    }

    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 16));
    if (Math.abs(cam.fov - this.fov) > 0.05) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    cam.position.set(px + shake.x, py + shake.y, pz);
    cam.rotation.set(pitch, yaw, roll + shake.roll);
    this.position = { x: px, y: py, z: pz };
    return this.position;
  }
}
