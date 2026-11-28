import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../../js/game/state.js';

const player = (id, x = 0, z = 0, alive = true) => ({ id, callsign: id.toUpperCase(), team: 'bharat', x, y: 0, z, yaw: 0, pitch: 0, alive });
const snap = (seq, players, extra = {}) => ({ seq, players, me: { hp: 100 }, scores: { bharat: 1, opfor: 2 }, timeLeftSec: 400, ...extra });

const JOIN = { playerId: 'p1', mode: 'TDM', team: 'opfor', callsign: 'Veer', roomId: 'alpha', rules: { matchSeconds: 480 } };

test('a fresh state is empty', () => {
  const s = new GameState();
  assert.equal(s.joined, false);
  assert.equal(s.myId, null);
  assert.equal(s.me, null);
  assert.equal(s.myPublic(), null);
  assert.equal(s.myDrone(), null);
  assert.deepEqual(s.others(), []);
});

test('applyJoin takes the identity, the rules and the first snapshot', () => {
  const s = new GameState();
  s.applyJoin({ ...JOIN, snapshot: snap(1, [player('p1'), player('p2')]) }, 1000);
  assert.equal(s.joined, true);
  assert.equal(s.myId, 'p1');
  assert.equal(s.team, 'opfor');
  assert.equal(s.callsign, 'Veer');
  assert.equal(s.roomId, 'alpha');
  assert.deepEqual(s.rules, { matchSeconds: 480 });
  assert.equal(s.gotFirstSnapshot, true);
  assert.equal(s.snapshotAt, 1000);
  assert.equal(s.myPublic().id, 'p1');
  assert.deepEqual(s.others().map((o) => o.data.id), ['p2']);
  assert.equal(s.timeLeftSec, 400);
});

test('applyJoin without a snapshot leaves the state waiting', () => {
  const s = new GameState();
  s.applyJoin(JOIN, 1000);
  assert.equal(s.joined, true);
  assert.equal(s.gotFirstSnapshot, false);
});

test('joining again starts from a clean state', () => {
  const s = new GameState();
  s.applyJoin({ ...JOIN, snapshot: snap(5, [player('p1'), player('p2')]) }, 1000);
  s.applyJoin({ ...JOIN, playerId: 'p9' }, 2000);
  assert.equal(s.myId, 'p9');
  assert.equal(s.players.size, 0);
  assert.equal(s.seq, 0);
});

test('snapshots update players, and players that left disappear', () => {
  const s = new GameState();
  s.applyJoin(JOIN, 0);
  s.applySnapshot(snap(1, [player('p1'), player('p2', 5, 5), player('p3')]), 100);
  assert.equal(s.players.size, 3);
  s.applySnapshot(snap(2, [player('p1'), player('p2', 6, 5)]), 150);
  assert.equal(s.players.size, 2);
  assert.equal(s.players.get('p2').data.x, 6);
  assert.equal(s.players.has('p3'), false);
  assert.deepEqual(s.scores, { bharat: 1, opfor: 2 });
});

test('old snapshots (arriving out of order) are ignored, but seq 0 (a new match) is accepted', () => {
  const s = new GameState();
  s.applyJoin(JOIN, 0);
  s.applySnapshot(snap(10, [player('p1', 1)]), 100);
  s.applySnapshot(snap(9, [player('p1', 99)]), 120);
  assert.equal(s.players.get('p1').data.x, 1);
  assert.equal(s.seq, 10);
  s.applySnapshot(snap(0, [player('p1', 7)]), 140);
  assert.equal(s.players.get('p1').data.x, 7);
});

test('garbage snapshots are ignored', () => {
  const s = new GameState();
  s.applyJoin(JOIN, 0);
  assert.doesNotThrow(() => s.applySnapshot(null, 1));
  assert.doesNotThrow(() => s.applySnapshot('x', 1));
  assert.equal(s.gotFirstSnapshot, false);
});

test('missing lists in a snapshot become empty lists, the private block is kept when absent', () => {
  const s = new GameState();
  s.applyJoin(JOIN, 0);
  s.applySnapshot({ seq: 1, players: [], me: { hp: 55 }, drones: [{ id: 'd1' }], grenades: [{ id: 'g' }] }, 10);
  assert.equal(s.me.hp, 55);
  assert.equal(s.drones.length, 1);
  s.applySnapshot({ seq: 2, players: [] }, 20);
  assert.equal(s.me.hp, 55);
  assert.deepEqual(s.drones, []);
  assert.deepEqual(s.grenades, []);
  assert.deepEqual(s.airdrops, []);
  assert.deepEqual(s.rockets, []);
  assert.deepEqual(s.missiles, []);
});

test('a player who dies or respawns does not slide: the smoothing history is cleared', () => {
  const s = new GameState();
  s.applyJoin(JOIN, 0);
  s.applySnapshot(snap(1, [player('p2', 0, 0, true)]), 100);
  s.applySnapshot(snap(2, [player('p2', 1, 0, true)]), 150);
  assert.equal(s.players.get('p2').interp.samples.length, 2);
  s.applySnapshot(snap(3, [player('p2', 1, 0, false)]), 200);
  assert.equal(s.players.get('p2').interp.samples.length, 1);
});

test('myDrone finds the drone I am flying', () => {
  const s = new GameState();
  s.applyJoin(JOIN, 0);
  s.applySnapshot({ seq: 1, players: [], me: { droneId: 'd2' }, drones: [{ id: 'd1' }, { id: 'd2', x: 3 }] }, 10);
  assert.equal(s.myDrone().x, 3);
  s.applySnapshot({ seq: 2, players: [], me: { droneId: null }, drones: [{ id: 'd1' }] }, 20);
  assert.equal(s.myDrone(), null);
  s.applySnapshot({ seq: 3, players: [], me: { droneId: 'gone' }, drones: [] }, 30);
  assert.equal(s.myDrone(), null);
});

test('crateNear: only landed crates, the closest one, within the radius', () => {
  const s = new GameState();
  s.applyJoin(JOIN, 0);
  s.applySnapshot({
    seq: 1,
    players: [],
    airdrops: [
      { id: 'a', x: 10, z: 0, landed: true },
      { id: 'b', x: 3, z: 0, landed: true },
      { id: 'c', x: 1, z: 0, landed: false }
    ]
  }, 10);
  assert.equal(s.crateNear(0, 0, 5).id, 'b');
  assert.equal(s.crateNear(0, 0, 2), null); // c is closest but still falling
  assert.equal(s.crateNear(10, 0, 0.5).id, 'a');
  assert.equal(s.crateNear(100, 100, 5), null);
});
