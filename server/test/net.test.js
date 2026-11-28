// Network layer: socket handlers (auth, rate limits, hostile payloads), the room manager,
// the backend reporter, configuration and payload validation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachSocket } from '../src/net/handlers.js';
import { RoomManager } from '../src/rooms/RoomManager.js';
import { createReporter } from '../src/net/report.js';
import { loadConfig, parseOrigins } from '../src/config.js';
import { signToken, verifyToken } from '../src/shared/token.js';
import * as V from '../src/net/validate.js';
import { seeded } from './helpers.js';

const SECRET = 'test-secret-value';

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.handlers = new Map();
    this.sent = [];
    this.disconnected = false;
    this.volatile = { emit: (event, payload) => this.sent.push({ event, payload, volatile: true }) };
  }
  on(event, fn) { this.handlers.set(event, fn); }
  emit(event, payload) { this.sent.push({ event, payload }); }
  disconnect() {
    this.disconnected = true;
    this.trigger('disconnect');
  }
  trigger(event, ...args) { return this.handlers.get(event)?.(...args); }
  all(event) { return this.sent.filter((e) => e.event === event).map((e) => e.payload); }
  last(event) { const a = this.all(event); return a[a.length - 1]; }
}

/** `step` = how much the fake clock moves on every reading (0 freezes time). */
function harness({ maxRooms, step = 5 } = {}) {
  let t = 1000;
  const clock = () => (t += step);
  const errors = [];
  const log = { info() {}, warn() {}, error: (...a) => errors.push(a) };
  const manager = new RoomManager({ rng: () => 0, clock, maxRooms, log });
  let n = 0;
  const connect = (name = 'Alpha', { guest = false, sub } = {}) => {
    const socket = new FakeSocket(`sock_${name}_${n++}`);
    attachSocket(socket, { manager, secret: SECRET, clock, log });
    const token = signToken({ sub: sub ?? `id_${name}`, name, guest }, SECRET, 60_000);
    return { socket, token };
  };
  const joinAs = (c, extra = {}) => {
    let ack;
    c.socket.trigger('join_match', { token: c.token, roomId: 'r1', mode: 'TDM', ...extra }, (a) => { ack = a; });
    return ack;
  };
  return { manager, connect, joinAs, errors, clock, advance: (ms) => { t += ms; } };
}

describe('joining through the socket layer', () => {
  it('a valid token joins and receives the match state', () => {
    const { connect, joinAs, manager } = harness();
    const a = connect('Alpha');
    assert.deepEqual(joinAs(a), { ok: true });
    const joined = a.socket.last('match_joined');
    assert.equal(joined.callsign, 'Alpha');
    assert.equal(joined.roomId, 'r1');
    assert.equal(joined.mode, 'TDM');
    assert.equal(joined.snapshot.me.hp, 100);
    assert.match(joined.resumeKey, /^[a-f0-9]{16,64}$/);
    assert.equal(manager.get('r1').connectedCount(), 1);
  });

  it('refuses forged, expired, wrongly-signed and service tokens - and creates no room for them', () => {
    const { connect, joinAs, manager } = harness();
    const base = connect('Alpha');
    const bad = [
      signToken({ sub: 'x', name: 'Eve' }, 'another-secret', 60_000),
      signToken({ sub: 'x', name: 'Eve' }, SECRET, -1000),
      signToken({ role: 'server', sub: 'game-server' }, SECRET, 60_000),
      signToken({ name: 'NoSubject' }, SECRET, 60_000),
      `${base.token}x`,
      'garbage',
      ''
    ];
    for (const token of bad) {
      const c = connect('Eve');
      const ack = joinAs({ ...c, token });
      assert.equal(ack.ok, false);
      assert.ok(c.socket.last('join_error'));
      assert.equal(c.socket.last('match_joined'), undefined);
    }
    assert.equal(manager.rooms.size, 0);
  });

  it('malformed join requests are answered, never thrown', () => {
    const { connect, errors } = harness();
    const c = connect('Alpha');
    for (const junk of [undefined, null, 0, 'x', [], {}, { token: 5 }, { token: 'a'.repeat(5000) }, () => 1]) {
      assert.doesNotThrow(() => c.socket.trigger('join_match', junk, () => {}));
    }
    assert.deepEqual(errors, []);
    assert.equal(c.socket.last('match_joined'), undefined);
  });

  it('a second login with the same account takes over and the old connection is dropped', () => {
    const { connect, joinAs, manager } = harness();
    const first = connect('Alpha', { sub: 'same' });
    const second = connect('Alpha', { sub: 'same' });
    joinAs(first);
    const id = first.socket.last('match_joined').playerId;
    joinAs(second);

    assert.equal(second.socket.last('match_joined').playerId, id, 'same soldier, new connection');
    assert.ok(first.socket.last('kicked'));
    assert.ok(first.socket.disconnected);

    // anything the old socket still sends is ignored
    const room = manager.get('r1');
    let moves = 0;
    const original = room.handleMove.bind(room);
    room.handleMove = (...args) => { moves += 1; return original(...args); };
    first.socket.trigger('player_move', { x: 5, y: 0, z: 5, yaw: 0, pitch: 0, stance: 'stand', epoch: 0 });
    assert.equal(moves, 0);
    assert.equal(room.connectedCount(), 1);
  });

  it('dropping the connection keeps the soldier for a while, and the same player can resume', () => {
    const { connect, joinAs, manager, advance } = harness();
    const a = connect('Alpha');
    joinAs(a);
    const joined = a.socket.last('match_joined');
    const room = manager.get('r1');
    room.players.get(joined.playerId).kills = 3;

    a.socket.trigger('disconnect');
    assert.equal(room.connectedCount(), 0);
    advance(5000);
    manager.tick(0.033);
    assert.ok(manager.get('r1'), 'room is kept during the reconnect grace period');

    const again = connect('Alpha');
    joinAs(again, { resumeKey: joined.resumeKey });
    const back = again.socket.last('match_joined');
    assert.equal(back.resumed, true);
    assert.equal(back.playerId, joined.playerId);
    assert.equal(back.snapshot.me.kills, 3);
  });

  it('leave_match removes the soldier and an empty room is cleaned up', () => {
    const { connect, joinAs, manager } = harness();
    const a = connect('Alpha');
    joinAs(a);
    a.socket.trigger('leave_match');
    manager.tick(0.033);
    assert.equal(manager.get('r1'), null);
  });

  it('joining another match on the same socket leaves the first one', () => {
    const { connect, joinAs, manager } = harness();
    const a = connect('Alpha');
    joinAs(a);
    joinAs(a, { roomId: 'r2' });
    assert.equal(manager.get('r1')?.connectedCount() ?? 0, 0);
    assert.equal(manager.get('r2').connectedCount(), 1);
  });
});

describe('rate limits and hostile traffic', () => {
  it('floods are cut off by the per-event rate limit', () => {
    const { connect, joinAs, manager } = harness({ step: 0 }); // frozen clock: nothing refills
    const a = connect('Alpha');
    joinAs(a);
    const room = manager.get('r1');
    let processed = 0;
    const original = room.handleMove.bind(room);
    room.handleMove = (...args) => { processed += 1; return original(...args); };
    for (let i = 0; i < 500; i++) {
      a.socket.trigger('player_move', { x: 0, y: 0, z: -92, yaw: 0, pitch: 0, stance: 'stand', epoch: 0 });
    }
    assert.ok(processed > 0 && processed <= 90, `processed ${processed}`);
  });

  it('every event survives garbage payloads without an error', () => {
    const { connect, joinAs, errors, manager } = harness();
    const a = connect('Alpha');
    joinAs(a);
    const events = [
      'player_move', 'switch_weapon', 'reload', 'shoot', 'throw_grenade', 'call_missile',
      'deploy_drone', 'control_drone', 'drone_action', 'use_heal', 'cancel_heal', 'loot_airdrop'
    ];
    const pollution = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    const junk = [
      undefined, null, 0, -1, NaN, Infinity, '', 'x', 'x'.repeat(20000), [], [1, 2, 3], {}, true,
      { x: NaN, y: NaN, z: NaN }, { x: 'a', y: {}, z: [] }, { dir: { x: 0, y: 0, z: 0 } },
      { dir: { x: 1e308, y: 1e308, z: 1e308 } }, { dir: { x: NaN, y: 1, z: 1 } }, { dir: 'up' },
      { type: 'toString', dir: { x: 1, y: 0, z: 0 } }, { item: 'constructor' }, { item: '__proto__' },
      { slot: '__proto__' }, { mode: 'constructor' }, { action: 'hasOwnProperty' }, { crateId: {} },
      { crateId: 'x'.repeat(500) }, pollution, { x: 1e20, y: 1e20, z: 1e20, yaw: 1e20, pitch: 1e20 },
      { x: -0, y: -0, z: -0, yaw: -0, pitch: -0, epoch: -5 }, { epoch: 1.5 }
    ];
    for (const event of events) {
      for (const payload of junk) a.socket.trigger(event, payload);
    }

    // seeded random objects on top of the hand-written ones
    const rnd = seeded(42);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const randomValue = (depth = 0) => {
      const kind = Math.floor(rnd() * 8);
      if (kind === 0) return rnd() * 4000 - 2000;
      if (kind === 1) return pick(['stand', 'crouch', 'prone', 'fly', 'frag', 'smoke', 'primary', 'bandage', 'fpv', 'detonate']);
      if (kind === 2) return pick([true, false, null, undefined, NaN, Infinity]);
      if (kind === 3 && depth < 2) return { x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1 };
      if (kind === 4 && depth < 2) return [randomValue(depth + 1)];
      if (kind === 5) return `drop_${Math.floor(rnd() * 5)}`;
      return Math.floor(rnd() * 3);
    };
    const keys = ['x', 'y', 'z', 'yaw', 'pitch', 'stance', 'lean', 'sprinting', 'ads', 'epoch', 'dir', 'type',
      'item', 'slot', 'mode', 'action', 'crateId', 'forward', 'backward', 'left', 'right', 'up', 'down'];
    for (let i = 0; i < 3000; i++) {
      const obj = {};
      for (let k = 0; k < 1 + Math.floor(rnd() * 7); k++) obj[pick(keys)] = randomValue();
      a.socket.trigger(pick(events), rnd() < 0.1 ? randomValue() : obj);
      if (i % 50 === 0) manager.tick(0.033);
    }

    assert.deepEqual(errors, [], 'no handler or tick raised an error');
    assert.equal({}.polluted, undefined, 'Object.prototype was not polluted');
    const room = manager.get('r1');
    for (const p of room.players.values()) {
      for (const v of [p.x, p.y, p.z, p.yaw, p.pitch, p.hp, p.armor, p.boost]) assert.ok(Number.isFinite(v));
      assert.ok(p.hp >= 0 && p.hp <= 100);
      assert.ok(Math.abs(p.x) <= 140 && Math.abs(p.z) <= 140);
    }
  });
});

describe('room manager', () => {
  it('limits how many matches run at once, but lets people into existing ones', () => {
    const { connect, joinAs } = harness({ maxRooms: 2 });
    const a = connect('Alpha'); joinAs(a, { roomId: 'one' });
    const b = connect('Bravo'); joinAs(b, { roomId: 'two' });
    const c = connect('Charlie');
    assert.equal(joinAs(c, { roomId: 'three' }).ok, false);
    assert.match(c.socket.last('join_error').error, /busy/i);
    const d = connect('Delta');
    assert.equal(joinAs(d, { roomId: 'one' }).ok, true);
  });

  it('a finished match is replaced by a fresh one under the same name (play again)', () => {
    const { connect, joinAs, manager } = harness();
    const a = connect('Alpha'); joinAs(a);
    const old = manager.get('r1');
    old.finish('time');
    assert.ok(a.socket.last('match_ended'));

    joinAs(a);
    const fresh = manager.get('r1');
    assert.notEqual(fresh, old);
    assert.equal(fresh.ended, false);
    assert.equal(fresh.connectedCount(), 1);
  });

  it('finished matches are removed after the linger time', () => {
    const { connect, joinAs, manager, advance } = harness();
    const a = connect('Alpha'); joinAs(a);
    manager.get('r1').finish('time');
    manager.tick(0.033);
    assert.ok(manager.get('r1'));
    advance(25_000);
    manager.tick(0.033);
    assert.equal(manager.get('r1'), null);
  });

  it('a crashing match is ended without hurting the others', () => {
    const { connect, joinAs, manager, errors } = harness();
    const a = connect('Alpha'); joinAs(a, { roomId: 'bad' });
    const b = connect('Bravo'); joinAs(b, { roomId: 'good' });
    const bad = manager.get('bad');
    const good = manager.get('good');
    bad.update = () => { throw new Error('boom'); };
    let goodTicks = 0;
    const original = good.update.bind(good);
    good.update = (...args) => { goodTicks += 1; return original(...args); };

    assert.doesNotThrow(() => manager.tick(0.033));
    assert.equal(bad.ended, true);
    assert.equal(goodTicks, 1);
    assert.equal(errors.length, 1);
    assert.ok(a.socket.last('match_ended'));
  });

  it('shutdown tells everybody the match is over', () => {
    const { connect, joinAs, manager } = harness();
    const a = connect('Alpha'); joinAs(a);
    manager.shutdown();
    assert.equal(a.socket.last('match_ended').reason, 'shutdown');
  });

  it('the loop can be started and stopped', () => {
    const timers = [];
    const manager = new RoomManager({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer() {} });
    manager.start();
    manager.start(); // second start is a no-op
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms > 30 && timers[0].ms < 36, '30Hz');
    timers[0].fn();
    assert.equal(timers.length, 2, 'it schedules the next tick');
    manager.stop();
    assert.equal(manager.timer, null);
  });
});

describe('match reporter', () => {
  const setup = (responses, opts = {}) => {
    const calls = [];
    const sleeps = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    const report = createReporter({
      backendUrl: 'http://backend.test', secret: SECRET, fetchFn,
      sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 10, ...opts
    });
    return { calls, sleeps, report };
  };

  it('posts the result with a short-lived service token', async () => {
    const { calls, report } = setup([{ ok: true, status: 200 }]);
    assert.equal(await report({ matchId: 'm1', players: [] }), true);
    assert.equal(calls[0].url, 'http://backend.test/api/leaderboard/match');
    const claims = verifyToken(calls[0].init.headers.Authorization.replace('Bearer ', ''), SECRET);
    assert.equal(claims.role, 'server');
    assert.equal(JSON.parse(calls[0].init.body).matchId, 'm1');
  });

  it('retries server errors with growing delays, then succeeds', async () => {
    const { calls, sleeps, report } = setup([{ ok: false, status: 503 }, new Error('ECONNRESET'), { ok: true, status: 200 }]);
    assert.equal(await report({ matchId: 'm2', players: [] }), true);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [10, 20]);
  });

  it('does not retry when the backend rejects the report', async () => {
    const { calls, report } = setup([{ ok: false, status: 400 }]);
    assert.equal(await report({ matchId: 'm3', players: [] }), false);
    assert.equal(calls.length, 1);
  });

  it('gives up after the last attempt without throwing', async () => {
    const { calls, report } = setup([new Error('down'), new Error('down'), new Error('down')], { attempts: 3 });
    assert.equal(await report({ matchId: 'm4', players: [] }), false);
    assert.equal(calls.length, 3);
  });
});

describe('configuration', () => {
  it('has safe local defaults', () => {
    const c = loadConfig({});
    assert.equal(c.port, 5000);
    assert.equal(c.backendUrl, 'http://localhost:4000');
    assert.equal(c.usingDevSecret, true);
    assert.equal(c.corsOrigins, '*');
    assert.equal(c.maxRooms, 20);
    assert.equal(c.roomCapacity, 12);
  });

  it('refuses to run in production without a shared secret', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SHARED_SECRET/);
    const ok = loadConfig({ NODE_ENV: 'production', SHARED_SECRET: 'abc' });
    assert.equal(ok.secret, 'abc');
    assert.equal(ok.usingDevSecret, false);
  });

  it('reads numbers and origins, and ignores nonsense', () => {
    const c = loadConfig({ PORT: '8080', MAX_ROOMS: '3', ROOM_CAPACITY: 'lots', BACKEND_URL: 'https://api.example.com//', CORS_ORIGIN: 'https://a.com, https://b.com' });
    assert.equal(c.port, 8080);
    assert.equal(c.maxRooms, 3);
    assert.equal(c.roomCapacity, 12);
    assert.equal(c.backendUrl, 'https://api.example.com');
    assert.deepEqual(c.corsOrigins, ['https://a.com', 'https://b.com']);
    assert.equal(parseOrigins(''), '*');
    assert.equal(parseOrigins(' * '), '*');
  });
});

describe('payload validation', () => {
  const good = { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0.2, stance: 'crouch', lean: 1, sprinting: true, ads: true, epoch: 4 };

  it('accepts a well-formed move and normalises the rest', () => {
    assert.deepEqual(V.sanitizeMove(good), good);
    const m = V.sanitizeMove({ ...good, stance: 'flying', lean: 7, pitch: 99, epoch: -3, sprinting: 'yes' });
    assert.equal(m.stance, 'stand');
    assert.equal(m.lean, 0);
    assert.equal(m.pitch, 1.5);
    assert.equal(m.epoch, 0);
    assert.equal(m.sprinting, false);
  });

  it('rejects moves with missing or non-finite numbers', () => {
    for (const bad of [null, 5, 'x', [], { ...good, x: NaN }, { ...good, z: Infinity }, { ...good, y: '1' }, { ...good, yaw: undefined }]) {
      assert.equal(V.sanitizeMove(bad), null);
    }
  });

  it('directions are normalised and zero or absurd vectors are refused', () => {
    const s = V.sanitizeShoot({ dir: { x: 0, y: 0, z: -5 } });
    assert.deepEqual(s.dir, { x: 0, y: 0, z: -1 });
    for (const bad of [{ dir: { x: 0, y: 0, z: 0 } }, { dir: { x: NaN, y: 0, z: 1 } }, { dir: { x: 1e300, y: 1e300, z: 1e300 } }, { dir: [1, 2, 3] }, {}, null]) {
      assert.equal(V.sanitizeShoot(bad), null);
    }
  });

  it('only whitelisted names get through', () => {
    assert.equal(V.sanitizeThrow({ type: 'toString', dir: { x: 1, y: 0, z: 0 } }), null);
    assert.equal(V.sanitizeThrow({ type: 'frag', dir: { x: 1, y: 0, z: 0 } }).type, 'frag');
    assert.equal(V.sanitizeHeal({ item: 'constructor' }), null);
    assert.equal(V.sanitizeHeal({ item: 'medkit' }).item, 'medkit');
    assert.equal(V.sanitizeSlot('__proto__'), null);
    assert.equal(V.sanitizeSlot('launcher'), 'launcher');
    assert.equal(V.sanitizeSlot({ slot: 'secondary' }), 'secondary');
    assert.equal(V.sanitizeDeploy({ mode: 'nuke' }), null);
    assert.equal(V.sanitizeDroneAction({ action: 'hasOwnProperty' }), null);
    assert.equal(V.sanitizeLoot({ crateId: 'x'.repeat(100) }), null);
  });

  it('join requests: bad rooms, modes and loadouts fall back to safe values', () => {
    const j = V.sanitizeJoin({
      token: 't', roomId: '../../etc/passwd', mode: 'BATTLE_ROYALE',
      loadout: { primary: 'trg42', secondary: 'sig716', launcher: 'nope' }, resumeKey: 'not hex!'
    });
    assert.equal(j.roomId, 'border-sector-1');
    assert.equal(j.mode, 'TDM');
    assert.deepEqual(j.loadout, { primary: 'sig716', secondary: 'pistol9mm', launcher: 'carlGustaf' }, 'air-drop guns cannot be chosen');
    assert.equal(j.resumeKey, null);
    assert.equal(V.sanitizeJoin({ roomId: 'ok' }), null, 'a token is required');
  });

  it('a hostile loadout cannot pollute prototypes', () => {
    const j = V.sanitizeJoin(JSON.parse('{"token":"t","loadout":{"__proto__":{"polluted":1},"primary":"ak203"}}'));
    assert.equal(j.loadout.primary, 'ak203');
    assert.equal({}.polluted, undefined);
  });

  it('callsigns are reduced to safe characters', () => {
    assert.equal(V.cleanCallsign('<script>alert(1)</script>'), 'scriptalert1script');
    assert.equal(V.cleanCallsign('A'), '');
    assert.equal(V.cleanCallsign('Maj. Singh-01_x'), 'Maj.Singh-01_x'.slice(0, 18));
    assert.equal(V.cleanCallsign(42), '');
  });
});
