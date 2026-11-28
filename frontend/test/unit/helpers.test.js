import test from 'node:test';
import assert from 'node:assert/strict';
import { damageAngle } from '../../js/ui/hud.js';
import { describeResult } from '../../js/ui/overlays.js';
import { rayHitsSphere } from '../../js/game/Game.js';
import { weaponSound } from '../../js/audio.js';
import { ARSENAL } from '../../js/shared/arsenal.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

// ------------------------------------------------------------------ damageAngle
test('damageAngle at yaw 0 (looking toward -Z): ahead, right, left, behind', () => {
  const me = { x: 0, z: 0, yaw: 0 };
  near(damageAngle(me, { x: 0, z: -10 }), 0);
  near(damageAngle(me, { x: 10, z: 0 }), Math.PI / 2);
  near(damageAngle(me, { x: -10, z: 0 }), -Math.PI / 2);
  near(Math.abs(damageAngle(me, { x: 0, z: 10 })), Math.PI);
});

test('damageAngle follows the way the player is facing', () => {
  // yaw +90 degrees: looking toward -X
  const me = { x: 5, z: 5, yaw: Math.PI / 2 };
  near(damageAngle(me, { x: -5, z: 5 }), 0);            // straight ahead
  near(damageAngle(me, { x: 5, z: -5 }), Math.PI / 2);  // -Z is on the right
  near(damageAngle(me, { x: 5, z: 15 }), -Math.PI / 2); // +Z is on the left
  // yaw 180 degrees: looking toward +Z
  near(damageAngle({ x: 0, z: 0, yaw: Math.PI }, { x: 0, z: 10 }), 0);
  near(damageAngle({ x: 0, z: 0, yaw: Math.PI }, { x: -10, z: 0 }), Math.PI / 2); // -X is on the right when facing +Z
});

test('damageAngle: no source or a source on top of you gives nothing to point at', () => {
  assert.equal(damageAngle({ x: 0, z: 0, yaw: 0 }, null), null);
  assert.equal(damageAngle({ x: 0, z: 0, yaw: 0 }, undefined), null);
  assert.equal(damageAngle({ x: 0, z: 0, yaw: 0 }, { x: 0.2, z: 0.2 }), null);
});

// ------------------------------------------------------------------ rayHitsSphere
test('rayHitsSphere: hits, misses, and distance limits', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 0, y: 0, z: -1 };
  near(rayHitsSphere(origin, dir, { x: 0, y: 0, z: -10 }, 1, 100), 10);
  near(rayHitsSphere(origin, dir, { x: 0.9, y: 0, z: -10 }, 1, 100), 10);
  assert.equal(rayHitsSphere(origin, dir, { x: 1.1, y: 0, z: -10 }, 1, 100), null); // passes beside it
  assert.equal(rayHitsSphere(origin, dir, { x: 0, y: 0, z: 10 }, 1, 100), null);    // behind the shooter
  assert.equal(rayHitsSphere(origin, dir, { x: 0, y: 0, z: -200 }, 1, 100), null);  // out of range
  assert.equal(rayHitsSphere(origin, dir, { x: 0, y: 0, z: -0.5 }, 1, 100), null);  // closer than 1 m is ignored (the shooter's own gun)
  assert.equal(rayHitsSphere(origin, dir, { x: 0, y: 3, z: -10 }, 1, 100), null);   // too high
  near(rayHitsSphere(origin, dir, { x: 0, y: 2.9, z: -10 }, 3, 100), 10 - 0 );      // inside a big radius
});

// ------------------------------------------------------------------ describeResult
const players = [
  { id: 'a', team: 'bharat' },
  { id: 'b', team: 'opfor' }
];

test('team match: victory, defeat and draw from my team', () => {
  const base = { mode: 'TDM', scores: { bharat: 25, opfor: 12 }, players, reason: 'limit' };
  const win = describeResult({ ...base, winnerTeam: 'bharat' }, { myId: 'a', team: 'bharat' });
  assert.equal(win.title, 'VICTORY');
  assert.equal(win.tone, 'win');
  assert.match(win.line, /BHARAT 25 .* 12 OPFOR/);
  assert.equal(win.reason, 'Score limit reached');

  const loss = describeResult({ ...base, winnerTeam: 'bharat' }, { myId: 'b', team: 'opfor' });
  assert.equal(loss.title, 'DEFEAT');
  assert.equal(loss.tone, 'loss');

  const draw = describeResult({ ...base, winnerTeam: null, draw: true, reason: 'time' }, { myId: 'a', team: 'bharat' });
  assert.equal(draw.title, 'DRAW');
  assert.equal(draw.tone, 'draw');
  assert.equal(draw.reason, 'Time is up');
});

test('team match: my team comes from the player list, falling back to the one I joined with', () => {
  const p = { mode: 'TDM', scores: { bharat: 1, opfor: 0 }, winnerTeam: 'bharat', players };
  assert.equal(describeResult(p, { myId: 'a', team: 'opfor' }).title, 'VICTORY'); // the list says bharat
  assert.equal(describeResult({ ...p, players: [] }, { myId: 'zzz', team: 'bharat' }).title, 'VICTORY');
  assert.equal(describeResult({ ...p, players: undefined }, { myId: 'zzz', team: 'opfor' }).title, 'DEFEAT');
});

test('free for all: victory for the winner, match over for everyone else, draw when nobody won', () => {
  const base = { mode: 'FFA', players, reason: 'time' };
  assert.equal(describeResult({ ...base, winnerId: 'a', winnerCallsign: 'Veer' }, { myId: 'a' }).title, 'VICTORY');
  const lose = describeResult({ ...base, winnerId: 'a', winnerCallsign: 'Veer' }, { myId: 'b' });
  assert.equal(lose.title, 'MATCH OVER');
  assert.match(lose.line, /Veer/);
  assert.equal(describeResult({ ...base, draw: true }, { myId: 'a' }).title, 'DRAW');
  assert.equal(describeResult({ ...base, winnerId: null }, { myId: 'a' }).title, 'DRAW');
  assert.match(describeResult({ ...base, winnerId: 'a' }, { myId: 'b' }).line, /unknown/);
});

test('unknown end reasons still read well', () => {
  assert.equal(describeResult({ mode: 'FFA', draw: true }, { myId: 'a' }).reason, 'Match finished');
  assert.equal(describeResult({ mode: 'FFA', draw: true, reason: 'shutdown' }, { myId: 'a' }).reason, 'The server is restarting');
});

// ------------------------------------------------------------------ weaponSound
test('every weapon in the arsenal maps to a sound the audio engine knows', () => {
  const known = new Set(['rifle', 'sniper', 'smg', 'pistol', 'launcher']);
  for (const w of Object.values(ARSENAL)) assert.ok(known.has(weaponSound(w)), `${w.id} -> ${weaponSound(w)}`);
  assert.equal(weaponSound(null), 'rifle');
  assert.equal(weaponSound(undefined), 'rifle');
  assert.equal(weaponSound({ category: 'sniper' }), 'sniper');
  assert.equal(weaponSound({ category: 'sidearm' }), 'pistol');
  assert.equal(weaponSound({ category: 'smg' }), 'smg');
  assert.equal(weaponSound({ category: 'launcher' }), 'launcher');
  assert.equal(weaponSound({ category: 'lmg' }), 'rifle');
});
