const { getTerrainHeight } = require('./terrainHeight');
const { applyDamage } = require('./ballistics');

class DroneManager {
  constructor() {
    this.drones = new Map();
    this.seq = 1;
  }

  spawnDrone(owner, mode) {
    // mode: 'fpv' (1st-person attack drone) or 'recon' (3rd-person overwatch drone)
    const id = `drone_${this.seq++}`;
    const drone = {
      id,
      ownerId: owner.id,
      ownerCallsign: owner.callsign,
      team: owner.team,
      mode,
      x: owner.x,
      y: owner.y + 3.0,
      z: owner.z,
      yaw: owner.yaw,
      pitch: -0.15,
      hp: mode === 'fpv' ? 40 : 65,
      expiresAt: Date.now() + (mode === 'fpv' ? 22000 : 30000),
      exploded: false
    };
    this.drones.set(id, drone);
    return drone;
  }

  controlDrone(droneId, ownerId, input) {
    const drone = this.drones.get(droneId);
    if (!drone || drone.ownerId !== ownerId) return null;
    if (typeof input.yaw === 'number') drone.yaw = input.yaw;
    if (typeof input.pitch === 'number') drone.pitch = input.pitch;

    const speed = drone.mode === 'fpv' ? 0.65 : 0.42;
    const forwardX = -Math.sin(drone.yaw);
    const forwardZ = -Math.cos(drone.yaw);
    const rightX = Math.cos(drone.yaw);
    const rightZ = -Math.sin(drone.yaw);

    if (input.forward) {
      drone.x += forwardX * speed;
      drone.z += forwardZ * speed;
      drone.y += Math.sin(drone.pitch) * speed * 0.7;
    }
    if (input.backward) {
      drone.x -= forwardX * speed * 0.7;
      drone.z -= forwardZ * speed * 0.7;
    }
    if (input.left) {
      drone.x -= rightX * speed * 0.7;
      drone.z -= rightZ * speed * 0.7;
    }
    if (input.right) {
      drone.x += rightX * speed * 0.7;
      drone.z += rightZ * speed * 0.7;
    }
    if (input.up) drone.y += 0.35;
    if (input.down) drone.y -= 0.35;

    const minY = getTerrainHeight(drone.x, drone.z) + 1.2;
    if (drone.y < minY) drone.y = minY;
    if (drone.y > 70) drone.y = 70;
    return drone;
  }

  detonateDrone(droneId, playersMap, onKill) {
    const drone = this.drones.get(droneId);
    if (!drone || drone.exploded) return null;
    drone.exploded = true;
    this.drones.delete(droneId);

    const owner = playersMap.get(drone.ownerId);
    const blastRadius = 9.0;
    const hits = [];

    for (const target of playersMap.values()) {
      if (!target.alive) continue;
      if (owner && owner.mode === 'TDM' && target.team === owner.team && target.id !== owner.id) continue;
      const dist = Math.hypot(target.x - drone.x, target.y + 1 - drone.y, target.z - drone.z);
      if (dist <= blastRadius) {
        const dmg = Math.round(115 * (1 - dist / (blastRadius + 2)));
        applyDamage(target, dmg, true);
        hits.push({ targetId: target.id, dmg });
        if (target.hp <= 0 && owner) {
          onKill(owner, target, 'FPV Attack Drone');
        }
      }
    }
    return { id: drone.id, x: drone.x, y: drone.y, z: drone.z, hits };
  }

  update(now) {
    const expired = [];
    for (const [id, d] of this.drones.entries()) {
      if (now >= d.expiresAt) {
        this.drones.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }

  serialize() {
    return Array.from(this.drones.values());
  }
}

module.exports = { DroneManager };
