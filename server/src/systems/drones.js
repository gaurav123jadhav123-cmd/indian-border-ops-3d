// 1st-person FPV attack drones and 3rd-person recon overwatch drones.
// The server flies them from the owner's latest inputs, scaled by real elapsed time, so
// flight speed no longer depends on how many packets the client sends.
import {
  getTerrainHeight, raycastWorld, pointInObstacle, clampToMap, forwardFromAngles
} from '../shared/world.js';

const r2 = (v) => Math.round(v * 100) / 100;
const INPUT_TIMEOUT_MS = 600; // no input for this long = hands off the sticks

const IDLE_INPUT = Object.freeze({
  forward: false, backward: false, left: false, right: false, up: false, down: false, yaw: 0, pitch: 0
});

export class DroneSystem {
  constructor(room) {
    this.room = room;
    this.drones = new Map();
    this.seq = 1;
  }

  spawn(owner, mode, now) {
    const cfg = this.room.rules.drone[mode];
    const drone = {
      id: `drone_${this.seq++}`,
      ownerId: owner.id,
      ownerCallsign: owner.callsign,
      team: owner.team,
      mode,
      x: owner.x,
      y: owner.y + 3.0,
      z: owner.z,
      yaw: owner.yaw,
      pitch: -0.15,
      hp: cfg.hp,
      expiresAt: now + cfg.ttlMs,
      input: IDLE_INPUT,
      inputAt: now
    };
    this.drones.set(drone.id, drone);
    return drone;
  }

  setInput(drone, input, now) {
    drone.input = input;
    drone.yaw = input.yaw;
    drone.pitch = input.pitch;
    drone.inputAt = now;
  }

  get(id) {
    return this.drones.get(id);
  }

  remove(drone) {
    this.drones.delete(drone.id);
  }

  list() {
    return Array.from(this.drones.values());
  }

  /** Returns true when the hit destroyed the drone. */
  damage(drone, amount) {
    drone.hp -= amount;
    return drone.hp <= 0;
  }

  update(dt, now) {
    const rules = this.room.rules.drone;
    for (const d of this.list()) {
      if (!this.drones.has(d.id)) continue; // removed earlier in this same tick
      if (now >= d.expiresAt) {
        this.room.endDrone(d, 'expired');
        continue;
      }

      const cfg = rules[d.mode];
      const inp = now - d.inputAt > INPUT_TIMEOUT_MS ? IDLE_INPUT : d.input;
      const f = forwardFromAngles(d.yaw, d.pitch);
      const rightX = Math.cos(d.yaw);
      const rightZ = -Math.sin(d.yaw);

      let mx = 0;
      let my = 0;
      let mz = 0;
      if (inp.forward) { mx += f.x; my += f.y; mz += f.z; }
      if (inp.backward) { mx -= f.x * 0.7; my -= f.y * 0.7; mz -= f.z * 0.7; }
      if (inp.right) { mx += rightX * 0.7; mz += rightZ * 0.7; }
      if (inp.left) { mx -= rightX * 0.7; mz -= rightZ * 0.7; }
      const climb = inp.up ? cfg.vertical / cfg.speed : inp.down ? -cfg.vertical / cfg.speed : 0;
      my += climb;

      const len = Math.hypot(mx, my, mz);
      if (len < 1e-6) continue;
      const scale = (cfg.speed * dt) / Math.max(1, len); // never faster than `speed`
      const nx = clampToMap(d.x + mx * scale);
      const nz = clampToMap(d.z + mz * scale);
      const ny = Math.min(rules.maxAltitude, d.y + my * scale);

      const dx = nx - d.x;
      const dy = ny - d.y;
      const dz = nz - d.z;
      const dist = Math.hypot(dx, dy, dz);
      const wall = dist > 1e-6
        ? raycastWorld(d.x, d.y, d.z, dx / dist, dy / dist, dz / dist, dist + 0.3, { terrain: false })
        : null;

      if (wall || pointInObstacle(nx, ny, nz, 0.2)) {
        if (d.mode === 'fpv') {
          this.room.detonateDrone(d);
        }
        continue; // recon drones just refuse to fly through walls
      }

      d.x = nx;
      d.z = nz;
      d.y = Math.max(getTerrainHeight(nx, nz) + rules.minAboveGround, ny);
    }
  }

  serialize() {
    return this.list().map((d) => ({
      id: d.id, ownerId: d.ownerId, team: d.team, mode: d.mode,
      x: r2(d.x), y: r2(d.y), z: r2(d.z), yaw: r2(d.yaw)
    }));
  }
}
