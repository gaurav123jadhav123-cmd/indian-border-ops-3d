// Test helpers: fake clock, fake connections, deterministic random numbers and small
// geometry shortcuts so every test can set up a battlefield in two lines.
import assert from 'node:assert/strict';
import { MatchRoom } from '../src/rooms/MatchRoom.js';
import { RULES } from '../src/rules.js';
import { getTerrainHeight, getEyePosition, STANCE_SCALE } from '../src/shared/world.js';

export function fakeClock(start = 10000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => { t += ms; return t; };
  clock.set = (v) => { t = v; };
  return clock;
}

/** Small deterministic random generator (mulberry32). */
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fakeConn(id = 'c') {
  const events = [];
  return {
    id,
    events,
    disconnected: false,
    send(event, payload, opts) { events.push({ event, payload, opts }); },
    disconnect() { this.disconnected = true; },
    all(event) { return events.filter((e) => e.event === event).map((e) => e.payload); },
    raw(event) { return events.filter((e) => e.event === event); },
    last(event) { const a = this.all(event); return a[a.length - 1]; },
    count(event) { return this.all(event).length; },
    clear() { events.length = 0; }
  };
}

/** rng = () => 0 means "no bullet spread, first airdrop zone, first loot": fully predictable. */
export function makeRoom({ mode = 'TDM', rules = RULES, rng = () => 0, capacity, onEnd } = {}) {
  const clock = fakeClock();
  const room = new MatchRoom({ roomId: 'test', mode, rules, rng, clock, capacity, onEnd });
  return { room, clock };
}

export function join(room, name, { loadout, guest = false, resumeKey, id } = {}) {
  const conn = fakeConn(name);
  const identity = { id: id ?? `id_${name}`, name, userId: guest ? null : (id ?? `id_${name}`), guest };
  const res = room.join(conn, identity, { loadout, resumeKey }, room.clock());
  assert.ok(res.ok, res.error);
  return { p: res.player, conn };
}

/** Put a soldier somewhere specific, standing on the terrain. */
export function place(p, x, z, { yaw = 0, stance = 'stand' } = {}) {
  p.x = x;
  p.z = z;
  p.y = getTerrainHeight(x, z);
  p.yaw = yaw;
  p.pitch = 0;
  p.stance = stance;
  p.lean = 0;
}

export function unprotect(...players) {
  for (const p of players) p.invulnUntil = 0;
}

const part = (p, h) => ({ x: p.x, y: p.y + h * (STANCE_SCALE[p.stance] ?? 1), z: p.z });
export const chest = (p) => part(p, 1.1);
export const head = (p) => part(p, 1.62);

export function dirBetween(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  return { x: dx / len, y: dy / len, z: dz / len };
}

export function aimAt(shooter, target, where = 'chest') {
  return dirBetween(getEyePosition(shooter), where === 'head' ? head(target) : chest(target));
}

/** Advance the room by `ms` in 33ms ticks (30Hz). */
export function run(room, clock, ms, stepMs = 33) {
  let left = ms;
  while (left > 0) {
    const s = Math.min(stepMs, left);
    clock.advance(s);
    room.update(s / 1000, clock());
    left -= s;
  }
}

/** A well-formed player_move payload for the player's current state. */
export function moveMsg(p, over = {}) {
  return {
    x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    stance: p.stance, lean: 0, sprinting: false, ads: false, epoch: p.epoch, ...over
  };
}

/** Two opposing soldiers 10m apart on open, gentle ground, protection removed. */
export function duel({ mode = 'TDM', loadoutA, loadoutB, rng } = {}) {
  const { room, clock } = makeRoom({ mode, rng });
  const a = join(room, 'Alpha', { loadout: loadoutA });
  const b = join(room, 'Bravo', { loadout: loadoutB });
  place(a.p, 0, -92, { yaw: Math.PI });
  place(b.p, 0, -82, { yaw: 0 });
  unprotect(a.p, b.p);
  return { room, clock, a, b };
}

export { RULES };
