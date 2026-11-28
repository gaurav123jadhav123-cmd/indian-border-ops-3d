// Full-stack test: the REAL browser-side client code (frontend/js/net, game state, movement),
// the REAL backend routes and the REAL game-server logic, all inside one Node process.
//
// What is faked: only the two transports. Express is skipped (routes are called through the same
// dispatcher Express uses) and Socket.IO is replaced by an in-memory pair of sockets that copy every
// message (structuredClone), the way a real network would. So this proves the three parts agree on
// every message and rule; it does not prove Express or Socket.IO themselves are configured right.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../backend/src/config.js';
import { Store } from '../../backend/src/services/store.js';
import { createServices } from '../../backend/src/services/index.js';
import { createDispatcher } from '../../backend/src/dispatch.js';
import { routes } from '../../backend/src/routes/index.js';
import { RoomManager } from '../../server/src/rooms/RoomManager.js';
import { attachSocket } from '../../server/src/net/handlers.js';
import { createReporter } from '../../server/src/net/report.js';
import { getEyePosition, getTerrainHeight } from '../../server/src/shared/world.js';
import { createApi } from '../../frontend/js/net/api.js';
import { GameClient } from '../../frontend/js/net/socket.js';
import { GameState } from '../../frontend/js/game/state.js';
import { PlayerController } from '../../frontend/js/game/controller.js';

const SECRET = 'integration-test-secret';
const silent = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 4000, step = 10, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

// ------------------------------------------------------------------ the three real parts
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibo-int-'));
const config = loadConfig({ SHARED_SECRET: SECRET, DATA_DIR: dir });
const store = new Store({ dir, saveDelayMs: 5, log: silent }).load();
const services = createServices({ config, store, log: silent });
const dispatch = createDispatcher({ routes, services });

/** fetch() that goes straight into the backend's route table. */
function makeFetch(ip) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const out = await dispatch(init.method ?? 'GET', u.pathname, {
      body: init.body ? JSON.parse(init.body) : undefined,
      query: Object.fromEntries(u.searchParams),
      headers,
      ip
    });
    const body = structuredClone(out.body);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => body };
  };
}
let nextIp = 0;
const newApi = () => createApi({ baseUrl: 'http://backend.test', fetchFn: makeFetch(`10.9.0.${++nextIp}`) });

const reportJobs = [];
const reportMatch = createReporter({
  backendUrl: 'http://backend.test', secret: SECRET, fetchFn: makeFetch('10.9.1.1'), log: silent, sleep: async () => {}
});
const manager = new RoomManager({
  log: silent,
  onMatchEnd: (report) => {
    // same rule as server/src/index.js: matches with only guests are not recorded
    if (report.players.some((p) => p.userId)) reportJobs.push(reportMatch(report));
  }
});
manager.start();

/** Stand-in for Socket.IO's `io()`: every call makes a client socket wired to a fresh server-side socket. */
function makeIo() {
  let count = 0;
  const sockets = [];
  const io = () => {
    const handlers = new Map(); // client side
    const any = [];
    const fire = (ev, ...args) => handlers.get(ev)?.(...args);
    let serverHandlers = new Map();
    let cid = null;
    let epoch = 0; // bumped on every (re)connect so late deliveries to an old connection are dropped

    const toClient = (myEpoch) => (ev, payload) => {
      const data = structuredClone(payload);
      setImmediate(() => {
        if (myEpoch !== epoch || !sock.connected) return;
        fire(ev, data);
        any.forEach((fn) => fn(ev, data));
      });
    };

    const link = () => {
      epoch += 1;
      cid = `int_${++count}`;
      serverHandlers = new Map();
      const deliver = toClient(epoch);
      const serverSide = {
        id: cid,
        on: (ev, fn) => serverHandlers.set(ev, fn),
        emit: deliver,
        volatile: { emit: deliver },
        disconnect() {
          setImmediate(() => {
            if (!sock.connected) return;
            sock.connected = false;
            serverHandlers.get('disconnect')?.('server namespace disconnect');
            fire('disconnect', 'io server disconnect');
          });
        }
      };
      attachSocket(serverSide, { manager, secret: SECRET, log: silent });
    };

    const sock = {
      connected: false,
      on(ev, fn) { handlers.set(ev, fn); return sock; },
      onAny(fn) { any.push(fn); return sock; },
      emit(ev, payload) {
        if (!sock.connected) return sock;
        const data = structuredClone(payload);
        const target = serverHandlers;
        setImmediate(() => { if (target === serverHandlers && sock.connected) target.get(ev)?.(data); });
        return sock;
      },
      get volatile() { return { emit: (ev, payload) => sock.emit(ev, payload) }; },
      disconnect() {
        if (!sock.connected) return sock;
        sock.connected = false;
        serverHandlers.get('disconnect')?.('client namespace disconnect');
        fire('disconnect', 'io client disconnect');
        return sock;
      },
      // test hooks
      drop() {
        if (!sock.connected) return;
        sock.connected = false;
        serverHandlers.get('disconnect')?.('transport close');
        fire('disconnect', 'transport close');
      },
      reconnect() {
        link();
        sock.connected = true;
        fire('connect');
      }
    };
    sockets.push(sock);
    setImmediate(() => sock.reconnect());
    return sock;
  };
  return { io, sockets };
}

/** One player: a GameClient on its own fake connection, plus a log of everything the server sent. */
async function connectClient() {
  const { io, sockets } = makeIo();
  const client = new GameClient({ url: 'http://game.test', ioFactory: io });
  const events = [];
  const original = client.handleServerEvent.bind(client);
  client.handleServerEvent = (ev, payload) => { events.push({ ev, payload }); original(ev, payload); };
  await client.connect();
  return {
    client,
    sock: sockets[0],
    events,
    all: (ev) => events.filter((e) => e.ev === ev).map((e) => e.payload),
    count: (ev) => events.filter((e) => e.ev === ev).length,
    last: (ev) => events.filter((e) => e.ev === ev).map((e) => e.payload).at(-1)
  };
}

async function joinAs(callsign, { roomId, mode = 'TDM', loadout, account = null }) {
  const api = newApi();
  let session;
  if (account) session = await api.register(callsign, account);
  else session = await api.guest(callsign);
  const conn = await connectClient();
  const joined = await conn.client.join({ token: session.token, roomId, mode, loadout });
  return { api, session, ...conn, joined, id: joined.playerId, room: manager.get(roomId) };
}

const serverSide = (p) => p.room.players.get(p.id);

/** Put a soldier somewhere on the server (clients here do not send movement) and drop spawn protection. */
function place(p, x, z, team) {
  const s = serverSide(p);
  s.x = x; s.z = z; s.y = getTerrainHeight(x, z); s.stance = 'stand'; s.invulnUntil = 0;
  if (team) s.team = team;
}
function aimAt(from, to) {
  const a = getEyePosition(serverSide(from));
  const b = serverSide(to);
  const dx = b.x - a.x; const dy = b.y + 1.1 - a.y; const dz = b.z - a.z;
  const l = Math.hypot(dx, dy, dz);
  return { x: dx / l, y: dy / l, z: dz / l };
}
async function killWithRifle(shooter, victim) {
  place(shooter, 0, -60, 'bharat');
  place(victim, 0, -50, 'opfor');
  for (let i = 0; i < 14 && victim.count('you_died') === 0; i++) {
    shooter.client.send('shoot', { dir: aimAt(shooter, victim) });
    await sleep(160);
  }
  await waitFor(() => victim.count('you_died') > 0, { what: 'the victim to die' });
}

const open = [];
const closeAll = () => { for (const p of open.splice(0)) { try { p.client.close(); } catch { /* ignore */ } } };
const track = (p) => { open.push(p); return p; };

after(async () => {
  closeAll();
  manager.shutdown();
  store.flush?.();
  await sleep(30);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the tests
test('guest sign-in, join, and the first snapshots feed the client game state', async () => {
  const p = track(await joinAs('Arjun_01', { roomId: 'int-join', loadout: { primary: 'sig716' } }));
  const j = p.joined;
  assert.match(j.playerId, /\S/);
  assert.match(j.resumeKey, /^[0-9a-f]{16,}$/i);
  assert.ok(['bharat', 'opfor'].includes(j.team));
  assert.equal(j.mode, 'TDM');
  assert.equal(j.roomId, 'int-join');
  assert.ok(j.rules.matchSeconds > 0 && j.rules.respawnMs > 0, 'rules reach the client');
  assert.ok(Number.isFinite(j.spawn.x) && Number.isFinite(j.spawn.z) && Number.isInteger(j.epoch));

  const state = new GameState();
  state.applyJoin(j, performance.now());
  p.client.on('state_snapshot', (snap) => state.applySnapshot(snap, performance.now()));
  await waitFor(() => state.gotFirstSnapshot && state.me, { what: 'the first snapshot' });
  assert.equal(state.myId, j.playerId);
  assert.equal(state.me.hp, 100);
  assert.ok(state.myPublic(), 'my own public entry is in the snapshot');
  assert.equal(state.myPublic().callsign, 'Arjun_01');

  // snapshots keep coming at about 20 a second
  const seq0 = state.seq;
  await sleep(300);
  assert.ok(state.seq - seq0 >= 3, `only ${state.seq - seq0} snapshots in 300ms`);
});

test('walking with the real movement code is accepted by the server without a single correction', async () => {
  const p = track(await joinAs('Walker_02', { roomId: 'int-walk' }));
  const ctl = new PlayerController();
  ctl.teleport({ ...p.joined.spawn, epoch: p.joined.epoch });
  ctl.resetPose();
  const start = { x: ctl.x, z: ctl.z };

  let last = performance.now();
  let lastSend = 0;
  const end = last + 1600;
  while (performance.now() < end) {
    await sleep(16);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctl.update(dt, { moveY: 1 });
    if (now - lastSend >= 50) {
      lastSend = now;
      p.client.sendFast('player_move', ctl.moveMessage());
    }
  }
  await sleep(150);
  const s = serverSide(p);
  const moved = Math.hypot(ctl.x - start.x, ctl.z - start.z);
  assert.ok(moved > 4, `the client only moved ${moved.toFixed(2)}m`);
  assert.ok(Math.hypot(s.x - ctl.x, s.z - ctl.z) < 1.5, `server ${s.x.toFixed(1)},${s.z.toFixed(1)} vs client ${ctl.x.toFixed(1)},${ctl.z.toFixed(1)}`);
  assert.equal(p.count('correction'), 0, 'honest movement must never be corrected');
});

test('a move with the wrong epoch is ignored and a cheat is pulled back', async () => {
  const p = track(await joinAs('Cheater_03', { roomId: 'int-cheat' }));
  const ctl = new PlayerController();
  ctl.teleport({ ...p.joined.spawn, epoch: p.joined.epoch });
  // 80 metres in one message is not walking
  p.client.sendFast('player_move', { ...ctl.moveMessage(), x: ctl.x + 80, z: ctl.z });
  await waitFor(() => p.count('correction') > 0, { what: 'a correction' });
  const fix = p.last('correction');
  assert.ok(Math.hypot(fix.x - p.joined.spawn.x, fix.z - p.joined.spawn.z) < 2, 'the server put the soldier back');
  assert.ok(fix.epoch > p.joined.epoch, 'the epoch moves on so old messages are ignored');
  const s = serverSide(p);
  assert.ok(Math.hypot(s.x - p.joined.spawn.x, s.z - p.joined.spawn.z) < 2);
});

test('two players fight: hit confirmation, damage event, death, kill feed, respawn', async () => {
  const roomId = 'int-fight';
  const a = track(await joinAs('Alpha_04', { roomId }));
  const b = track(await joinAs('Bravo_05', { roomId }));
  place(a, 0, -60, 'bharat');
  place(b, 0, -50, 'opfor');

  a.client.send('shoot', { dir: aimAt(a, b) });
  await waitFor(() => a.count('hit_confirm') > 0 && b.count('damage_taken') > 0, { what: 'hit and damage events' });
  assert.ok(b.last('damage_taken').amount > 0 || b.last('damage_taken').damage > 0 || b.last('damage_taken').hp < 100);
  assert.ok(a.all('shot_fired').length > 0 && b.all('shot_fired').length > 0, 'everybody hears the shot');

  await killWithRifle(a, b);
  const death = b.last('you_died');
  assert.equal(death.killer, 'Alpha_04');
  assert.ok(death.respawnInMs > 0);
  await waitFor(() => a.count('kill_feed') > 0 && b.count('kill_feed') > 0, { what: 'the kill feed' });
  const feed = a.last('kill_feed');
  assert.equal(feed.killer, 'Alpha_04');
  assert.equal(feed.victim, 'Bravo_05');

  assert.equal(serverSide(b).alive, false);
  await waitFor(() => b.count('respawned') > 0, { timeout: 9000, what: 'the respawn' });
  assert.equal(serverSide(b).alive, true);
  assert.equal(serverSide(b).hp, 100);
  assert.ok(Number.isInteger(b.last('respawned').epoch));
});

test('a registered account keeps its loadout and a finished match lands on the leaderboard', async () => {
  const roomId = 'int-board';
  const api = newApi();
  const reg = await api.register('Veer_Sena', 'jaihind99');
  assert.equal(reg.user.guest, false);
  const saved = await api.saveLoadout(reg.token, { primary: 'ak203' });
  assert.equal(saved.loadout.primary, 'ak203');

  // guests cannot save loadouts
  const guest = await api.guest('Just_Visiting');
  await assert.rejects(() => api.saveLoadout(guest.token, { primary: 'ak203' }), (e) => e.status === 403);

  // the lobby sends the saved loadout when it joins
  const me = await api.me(reg.token);
  const conn = track({ ...(await connectClient()) });
  const joined = await conn.client.join({ token: reg.token, roomId, mode: 'TDM', loadout: me.user.loadout });
  const veer = { ...conn, joined, id: joined.playerId, room: manager.get(roomId) };
  assert.equal(serverSide(veer).loadout.primary, 'ak203', 'the server equips the saved rifle');

  const foe = track(await joinAs('Sparring_Guest', { roomId }));
  await killWithRifle(veer, foe);

  const room = manager.get(roomId);
  room.finish('time');
  await waitFor(() => veer.count('match_ended') > 0 && foe.count('match_ended') > 0, { what: 'match_ended' });
  const ended = veer.last('match_ended');
  assert.equal(ended.roomId, roomId);
  assert.ok(ended.players.some((r) => r.callsign === 'Veer_Sena' && r.kills >= 1));

  assert.equal(reportJobs.length, 1, 'the game server reported exactly one match');
  assert.deepEqual(await Promise.all(reportJobs), [true], 'the backend accepted the signed report');

  const board = await newApi().leaderboard();
  const row = board.leaderboard.find((r) => r.callsign === 'Veer_Sena');
  assert.ok(row, 'the account is on the leaderboard');
  assert.equal(row.stats.matchesPlayed, 1);
  assert.ok(row.stats.kills >= 1);
  assert.ok(!board.leaderboard.some((r) => r.callsign === 'Sparring_Guest'), 'guests are not ranked');
  assert.equal(board.recentMatches.length, 1);
});

test('PLAY AGAIN: joining the same room after the match gives a fresh match', async () => {
  const roomId = 'int-again';
  const a = track(await joinAs('Again_06', { roomId }));
  const before = manager.get(roomId);
  before.finish('time');
  await waitFor(() => a.count('match_ended') > 0, { what: 'match_ended' });
  a.client.leave();
  const again = track(await joinAs('Again_06b', { roomId }));
  const after = manager.get(roomId);
  assert.notEqual(after, before);
  assert.equal(after.ended, false);
  assert.equal(again.joined.roomId, roomId);
});

test('a dropped connection resumes the same soldier, with no second body left behind', async () => {
  const roomId = 'int-resume';
  const p = track(await joinAs('Flaky_07', { roomId }));
  const room = manager.get(roomId);
  assert.equal(room.players.size, 1);

  p.sock.drop();
  await waitFor(() => p.client.status === 'reconnecting', { what: 'the client to notice' });
  assert.equal(p.count('match_joined'), 1);
  await sleep(100);
  p.sock.reconnect();
  await waitFor(() => p.count('match_joined') === 2, { what: 'the automatic re-join' });
  const again = p.last('match_joined');
  assert.equal(again.playerId, p.id);
  assert.equal(again.resumed, true);
  assert.equal(room.players.size, 1);
  assert.equal(p.client.status, 'connected');
});

test('joining from a second device tells the first one it was replaced', async () => {
  const roomId = 'int-takeover';
  const first = track(await joinAs('Twice_08', { roomId }));
  const api = newApi();
  // the same account (same token) from another tab
  const token = first.session.token;
  const second = track({ ...(await connectClient()) });
  const joined = await second.client.join({ token, roomId, mode: 'TDM' });
  assert.ok(joined.playerId);
  await waitFor(() => first.count('kicked') > 0, { what: 'the kick' });
  assert.match(first.last('kicked').reason, /another tab or device/);
  assert.equal(first.client.status, 'closed');
  void api;
});

test('a bad token is refused with a readable message; a malformed room code falls back to the default room', async () => {
  const conn = track(await connectClient());
  await assert.rejects(
    () => conn.client.join({ token: 'not.a.token', roomId: 'int-bad', mode: 'TDM' }),
    (e) => /sign in/i.test(e.message)
  );
  assert.equal(manager.get('int-bad'), null, 'no room is created for a refused join');

  const { token } = await newApi().guest('Polite_09');
  const conn2 = track(await connectClient());
  const joined = await conn2.client.join({ token, roomId: 'bad room!', mode: 'TDM' });
  assert.equal(joined.roomId, 'border-sector-1');
  assert.equal(manager.get('bad room!'), null);
});
