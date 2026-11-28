// Backend: passwords, the player database, every API route (through the dispatcher, no Express
// needed), the Express wiring (with a recording fake) and configuration.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, verifyPassword, needsRehash } from '../src/services/passwords.js';
import { Store, MAX_RECENT_MATCHES } from '../src/services/store.js';
import { createServices } from '../src/services/index.js';
import { createDispatcher } from '../src/dispatch.js';
import { routes } from '../src/routes/index.js';
import { createApp, expressHandler } from '../src/app.js';
import { securityHeaders, errorHandler } from '../src/middleware/security.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { loadConfig, parseOrigins, parseTrustProxy } from '../src/config.js';
import { validateReport } from '../src/services/matches.js';
import { signToken, verifyToken } from '../src/shared/token.js';

const SECRET = 'test-secret-value';
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibo-backend-'));
  dirs.push(dir);
  return dir;
}

function makeBackend({ now = () => Date.now(), dir = tempDir() } = {}) {
  const warnings = [];
  const log = { info() {}, warn: (...a) => warnings.push(a), error() {} };
  const config = loadConfig({ SHARED_SECRET: SECRET, DATA_DIR: dir });
  const store = new Store({ dir, saveDelayMs: 5, log, now }).load();
  const services = createServices({ config, store, log, now });
  const dispatch = createDispatcher({ routes, services });
  const call = (method, route, { body, token, ip = '10.0.0.1' } = {}) =>
    dispatch(method, route, { body, ip, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { dir, config, store, services, dispatch, call, warnings, log };
}

async function register(b, callsign = 'Alpha', password = 'secret123') {
  const res = await b.call('POST', '/api/auth/register', { body: { callsign, password } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const serviceToken = () => signToken({ role: 'server' }, SECRET, 60_000);

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('hunter2!');
    const b = await hashPassword('hunter2!');
    assert.match(a, /^s1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('hunter2!', a), true);
    assert.equal(await verifyPassword('hunter3!', a), false);
    assert.equal(needsRehash(a), false);
  });

  it('still accepts the legacy salt:hash format and asks for an upgrade', async () => {
    const salt = crypto.randomBytes(8).toString('hex');
    const legacy = `${salt}:${crypto.scryptSync('borderops', salt, 32).toString('hex')}`;
    assert.equal(await verifyPassword('borderops', legacy), true);
    assert.equal(await verifyPassword('nope', legacy), false);
    assert.equal(needsRehash(legacy), true);
  });

  it('empty, truncated or malformed stored hashes never match', async () => {
    for (const stored of ['', ':', 's1$', 's1$salt$', 's1$salt$00', 'salt:', ':abcd', 's1$salt$zz', 'plain', null, undefined, 42]) {
      assert.equal(await verifyPassword('', stored), false);
      assert.equal(await verifyPassword('anything', stored), false);
    }
    assert.equal(await verifyPassword('x'.repeat(100000), await hashPassword('x')), false);
  });
});

describe('player database', () => {
  it('finds players regardless of capitalisation and refuses duplicates', () => {
    const { store } = makeBackend();
    const u = store.createUser({ callsign: 'Maj_Singh', passwordHash: 'h' });
    assert.equal(store.findByCallsign('maj_singh'), u);
    assert.equal(store.findById(u.id), u);
    assert.throws(() => store.createUser({ callsign: 'MAJ_SINGH', passwordHash: 'h' }), (e) => e.status === 409);
  });

  it('callsigns like __proto__ and constructor are ordinary names', () => {
    const { store } = makeBackend();
    assert.equal(store.findByCallsign('__proto__'), null);
    assert.equal(store.findByCallsign('constructor'), null);
    const u = store.createUser({ callsign: '__proto__', passwordHash: 'h' });
    assert.equal(store.findByCallsign('__PROTO__'), u);
    assert.equal({}.callsign, undefined);
  });

  it('saves atomically and loads back everything', async () => {
    const b = makeBackend();
    const u = b.store.createUser({ callsign: 'Alpha', passwordHash: 's1$a$b' });
    b.store.updateLoadout(u, { primary: 'ak203' });
    await b.store.flush();
    assert.deepEqual(fs.readdirSync(b.dir), ['db.json'], 'no temp file left behind');

    const again = new Store({ dir: b.dir }).load();
    const back = again.findByCallsign('alpha');
    assert.equal(back.id, u.id);
    assert.equal(back.loadout.primary, 'ak203');
    assert.equal(back.loadout.secondary, 'pistol9mm');
  });

  it('saves on its own shortly after a change', async () => {
    const b = makeBackend();
    b.store.createUser({ callsign: 'Alpha', passwordHash: 'h' });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(fs.existsSync(path.join(b.dir, 'db.json')));
  });

  it('a corrupt database file is kept aside and a fresh one starts', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'db.json'), '{"users": [ this is not json');
    const b = makeBackend({ dir });
    assert.equal(b.store.counts().users, 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('db.json.corrupt-')));
    assert.equal(b.warnings.length, 1);
  });

  it('loads the first version\'s database format', () => {
    const dir = tempDir();
    const salt = 'abcd1234abcd1234';
    const hash = crypto.scryptSync('borderops', salt, 32).toString('hex');
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
      users: {
        alpha: {
          id: 'old-id-1', callsign: 'Alpha', passwordHash: `${salt}:${hash}`,
          loadout: { primary: 'ak203', secondary: 'pistol9mm', launcher: 'carlGustaf', tactical: 'smoke', lethal: 'frag' },
          stats: { kills: 5, deaths: 2, wins: 1, matchesPlayed: 3, score: 750 }
        },
        broken: { callsign: 12 }
      },
      sessions: { deadbeef: { callsign: 'Alpha' } },
      matches: [{ id: 'm', mode: 'TDM', winnerTeam: 'bharat', players: [{ callsign: 'Alpha', team: 'bharat', kills: 5, deaths: 2 }] }]
    }));
    const { store } = makeBackend({ dir });
    const u = store.findByCallsign('ALPHA');
    assert.equal(u.id, 'old-id-1');
    assert.deepEqual(u.loadout, { primary: 'ak203', secondary: 'pistol9mm', launcher: 'carlGustaf' });
    assert.equal(u.stats.kills, 5);
    assert.equal(u.stats.headshots, 0);
    assert.equal(store.counts().users, 1);
    assert.equal(store.recentMatches()[0].players[0].callsign, 'Alpha');
  });

  describe('recording matches', () => {
    const report = (over = {}) => validateReport({
      matchId: 'm1', mode: 'TDM', winnerTeam: 'bharat', draw: false, durationSec: 300, endedAt: new Date().toISOString(),
      scores: { bharat: 25, opfor: 20 },
      players: [], ...over
    });

    it('credits registered players, wins and score; ignores guests', () => {
      const { store } = makeBackend();
      const a = store.createUser({ callsign: 'Alpha', passwordHash: 'h' });
      const b = store.createUser({ callsign: 'Bravo', passwordHash: 'h' });
      const res = store.recordMatch(report({
        players: [
          { id: 'p1', callsign: 'Alpha', team: 'bharat', kills: 10, deaths: 3, headshots: 4, userId: a.id },
          { id: 'p2', callsign: 'Bravo', team: 'opfor', kills: 6, deaths: 9, headshots: 1, userId: b.id },
          { id: 'p3', callsign: 'Guest_1', team: 'opfor', kills: 20, deaths: 0, userId: null }
        ]
      }));
      assert.deepEqual(res, { recorded: true, duplicate: false, updated: 2 });
      assert.deepEqual(a.stats, { kills: 10, deaths: 3, headshots: 4, wins: 1, matchesPlayed: 1, score: 1250 });
      assert.deepEqual(b.stats, { kills: 6, deaths: 9, headshots: 1, wins: 0, matchesPlayed: 1, score: 600 });
    });

    it('reporting the same match twice changes nothing', () => {
      const { store } = makeBackend();
      const a = store.createUser({ callsign: 'Alpha', passwordHash: 'h' });
      const r = report({ players: [{ id: 'p1', callsign: 'Alpha', team: 'bharat', kills: 5, deaths: 1, userId: a.id }] });
      store.recordMatch(r);
      assert.equal(store.recordMatch(r).duplicate, true);
      assert.equal(a.stats.kills, 5);
      assert.equal(store.recentMatches().length, 1);
    });

    it('draws have no winners; free-for-all winners are found by player id', () => {
      const { store } = makeBackend();
      const a = store.createUser({ callsign: 'Alpha', passwordHash: 'h' });
      const b = store.createUser({ callsign: 'Bravo', passwordHash: 'h' });
      const rows = [
        { id: 'p1', callsign: 'Alpha', team: 'ffa', kills: 15, deaths: 2, userId: a.id },
        { id: 'p2', callsign: 'Bravo', team: 'ffa', kills: 9, deaths: 5, userId: b.id }
      ];
      store.recordMatch(report({ matchId: 'ffa1', mode: 'FFA', winnerTeam: null, winnerId: 'p1', players: rows }));
      assert.equal(a.stats.wins, 1);
      assert.equal(b.stats.wins, 0);
      store.recordMatch(report({ matchId: 'draw1', draw: true, winnerTeam: null, players: [{ ...rows[0], team: 'bharat' }] }));
      assert.equal(a.stats.wins, 1, 'a draw is not a win');
    });

    it('someone who stayed counts a match played even with no kills; someone who left at once does not', () => {
      const { store } = makeBackend();
      const a = store.createUser({ callsign: 'Alpha', passwordHash: 'h' });
      const b = store.createUser({ callsign: 'Bravo', passwordHash: 'h' });
      store.recordMatch(report({
        players: [
          { id: 'p1', callsign: 'Alpha', team: 'bharat', kills: 0, deaths: 0, present: true, userId: a.id },
          { id: 'p2', callsign: 'Bravo', team: 'opfor', kills: 0, deaths: 0, present: false, userId: b.id }
        ]
      }));
      assert.equal(a.stats.matchesPlayed, 1);
      assert.equal(b.stats.matchesPlayed, 0);
    });

    it('the leaderboard ranks by score and hides players who never played', () => {
      const { store } = makeBackend();
      const names = ['Alpha', 'Bravo', 'Charlie', 'Idle'];
      const users = names.map((callsign) => store.createUser({ callsign, passwordHash: 'h' }));
      store.recordMatch(report({
        players: [
          { id: 'p1', callsign: 'Alpha', team: 'bharat', kills: 3, deaths: 1, userId: users[0].id },
          { id: 'p2', callsign: 'Bravo', team: 'opfor', kills: 9, deaths: 1, userId: users[1].id },
          { id: 'p3', callsign: 'Charlie', team: 'opfor', kills: 9, deaths: 4, userId: users[2].id }
        ]
      }));
      const board = store.leaderboard();
      // Bravo and Charlie tie on 900 (callsign breaks the tie); Alpha has 3 kills + the win bonus = 550.
      assert.deepEqual(board.map((r) => [r.rank, r.callsign]), [[1, 'Bravo'], [2, 'Charlie'], [3, 'Alpha']]);
      assert.equal(board[0].stats.score, 900);
      assert.equal(board[2].stats.score, 550);
      assert.equal(board[0].passwordHash, undefined);
    });

    it('keeps only the most recent matches', () => {
      const { store } = makeBackend();
      for (let i = 0; i < MAX_RECENT_MATCHES + 10; i++) store.recordMatch(report({ matchId: `m${i}` }));
      assert.equal(store.matches.length, MAX_RECENT_MATCHES);
      assert.equal(store.recentMatches(3)[0].id, `m${MAX_RECENT_MATCHES + 9}`);
    });
  });
});

describe('report validation', () => {
  it('clamps numbers, caps strings and drops unknown fields', () => {
    const r = validateReport({
      matchId: 'abc-1', mode: 'TDM', durationSec: 1e12, draw: 'yes', roomId: 'x'.repeat(100), extra: 'ignored',
      players: [{ id: 'p1', callsign: 'y'.repeat(100), team: 'martians', kills: 1e9, deaths: -5, headshots: 1e9, userId: 'u1', evil: 1 }]
    });
    assert.equal(r.durationSec, 86400);
    assert.equal(r.draw, false);
    assert.equal(r.roomId.length, 24);
    assert.equal(r.extra, undefined);
    assert.deepEqual(r.players[0], {
      id: 'p1', callsign: 'y'.repeat(18), team: 'ffa', kills: 100, deaths: 0, headshots: 100, present: true, userId: 'u1'
    });
  });

  it('rejects reports that make no sense', () => {
    for (const bad of [null, [], 'x', {}, { matchId: '../x', mode: 'TDM', players: [] }, { matchId: 'a', mode: 'RPG', players: [] },
      { matchId: 'a', mode: 'TDM', players: 'no' }, { matchId: 'a', mode: 'TDM', players: new Array(41).fill({}) }]) {
      assert.throws(() => validateReport(bad), (e) => e.status === 400);
    }
  });
});

describe('API: meta', () => {
  it('health and arsenal', async () => {
    const { call } = makeBackend();
    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const arsenal = await call('GET', '/api/arsenal');
    assert.equal(arsenal.status, 200);
    assert.ok(arsenal.body.weapons.sig716);
    assert.ok(arsenal.body.healing.medkit);
    assert.deepEqual(arsenal.body.defaultLoadout, { primary: 'sig716', secondary: 'pistol9mm', launcher: 'carlGustaf' });
    assert.match(arsenal.headers['Cache-Control'], /max-age/);
  });

  it('unknown routes are 404 and unexpected failures are a generic 500', async () => {
    const b = makeBackend();
    assert.equal((await b.call('GET', '/api/nothing')).status, 404);
    const boom = createDispatcher({
      routes: [{ method: 'GET', path: '/api/boom', handler: async () => { throw new Error('secret internals'); } }],
      services: b.services
    });
    const res = await boom('GET', '/api/boom', {});
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /secret internals/);
  });
});

describe('API: accounts', () => {
  it('registers an account and returns a token the game server accepts', async () => {
    const b = makeBackend();
    const { token, user } = await register(b);
    assert.equal(user.callsign, 'Alpha');
    assert.equal(user.guest, false);
    assert.equal(user.passwordHash, undefined, 'the hash never leaves the server');
    const claims = verifyToken(token, SECRET);
    assert.equal(claims.sub, user.id);
    assert.equal(claims.name, 'Alpha');
    assert.equal(claims.guest, false);
    assert.ok(b.store.findById(user.id).passwordHash.startsWith('s1$'));
  });

  it('validates callsign and password on registration', async () => {
    const b = makeBackend();
    const attempt = (callsign, password) => b.call('POST', '/api/auth/register', { body: { callsign, password }, ip: `9.9.9.${Math.random()}` });
    for (const [callsign, password] of [['A', 'secret123'], ['x'.repeat(19), 'secret123'], ['has space', 'secret123'],
      ['<b>hi</b>', 'secret123'], ['', 'secret123'], ['Alpha', '123'], ['Alpha', ''], ['Alpha', 'x'.repeat(200)], [5, 'secret123']]) {
      const res = await attempt(callsign, password);
      assert.equal(res.status, 400, `${callsign}/${password}`);
      assert.ok(res.body.error);
    }
    assert.equal(b.store.counts().users, 0);
  });

  it('refuses a callsign that is already taken, whatever the capitalisation', async () => {
    const b = makeBackend();
    await register(b, 'Alpha');
    const res = await b.call('POST', '/api/auth/register', { body: { callsign: 'aLPHA', password: 'secret123' } });
    assert.equal(res.status, 409);
  });

  it('login needs the right password - there is no passwordless login any more', async () => {
    const b = makeBackend();
    await register(b, 'Alpha', 'secret123');
    const ok = await b.call('POST', '/api/auth/login', { body: { callsign: 'alpha', password: 'secret123' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.callsign, 'Alpha');

    const wrong = await b.call('POST', '/api/auth/login', { body: { callsign: 'Alpha', password: 'wrongpass' } });
    const unknown = await b.call('POST', '/api/auth/login', { body: { callsign: 'Nobody', password: 'secret123' } });
    const none = await b.call('POST', '/api/auth/login', { body: { callsign: 'Alpha' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error, unknown.body.error, 'does not reveal which callsigns exist');
    assert.equal(none.status, 400);
    assert.equal(b.store.counts().users, 1, 'login never creates accounts');
  });

  it('a legacy password hash is upgraded after a successful login', async () => {
    const b = makeBackend();
    const salt = 'aa11bb22cc33dd44';
    const legacy = `${salt}:${crypto.scryptSync('borderops', salt, 32).toString('hex')}`;
    const user = b.store.createUser({ callsign: 'Veteran', passwordHash: legacy });
    const res = await b.call('POST', '/api/auth/login', { body: { callsign: 'Veteran', password: 'borderops' } });
    assert.equal(res.status, 200);
    assert.ok(user.passwordHash.startsWith('s1$'));
    assert.equal((await b.call('POST', '/api/auth/login', { body: { callsign: 'Veteran', password: 'borderops' } })).status, 200);
  });

  it('guest play: instant token, cleaned callsign, cannot copy a registered name', async () => {
    const b = makeBackend();
    await register(b, 'Alpha');
    const guest = await b.call('POST', '/api/auth/guest', { body: { callsign: '<Rookie>!!' } });
    assert.equal(guest.status, 201);
    assert.equal(guest.body.user.callsign, 'Rookie');
    assert.equal(guest.body.user.guest, true);
    const claims = verifyToken(guest.body.token, SECRET);
    assert.equal(claims.guest, true);
    assert.match(claims.sub, /^g_[0-9a-f]{16}$/);
    assert.equal(b.store.counts().users, 1, 'guests are not stored');

    const copy = await b.call('POST', '/api/auth/guest', { body: { callsign: 'alpha' } });
    assert.equal(copy.status, 409);
    const anon = await b.call('POST', '/api/auth/guest', { body: {} });
    assert.match(anon.body.user.callsign, /^Guest_\d{4}$/);
  });

  it('/me works for accounts and guests, and refuses bad or service tokens', async () => {
    const b = makeBackend();
    const { token } = await register(b);
    assert.equal((await b.call('GET', '/api/auth/me', { token })).body.user.callsign, 'Alpha');
    const guest = (await b.call('POST', '/api/auth/guest', { body: { callsign: 'Rookie' } })).body;
    assert.equal((await b.call('GET', '/api/auth/me', { token: guest.token })).body.user.guest, true);
    for (const bad of [undefined, 'garbage', `${token}x`, serviceToken(), signToken({ sub: 'x' }, 'other-secret', 1000)]) {
      assert.equal((await b.call('GET', '/api/auth/me', { token: bad })).status, 401);
    }
    const expired = signToken({ sub: 'x', name: 'x', guest: false }, SECRET, -1000);
    assert.equal((await b.call('GET', '/api/auth/me', { token: expired })).status, 401);
  });

  it('a token for a deleted account stops working', async () => {
    const b = makeBackend();
    const { token, user } = await register(b);
    b.store.byId.delete(user.id);
    assert.equal((await b.call('GET', '/api/auth/me', { token })).status, 401);
  });
});

describe('API: loadouts', () => {
  it('saves valid choices and keeps the slots that were not sent', async () => {
    const b = makeBackend();
    const { token } = await register(b);
    const res = await b.call('POST', '/api/loadout/save', { token, body: { primary: 'svd' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.loadout, { primary: 'svd', secondary: 'pistol9mm', launcher: 'carlGustaf' });
    const res2 = await b.call('POST', '/api/loadout/save', { token, body: { launcher: 'carlGustaf', secondary: 'pistol9mm' } });
    assert.equal(res2.body.loadout.primary, 'svd', 'saving other slots does not wipe the primary');
    assert.equal((await b.call('GET', '/api/loadout', { token })).body.loadout.primary, 'svd');
  });

  it('rejects unknown weapons, wrong slots, air-drop guns and empty requests', async () => {
    const b = makeBackend();
    const { token } = await register(b);
    for (const body of [{ primary: 'laser' }, { primary: 'pistol9mm' }, { secondary: 'sig716' }, { launcher: 'sig716' },
      { primary: 'trg42' }, { primary: 'negev' }, { primary: '__proto__' }, { primary: { a: 1 } }, {}, { tactical: 'smoke' }]) {
      const res = await b.call('POST', '/api/loadout/save', { token, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(b.store.findByCallsign('Alpha').loadout.primary, 'sig716');
  });

  it('needs an account: no token is 401, guests are 403', async () => {
    const b = makeBackend();
    assert.equal((await b.call('POST', '/api/loadout/save', { body: { primary: 'svd' } })).status, 401);
    const guest = (await b.call('POST', '/api/auth/guest', { body: { callsign: 'Rookie' } })).body;
    assert.equal((await b.call('POST', '/api/loadout/save', { token: guest.token, body: { primary: 'svd' } })).status, 403);
    assert.equal((await b.call('GET', '/api/loadout', { token: guest.token })).body.loadout.primary, 'sig716');
  });
});

describe('API: leaderboard and match reports', () => {
  const body = (userId) => ({
    matchId: 'match-1', mode: 'TDM', winnerTeam: 'bharat', draw: false, durationSec: 240,
    scores: { bharat: 25, opfor: 17 },
    players: [{ id: 'p1', callsign: 'Alpha', team: 'bharat', kills: 11, deaths: 4, headshots: 3, userId }]
  });

  it('only the game server may post results', async () => {
    const b = makeBackend();
    const { token, user } = await register(b);
    assert.equal((await b.call('POST', '/api/leaderboard/match', { body: body(user.id) })).status, 401);
    assert.equal((await b.call('POST', '/api/leaderboard/match', { token, body: body(user.id) })).status, 401, 'a player token cannot report');
    assert.equal((await b.call('POST', '/api/leaderboard/match', { token: signToken({ role: 'server' }, 'wrong', 1000), body: body(user.id) })).status, 401);
    assert.equal(b.store.findByCallsign('Alpha').stats.kills, 0);
  });

  it('records a match, shows the leaderboard and is safe to retry', async () => {
    const b = makeBackend();
    const { user } = await register(b);
    const first = await b.call('POST', '/api/leaderboard/match', { token: serviceToken(), body: body(user.id) });
    assert.equal(first.status, 200);
    assert.equal(first.body.updated, 1);
    const retry = await b.call('POST', '/api/leaderboard/match', { token: serviceToken(), body: body(user.id) });
    assert.equal(retry.body.duplicate, true);

    const board = (await b.call('GET', '/api/leaderboard')).body;
    assert.equal(board.leaderboard.length, 1);
    assert.deepEqual(board.leaderboard[0], {
      rank: 1, callsign: 'Alpha',
      stats: { kills: 11, deaths: 4, headshots: 3, wins: 1, matchesPlayed: 1, score: 1350 }
    });
    assert.equal(board.recentMatches[0].winnerTeam, 'bharat');
    assert.equal(JSON.stringify(board).includes(user.id), false, 'account ids stay private');
  });

  it('refuses nonsense reports', async () => {
    const b = makeBackend();
    for (const bad of [null, { mode: 'TDM' }, { ...body('x'), mode: 'LOL' }, { ...body('x'), players: 'many' }]) {
      const res = await b.call('POST', '/api/leaderboard/match', { token: serviceToken(), body: bad });
      assert.equal(res.status, 400);
    }
  });
});

describe('rate limiting', () => {
  it('stops password guessing per IP and recovers when the window passes', async () => {
    let t = 1_000_000;
    const b = makeBackend({ now: () => t });
    const login = (ip) => b.call('POST', '/api/auth/login', { body: { callsign: 'Nobody', password: 'guess1' }, ip });
    for (let i = 0; i < 12; i++) assert.equal((await login('1.2.3.4')).status, 401);
    const blocked = await login('1.2.3.4');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['Retry-After']) >= 1);
    assert.equal((await login('5.6.7.8')).status, 401, 'other clients are not affected');
    t += 61_000;
    assert.equal((await login('1.2.3.4')).status, 401, 'the window reset');
  });

  it('the limiter forgets old clients instead of growing without bound', () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => t, maxKeys: 10 });
    for (let i = 0; i < 6; i++) limiter.check(`ip${i}`);
    t = 5000;
    for (let i = 0; i < 6; i++) assert.equal(limiter.check(`new${i}`).ok, true);
  });
});

describe('Express wiring (with a recording fake)', () => {
  function fakeExpress() {
    const calls = [];
    const app = {
      disable: (...a) => calls.push(['disable', ...a]),
      set: (...a) => calls.push(['set', ...a]),
      use: (...a) => calls.push(['use', ...a]),
      get: (...a) => calls.push(['get', ...a]),
      post: (...a) => calls.push(['post', ...a])
    };
    const express = () => app;
    express.json = (o) => ({ marker: 'json', o });
    express.static = (dir, o) => ({ marker: 'static', dir, o });
    const cors = (o) => ({ marker: 'cors', o });
    return { express, cors, calls };
  }

  it('registers every route, in a sensible order', () => {
    const b = makeBackend();
    const f = fakeExpress();
    createApp({ express: f.express, cors: f.cors, routes, services: b.services, config: { ...b.config, serveFrontend: true, trustProxy: 1 } });

    assert.deepEqual(f.calls.find((c) => c[0] === 'disable'), ['disable', 'x-powered-by']);
    assert.deepEqual(f.calls.find((c) => c[0] === 'set'), ['set', 'trust proxy', 1]);
    const registered = f.calls.filter((c) => c[0] === 'get' || c[0] === 'post').map((c) => `${c[0].toUpperCase()} ${c[1]}`);
    assert.deepEqual(registered.sort(), routes.map((r) => `${r.method} ${r.path}`).sort());

    const uses = f.calls.filter((c) => c[0] === 'use');
    assert.equal(uses[0][1].marker, 'cors');
    assert.equal(uses[1][1], securityHeaders);
    assert.equal(uses[2][1], '/api');
    assert.equal(uses[2][2].marker, 'json');
    assert.equal(uses[2][2].o.limit, '16kb');
    const staticIndex = uses.findIndex((u) => u[1].marker === 'static');
    assert.ok(staticIndex > 3, 'static files come after the API');
    assert.equal(typeof uses[uses.length - 1][1], 'function', 'the error handler is last');
  });

  it('can run without serving the frontend', () => {
    const b = makeBackend();
    const f = fakeExpress();
    createApp({ express: f.express, cors: f.cors, routes, services: b.services, config: { ...b.config, serveFrontend: false } });
    assert.equal(f.calls.some((c) => c[0] === 'use' && c[1]?.marker === 'static'), false);
    assert.equal(f.calls.some((c) => c[0] === 'set'), false);
  });

  it('the Express handler sends the dispatcher result', async () => {
    const sent = {};
    const res = {
      set(h) { sent.headers = h; },
      status(s) { sent.status = s; return this; },
      json(b) { sent.body = b; }
    };
    const dispatch = async (method, path, request) => ({ status: 201, headers: { 'X-A': '1' }, body: { echo: request.ip } });
    await expressHandler(dispatch, { method: 'POST', path: '/x' })({ body: {}, query: {}, headers: {}, ip: '1.1.1.1' }, res);
    assert.deepEqual(sent, { headers: { 'X-A': '1' }, status: 201, body: { echo: '1.1.1.1' } });
  });

  it('security headers and the error handler', () => {
    const headers = {};
    securityHeaders({ path: '/api/auth/me' }, { setHeader: (k, v) => { headers[k] = v; } }, () => {});
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['Cache-Control'], 'no-store');
    const page = {};
    securityHeaders({ path: '/index.html' }, { setHeader: (k, v) => { page[k] = v; } }, () => {});
    assert.equal(page['Cache-Control'], undefined);

    const errors = [];
    const handler = errorHandler({ error: (...a) => errors.push(a) });
    const run = (err) => {
      const out = {};
      const res = { headersSent: false, status(s) { out.status = s; return this; }, json(b) { out.body = b; } };
      handler(err, {}, res, () => {});
      return out;
    };
    assert.equal(run({ type: 'entity.parse.failed' }).status, 400);
    assert.equal(run({ type: 'entity.too.large' }).status, 413);
    assert.equal(run({ status: 404 }).status, 404);
    assert.equal(errors.length, 0);
    const crash = run(new Error('db exploded'));
    assert.equal(crash.status, 500);
    assert.doesNotMatch(JSON.stringify(crash.body), /exploded/);
    assert.equal(errors.length, 1);
  });
});

describe('configuration', () => {
  it('has local defaults, and demands a secret in production', () => {
    const c = loadConfig({});
    assert.equal(c.port, 4000);
    assert.equal(c.usingDevSecret, true);
    assert.equal(c.corsOrigins, '*');
    assert.equal(c.serveFrontend, true);
    assert.equal(c.trustProxy, false);
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SHARED_SECRET/);
    assert.equal(loadConfig({ NODE_ENV: 'production', SHARED_SECRET: 'x' }).usingDevSecret, false);
  });

  it('reads the environment', () => {
    const c = loadConfig({ PORT: '9000', DATA_DIR: '/tmp/ibo-x', CORS_ORIGIN: 'https://a.com,https://b.com', SERVE_FRONTEND: '0', TOKEN_TTL_DAYS: '2' });
    assert.equal(c.port, 9000);
    assert.equal(c.dataDir, '/tmp/ibo-x');
    assert.deepEqual(c.corsOrigins, ['https://a.com', 'https://b.com']);
    assert.equal(c.serveFrontend, false);
    assert.equal(c.userTokenTtlMs, 2 * 86400000);
    assert.equal(parseOrigins('*'), '*');
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('loopback'), 'loopback');
    assert.equal(parseTrustProxy('0'), false);
  });
});
