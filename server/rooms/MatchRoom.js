const { getTerrainHeight, MAP_HALF_SIZE } = require('../systems/terrainHeight');
const { WEAPON_STATS, traceShot, applyDamage } = require('../systems/ballistics');
const { AirdropManager } = require('../systems/airdrop');
const { DroneManager } = require('../systems/drones');


const HEAL_ITEMS = {
  bandage: { heal: 15, cap: 75, boost: 0, castMs: 2000 },
  firstAid: { heal: 60, cap: 75, boost: 0, castMs: 3500 },
  medkit: { heal: 100, cap: 100, boost: 0, castMs: 4500 },
  energyDrink: { heal: 0, cap: 100, boost: 40, castMs: 2200 }
};

class MatchRoom {
  constructor(roomId, mode = 'TDM', io, onMatchEnd) {
    this.roomId = roomId;
    this.mode = mode; // 'TDM' or 'FFA'
    this.io = io;
    this.onMatchEnd = onMatchEnd;
    this.players = new Map();
    this.airdrops = new AirdropManager();
    this.drones = new DroneManager();
    this.grenades = [];
    this.missiles = [];
    this.scores = { bharat: 0, opfor: 0 };
    this.scoreLimit = 25;
    this.matchEndAt = Date.now() + 8 * 60 * 1000;
    this.ended = false;
    this.seq = 1;

    this.tickInterval = setInterval(() => this.tick(), 33); // 30Hz authoritative tick
  }

  addPlayer(socket, { callsign, loadout, team }) {
    let assignedTeam = team;
    if (!assignedTeam) {
      const bharatCount = Array.from(this.players.values()).filter((p) => p.team === 'bharat').length;
      const opforCount = Array.from(this.players.values()).filter((p) => p.team === 'opfor').length;
      assignedTeam = bharatCount <= opforCount ? 'bharat' : 'opfor';
    }

    const spawn = this.getSpawnPoint(assignedTeam);
    const player = {
      id: socket.id,
      callsign: callsign || `Soldier_${socket.id.slice(0, 4)}`,
      team: assignedTeam,
      mode: this.mode,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: assignedTeam === 'bharat' ? 0 : Math.PI,
      pitch: 0,
      stance: 'stand', // stand | crouch | prone
      lean: 0,         // -1 | 0 | 1
      sprinting: false,
      hp: 100,
      armor: 50,
      boost: 0,
      alive: true,
      respawnAt: 0,
      kills: 0,
      deaths: 0,
      streak: 0,
      activeSlot: 'primary',
      loadout: {
        primary: (loadout && loadout.primary) || 'sig716',
        secondary: (loadout && loadout.secondary) || 'pistol9mm',
        launcher: (loadout && loadout.launcher) || 'carlGustaf'
      },
      ammo: {
        primary: (WEAPON_STATS[(loadout && loadout.primary) || 'sig716'] || WEAPON_STATS.sig716).magSize,
        secondary: WEAPON_STATS.pistol9mm.magSize,
        launcher: 1
      },
      inventory: {
        frag: 2,
        smoke: 2,
        bandage: 4,
        firstAid: 2,
        medkit: 1,
        energyDrink: 2,
        missileReady: true,
        fpvDroneReady: true,
        reconDroneReady: true
      },
      lastShotAt: 0,
      activeDroneId: null,
      healingUntil: 0
    };

    this.players.set(socket.id, player);
    socket.join(this.roomId);
    return player;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    if (this.players.size === 0) {
      clearInterval(this.tickInterval);
    }
  }

  getSpawnPoint(team) {
    const baseZ = team === 'bharat' ? -92 : 92;
    const x = (Math.random() - 0.5) * 36;
    const z = baseZ + (Math.random() - 0.5) * 14;
    return { x, y: getTerrainHeight(x, z), z };
  }

  handleMove(socketId, state) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;

    const clampedX = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, state.x));
    const clampedZ = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, state.z));
    p.x = clampedX;
    p.z = clampedZ;
    p.y = typeof state.y === 'number' ? state.y : getTerrainHeight(clampedX, clampedZ);
    p.yaw = state.yaw || 0;
    p.pitch = state.pitch || 0;
    p.stance = state.stance || 'stand';
    p.lean = state.lean || 0;
    p.sprinting = !!state.sprinting;
  }

  handleSwitchWeapon(socketId, slot) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    if (['primary', 'secondary', 'launcher'].includes(slot)) {
      p.activeSlot = slot;
    }
  }

  handleReload(socketId) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    const weaponId = p.loadout[p.activeSlot];
    const stats = WEAPON_STATS[weaponId] || WEAPON_STATS.sig716;
    p.ammo[p.activeSlot] = stats.magSize;
    this.io.to(socketId).emit('reloaded', { slot: p.activeSlot, ammo: p.ammo[p.activeSlot] });
  }

  handleShoot(socketId, { origin, dir }) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    const now = Date.now();
    const weaponId = p.loadout[p.activeSlot] || 'sig716';
    const stats = WEAPON_STATS[weaponId] || WEAPON_STATS.sig716;

    if (now - p.lastShotAt < stats.fireRateMs * 0.8) return;
    if (p.ammo[p.activeSlot] <= 0) return;

    p.lastShotAt = now;
    p.ammo[p.activeSlot] -= 1;

    // Carl Gustaf explosive rocket
    if (weaponId === 'carlGustaf') {
      const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      const ndir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
      const impact = {
        x: origin.x + ndir.x * 45,
        y: getTerrainHeight(origin.x + ndir.x * 45, origin.z + ndir.z * 45),
        z: origin.z + ndir.z * 45
      };
      this.explodeAt(impact.x, impact.y, impact.z, stats.blastRadius, stats.damage, p, stats.name);
      this.io.to(this.roomId).emit('explosion', { ...impact, radius: stats.blastRadius, kind: 'rocket' });
      return;
    }

    const { closestHit } = traceShot(p, origin, dir, weaponId, this.players);
    this.io.to(this.roomId).emit('shot_fired', {
      shooterId: p.id,
      weaponId,
      origin,
      dir
    });

    if (closestHit) {
      const dmg = Math.round(stats.damage * (closestHit.headshot ? stats.headshotMult : 1));
      const dealt = applyDamage(closestHit.target, dmg);
      this.io.to(p.id).emit('hit_confirm', {
        targetId: closestHit.target.id,
        damage: dealt,
        headshot: closestHit.headshot
      });

      if (closestHit.target.hp <= 0) {
        this.registerKill(p, closestHit.target, stats.name, closestHit.headshot);
      }
    }
  }

  handleThrowGrenade(socketId, { type, origin, dir }) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    if (!p.inventory[type] || p.inventory[type] <= 0) return;

    p.inventory[type] -= 1;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const speed = 22;
    const grenade = {
      id: `nade_${this.seq++}`,
      ownerId: p.id,
      type, // 'frag' or 'smoke'
      x: origin.x,
      y: origin.y,
      z: origin.z,
      vx: (dir.x / len) * speed,
      vy: (dir.y / len) * speed + 5.5,
      vz: (dir.z / len) * speed,
      detonateAt: Date.now() + 2400
    };
    this.grenades.push(grenade);
    this.io.to(this.roomId).emit('grenade_thrown', grenade);
  }

  handleCallMissile(socketId, { targetX, targetZ }) {
    const p = this.players.get(socketId);
    if (!p || !p.alive || !p.inventory.missileReady) return;
    p.inventory.missileReady = false;
    setTimeout(() => {
      if (this.players.has(p.id)) p.inventory.missileReady = true;
    }, 45000);

    const groundY = getTerrainHeight(targetX, targetZ);
    const missile = {
      id: `missile_${this.seq++}`,
      ownerId: p.id,
      x: targetX,
      y: groundY + 95,
      z: targetZ,
      targetY: groundY
    };
    this.missiles.push(missile);
    this.io.to(this.roomId).emit('missile_incoming', {
      id: missile.id,
      x: targetX,
      z: targetZ,
      caller: p.callsign
    });
  }

  handleDeployDrone(socketId, mode) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    const flag = mode === 'fpv' ? 'fpvDroneReady' : 'reconDroneReady';
    if (!p.inventory[flag]) return;
    p.inventory[flag] = false;
    setTimeout(() => {
      if (this.players.has(p.id)) p.inventory[flag] = true;
    }, 35000);

    const drone = this.drones.spawnDrone(p, mode);
    p.activeDroneId = drone.id;
    this.io.to(this.roomId).emit('drone_deployed', drone);
  }

  handleControlDrone(socketId, input) {
    const p = this.players.get(socketId);
    if (!p || !p.activeDroneId) return;
    if (input.detonate) {
      const res = this.drones.detonateDrone(p.activeDroneId, this.players, (k, v, w) => this.registerKill(k, v, w));
      p.activeDroneId = null;
      if (res) this.io.to(this.roomId).emit('explosion', { ...res, radius: 9.0, kind: 'drone' });
      return;
    }
    this.drones.controlDrone(p.activeDroneId, p.id, input);
  }

  handleHeal(socketId, itemKey) {
    const p = this.players.get(socketId);
    const item = HEAL_ITEMS[itemKey];
    if (!p || !p.alive || !item || !p.inventory[itemKey]) return;
    p.inventory[itemKey] -= 1;

    if (item.heal > 0 && p.hp < item.cap) {
      p.hp = Math.min(item.cap, p.hp + item.heal);
    }
    if (item.boost > 0) {
      p.boost = Math.min(100, p.boost + item.boost);
    }
    this.io.to(socketId).emit('heal_applied', { itemKey, hp: p.hp, boost: p.boost, inventory: p.inventory });
  }

  handleLootAirdrop(socketId, crateId) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    const crate = this.airdrops.tryLoot(p, crateId);
    if (crate) {
      this.io.to(this.roomId).emit('airdrop_looted', {
        crateId: crate.id,
        callsign: p.callsign,
        label: crate.label
      });
    }
  }

  explodeAt(x, y, z, radius, maxDamage, owner, weaponName) {
    for (const target of this.players.values()) {
      if (!target.alive) continue;
      if (owner && this.mode === 'TDM' && target.team === owner.team && target.id !== owner.id) continue;
      const dist = Math.hypot(target.x - x, target.y + 1 - y, target.z - z);
      if (dist <= radius) {
        const dmg = Math.round(maxDamage * (1 - dist / (radius + 1.5)));
        applyDamage(target, dmg, true);
        if (target.hp <= 0 && owner) {
          this.registerKill(owner, target, weaponName, false);
        }
      }
    }
  }

  registerKill(killer, victim, weaponName, headshot = false) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.deaths += 1;
    victim.streak = 0;
    victim.respawnAt = Date.now() + 4500;
    victim.activeDroneId = null;

    if (killer.id !== victim.id) {
      killer.kills += 1;
      killer.streak += 1;
      if (this.mode === 'TDM') {
        this.scores[killer.team] += 1;
      }
    }

    this.io.to(this.roomId).emit('kill_feed', {
      killer: killer.callsign,
      killerTeam: killer.team,
      victim: victim.callsign,
      victimTeam: victim.team,
      weapon: weaponName,
      headshot
    });

    if (this.mode === 'TDM' && (this.scores.bharat >= this.scoreLimit || this.scores.opfor >= this.scoreLimit)) {
      this.finishMatch();
    }
  }

  tick() {
    if (this.ended) return;
    const now = Date.now();

    // 1. Respawns & BGMI-style Energy Boost Passive Heal
    for (const p of this.players.values()) {
      if (!p.alive && now >= p.respawnAt) {
        const spawn = this.getSpawnPoint(p.team);
        p.x = spawn.x;
        p.y = spawn.y;
        p.z = spawn.z;
        p.hp = 100;
        p.armor = 50;
        p.alive = true;
        this.io.to(p.id).emit('respawned', { x: p.x, y: p.y, z: p.z });
      } else if (p.alive && p.boost > 0) {
        if (Math.random() < 0.08 && p.hp < 100) p.hp = Math.min(100, p.hp + 1);
        p.boost = Math.max(0, p.boost - 0.08);
      }
    }

    // 2. Grenades Physics
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.vy -= 14 * 0.033;
      g.x += g.vx * 0.033;
      g.y += g.vy * 0.033;
      g.z += g.vz * 0.033;
      const ground = getTerrainHeight(g.x, g.z);
      if (g.y < ground + 0.15) {
        g.y = ground + 0.15;
        g.vy = Math.abs(g.vy) * 0.35;
        g.vx *= 0.6;
        g.vz *= 0.6;
      }
      if (now >= g.detonateAt) {
        const owner = this.players.get(g.ownerId);
        if (g.type === 'frag') {
          this.explodeAt(g.x, g.y, g.z, 8.5, 110, owner, 'HE-36M1 Frag');
          this.io.to(this.roomId).emit('explosion', { x: g.x, y: g.y, z: g.z, radius: 8.5, kind: 'frag' });
        } else {
          this.io.to(this.roomId).emit('smoke_deployed', { x: g.x, y: g.y, z: g.z });
        }
        this.grenades.splice(i, 1);
      }
    }

    // 3. Tactical Missiles
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.y -= 1.8;
      if (m.y <= m.targetY) {
        const owner = this.players.get(m.ownerId);
        this.explodeAt(m.x, m.targetY, m.z, 15.0, 145, owner, 'Tactical Missile Strike');
        this.io.to(this.roomId).emit('explosion', { x: m.x, y: m.targetY, z: m.z, radius: 15.0, kind: 'missile' });
        this.missiles.splice(i, 1);
      }
    }

    // 4. Air Drops & Drones
    const airdropEvents = this.airdrops.update(now);
    for (const ev of airdropEvents) {
      this.io.to(this.roomId).emit(ev.type, ev.crate);
    }
    const expiredDrones = this.drones.update(now);
    for (const dId of expiredDrones) {
      for (const p of this.players.values()) {
        if (p.activeDroneId === dId) p.activeDroneId = null;
      }
    }

    // 5. Match timer check
    if (now >= this.matchEndAt) {
      this.finishMatch();
      return;
    }

    // 6. Broadcast 30Hz authoritative snapshot
    this.io.to(this.roomId).emit('state_snapshot', {
      t: now,
      timeLeftSec: Math.max(0, Math.round((this.matchEndAt - now) / 1000)),
      scores: this.scores,
      players: Array.from(this.players.values()),
      airdrops: this.airdrops.crates,
      drones: this.drones.serialize(),
      grenades: this.grenades,
      missiles: this.missiles
    });
  }

  finishMatch() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.tickInterval);
    const winnerTeam = this.scores.bharat >= this.scores.opfor ? 'bharat' : 'opfor';
    const summary = {
      winnerTeam,
      scores: this.scores,
      mode: this.mode,
      players: Array.from(this.players.values()).map((p) => ({
        callsign: p.callsign,
        team: p.team,
        kills: p.kills,
        deaths: p.deaths
      }))
    };
    this.io.to(this.roomId).emit('match_ended', summary);
    if (this.onMatchEnd) this.onMatchEnd(summary);
  }
}

module.exports = { MatchRoom };
