// One match: players, rules, scoring and the authoritative simulation.
//
// The room never touches a socket. Every player owns a `conn` ({ id, send(event, payload, opts),
// disconnect() }) and the room only calls conn.send(), so the whole game can be tested with
// fake connections and a fake clock. Time is always milliseconds from `clock()` (monotonic).
import crypto from 'node:crypto';
import {
  ARSENAL, HEALING_ITEMS, STARTING_INVENTORY, LOADOUT_SLOTS, sanitizeLoadout
} from '../shared/arsenal.js';
import {
  MAP_HALF_SIZE, PLAYER_RADIUS, MOVE, STANCE_SCALE, getTerrainHeight, resolveObstacles,
  raycastWorld, moveSpeed, clampToMap, getEyePosition
} from '../shared/world.js';
import { RULES } from '../rules.js';
import {
  traceShot, applyDamage, applySpread, effectiveSpread, weaponStats
} from '../systems/ballistics.js';
import { AirdropManager, publicCrate } from '../systems/airdrop.js';
import { DroneSystem } from '../systems/drones.js';
import { ProjectileSystem } from '../systems/projectiles.js';
import { cleanCallsign } from '../net/validate.js';

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const v3 = (v) => ({ x: r2(v.x), y: r2(v.y), z: r2(v.z) });
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class MatchRoom {
  /**
   * @param {object} o
   * @param {string} o.roomId
   * @param {'TDM'|'FFA'} [o.mode]
   * @param {object} [o.rules]     gameplay numbers (see rules.js)
   * @param {() => number} [o.rng] random source, 0 <= n < 1
   * @param {() => number} [o.clock] monotonic milliseconds
   * @param {number} [o.capacity]
   * @param {(report: object, publicSummary: object) => void} [o.onEnd]
   */
  constructor({
    roomId, mode = 'TDM', rules = RULES, rng = Math.random,
    clock = () => performance.now(), capacity, onEnd = null
  }) {
    this.roomId = roomId;
    this.mode = mode === 'FFA' ? 'FFA' : 'TDM';
    this.rules = rules;
    this.rng = rng;
    this.clock = clock;
    this.capacity = capacity ?? rules.roomCapacity;
    this.onEnd = onEnd;

    const now = clock();
    this.matchId = `${roomId}-${crypto.randomBytes(6).toString('hex')}`;
    this.startedAt = now;
    this.endsAt = now + rules.matchSeconds * 1000;
    this.createdAtIso = new Date().toISOString();

    this.players = new Map();
    this.playerSeq = 1;
    this.scores = { bharat: 0, opfor: 0 };
    this.ended = false;
    this.endReason = null;
    this.endInfo = null;
    this.finishRequested = null;
    this.snapshotAcc = 0;
    this.snapshotSeq = 0;

    this.airdrops = new AirdropManager({ rules, rng, now });
    this.drones = new DroneSystem(this);
    this.projectiles = new ProjectileSystem(this);
  }

  // ------------------------------------------------------------------ roster
  get teamMode() {
    return this.mode === 'TDM';
  }

  presentPlayers() {
    return Array.from(this.players.values()).filter((p) => p.status !== 'left');
  }

  presentCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.status !== 'left') n++;
    return n;
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  isEmpty() {
    return this.presentCount() === 0;
  }

  info() {
    return {
      roomId: this.roomId,
      mode: this.mode,
      players: this.presentCount(),
      capacity: this.capacity,
      ended: this.ended,
      timeLeftSec: Math.max(0, Math.ceil((this.endsAt - this.clock()) / 1000))
    };
  }

  pickTeam() {
    if (!this.teamMode) return 'ffa';
    let bharat = 0;
    let opfor = 0;
    for (const p of this.players.values()) {
      if (p.status === 'left') continue;
      if (p.team === 'bharat') bharat++;
      else if (p.team === 'opfor') opfor++;
    }
    return bharat <= opfor ? 'bharat' : 'opfor';
  }

  uniqueCallsign(wanted, identityId) {
    const base = cleanCallsign(wanted) || `Soldier_${this.playerSeq}`;
    const taken = new Set();
    for (const p of this.players.values()) {
      if (p.status !== 'left' && p.identityId !== identityId) taken.add(p.callsign.toLowerCase());
    }
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base.slice(0, 14)}_${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base.slice(0, 10)}_${crypto.randomBytes(3).toString('hex')}`;
  }

  findReturning(identityId, resumeKey) {
    for (const p of this.players.values()) {
      if (p.status === 'left') continue;
      if (p.identityId === identityId || (resumeKey && p.resumeKey === resumeKey)) return p;
    }
    return null;
  }

  /**
   * Add a player (or hand an existing player to a new connection).
   * identity = { id, name, userId, guest }.  Returns { ok, player, resumed } | { ok:false, error }.
   */
  join(conn, identity, { loadout, resumeKey = null } = {}, now = this.clock()) {
    if (this.ended) return { ok: false, error: 'This match has already ended.' };

    const returning = this.findReturning(identity.id, resumeKey);
    if (returning) {
      this.attach(returning, conn, identity, now);
      return { ok: true, player: returning, resumed: true };
    }
    if (this.presentCount() >= this.capacity) {
      return { ok: false, error: 'This match is full. Try another room.' };
    }

    const p = {
      id: `p${this.playerSeq}`,
      resumeKey: crypto.randomBytes(16).toString('hex'),
      identityId: identity.id,
      userId: identity.userId ?? null,
      isGuest: !!identity.guest,
      callsign: this.uniqueCallsign(identity.name, identity.id),
      team: this.pickTeam(),
      conn,
      connected: true,
      status: 'active', // active | grace (disconnected, may come back) | left
      disconnectedAt: 0,
      joinedAt: now,

      x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
      stance: 'stand', lean: 0, sprinting: false, ads: false,
      epoch: 0,
      moveBudget: 0,
      lastMoveAt: now,
      lastMovedAt: 0,
      lastCorrectionAt: -1e9,
      lastNoticeAt: -1e9,

      hp: 100, armor: 50, boost: 0,
      alive: true,
      respawnAt: 0,
      invulnUntil: 0,
      lastDamagedAt: 0,

      kills: 0, deaths: 0, headshots: 0, streak: 0,

      baseLoadout: sanitizeLoadout(loadout), // always a complete, legal loadout
      loadout: null,
      activeSlot: 'primary',
      ammo: null,
      inventory: null,
      nextFireAt: 0,
      equipUntil: 0,
      nextThrowAt: 0,
      reload: null,
      heal: null,
      cooldowns: { missile: 0, fpv: 0, recon: 0 },
      droneId: null
    };
    this.playerSeq += 1;
    this.players.set(p.id, p);

    this.equipBaseLoadout(p);
    this.placeAtSpawn(p, now);
    p.invulnUntil = now + this.rules.spawnProtectionMs;
    return { ok: true, player: p, resumed: false };
  }

  attach(p, conn, identity, now) {
    const old = p.conn;
    p.conn = conn;
    p.connected = true;
    p.status = 'active';
    p.disconnectedAt = 0;
    p.identityId = identity.id; // a guest who got a fresh token still owns this soldier via resumeKey
    p.userId = identity.userId ?? null;
    p.isGuest = !!identity.guest;
    p.epoch += 1;
    p.moveBudget = 0;
    p.lastMoveAt = now;
    if (old && old !== conn) {
      try {
        old.send('kicked', { reason: 'You joined this match from another tab or device.' });
        old.disconnect?.();
      } catch { /* the old socket is already gone */ }
    }
  }

  /** The connection dropped. The soldier is ghosted (unhittable, invisible) for a grace period. */
  detach(p, conn, now = this.clock()) {
    if (!p || p.conn !== conn) return false; // a replaced, older connection: nothing to do
    p.conn = null;
    p.connected = false;
    p.status = 'grace';
    p.disconnectedAt = now;
    p.reload = null;
    p.heal = null;
    p.sprinting = false;
    this.endPilotedDrone(p, 'owner_left');
    return true;
  }

  /** Deliberate leave: no grace period. */
  leave(p, conn, now = this.clock()) {
    if (!p || p.conn !== conn) return false;
    this.removePlayer(p, now);
    return true;
  }

  removePlayer(p, now = this.clock()) {
    if (p.status === 'left') return;
    p.status = 'left';
    p.connected = false;
    p.conn = null;
    p.leftAt = now;
    p.reload = null;
    p.heal = null;
    this.endPilotedDrone(p, 'owner_left');
  }

  // --------------------------------------------------------------- messaging
  sendTo(p, event, payload, volatile = false) {
    if (!p || !p.connected || !p.conn) return;
    try {
      p.conn.send(event, payload, volatile ? { volatile: true } : undefined);
    } catch { /* one broken socket must never stop the simulation */ }
  }

  broadcast(event, payload, { volatile = false, exceptId = null } = {}) {
    for (const p of this.players.values()) {
      if (!p.connected || p.id === exceptId) continue;
      this.sendTo(p, event, payload, volatile);
    }
  }

  notify(p, text, now = this.clock()) {
    if (now - p.lastNoticeAt < 400) return;
    p.lastNoticeAt = now;
    this.sendTo(p, 'notice', { text });
  }

  // ------------------------------------------------------- spawning & reset
  equipBaseLoadout(p) {
    p.loadout = {};
    p.ammo = {};
    for (const slot of LOADOUT_SLOTS) {
      p.loadout[slot] = p.baseLoadout[slot];
      const w = ARSENAL[p.loadout[slot]];
      p.ammo[slot] = { mag: w.magSize, reserve: w.reserveAmmo };
    }
    p.inventory = { ...STARTING_INVENTORY };
    p.activeSlot = 'primary';
    p.reload = null;
    p.heal = null;
    p.nextFireAt = 0;
  }

  randomSpawnCandidate(team) {
    const u = () => this.rng() - 0.5;
    let x;
    let z;
    if (team === 'bharat') { x = u() * 36; z = -92 + u() * 14; }
    else if (team === 'opfor') { x = u() * 36; z = 92 + u() * 14; }
    else { x = u() * 220; z = u() * 220; }
    const fixed = resolveObstacles(x, z, 1.0);
    // Yaw 0 looks toward -Z: Bharat (north, z<0) faces +Z => PI. Free-for-all soldiers face the centre.
    const yaw = team === 'bharat' ? Math.PI : team === 'opfor' ? 0 : Math.atan2(fixed.x, fixed.z);
    return { x: fixed.x, z: fixed.z, y: getTerrainHeight(fixed.x, fixed.z), yaw };
  }

  /** Best of 8 random spots: the one furthest from the nearest living enemy. */
  pickSpawn(p) {
    const enemies = [];
    for (const o of this.players.values()) {
      if (o === p || !o.alive || !o.connected) continue;
      if (this.teamMode && o.team === p.team) continue;
      enemies.push(o);
    }
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c = this.randomSpawnCandidate(p.team);
      let nearest = Infinity;
      for (const e of enemies) nearest = Math.min(nearest, Math.hypot(e.x - c.x, e.z - c.z));
      const score = enemies.length ? nearest : this.rng();
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  placeAtSpawn(p, now) {
    const s = this.pickSpawn(p);
    p.x = s.x; p.y = s.y; p.z = s.z;
    p.yaw = s.yaw; p.pitch = 0;
    p.stance = 'stand'; p.lean = 0; p.sprinting = false; p.ads = false;
    p.epoch += 1; // tells the client "forget your position, here is the real one"
    p.moveBudget = 0;
    p.lastMoveAt = now;
    return s;
  }

  respawn(p, now) {
    p.hp = 100;
    p.armor = 50;
    p.boost = 0;
    p.alive = true;
    this.equipBaseLoadout(p);
    const s = this.placeAtSpawn(p, now);
    p.invulnUntil = now + this.rules.spawnProtectionMs;
    p.equipUntil = now + this.rules.equipDelayMs;
    this.sendTo(p, 'respawned', {
      x: r2(s.x), y: r2(s.y), z: r2(s.z), yaw: r2(s.yaw), pitch: 0,
      epoch: p.epoch, protectedMs: this.rules.spawnProtectionMs
    });
  }

  // ----------------------------------------------------------- player input
  canAct(p) {
    return !!p && p.alive && p.connected && !this.ended;
  }

  handleMove(p, m, now = this.clock()) {
    if (!this.canAct(p) || p.droneId) return; // the body of a drone pilot stays put

    if (m.epoch !== p.epoch) {
      // The client has not applied the latest server teleport (respawn / correction) yet.
      this.resendCorrection(p, now);
      return;
    }

    const cfg = this.rules.move;
    const weapon = weaponStats(p.loadout[p.activeSlot]);
    const maxSpeed = moveSpeed({
      stance: m.stance, sprinting: m.sprinting, boost: p.boost, weaponMult: weapon.moveSpeedMult
    });
    const elapsed = clamp((now - p.lastMoveAt) / 1000, 0, 1);
    p.lastMoveAt = now;
    p.moveBudget = Math.min(maxSpeed * cfg.burstSeconds + cfg.slackMeters, p.moveBudget + maxSpeed * elapsed);

    const targetX = clampToMap(m.x);
    const targetZ = clampToMap(m.z);
    const dx = targetX - p.x;
    const dz = targetZ - p.z;
    const dist = Math.hypot(dx, dz);

    let nx = targetX;
    let nz = targetZ;
    if (dist > p.moveBudget) {
      // Faster than a human can run: accept only as far as the budget allows.
      const k = dist > 1e-9 ? p.moveBudget / dist : 0;
      nx = p.x + dx * k;
      nz = p.z + dz * k;
      p.moveBudget = 0;
    } else {
      p.moveBudget -= dist;
    }

    const fixed = resolveObstacles(nx, nz, PLAYER_RADIUS);
    nx = fixed.x;
    nz = fixed.z;
    const ground = getTerrainHeight(nx, nz);
    const ny = clamp(m.y, ground, ground + MOVE.maxRiseAboveGround);

    if (Math.hypot(nx - p.x, nz - p.z) > 0.03) p.lastMovedAt = now;
    p.x = nx; p.y = ny; p.z = nz;
    p.yaw = m.yaw; p.pitch = m.pitch;
    p.stance = m.stance; p.lean = m.lean;
    p.sprinting = m.sprinting; p.ads = m.ads;

    if (Math.hypot(targetX - nx, targetZ - nz) > cfg.correctionDistance) this.correct(p, now);
  }

  /** The client is too far from the truth: teleport it back and bump the epoch. */
  correct(p, now) {
    if (now - p.lastCorrectionAt < 250) return;
    p.lastCorrectionAt = now;
    p.epoch += 1;
    p.moveBudget = 0;
    this.sendTo(p, 'correction', { x: r2(p.x), y: r2(p.y), z: r2(p.z), epoch: p.epoch });
  }

  resendCorrection(p, now) {
    if (now - p.lastCorrectionAt < 500) return;
    p.lastCorrectionAt = now;
    this.sendTo(p, 'correction', { x: r2(p.x), y: r2(p.y), z: r2(p.z), epoch: p.epoch });
  }

  handleSwitch(p, slot, now = this.clock()) {
    if (!this.canAct(p) || p.droneId || slot === p.activeSlot) return;
    p.activeSlot = slot;
    p.equipUntil = now + this.rules.equipDelayMs;
    p.reload = null; // switching away abandons a reload in progress
  }

  startReload(p, now) {
    if (p.reload) return false;
    const slot = p.activeSlot;
    const w = ARSENAL[p.loadout[slot]];
    const a = p.ammo[slot];
    if (a.mag >= w.magSize || a.reserve <= 0) return false;
    p.reload = { slot, doneAt: now + w.reloadMs, totalMs: w.reloadMs };
    this.sendTo(p, 'reload_started', { slot, totalMs: w.reloadMs });
    return true;
  }

  finishReload(p) {
    const { slot } = p.reload;
    p.reload = null;
    const w = ARSENAL[p.loadout[slot]];
    const a = p.ammo[slot];
    const take = Math.min(w.magSize - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
    this.sendTo(p, 'reload_done', { slot, mag: a.mag, reserve: a.reserve });
  }

  handleReload(p, now = this.clock()) {
    if (!this.canAct(p) || p.droneId) return;
    this.startReload(p, now);
  }

  /** Spawn protection ends the moment you do something aggressive. */
  dropProtection(p, now) {
    if (p.invulnUntil > now) p.invulnUntil = now;
  }

  handleShoot(p, { dir }, now = this.clock()) {
    if (!this.canAct(p) || p.droneId) return;
    if (now < p.equipUntil || p.reload || now < p.nextFireAt) return;

    const weaponId = p.loadout[p.activeSlot];
    const w = weaponStats(weaponId);
    const ammo = p.ammo[p.activeSlot];
    if (ammo.mag <= 0) {
      if (!this.startReload(p, now)) this.notify(p, 'Out of ammo!', now);
      return;
    }

    ammo.mag -= 1;
    p.nextFireAt = now + w.fireRateMs * (1 - this.rules.fireTolerance);
    this.dropProtection(p, now);
    this.cancelHeal(p, 'fired');

    // The origin is computed here from the server's own idea of where the soldier is.
    const eye = getEyePosition(p);
    const moving = now - p.lastMovedAt < 250;
    const aim = applySpread(dir, effectiveSpread(w, p, moving), this.rng);

    if (w.category === 'launcher') {
      this.projectiles.fireRocket(p, aim, weaponId, now);
      this.broadcast('shot_fired', { shooterId: p.id, weaponId, kind: 'rocket', origin: v3(eye), dir: v3(aim) });
    } else {
      this.fireBullet(p, w, eye, aim, now);
    }

    if (ammo.mag === 0) this.startReload(p, now); // automatic reload on an empty magazine
  }

  fireBullet(p, w, eye, aim, now) {
    const { hit, world, end } = traceShot({
      shooter: p,
      origin: eye,
      dir: aim,
      range: w.range,
      players: this.players.values(),
      drones: this.drones.list(),
      teamMode: this.teamMode
    });

    this.broadcast('shot_fired', {
      shooterId: p.id,
      weaponId: w.id,
      kind: 'bullet',
      origin: v3(eye),
      end: v3(end),
      hit: hit ? hit.kind : world ? 'world' : 'none'
    }, { volatile: true });

    if (!hit) return;
    if (hit.kind === 'player') {
      const raw = Math.round(w.damage * (hit.headshot ? w.headshotMult : 1));
      this.dealDamage(p, hit.target, raw, { weapon: w.name, headshot: hit.headshot, src: eye, now });
    } else if (hit.kind === 'drone') {
      const raw = Math.round(w.damage);
      const destroyed = this.drones.damage(hit.target, raw);
      this.sendTo(p, 'hit_confirm', {
        targetId: hit.target.id, kind: 'drone', damage: raw, headshot: false, killed: destroyed
      });
      if (destroyed) this.destroyDrone(hit.target);
    }
  }

  handleThrow(p, { type, dir }, now = this.clock()) {
    if (!this.canAct(p) || p.droneId || now < p.nextThrowAt) return;
    if (!(p.inventory[type] > 0)) {
      this.notify(p, `No ${type === 'frag' ? 'frag' : 'smoke'} grenades left.`, now);
      return;
    }
    p.inventory[type] -= 1;
    p.nextThrowAt = now + this.rules.throwCooldownMs;
    this.dropProtection(p, now);
    this.cancelHeal(p, 'threw');
    this.projectiles.throwGrenade(p, type, dir, now);
    this.broadcast('grenade_thrown', { ownerId: p.id, type });
  }

  handleMissile(p, { dir }, now = this.clock()) {
    if (!this.canAct(p) || p.droneId) return;
    if (now < p.cooldowns.missile) {
      this.notify(p, `Missile strike ready in ${Math.ceil((p.cooldowns.missile - now) / 1000)}s.`, now);
      return;
    }
    p.cooldowns.missile = now + this.rules.missile.cooldownMs;
    this.dropProtection(p, now);
    this.cancelHeal(p, 'missile');
    const m = this.projectiles.callMissile(p, dir);
    this.broadcast('missile_incoming', {
      id: m.id, x: r2(m.x), y: r2(m.targetY), z: r2(m.z), etaMs: m.etaMs,
      radius: this.rules.missile.radius, caller: p.callsign, callerId: p.id
    });
  }

  // ------------------------------------------------------------------ drones
  handleDeploy(p, { mode }, now = this.clock()) {
    if (!this.canAct(p) || p.droneId) return;
    if (now < p.cooldowns[mode]) {
      this.notify(p, `${mode === 'fpv' ? 'FPV' : 'Recon'} drone ready in ${Math.ceil((p.cooldowns[mode] - now) / 1000)}s.`, now);
      return;
    }
    const cfg = this.rules.drone[mode];
    p.cooldowns[mode] = now + cfg.cooldownMs;
    this.cancelHeal(p, 'drone');
    const d = this.drones.spawn(p, mode, now);
    p.droneId = d.id;
    this.broadcast('drone_deployed', {
      id: d.id, ownerId: p.id, mode, ttlMs: cfg.ttlMs, x: r2(d.x), y: r2(d.y), z: r2(d.z), yaw: r2(d.yaw)
    });
  }

  handleDroneInput(p, input, now = this.clock()) {
    if (!this.canAct(p) || !p.droneId) return;
    const d = this.drones.get(p.droneId);
    if (!d) { p.droneId = null; return; }
    this.drones.setInput(d, input, now);
  }

  handleDroneAction(p, { action }) {
    if (!this.canAct(p) || !p.droneId) return;
    const d = this.drones.get(p.droneId);
    if (!d) { p.droneId = null; return; }
    if (action === 'detonate') {
      if (d.mode === 'fpv') this.detonateDrone(d); // recon drones carry no payload
    } else if (action === 'recall') {
      this.endDrone(d, 'recalled');
    }
  }

  detonateDrone(d) {
    const cfg = this.rules.drone.fpv;
    this.explode({
      x: d.x, y: d.y, z: d.z, radius: cfg.blastRadius, damage: cfg.blastDamage,
      ownerId: d.ownerId, weapon: 'FPV Kamikaze Drone', kind: 'drone'
    });
    this.endDrone(d, 'detonated');
  }

  destroyDrone(d) {
    this.broadcast('explosion', { x: r2(d.x), y: r2(d.y), z: r2(d.z), radius: 2.5, kind: 'drone_down' });
    this.endDrone(d, 'destroyed');
  }

  endDrone(d, reason) {
    if (!d || !this.drones.get(d.id)) return;
    this.drones.remove(d);
    const owner = this.players.get(d.ownerId);
    if (owner && owner.droneId === d.id) owner.droneId = null;
    this.broadcast('drone_ended', { droneId: d.id, ownerId: d.ownerId, reason });
  }

  endPilotedDrone(p, reason) {
    if (!p.droneId) return;
    const d = this.drones.get(p.droneId);
    if (d) this.endDrone(d, reason);
    p.droneId = null;
  }

  // ----------------------------------------------------------------- healing
  handleHeal(p, { item }, now = this.clock()) {
    if (!this.canAct(p) || p.heal) return;
    const def = HEALING_ITEMS[item];
    if (!def || !(p.inventory[item] > 0)) return;
    if (def.healAmount > 0 && p.hp >= def.maxCap) {
      this.notify(p, `Health is already at ${def.maxCap}% or more: ${def.name} would be wasted.`, now);
      return;
    }
    if (def.boostAmount > 0 && p.boost >= 100) {
      this.notify(p, 'Energy boost is already full.', now);
      return;
    }
    p.heal = { item, doneAt: now + def.castTimeMs, totalMs: def.castTimeMs };
    this.sendTo(p, 'heal_started', { item, totalMs: def.castTimeMs });
  }

  /** Items are only used up when the cast completes. */
  finishHeal(p) {
    const { item } = p.heal;
    p.heal = null;
    const def = HEALING_ITEMS[item];
    let used = false;
    if (p.inventory[item] > 0) {
      if (def.healAmount > 0 && p.hp < def.maxCap) {
        p.hp = Math.min(def.maxCap, p.hp + def.healAmount);
        used = true;
      }
      if (def.boostAmount > 0 && p.boost < 100) {
        p.boost = Math.min(100, p.boost + def.boostAmount);
        used = true;
      }
      if (used) p.inventory[item] -= 1;
    }
    this.sendTo(p, 'heal_done', { item, used, hp: Math.ceil(p.hp), boost: Math.round(p.boost) });
  }

  cancelHeal(p, reason) {
    if (!p.heal) return;
    p.heal = null;
    this.sendTo(p, 'heal_cancelled', { reason });
  }

  handleCancelHeal(p) {
    if (this.canAct(p)) this.cancelHeal(p, 'cancelled');
  }

  // ------------------------------------------------------------------ airdrop
  handleLoot(p, { crateId }, now = this.clock()) {
    if (!this.canAct(p) || p.droneId) return;
    const crate = this.airdrops.find(crateId);
    if (!crate) {
      this.notify(p, 'That crate is gone.', now);
      return;
    }
    if (Math.hypot(p.x - crate.x, p.z - crate.z) > this.rules.airdrop.lootRadius) {
      this.notify(p, 'Move closer to the crate.', now);
      return;
    }

    const loot = crate.loot;
    const w = ARSENAL[loot.weapon];
    const slot = loot.slot;
    const sameWeapon = p.loadout[slot] === loot.weapon;
    p.loadout[slot] = loot.weapon;
    const a = p.ammo[slot];
    a.mag = w.magSize;
    a.reserve = loot.rockets ? (sameWeapon ? a.reserve : 0) + loot.rockets : w.reserveAmmo;
    if (p.reload && p.reload.slot === slot) p.reload = null;
    if (slot === p.activeSlot) p.equipUntil = Math.max(p.equipUntil, now + this.rules.equipDelayMs);

    p.armor = Math.max(p.armor, loot.armor);
    for (const [item, count] of Object.entries(loot.items)) {
      p.inventory[item] = (p.inventory[item] ?? 0) + count;
    }

    this.airdrops.remove(crate);
    this.broadcast('airdrop_looted', { crateId: crate.id, by: p.callsign, label: crate.label });
    this.sendTo(p, 'loot_received', { label: crate.label, slot, weapon: loot.weapon });
  }

  // ------------------------------------------------------- damage and deaths
  /**
   * The only place health is reduced. Handles spawn protection, armor, notifications,
   * the shooter's hit marker and the kill itself.
   */
  dealDamage(attacker, target, rawDamage, { weapon, headshot = false, armorBypass = false, src = null, now = this.clock() }) {
    if (!target || !target.alive || !target.connected) return null;
    const external = attacker && attacker !== target;

    if (now < target.invulnUntil) {
      if (external) {
        this.sendTo(attacker, 'hit_confirm', {
          targetId: target.id, kind: 'player', damage: 0, headshot, blocked: true, killed: false
        });
      }
      return { dealt: 0, killed: false };
    }

    const dealt = applyDamage(target, rawDamage, armorBypass);
    target.lastDamagedAt = now;
    this.cancelHeal(target, 'damaged');
    this.sendTo(target, 'damage_taken', {
      amount: dealt,
      hp: Math.ceil(target.hp),
      armor: Math.round(target.armor),
      fromId: attacker ? attacker.id : null,
      src: src ? { x: r1(src.x), z: r1(src.z) } : null
    });

    const killed = target.hp <= 0;
    if (external) {
      this.sendTo(attacker, 'hit_confirm', {
        targetId: target.id, kind: 'player', damage: dealt, headshot, blocked: false, killed
      });
    }
    if (killed) this.registerKill(attacker, target, weapon, headshot, now);
    return { dealt, killed };
  }

  registerKill(killer, victim, weapon, headshot, now = this.clock()) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.deaths += 1;
    victim.streak = 0;
    victim.respawnAt = now + this.rules.respawnMs;
    victim.reload = null;
    victim.heal = null;
    victim.sprinting = false;
    victim.ads = false;
    this.endPilotedDrone(victim, 'owner_died');

    const suicide = !killer || killer === victim;
    if (!suicide) {
      killer.kills += 1;
      killer.streak += 1;
      if (headshot) killer.headshots += 1;
      if (this.teamMode) this.scores[killer.team] += 1;
    }

    this.sendTo(victim, 'you_died', {
      killerId: suicide ? null : killer.id,
      killer: suicide ? victim.callsign : killer.callsign,
      weapon,
      headshot: !!headshot,
      respawnInMs: this.rules.respawnMs
    });
    this.broadcast('kill_feed', {
      killer: suicide ? victim.callsign : killer.callsign,
      killerId: suicide ? victim.id : killer.id,
      killerTeam: suicide ? victim.team : killer.team,
      victim: victim.callsign,
      victimId: victim.id,
      victimTeam: victim.team,
      weapon,
      headshot: !!headshot,
      suicide
    });

    if (!this.finishRequested) {
      if (this.teamMode) {
        if (Math.max(this.scores.bharat, this.scores.opfor) >= this.rules.tdmScoreLimit) this.finishRequested = 'limit';
      } else if (!suicide && killer.kills >= this.rules.ffaKillLimit) {
        this.finishRequested = 'limit';
      }
    }
  }

  /** Area damage. Structures block the blast; people on the other side of a wall are safe. */
  explode({ x, y, z, radius, damage, ownerId, weapon, kind }) {
    const now = this.clock();
    const owner = this.players.get(ownerId) ?? null;
    this.broadcast('explosion', { x: r2(x), y: r2(y), z: r2(z), radius, kind });

    for (const t of this.players.values()) {
      if (!t.alive || !t.connected) continue;
      if (this.teamMode && owner && t !== owner && t.team === owner.team) continue;

      const cy = t.y + 1.0 * (STANCE_SCALE[t.stance] ?? 1);
      const dist = Math.hypot(t.x - x, cy - y, t.z - z);
      if (dist > radius) continue;
      if (dist > 0.5) {
        const inv = 1 / dist;
        const wall = raycastWorld(x, y, z, (t.x - x) * inv, (cy - y) * inv, (t.z - z) * inv, dist - 0.3, { terrain: false });
        if (wall) continue;
      }
      const dmg = Math.round(damage * (1 - dist / (radius + 1.5)));
      if (dmg <= 0) continue;
      this.dealDamage(owner, t, dmg, { weapon, armorBypass: true, src: { x, z }, now });
    }
  }

  // -------------------------------------------------------------- simulation
  update(dt, now = this.clock()) {
    if (this.ended) return;
    dt = clamp(dt, 0, 0.1);

    for (const p of this.players.values()) {
      if (p.status === 'grace' && now - p.disconnectedAt >= this.rules.reconnectGraceMs) {
        this.removePlayer(p, now);
      }
      if (p.status === 'left') continue;

      if (!p.alive) {
        if (now >= p.respawnAt) this.respawn(p, now);
        continue;
      }
      if (!p.connected) continue;

      if (p.reload && now >= p.reload.doneAt) this.finishReload(p);
      if (p.heal && now >= p.heal.doneAt) this.finishHeal(p);
      if (p.boost > 0) {
        p.boost = Math.max(0, p.boost - this.rules.boost.decayPerSec * dt);
        if (p.hp < 100) p.hp = Math.min(100, p.hp + this.rules.boost.regenHpPerSec * dt);
      }
    }

    for (const ev of this.airdrops.update(dt, now)) {
      this.broadcast(ev.type, publicCrate(ev.crate));
    }
    this.projectiles.update(dt, now);
    this.drones.update(dt, now);

    if (!this.finishRequested && now >= this.endsAt) this.finishRequested = 'time';
    if (this.finishRequested) {
      this.finish(this.finishRequested, now);
      return;
    }

    this.snapshotAcc += dt;
    const step = 1 / this.rules.snapshotHz;
    if (this.snapshotAcc >= step) {
      this.snapshotAcc = Math.min(this.snapshotAcc - step, step);
      this.sendSnapshots(now);
    }
  }

  // --------------------------------------------------------------- snapshots
  publicPlayer(o, now) {
    return {
      id: o.id,
      callsign: o.callsign,
      team: o.team,
      x: r2(o.x), y: r2(o.y), z: r2(o.z),
      yaw: r2(o.yaw), pitch: r2(o.pitch),
      stance: o.stance,
      lean: o.lean,
      sprint: o.sprinting,
      ads: o.ads,
      hp: Math.ceil(o.hp),
      alive: o.alive,
      weapon: o.loadout[o.activeSlot],
      kills: o.kills,
      deaths: o.deaths,
      prot: now < o.invulnUntil,
      drone: !!o.droneId
    };
  }

  privateState(p, now) {
    const ammo = {};
    for (const slot of LOADOUT_SLOTS) ammo[slot] = { ...p.ammo[slot] };
    return {
      hp: Math.ceil(p.hp),
      armor: Math.round(p.armor),
      boost: Math.round(p.boost),
      alive: p.alive,
      respawnInMs: p.alive ? 0 : Math.max(0, Math.round(p.respawnAt - now)),
      activeSlot: p.activeSlot,
      loadout: { ...p.loadout },
      ammo,
      inventory: { ...p.inventory },
      reload: p.reload
        ? { slot: p.reload.slot, remainingMs: Math.max(0, Math.round(p.reload.doneAt - now)), totalMs: p.reload.totalMs }
        : null,
      heal: p.heal
        ? { item: p.heal.item, remainingMs: Math.max(0, Math.round(p.heal.doneAt - now)), totalMs: p.heal.totalMs }
        : null,
      cooldowns: {
        missileMs: Math.max(0, Math.round(p.cooldowns.missile - now)),
        fpvMs: Math.max(0, Math.round(p.cooldowns.fpv - now)),
        reconMs: Math.max(0, Math.round(p.cooldowns.recon - now))
      },
      droneId: p.droneId,
      epoch: p.epoch,
      protectedMs: Math.max(0, Math.round(p.invulnUntil - now)),
      kills: p.kills,
      deaths: p.deaths,
      streak: p.streak
    };
  }

  /** The part of a snapshot every recipient gets: only public information. */
  sharedSnapshot(now) {
    const players = [];
    for (const o of this.players.values()) if (o.connected) players.push(this.publicPlayer(o, now));
    return {
      t: Math.round(now),
      seq: this.snapshotSeq,
      timeLeftSec: Math.max(0, Math.ceil((this.endsAt - now) / 1000)),
      scores: this.teamMode ? { ...this.scores } : null,
      players,
      airdrops: this.airdrops.crates.map(publicCrate),
      drones: this.drones.serialize(),
      ...this.projectiles.serialize()
    };
  }

  snapshotFor(viewer, now = this.clock()) {
    return { ...this.sharedSnapshot(now), me: this.privateState(viewer, now) };
  }

  sendSnapshots(now) {
    this.snapshotSeq += 1;
    const shared = this.sharedSnapshot(now);
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      // volatile: an old snapshot is worthless, so a congested socket may simply drop it
      this.sendTo(p, 'state_snapshot', { ...shared, me: this.privateState(p, now) }, true);
    }
  }

  joinPayload(p, resumed, now = this.clock()) {
    const r = this.rules;
    return {
      playerId: p.id,
      resumeKey: p.resumeKey,
      resumed,
      roomId: this.roomId,
      mode: this.mode,
      team: p.team,
      callsign: p.callsign,
      spawn: { x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r2(p.yaw), pitch: r2(p.pitch) },
      epoch: p.epoch,
      rules: {
        matchSeconds: r.matchSeconds,
        tdmScoreLimit: r.tdmScoreLimit,
        ffaKillLimit: r.ffaKillLimit,
        respawnMs: r.respawnMs,
        spawnProtectionMs: r.spawnProtectionMs,
        missileCooldownMs: r.missile.cooldownMs,
        fpvCooldownMs: r.drone.fpv.cooldownMs,
        reconCooldownMs: r.drone.recon.cooldownMs,
        fpvTtlMs: r.drone.fpv.ttlMs,
        reconTtlMs: r.drone.recon.ttlMs,
        lootRadius: r.airdrop.lootRadius,
        mapHalfSize: MAP_HALF_SIZE,
        // used by the client only to draw rockets / missiles smoothly between snapshots
        rocketSpeed: r.rocket.speed,
        missileFallSpeed: r.missile.fallSpeed,
        grenadeGravity: r.grenade.gravity,
        equipDelayMs: r.equipDelayMs,
        throwCooldownMs: r.throwCooldownMs,
        smokeMs: r.grenade.smokeMs
      },
      snapshot: this.snapshotFor(p, now)
    };
  }

  // --------------------------------------------------------------- match end
  row(p) {
    return {
      id: p.id,
      callsign: p.callsign,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      headshots: p.headshots,
      present: p.status !== 'left'
    };
  }

  /** Ends the match (once). `reason` is 'limit' | 'time' | 'shutdown'. */
  finish(reason, now = this.clock()) {
    if (this.ended) return this.endInfo;
    this.ended = true;
    this.endedAt = now;
    this.endReason = reason;
    this.finishRequested = null;

    for (const d of this.drones.list()) this.drones.remove(d);
    this.projectiles.grenades.length = 0;
    this.projectiles.rockets.length = 0;
    this.projectiles.missiles.length = 0;

    const all = Array.from(this.players.values());
    const rows = all.map((p) => this.row(p));
    let winnerTeam = null;
    let winnerId = null;
    let winnerCallsign = null;
    let draw = false;

    if (this.teamMode) {
      if (this.scores.bharat === this.scores.opfor) draw = true;
      else winnerTeam = this.scores.bharat > this.scores.opfor ? 'bharat' : 'opfor';
    } else {
      const top = rows.reduce((m, r) => Math.max(m, r.kills), 0);
      const leaders = rows.filter((r) => r.kills === top);
      if (top === 0 || leaders.length !== 1) draw = true;
      else { winnerId = leaders[0].id; winnerCallsign = leaders[0].callsign; }
    }

    const publicSummary = {
      matchId: this.matchId,
      roomId: this.roomId,
      mode: this.mode,
      reason,
      durationSec: Math.round((now - this.startedAt) / 1000),
      draw,
      winnerTeam,
      winnerId,
      winnerCallsign,
      scores: this.teamMode ? { ...this.scores } : null,
      players: rows
    };
    // The backend also learns which rows belong to registered accounts. Clients never see that.
    const report = {
      ...publicSummary,
      endedAt: new Date().toISOString(),
      players: all.map((p) => ({ ...this.row(p), userId: p.userId, guest: p.isGuest }))
    };
    this.endInfo = publicSummary;

    this.broadcast('match_ended', publicSummary);
    if (this.onEnd) {
      try { this.onEnd(report, publicSummary); } catch { /* reporting problems never crash the room */ }
    }
    return publicSummary;
  }
}
