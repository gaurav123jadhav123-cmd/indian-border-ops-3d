import test from 'node:test';
import assert from 'node:assert/strict';
import { Interpolator } from '../../js/game/interp.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const at = (x, z = 0, yaw = 0, pitch = 0, y = 0) => ({ x, y, z, yaw, pitch });

test('nothing known yet: null', () => {
  assert.equal(new Interpolator().sample(1000), null);
});

test('one snapshot: stand still there', () => {
  const i = new Interpolator();
  i.push(1000, at(5, 6));
  assert.deepEqual(i.sample(5000), { t: 1000, x: 5, y: 0, z: 6, yaw: 0, pitch: 0 });
});

test('blends between the two snapshots around (now - delay)', () => {
  const i = new Interpolator({ delayMs: 100 });
  i.push(1000, at(0, 0, 0, 0, 0));
  i.push(1050, at(10, 4, 0.5, 0.2, 2));
  const s = i.sample(1125); // 1125 - 100 = 1025: halfway
  near(s.x, 5);
  near(s.z, 2);
  near(s.y, 1);
  near(s.yaw, 0.25);
  near(s.pitch, 0.1);
});

test('the blend is weighted by time, not just a midpoint (a quarter of the way is a quarter of the distance)', () => {
  const i = new Interpolator({ delayMs: 100 });
  i.push(1000, at(0, 0, 0, 0, 0));
  i.push(1100, at(8, 4, 1, 0.4, 2));
  const s = i.sample(1125); // 1025: a quarter of the way
  near(s.x, 2);
  near(s.z, 1);
  near(s.y, 0.5);
  near(s.yaw, 0.25);
  near(s.pitch, 0.1);
});

test('before the first snapshot: hold the first one', () => {
  const i = new Interpolator({ delayMs: 100 });
  i.push(1000, at(1));
  i.push(1050, at(2));
  assert.equal(i.sample(1000).x, 1); // t = 900 < 1000
});

test('out of snapshots: coast on the last velocity, but only for maxExtrapolateMs', () => {
  const i = new Interpolator({ delayMs: 100, maxExtrapolateMs: 120 });
  i.push(1000, at(0));
  i.push(1050, at(5)); // 5 units per 50 ms
  // t = 1100 -> 50 ms ahead of the last snapshot: one more step
  near(i.sample(1200).x, 10);
  // a long silence: capped at 120 ms of coasting = 2.4 steps
  near(i.sample(9000).x, 5 + 5 * (120 / 50));
  // the view direction is not extrapolated
  i.push(1100, at(10, 0, 1.0, 0.3));
  const s = i.sample(9000);
  assert.equal(s.yaw, 1.0);
  assert.equal(s.pitch, 0.3);
});

test('turning picks the short way across +-pi', () => {
  const i = new Interpolator({ delayMs: 0 });
  i.push(1000, at(0, 0, Math.PI - 0.1));
  i.push(1100, at(0, 0, -Math.PI + 0.1));
  const mid = i.sample(1050).yaw;
  near(Math.abs(mid), Math.PI, 1e-9);
});

test('a big jump (respawn) does not slide across the map', () => {
  const i = new Interpolator({ delayMs: 100, teleportDistance: 12 });
  i.push(1000, at(0, 0));
  i.push(1050, at(1, 0));
  i.push(1100, at(100, 100)); // died and respawned far away
  assert.equal(i.samples.length, 1);
  assert.equal(i.sample(1100).x, 100);
});

test('old or duplicate timestamps are ignored', () => {
  const i = new Interpolator();
  i.push(1000, at(1));
  i.push(1000, at(2));
  i.push(900, at(3));
  assert.equal(i.samples.length, 1);
  assert.equal(i.samples[0].x, 1);
});

test('only the latest maxSamples are kept', () => {
  const i = new Interpolator({ maxSamples: 4 });
  for (let k = 0; k < 10; k++) i.push(1000 + k * 50, at(k));
  assert.equal(i.samples.length, 4);
  assert.equal(i.samples[0].x, 6);
});

test('clear forgets everything', () => {
  const i = new Interpolator();
  i.push(1000, at(1));
  i.clear();
  assert.equal(i.sample(1000), null);
});

test('sample never returns a reference to the stored snapshot', () => {
  const i = new Interpolator();
  i.push(1000, at(1));
  const s = i.sample(1000);
  s.x = 99;
  assert.equal(i.samples[0].x, 1);
});
