import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRoom, join, place, unprotect, run, moveMsg, aimAt, duel, fakeConn, seeded, RULES
} from './helpers.js';
import { getTerrainHeight, MOVE, MAP_HALF_SIZE } from '../src/shared/world.js';
import { withRules } from '../src/rules.js';

describe('joining a match', () => {
  test('TDM balances teams, FFA uses one free-for-all team', () => {
    const { room } = makeRoom();
    const names = ['A1', 'B2', 'C3', 'D4', 'E5'];
    const teams = names.map((n) => join(room, n).p.team);
    assert.deepEqual(teams, ['bharat', 'opfor', 'bharat', 'opfor', 'bharat']);

    const ffa = makeRoom({ mode: 'FFA' });
    assert.equal(join(ffa.room, 'Solo').p.team, 'ffa');
  });

  test('callsigns are cleaned and made unique inside a room', () => {
    const { room } = makeRoom();
    assert.equal(join(room, 'Rahul<script>').p.callsign, 'Rahulscript');
    assert.equal(join(room, 'Vikram').p.callsign, 'Vikram');
    const twin = join(room, 'vikram', { id: 'someone-else' });
    assert.equal(twin.p.callsign, 'vikram_2');
    assert.match(join(room, '!').p.callsign, /^Soldier_\d+$/);
  });

  test('capacity is enforced, but a returning player always gets back in', () => {
    const { room } = makeRoom({ capacity: 2 });
    join(room, 'One');
    const two = join(room, 'Two');
    const full = room.join(fakeConn('x'), { id: 'id_Three', name: 'Three', guest: false }, {}, room.clock());
    assert.equal(full.ok, false);
    assert.match(full.error, /full/i);

    const again = room.join(fakeConn('y'), { id: 'id_Two', name: 'Two', userId: 'id_Two', guest: false }, {}, room.clock());
    assert.equal(again.ok, true);
    assert.equal(again.resumed, true);
    assert.equal(again.player, two.p);
  });

  test('joining again from another tab takes over the soldier and kicks the old connection', () => {
    const { room, clock } = makeRoom();
    const first = join(room, 'Gaurav');
    first.p.kills = 3;
    const oldEpoch = first.p.epoch;
    const secondConn = fakeConn('tab2');
    const res = room.join(secondConn, { id: 'id_Gaurav', name: 'Gaurav', userId: 'id_Gaurav', guest: false }, {}, clock());
    assert.equal(res.resumed, true);
    assert.equal(res.player.kills, 3, 'stats are kept');
    assert.equal(res.player.conn, secondConn);
    assert.ok(res.player.epoch > oldEpoch, 'client must re-sync its position');
    assert.equal(first.conn.count('kicked'), 1);
    assert.equal(first.conn.disconnected, true);
    // the old connection can no longer detach or leave the new session
    assert.equal(room.detach(res.player, first.conn), false);
    assert.equal(res.player.connected, true);
  });

  test('a guest with a brand new token reclaims the soldier with the resume key', () => {
    const { room, clock } = makeRoom();
    const g = join(room, 'Guesty', { guest: true, id: 'guest-1' });
    room.detach(g.p, g.conn, clock());
    const res = room.join(fakeConn('new'), { id: 'guest-2', name: 'Guesty', userId: null, guest: true },
      { resumeKey: g.p.resumeKey }, clock());
    assert.equal(res.resumed, true);
    assert.equal(res.player, g.p);
    assert.equal(g.p.identityId, 'guest-2');
  });

  test('a stranger cannot claim somebody else\'s soldier with a wrong resume key', () => {
    const { room, clock } = makeRoom();
    const a = join(room, 'Alpha');
    const res = room.join(fakeConn('evil'), { id: 'id_Eve', name: 'Eve', userId: 'id_Eve', guest: false },
      { resumeKey: 'f'.repeat(32) }, clock());
    assert.equal(res.resumed, false);
    assert.notEqual(res.player, a.p);
  });

  test('soldiers spawn on their own side, facing the enemy, on the ground', () => {
    const { room } = makeRoom({ rng: seeded(7) });
    const north = join(room, 'North').p; // bharat
    const south = join(room, 'South').p; // opfor
    assert.equal(north.team, 'bharat');
    assert.ok(north.z < -80 && north.z > -105);
    assert.ok(Math.abs(north.yaw - Math.PI) < 1e-9, 'bharat looks toward +Z');
    assert.ok(south.z > 80 && south.z < 105);
    assert.equal(south.yaw, 0, 'opfor looks toward -Z');
    for (const p of [north, south]) assert.ok(Math.abs(p.y - getTerrainHeight(p.x, p.z)) < 1e-9);

    const ffa = makeRoom({ mode: 'FFA', rng: seeded(3) });
    const solo = join(ffa.room, 'Solo').p;
    // yaw = atan2(x, z) means the forward vector (-sin yaw, -cos yaw) points at the origin
    const fx = -Math.sin(solo.yaw);
    const fz = -Math.cos(solo.yaw);
    const towardCentre = (-solo.x * fx - solo.z * fz) / Math.hypot(solo.x, solo.z);
    assert.ok(towardCentre > 0.999, `FFA soldier should face the centre, got ${towardCentre}`);
  });

  test('new soldiers are spawn-protected and respect the best-of-8 rule', () => {
    const { room, clock } = makeRoom({ rng: seeded(11) });
    const a = join(room, 'A').p;
    place(a, 0, 92); // an opfor-side enemy would stand here
    a.team = 'opfor';
    const b = join(room, 'B').p; // bharat
    assert.ok(b.invulnUntil > clock());
    // both on opposite ends
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 150);
  });

  test('match_joined carries a full private state and rules, but snapshots hide other people\'s secrets', () => {
    const { room, clock } = makeRoom();
    const a = join(room, 'Alpha');
    const b = join(room, 'Bravo');
    const payload = room.joinPayload(a.p, false, clock());
    assert.equal(payload.playerId, a.p.id);
    assert.match(payload.resumeKey, /^[a-f0-9]{32}$/);
    assert.equal(payload.snapshot.me.inventory.frag, 2);
    assert.equal(payload.snapshot.me.ammo.primary.mag, 20);
    assert.equal(payload.rules.matchSeconds, 480);

    const snap = room.snapshotFor(a.p, clock());
    const other = snap.players.find((p) => p.id === b.p.id);
    for (const secret of ['inventory', 'ammo', 'armor', 'boost', 'loadout', 'cooldowns', 'resumeKey', 'identityId', 'userId']) {
      assert.equal(secret in other, false, `public player block leaks ${secret}`);
    }
    assert.equal(JSON.stringify(snap.players).includes('resumeKey'), false);
  });
});

describe('connections dropping and coming back', () => {
  test('a disconnected soldier is a ghost: invisible, unhittable, then removed after the grace period', () => {
    const { room, clock } = duel();
    const { a, b } = { a: room.players.get('p1'), b: room.players.get('p2') };
    const connA = a.conn;
    assert.equal(room.detach(a, connA, clock()), true);
    assert.equal(a.status, 'grace');
    const snap = room.snapshotFor(b, clock());
    assert.equal(snap.players.some((p) => p.id === a.id), false, 'ghosts are not shown');

    const res = room.dealDamage(b, a, 50, { weapon: 'test' });
    assert.equal(res, null, 'ghosts cannot be hurt');

    run(room, clock, RULES.reconnectGraceMs + 100);
    assert.equal(a.status, 'left');
    assert.equal(room.presentCount(), 1);
  });

  test('reconnecting inside the grace period restores the same soldier', () => {
    const { room, clock } = duel();
    const a = room.players.get('p1');
    a.kills = 4;
    room.detach(a, a.conn, clock());
    run(room, clock, 5000);
    const conn = fakeConn('back');
    const res = room.join(conn, { id: a.identityId, name: 'Alpha', userId: a.userId, guest: false }, {}, clock());
    assert.equal(res.resumed, true);
    assert.equal(res.player.kills, 4);
    assert.equal(a.connected, true);
    assert.equal(a.status, 'active');
  });

  test('a player who left for good starts fresh when they join again, but their old stats stay in the summary', () => {
    let report = null;
    const { room, clock } = makeRoom({ onEnd: (r) => { report = r; } });
    const a = join(room, 'Alpha');
    const b = join(room, 'Bravo');
    a.p.kills = 6; a.p.deaths = 2;
    assert.equal(room.leave(a.p, a.conn, clock()), true);
    const again = join(room, 'Alpha', { id: 'id_Alpha' });
    assert.notEqual(again.p, a.p);
    assert.equal(again.p.kills, 0);
    room.finish('time', clock());
    const rows = report.players.filter((r) => r.callsign === 'Alpha');
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.kills === 6 && r.present === false));
    assert.ok(b.conn.count('match_ended') === 1);
  });

  test('an empty room reports itself as empty', () => {
    const { room, clock } = makeRoom();
    const a = join(room, 'Alpha');
    assert.equal(room.isEmpty(), false);
    room.leave(a.p, a.conn, clock());
    assert.equal(room.isEmpty(), true);
  });
});

describe('movement validation', () => {
  function walker() {
    const { room, clock } = makeRoom();
    const a = join(room, 'Walker');
    place(a.p, 0, -90);
    unprotect(a.p);
    a.p.lastMoveAt = clock();
    return { room, clock, a };
  }

  test('normal running is accepted without corrections', () => {
    const { room, clock, a } = walker();
    const speed = 5.8; // a bit under SIG716 walking speed (6.2 * 0.94)
    let x = a.p.x;
    for (let i = 0; i < 40; i++) { // 2 seconds at 20Hz
      clock.advance(50);
      x += speed * 0.05;
      room.handleMove(a.p, moveMsg(a.p, { x, y: getTerrainHeight(x, a.p.z) }), clock());
    }
    assert.ok(Math.abs(a.p.x - x) < 0.01, `server position ${a.p.x} should follow client ${x}`);
    assert.equal(a.conn.count('correction'), 0);
  });

  test('a lag spike followed by a burst of movement does not trigger a correction', () => {
    const { room, clock, a } = walker();
    const speed = 5.8;
    clock.advance(500); // 0.5s of silence
    const x = a.p.x + speed * 0.5;
    room.handleMove(a.p, moveMsg(a.p, { x, y: getTerrainHeight(x, a.p.z) }), clock());
    assert.ok(Math.abs(a.p.x - x) < 0.01);
    assert.equal(a.conn.count('correction'), 0);
  });

  test('teleporting is refused and the client is snapped back with a new epoch', () => {
    const { room, clock, a } = walker();
    const startX = a.p.x;
    const epoch = a.p.epoch;
    clock.advance(50);
    room.handleMove(a.p, moveMsg(a.p, { x: startX + 60 }), clock());
    assert.ok(a.p.x - startX < 1.5, `moved ${a.p.x - startX}m in 50ms`);
    const fix = a.conn.last('correction');
    assert.ok(fix, 'a correction was sent');
    assert.equal(fix.epoch, epoch + 1);
    assert.ok(Math.abs(fix.x - a.p.x) < 0.01);
  });

  test('moves carrying an old epoch are ignored until the client applies the correction', () => {
    const { room, clock, a } = walker();
    clock.advance(50);
    room.handleMove(a.p, moveMsg(a.p, { x: a.p.x + 60 }), clock()); // -> correction, epoch + 1
    const frozenX = a.p.x;
    const stale = moveMsg(a.p, { x: frozenX + 1, epoch: a.p.epoch - 1 });
    clock.advance(50);
    room.handleMove(a.p, stale, clock());
    assert.equal(a.p.x, frozenX);
    clock.advance(600);
    room.handleMove(a.p, stale, clock());
    assert.ok(a.conn.count('correction') >= 2, 'the correction is re-sent for a client that missed it');
    // with the right epoch moves work again
    clock.advance(50);
    room.handleMove(a.p, moveMsg(a.p, { x: frozenX + 0.2 }), clock());
    assert.ok(Math.abs(a.p.x - (frozenX + 0.2)) < 1e-9);
  });

  test('sustained speed hacking falls behind and keeps getting corrected', () => {
    const { room, clock, a } = walker();
    const startX = a.p.x;
    let claimed = startX;
    for (let i = 0; i < 100; i++) { // 5 seconds at 3x speed
      clock.advance(50);
      claimed += 18 * 0.05;
      room.handleMove(a.p, moveMsg(a.p, { x: claimed }), clock());
    }
    const honestMax = (6.2 * 0.94) * 5 + 8; // generous: 5s of running + burst allowance
    assert.ok(a.p.x - startX < honestMax, `server allowed ${a.p.x - startX}m`);
    assert.ok(a.conn.count('correction') > 0);
  });

  test('height is clamped to the ground plus a jump', () => {
    const { room, clock, a } = walker();
    const ground = getTerrainHeight(a.p.x, a.p.z);
    clock.advance(50);
    room.handleMove(a.p, moveMsg(a.p, { y: ground + 80 }), clock());
    assert.ok(Math.abs(a.p.y - (ground + MOVE.maxRiseAboveGround)) < 1e-9);
    clock.advance(50);
    room.handleMove(a.p, moveMsg(a.p, { y: ground - 50 }), clock());
    assert.ok(Math.abs(a.p.y - ground) < 1e-9);
  });

  test('players cannot walk into a bunker or off the map', () => {
    const { room, clock, a } = makeRoom();
    const w = join(room, 'Wall');
    place(w.p, -7, 0); // 2 m west of the centre checkpoint (x -5..5)
    unprotect(w.p);
    w.p.lastMoveAt = clock();
    for (let i = 0; i < 20; i++) {
      clock.advance(50);
      room.handleMove(w.p, moveMsg(w.p, { x: w.p.x + 0.25, y: getTerrainHeight(w.p.x, w.p.z) }), clock());
    }
    assert.ok(w.p.x <= -5.4, `stopped at the wall, x=${w.p.x}`);

    place(w.p, MAP_HALF_SIZE - 3, 0);
    w.p.lastMoveAt = clock();
    clock.advance(1000);
    room.handleMove(w.p, moveMsg(w.p, { x: 500 }), clock());
    assert.ok(w.p.x <= MAP_HALF_SIZE - 1);
  });

  test('dead soldiers and drone pilots do not move', () => {
    const { room, clock, a } = walker();
    clock.advance(500);
    room.handleDeploy(a.p, { mode: 'recon' }, clock());
    const x0 = a.p.x;
    room.handleMove(a.p, moveMsg(a.p, { x: x0 + 2 }), clock());
    assert.equal(a.p.x, x0);
    room.endPilotedDrone(a.p, 'recalled');
    a.p.alive = false;
    room.handleMove(a.p, moveMsg(a.p, { x: x0 + 2 }), clock());
    assert.equal(a.p.x, x0);
  });
});

describe('snapshots', () => {
  test('about 20 per second per connected player, flagged volatile', () => {
    const { room, clock } = makeRoom();
    const a = join(room, 'Alpha');
    join(room, 'Bravo');
    a.conn.clear();
    run(room, clock, 1000);
    const n = a.conn.count('state_snapshot');
    assert.ok(n >= 18 && n <= 22, `got ${n} snapshots in a second`);
    assert.equal(a.conn.raw('state_snapshot')[0].opts.volatile, true);
  });

  test('each recipient gets their own private block', () => {
    const { room, clock } = makeRoom();
    const a = join(room, 'Alpha');
    const b = join(room, 'Bravo');
    b.p.hp = 40;
    run(room, clock, 100);
    assert.equal(a.conn.last('state_snapshot').me.hp, 100);
    assert.equal(b.conn.last('state_snapshot').me.hp, 40);
    assert.equal(b.conn.last('state_snapshot').timeLeftSec, 480);
  });
});

describe('match end', () => {
  test('TDM: first team to the score limit wins, once, and the report goes to the backend callback', () => {
    const reports = [];
    const { room, clock } = duel();
    room.onEnd = (r, s) => reports.push({ r, s });
    room.scores.bharat = RULES.tdmScoreLimit - 1;
    const a = room.players.get('p1');
    const b = room.players.get('p2');
    room.registerKill(a, b, 'SIG 716 G2', true, clock());
    run(room, clock, 100);

    assert.equal(room.ended, true);
    assert.equal(reports.length, 1);
    const { r, s } = reports[0];
    assert.equal(s.winnerTeam, 'bharat');
    assert.equal(s.reason, 'limit');
    assert.equal(s.draw, false);
    assert.equal(s.scores.bharat, RULES.tdmScoreLimit);
    assert.ok(r.players.find((p) => p.callsign === 'Alpha').userId, 'the report names registered accounts');
    assert.equal(JSON.stringify(s).includes('userId'), false, 'the public summary never does');
    assert.equal(a.conn.count('match_ended'), 1);

    // after the end nothing is accepted and nothing is reported twice
    room.handleShoot(a, { dir: { x: 0, y: 0, z: 1 } }, clock());
    room.finish('time', clock());
    run(room, clock, 500);
    assert.equal(reports.length, 1);
  });

  test('FFA: the first soldier to the kill limit wins', () => {
    const { room, clock } = duel({ mode: 'FFA' });
    const a = room.players.get('p1');
    const b = room.players.get('p2');
    a.kills = RULES.ffaKillLimit - 1;
    room.registerKill(a, b, 'SIG 716 G2', false, clock());
    run(room, clock, 50);
    assert.equal(room.ended, true);
    assert.equal(room.endInfo.winnerCallsign, 'Alpha');
    assert.equal(room.endInfo.scores, null);
  });

  test('time limit: the leader wins, a tie is a draw', () => {
    const t1 = duel();
    t1.room.scores.opfor = 3;
    run(t1.room, t1.clock, RULES.matchSeconds * 1000 + 100);
    assert.equal(t1.room.endInfo.reason, 'time');
    assert.equal(t1.room.endInfo.winnerTeam, 'opfor');

    const t2 = duel();
    run(t2.room, t2.clock, RULES.matchSeconds * 1000 + 100);
    assert.equal(t2.room.endInfo.draw, true);
    assert.equal(t2.room.endInfo.winnerTeam, null);

    const t3 = duel({ mode: 'FFA' });
    t3.room.players.get('p1').kills = 4;
    t3.room.players.get('p2').kills = 4;
    run(t3.room, t3.clock, RULES.matchSeconds * 1000 + 100);
    assert.equal(t3.room.endInfo.draw, true);
    assert.equal(t3.room.endInfo.winnerId, null);
  });

  test('an explosion that ends the match still counts every kill in it', () => {
    const { room, clock } = makeRoom({ rules: withRules({ tdmScoreLimit: 1 }) });
    const killer = join(room, 'Killer');
    const v1 = join(room, 'V1');
    const v2 = join(room, 'V2');
    v2.p.team = 'opfor'; v1.p.team = 'opfor';
    for (const s of [killer, v1, v2]) { place(s.p, 0, -90); unprotect(s.p); }
    room.explode({ x: 0, y: getTerrainHeight(0, -90) + 1, z: -90, radius: 8, damage: 500, ownerId: killer.p.id, weapon: 'test', kind: 'frag' });
    assert.equal(killer.p.kills, 2);
    assert.equal(room.scores.bharat, 2);
    run(room, clock, 50);
    assert.equal(room.ended, true);
  });
});
