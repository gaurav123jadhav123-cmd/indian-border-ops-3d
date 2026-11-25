const { getTerrainHeight, MAP_HALF_SIZE, raycastWorldOcclusion } = require('../systems/terrainHeight');
const { WEAPON_STATS, traceShot, computeDistanceDamage, applyDamage } = require('../systems/ballistics');
const { validateAndClampMove, validateShotPayload } = require('../systems/antiCheat');
const { AirdropManager } = require('../systems/airdrop');
const { DroneManager } = require('../systems/drones');
const { BotManager } = require('../systems/bots');

const TARGET_ROOM_PLAYERS = 10; // 5v5 PVP Match

const HEAL_ITEMS = {
  bandage: { heal: 15, cap: 75, boost: 0, castMs: 2000 },
  firstAid: { heal: 60, cap: 75, boost: 0, castMs: 3500 },
  medkit: { heal: 100, cap: 100, boost: 0, castMs: 4500 },
  energyDrink: { heal: 0, cap: 100, boost: 40, castMs: 2200 }
};

const WEATHER_STATES = ['clear', 'snowfall', 'blizzard_fog'];

class MatchRoom {
  constructor(roomId, mode = 'TDM', io, onMatchEnd) {
    this.roomId = roomId;
    this.mode = mode;
    this.io = io;
    this.onMatchEnd = onMatchEnd;
    this.players = new Map();
    this.airdrops = new AirdropManager();
    this.drones = new DroneManager();
    this.bots = new BotManager(this);
    this.grenades = [];
    this.rockets = [];
    this.missiles = [];
    this.scores = { bharat: 0, opfor: 0 };
    this.scoreLimit = 40;
    this.matchEndAt = Date.now() + 8 * 60 * 1000;
    this.ended = false;
    this.weather = 'snowfall';
    this.nextWeatherAt = Date.now() + 90000;
    this.seq = 1;
    this.avgTickMs = 0;

    this.tickInterval = setInterval(() => this.tick(), 50); // 20Hz authoritative tick
  }

  addPlayer(socket, { callsign, loadout, team }) {
    let assignedTeam = team;
    if (!assignedTeam) {
      const humans = Array.from(this.players.values()).filter((p) => !p.isBot);
      const bharatHumans = humans.filter((p) => p.team === 'bharat').length;
      const opforHumans = humans.filter((p) => p.team === 'opfor').length;
      assignedTeam = bharatHumans <= opforHumans ? 'bharat' : 'opfor';
    }

    const spawn = this.getSpawnPoint(assignedTeam, false);
    const primary = (loadout && WEAPON_STATS[loadout.primary]) ? loadout.primary : 'sig716';
    const secondary = (loadout && WEAPON_STATS[loadout.secondary]) ? loadout.secondary : 'pistol9mm';
    const launcher = (loadout && WEAPON_STATS[loadout.launcher]) ? loadout.launcher : 'carlGustaf';

    const player = {
      id: socket.id,
      isBot: false,
      callsign: String(callsign || `Soldier_${socket.id.slice(0, 4)}`).slice(0, 20),
      team: assignedTeam,
      mode: this.mode,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: assignedTeam === 'bharat' ? 0 : Math.PI,
      pitch: 0,
      stance: 'stand',
      lean: 0,
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
      loadout: { primary, secondary, launcher },
      ammo: {
        primary: WEAPON_STATS[primary].magSize,
        secondary: WEAPON_STATS[secondary].magSize,
        launcher: WEAPON_STATS[launcher].magSize
      },
      reloadingUntil: 0,
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
      lastMoveAt: Date.now(),
      activeDroneId: null
    };

    this.players.set(socket.id, player);
    socket.join(this.roomId);
    this.bots.syncBotCount(TARGET_ROOM_PLAYERS);
    return player;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    const remainingHumans = Array.from(this.players.values()).filter((p) => !p.isBot).length;
    if (remainingHumans === 0) {
      this.players.clear();
      clearInterval(this.tickInterval);
    } else {
      this.bots.syncBotCount(TARGET_ROOM_PLAYERS);
    }
  }

  getSpawnPoint(team, isBot = false) {
    const baseZ = isBot ? (team === 'bharat' ? -45 : 45) : (team === 'bharat' ? -64 : 64);
    const x = (Math.random() - 0.5) * 44;
    const z = baseZ + (Math.random() - 0.5) * 16;
    return { x, y: getTerrainHeight(x, z), z };
  }

  handleMove(socketId, state) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    const now = Date.now();
    const dt = (now - p.lastMoveAt) / 1000;
    const clamped = validateAndClampMove(p, state, dt);
    if (!clamped) return;

    p.x = clamped.x;
    p.y = clamped.y;
    p.z = clamped.z;
    p.yaw = clamped.yaw;
    p.pitch = clamped.pitch;
    p.stance = clamped.stance;
    p.lean = clamped.lean;
    p.sprinting = clamped.sprinting;
    p.lastMoveAt = now;
  }

  handleSwitchWeapon(socketId, slot) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    if (['primary', 'secondary', 'launcher'].includes(slot)) {
      p.activeSlot = slot;
      p.reloadingUntil = 0;
    }
  }

  startReload(p) {
    const now = Date.now();
    if (p.reloadingUntil > now) return;
    const slot = p.activeSlot;
    const weaponId = p.loadout[slot];
    const stats = WEAPON_STATS[weaponId] || WEAPON_STATS.sig716;
    const reloadMs = stats.reloadMs || 1800;
    p.reloadingUntil = now + reloadMs;
    if (!p.isBot) {
      this.io.to(p.id).emit('reloading', { slot, reloadMs });
    }
    setTimeout(() => {
      if (!this.players.has(p.id)) return;
      p.ammo[slot] = stats.magSize;
      p.reloadingUntil = 0;
      if (!p.isBot) {
        this.io.to(p.id).emit('reloaded', { slot, ammo: p.ammo[slot] });
      }
    }, reloadMs);
  }

  handleReload(socketId) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    this.startReload(p);
  }

  handleShoot(socketId, data) {
    const p = this.players.get(socketId);
    if (!p || !p.alive || !validateShotPayload(data)) return;
    const now = Date.now();
    if (p.reloadingUntil > now) return;

    const { origin, dir } = data;
    const weaponId = p.loadout[p.activeSlot] || 'sig716';
    const stats = WEAPON_STATS[weaponId] || WEAPON_STATS.sig716;

    if (now - p.lastShotAt < stats.fireRateMs * 0.75) return;
    if (p.ammo[p.activeSlot] <= 0) {
      this.startReload(p);
      return;
    }

    p.lastShotAt = now;
    p.ammo[p.activeSlot] -= 1;
    if (p.ammo[p.activeSlot] <= 0) {
      this.startReload(p);
    }

    if (weaponId === 'carlGustaf') {
      const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      const ndir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
      const speed = 52;
      const rocket = {
        id: `rocket_${this.seq++}`,
        ownerId: p.id,
        x: origin.x + ndir.x * 1.1,
        y: origin.y + ndir.y * 1.1,
        z: origin.z + ndir.z * 1.1,
        vx: ndir.x * speed,
        vy: ndir.y * speed,
        vz: ndir.z * speed,
        ttl: Date.now() + 5000
      };
      this.rockets.push(rocket);
      this.io.to(this.roomId).emit('rocket_launched', rocket);
      return;
    }

    const { closestHit } = traceShot(p, origin, dir, weaponId, this.players);
    this.io.to(this.roomId).emit('shot_fired', { shooterId: p.id, weaponId, origin, dir });

    if (closestHit) {
      const dmg = computeDistanceDamage(stats, closestHit.dist, closestHit.headshot);
      const dealt = applyDamage(closestHit.target, dmg);
      if (!p.isBot) {
        this.io.to(p.id).emit('hit_confirm', {
          targetId: closestHit.target.id,
          damage: dealt,
          headshot: closestHit.headshot,
          targetPos: { x: closestHit.target.x, y: closestHit.target.y + 1.7, z: closestHit.target.z }
        });
      }
      if (!closestHit.target.isBot) {
        this.io.to(closestHit.target.id).emit('took_damage', { amount: dealt });
      }
      if (closestHit.target.hp <= 0) {
        this.registerKill(p, closestHit.target, stats.name, closestHit.headshot);
      }
    }
  }

  handleThrowGrenade(socketId, { type, origin, dir }) {
    const p = this.players.get(socketId);
    if (!p || !p.alive || !p.inventory[type]) return;
    if (!validateShotPayload({ origin, dir })) return;

    p.inventory[type] -= 1;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const speed = 23;
    const grenade = {
      id: `nade_${this.seq++}`,
      ownerId: p.id,
      type,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      vx: (dir.x / len) * speed,
      vy: (dir.y / len) * speed + 6.0,
      vz: (dir.z / len) * speed,
      detonateAt: Date.now() + 2400
    };
    this.grenades.push(grenade);
    this.io.to(this.roomId).emit('grenade_thrown', grenade);
  }

  handleCallMissile(socketId, { targetX, targetZ }) {
    const p = this.players.get(socketId);
    if (!p || !p.alive || !p.inventory.missileReady) return;
    const tx = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, Number(targetX) || 0));
    const tz = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, Number(targetZ) || 0));

    p.inventory.missileReady = false;
    setTimeout(() => {
      if (this.players.has(p.id)) p.inventory.missileReady = true;
    }, 45000);

    const groundY = getTerrainHeight(tx, tz);
    const missile = { id: `missile_${this.seq++}`, ownerId: p.id, x: tx, y: groundY + 95, z: tz, targetY: groundY };
    this.missiles.push(missile);
    this.io.to(this.roomId).emit('missile_incoming', { id: missile.id, x: tx, z: tz, caller: p.callsign });
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
    if (!p || !p.activeDroneId || !input) return;
    if (input.exit) {
      p.activeDroneId = null;
      return;
    }
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

    if (item.heal > 0 && p.hp < item.cap) p.hp = Math.min(item.cap, p.hp + item.heal);
    if (item.boost > 0) p.boost = Math.min(100, p.boost + item.boost);
    this.io.to(socketId).emit('heal_applied', { itemKey, hp: p.hp, boost: p.boost, inventory: p.inventory });
  }

  handleLootAirdrop(socketId, crateId) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    const crate = this.airdrops.tryLoot(p, crateId);
    if (crate) {
      this.io.to(this.roomId).emit('airdrop_looted', { crateId: crate.id, callsign: p.callsign, label: crate.label });
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
        if (!target.isBot) this.io.to(target.id).emit('took_damage', { amount: dmg });
        if (owner && !owner.isBot) {
          this.io.to(owner.id).emit('hit_confirm', {
            targetId: target.id,
            damage: dmg,
            headshot: false,
            targetPos: { x: target.x, y: target.y + 1.7, z: target.z }
          });
        }
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
    victim.respawnAt = Date.now() + 5000;
    victim.activeDroneId = null;

    if (!victim.isBot) {
      this.io.to(victim.id).emit('player_killed', { respawnSec: 5, killer: killer.callsign });
    }

    if (killer.id !== victim.id) {
      killer.kills += 1;
      killer.streak += 1;
      if (this.mode === 'TDM') this.scores[killer.team] += 1;

      // COD-style Killstreak Rewards
      if (!killer.isBot) {
        if (killer.streak === 3) {
          this.io.to(killer.id).emit('killstreak_unlocked', { streak: 3, reward: 'UAV Radar Sweep' });
        } else if (killer.streak === 5) {
          killer.inventory.fpvDroneReady = true;
          this.io.to(killer.id).emit('killstreak_unlocked', { streak: 5, reward: 'FPV Attack Drone Recharged' });
        } else if (killer.streak === 7) {
          killer.inventory.missileReady = true;
          this.io.to(killer.id).emit('killstreak_unlocked', { streak: 7, reward: 'Tactical Missile Strike Ready' });
        }
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
    const tStart = Date.now();
    const now = tStart;

    if (now >= this.nextWeatherAt) {
      this.weather = WEATHER_STATES[Math.floor(Math.random() * WEATHER_STATES.length)];
      this.nextWeatherAt = now + 90000;
    }

    for (const p of this.players.values()) {
      if (!p.alive && now >= p.respawnAt) {
        const spawn = this.getSpawnPoint(p.team, p.isBot);
        p.x = spawn.x;
        p.y = spawn.y;
        p.z = spawn.z;
        p.hp = 100;
        p.armor = 50;
        p.alive = true;
        if (!p.isBot) this.io.to(p.id).emit('respawned', { x: p.x, y: p.y, z: p.z });
      } else if (p.alive && p.boost > 0) {
        if (Math.random() < 0.08 && p.hp < 100) p.hp = Math.min(100, p.hp + 1);
        p.boost = Math.max(0, p.boost - 0.08);
      }
    }

    this.bots.update(now);

    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.vy -= 14 * 0.05;
      g.x += g.vx * 0.05;
      g.y += g.vy * 0.05;
      g.z += g.vz * 0.05;
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

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const stepDist = Math.hypot(r.vx * 0.05, r.vy * 0.05, r.vz * 0.05) || 1;
      const rDir = { x: (r.vx * 0.05) / stepDist, y: (r.vy * 0.05) / stepDist, z: (r.vz * 0.05) / stepDist };
      const occ = raycastWorldOcclusion({ x: r.x, y: r.y, z: r.z }, rDir, stepDist);

      r.x += r.vx * 0.05;
      r.y += r.vy * 0.05;
      r.z += r.vz * 0.05;
      r.vy -= 1.2 * 0.05;

      let hit = occ !== null || r.y <= getTerrainHeight(r.x, r.z) + 0.2 || now >= r.ttl || Math.abs(r.x) > MAP_HALF_SIZE || Math.abs(r.z) > MAP_HALF_SIZE;
      if (!hit) {
        for (const t of this.players.values()) {
          if (t.id !== r.ownerId && t.alive && Math.hypot(t.x - r.x, t.y + 1 - r.y, t.z - r.z) < 1.6) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        const owner = this.players.get(r.ownerId);
        this.explodeAt(r.x, r.y, r.z, 9.5, 130, owner, 'Carl Gustaf M4');
        this.io.to(this.roomId).emit('explosion', { x: r.x, y: r.y, z: r.z, radius: 9.5, kind: 'rocket' });
        this.rockets.splice(i, 1);
      }
    }

    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.y -= 2.4;
      if (m.y <= m.targetY) {
        const owner = this.players.get(m.ownerId);
        this.explodeAt(m.x, m.targetY, m.z, 15.0, 145, owner, 'Tactical Missile Strike');
        this.io.to(this.roomId).emit('explosion', { x: m.x, y: m.targetY, z: m.z, radius: 15.0, kind: 'missile' });
        this.missiles.splice(i, 1);
      }
    }

    const airdropEvents = this.airdrops.update(now);
    for (const ev of airdropEvents) this.io.to(this.roomId).emit(ev.type, ev.crate);
    const expiredDrones = this.drones.update(now);
    for (const dId of expiredDrones) {
      for (const p of this.players.values()) {
        if (p.activeDroneId === dId) p.activeDroneId = null;
      }
    }

    if (now >= this.matchEndAt) {
      this.finishMatch();
      return;
    }

    this.io.to(this.roomId).emit('state_snapshot', {
      t: now,
      weather: this.weather,
      timeLeftSec: Math.max(0, Math.round((this.matchEndAt - now) / 1000)),
      scores: this.scores,
      players: Array.from(this.players.values()),
      airdrops: this.airdrops.crates,
      drones: this.drones.serialize(),
      grenades: this.grenades,
      rockets: this.rockets,
      missiles: this.missiles
    });

    const elapsed = Date.now() - tStart;
    this.avgTickMs = this.avgTickMs ? this.avgTickMs * 0.9 + elapsed * 0.1 : elapsed;
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
      players: Array.from(this.players.values())
        .filter((p) => !p.isBot)
        .map((p) => ({
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
