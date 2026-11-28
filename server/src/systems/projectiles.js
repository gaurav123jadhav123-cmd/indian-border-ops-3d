// Grenades, Carl Gustaf rockets and tactical missile strikes.
// They only move things and call room.explode() when something detonates.
import { ARSENAL } from '../shared/arsenal.js';
import { raycastWorld, getTerrainHeight, clampToMap, getEyePosition } from '../shared/world.js';
import { hitSpheres, raySphere } from './ballistics.js';

const r2 = (v) => Math.round(v * 100) / 100;

/** Start point for something fired from the eye: stays outside walls the player is hugging. */
function muzzlePoint(eye, dir, reach) {
  const probe = raycastWorld(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, reach);
  if (probe) return { x: probe.x + probe.nx * 0.15, y: probe.y + probe.ny * 0.15, z: probe.z + probe.nz * 0.15 };
  return { x: eye.x + dir.x * reach, y: eye.y + dir.y * reach, z: eye.z + dir.z * reach };
}

export class ProjectileSystem {
  constructor(room) {
    this.room = room;
    this.grenades = [];
    this.rockets = [];
    this.missiles = [];
    this.seq = 1;
  }

  // ---- launching -----------------------------------------------------------
  throwGrenade(p, type, dir, now) {
    const cfg = this.room.rules.grenade;
    const start = muzzlePoint(getEyePosition(p), dir, 0.6);
    this.grenades.push({
      id: `nade_${this.seq++}`,
      ownerId: p.id,
      type,
      x: start.x, y: start.y, z: start.z,
      vx: dir.x * cfg.speed,
      vy: dir.y * cfg.speed + cfg.lift,
      vz: dir.z * cfg.speed,
      detonateAt: now + cfg.fuseMs
    });
  }

  fireRocket(p, dir, weaponId, now) {
    const start = muzzlePoint(getEyePosition(p), dir, 0.8);
    this.rockets.push({
      id: `rocket_${this.seq++}`,
      ownerId: p.id,
      weaponId,
      x: start.x, y: start.y, z: start.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
      travelled: 0,
      armedAt: now + this.room.rules.rocket.armDelayMs
    });
  }

  callMissile(p, dir) {
    const cfg = this.room.rules.missile;
    // Target = what the caller is aiming at (first terrain / bunker hit), limited to
    // [minRange, maxRange] from the caller. The client only sends a direction, never a point.
    const eye = getEyePosition(p);
    const hit = raycastWorld(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, cfg.maxRange);
    let tx = hit ? hit.x : eye.x + dir.x * cfg.maxRange;
    let tz = hit ? hit.z : eye.z + dir.z * cfg.maxRange;

    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < cfg.minRange) {
      let hx = -Math.sin(p.yaw);
      let hz = -Math.cos(p.yaw);
      if (d > 1e-3) { hx = dx / d; hz = dz / d; }
      tx = p.x + hx * cfg.minRange;
      tz = p.z + hz * cfg.minRange;
    }
    const x = clampToMap(tx);
    const z = clampToMap(tz);
    const groundY = getTerrainHeight(x, z);
    const missile = {
      id: `missile_${this.seq++}`,
      ownerId: p.id,
      x, z,
      y: groundY + cfg.height,
      targetY: groundY
    };
    this.missiles.push(missile);
    return { ...missile, etaMs: Math.round((cfg.height / cfg.fallSpeed) * 1000) };
  }

  // ---- simulation ----------------------------------------------------------
  update(dt, now) {
    this.updateGrenades(dt, now);
    this.updateRockets(dt, now);
    this.updateMissiles(dt);
  }

  updateGrenades(dt, now) {
    const cfg = this.room.rules.grenade;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      if (now >= g.detonateAt) {
        this.grenades.splice(i, 1);
        this.detonateGrenade(g);
        continue;
      }

      g.vy -= cfg.gravity * dt;
      const nx = g.x + g.vx * dt;
      const ny = g.y + g.vy * dt;
      const nz = g.z + g.vz * dt;
      const sx = nx - g.x;
      const sy = ny - g.y;
      const sz = nz - g.z;
      const len = Math.hypot(sx, sy, sz);
      if (len < 1e-6) continue;

      const hit = raycastWorld(g.x, g.y, g.z, sx / len, sy / len, sz / len, len + 0.12);
      if (!hit) {
        g.x = nx; g.y = ny; g.z = nz;
        continue;
      }

      // Bounce: keep the grenade just off the surface, reflect the velocity, add friction.
      g.x = hit.x + hit.nx * 0.12;
      g.y = hit.y + hit.ny * 0.12;
      g.z = hit.z + hit.nz * 0.12;
      const vn = g.vx * hit.nx + g.vy * hit.ny + g.vz * hit.nz;
      if (vn < 0) {
        const bounce = 1 + cfg.restitution;
        let vx = g.vx - bounce * vn * hit.nx;
        let vy = g.vy - bounce * vn * hit.ny;
        let vz = g.vz - bounce * vn * hit.nz;
        const vn2 = vx * hit.nx + vy * hit.ny + vz * hit.nz; // normal part after the bounce
        const tx = (vx - vn2 * hit.nx) * cfg.friction;
        const ty = (vy - vn2 * hit.ny) * cfg.friction;
        const tz = (vz - vn2 * hit.nz) * cfg.friction;
        vx = tx + vn2 * hit.nx;
        vy = ty + vn2 * hit.ny;
        vz = tz + vn2 * hit.nz;
        g.vx = vx; g.vy = vy; g.vz = vz;
      }
    }
  }

  detonateGrenade(g) {
    const room = this.room;
    if (g.type === 'frag') {
      const cfg = room.rules.grenade.frag;
      room.explode({
        x: g.x, y: g.y, z: g.z, radius: cfg.radius, damage: cfg.damage,
        ownerId: g.ownerId, weapon: 'HE-36M1 Frag', kind: 'frag'
      });
    } else {
      room.broadcast('smoke_deployed', { x: r2(g.x), y: r2(g.y), z: r2(g.z), ms: room.rules.grenade.smokeMs });
    }
  }

  updateRockets(dt, now) {
    const room = this.room;
    const cfg = room.rules.rocket;
    const teamMode = room.mode === 'TDM';

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const weapon = ARSENAL[r.weaponId] || ARSENAL.carlGustaf;
      const step = cfg.speed * dt;
      const owner = room.players.get(r.ownerId);

      // First thing in the way this tick: a wall / the ground, or a person.
      const world = raycastWorld(r.x, r.y, r.z, r.dx, r.dy, r.dz, step);
      let bestDist = world ? world.dist : Infinity;
      let surface = world;

      for (const t of room.players.values()) {
        if (!t.alive || !t.connected) continue;
        if (t.id === r.ownerId && now < r.armedAt) continue;
        if (teamMode && owner && t.team === owner.team && t.id !== r.ownerId) continue;
        for (const s of hitSpheres(t)) {
          const d = raySphere(r.x, r.y, r.z, r.dx, r.dy, r.dz, s.x, s.y, s.z, s.r + cfg.hitPadding);
          if (d !== null && d <= step && d < bestDist) { bestDist = d; surface = null; }
        }
      }

      let boom = null;
      if (bestDist !== Infinity) {
        boom = surface
          ? { x: surface.x + surface.nx * 0.2, y: surface.y + surface.ny * 0.2, z: surface.z + surface.nz * 0.2 }
          : { x: r.x + r.dx * bestDist, y: r.y + r.dy * bestDist, z: r.z + r.dz * bestDist };
      } else {
        r.x += r.dx * step; r.y += r.dy * step; r.z += r.dz * step;
        r.travelled += step;
        if (r.travelled >= weapon.range) boom = { x: r.x, y: r.y, z: r.z };
      }

      if (boom) {
        this.rockets.splice(i, 1);
        room.explode({
          x: boom.x, y: boom.y, z: boom.z,
          radius: weapon.blastRadius, damage: weapon.damage,
          ownerId: r.ownerId, weapon: weapon.name, kind: 'rocket'
        });
      }
    }
  }

  updateMissiles(dt) {
    const cfg = this.room.rules.missile;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.y -= cfg.fallSpeed * dt;
      if (m.y <= m.targetY) {
        this.missiles.splice(i, 1);
        this.room.explode({
          x: m.x, y: m.targetY, z: m.z, radius: cfg.radius, damage: cfg.damage,
          ownerId: m.ownerId, weapon: 'Tactical Missile Strike', kind: 'missile'
        });
      }
    }
  }

  // ---- snapshot data --------------------------------------------------------
  serialize() {
    return {
      grenades: this.grenades.map((g) => ({
        id: g.id, type: g.type, x: r2(g.x), y: r2(g.y), z: r2(g.z), vx: r2(g.vx), vy: r2(g.vy), vz: r2(g.vz)
      })),
      rockets: this.rockets.map((r) => ({ id: r.id, x: r2(r.x), y: r2(r.y), z: r2(r.z), dx: r2(r.dx), dy: r2(r.dy), dz: r2(r.dz) })),
      missiles: this.missiles.map((m) => ({ id: m.id, x: r2(m.x), y: r2(m.y), z: r2(m.z) }))
    };
  }
}
