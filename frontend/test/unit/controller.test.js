import test from 'node:test';
import assert from 'node:assert/strict';
import { DroneControl, PITCH_LIMIT, PlayerController } from '../../js/game/controller.js';
import {
  MAP_HALF_SIZE, MOVE, OBSTACLES, PLAYER_RADIUS, getTerrainHeight, moveSpeed, resolveObstacles
} from '../../js/shared/world.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const STEP = 1 / 60;

/** A spot with nothing to bump into for 10 metres in every direction. */
function openSpot() {
  for (let x = -100; x <= 100; x += 10) {
    for (let z = -60; z <= 60; z += 10) {
      let free = true;
      for (let a = 0; a < 16 && free; a++) {
        const px = x + Math.cos((a * Math.PI) / 8) * 10;
        const pz = z + Math.sin((a * Math.PI) / 8) * 10;
        const r = resolveObstacles(px, pz, PLAYER_RADIUS + 1);
        if (r.x !== px || r.z !== pz) free = false;
      }
      if (free) return { x, z };
    }
  }
  throw new Error('no open spot found');
}

function spawn(yaw = 0, spot = openSpot()) {
  const c = new PlayerController();
  c.teleport({ x: spot.x, y: getTerrainHeight(spot.x, spot.z), z: spot.z, yaw, pitch: 0, epoch: 1 });
  return { c, spot };
}

/** Run `seconds` of game time with the same intent every frame. */
function run(c, seconds, intent, opts) {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) c.update(STEP, intent, opts);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('walking forward at yaw 0 goes toward -Z at the shared walking speed', () => {
  const { c, spot } = spawn(0);
  run(c, 1, { moveY: 1 });
  near(c.z, spot.z - moveSpeed(), 1e-6);
  near(c.x, spot.x, 1e-9);
  assert.equal(c.moving, true);
});

test('forward follows the yaw: turning left (yaw +90 degrees) walks toward -X', () => {
  const { c, spot } = spawn(Math.PI / 2);
  run(c, 1, { moveY: 1 });
  near(c.x, spot.x - moveSpeed(), 1e-6);
  near(c.z, spot.z, 1e-6);
});

test('strafing right at yaw 0 goes toward +X, backwards toward +Z', () => {
  const a = spawn(0);
  run(a.c, 1, { moveX: 1 });
  near(a.c.x, a.spot.x + moveSpeed(), 1e-6);
  const b = spawn(0);
  run(b.c, 1, { moveY: -1 });
  near(b.c.z, b.spot.z + moveSpeed(), 1e-6);
});

test('moving diagonally is not faster than moving straight', () => {
  const { c, spot } = spawn(0);
  run(c, 1, { moveX: 1, moveY: 1 });
  near(dist(c, spot), moveSpeed(), 1e-6);
});

test('a half-pushed stick walks at half speed, an over-pushed one is capped', () => {
  const a = spawn(0);
  run(a.c, 1, { moveY: 0.5 });
  near(a.spot.z - a.c.z, moveSpeed() / 2, 1e-6);
  const b = spawn(0);
  run(b.c, 1, { moveY: 5, moveX: 5 });
  near(dist(b.c, b.spot), moveSpeed(), 1e-6);
});

test('sprinting needs: standing, moving forward, not aiming', () => {
  const a = spawn(0);
  run(a.c, 1, { moveY: 1, sprint: true });
  near(a.spot.z - a.c.z, moveSpeed({ sprinting: true }), 1e-6);
  assert.equal(a.c.sprinting, true);

  const standing = spawn(0);
  run(standing.c, 0.2, { moveY: -1, sprint: true });
  assert.equal(standing.c.sprinting, false); // backwards: no sprint

  const aiming = spawn(0);
  run(aiming.c, 0.2, { moveY: 1, sprint: true }, { ads: true });
  assert.equal(aiming.c.sprinting, false);
  assert.equal(aiming.c.ads, true);

  const crouched = spawn(0);
  crouched.c.update(STEP, { toggleCrouch: true });
  run(crouched.c, 0.2, { moveY: 1, sprint: true });
  assert.equal(crouched.c.sprinting, false);
});

test('crouching and lying down are slower; toggling twice stands up again', () => {
  const a = spawn(0);
  a.c.update(STEP, { toggleCrouch: true });
  assert.equal(a.c.stance, 'crouch');
  const z0 = a.c.z;
  run(a.c, 1, { moveY: 1 });
  near(z0 - a.c.z, moveSpeed({ stance: 'crouch' }), 1e-6);
  a.c.update(STEP, { toggleCrouch: true });
  assert.equal(a.c.stance, 'stand');

  const b = spawn(0);
  b.c.update(STEP, { toggleProne: true });
  assert.equal(b.c.stance, 'prone');
  const z1 = b.c.z;
  run(b.c, 1, { moveY: 1 });
  near(z1 - b.c.z, moveSpeed({ stance: 'prone' }), 1e-6);
  b.c.update(STEP, { toggleCrouch: true }); // prone -> crouch
  assert.equal(b.c.stance, 'crouch');
});

test('the energy-drink boost and a heavy weapon change the speed', () => {
  const { c, spot } = spawn(0);
  run(c, 1, { moveY: 1 }, { boost: 50, weaponMult: 0.9 });
  near(spot.z - c.z, moveSpeed({ boost: 50, weaponMult: 0.9 }), 1e-6);
});

test('lean is -1, 0 or 1 only', () => {
  const { c } = spawn(0);
  c.update(STEP, { lean: 1 });
  assert.equal(c.lean, 1);
  c.update(STEP, { lean: -1 });
  assert.equal(c.lean, -1);
  c.update(STEP, { lean: 0.5 });
  assert.equal(c.lean, 0);
  c.update(STEP, {});
  assert.equal(c.lean, 0);
});

test('jump: rises about v^2/2g, comes back down onto the ground, no double jump', () => {
  const { c } = spawn(0);
  const ground = c.y;
  c.update(STEP, { jump: true });
  assert.equal(c.grounded, false);
  let top = c.y;
  for (let i = 0; i < 90; i++) {
    c.update(STEP, { jump: !c.grounded && i % 5 === 0 }); // keeps pressing while in the air: must not launch again
    top = Math.max(top, c.y);
  }
  const expected = (MOVE.jumpVelocity ** 2) / (2 * MOVE.gravity);
  assert.ok(top - ground > expected * 0.85 && top - ground < expected * 1.15, `rise ${top - ground} vs ${expected}`);
  assert.equal(c.grounded, true);
  near(c.y, getTerrainHeight(c.x, c.z), 1e-9);
});

test('crouched or lying down: no jumping', () => {
  const { c } = spawn(0);
  c.update(STEP, { toggleCrouch: true });
  c.update(STEP, { jump: true });
  assert.equal(c.grounded, true);
  assert.equal(c.vy, 0);
});

test('the edge of the map stops you', () => {
  const c = new PlayerController();
  c.teleport({ x: MAP_HALF_SIZE - 3, y: getTerrainHeight(MAP_HALF_SIZE - 3, 0), z: 0, yaw: -Math.PI / 2, pitch: 0, epoch: 0 });
  run(c, 3, { moveY: 1 });
  assert.ok(c.x <= MAP_HALF_SIZE - 1 + 1e-9, `x ${c.x}`);
  assert.ok(c.x >= MAP_HALF_SIZE - 1.5);
});

test('walking into a bunker: stopped outside it, never inside', () => {
  const box = OBSTACLES[0];
  const c = new PlayerController();
  const z = (box.minZ + box.maxZ) / 2;
  const x = box.minX - 3;
  c.teleport({ x, y: getTerrainHeight(x, z), z, yaw: -Math.PI / 2, pitch: 0, epoch: 0 }); // facing +X
  for (let i = 0; i < 240; i++) {
    c.update(STEP, { moveY: 1 });
    const inside = c.x > box.minX && c.x < box.maxX && c.z > box.minZ && c.z < box.maxZ;
    assert.equal(inside, false, `inside the box at step ${i}`);
  }
  assert.ok(c.x <= box.minX - PLAYER_RADIUS + 1e-6 || c.z < box.minZ || c.z > box.maxZ, 'should be held at the wall or slid around it');
});

test('looking: pitch is limited, yaw stays a small number', () => {
  const { c } = spawn(0);
  c.look(0, 10);
  assert.equal(c.pitch, PITCH_LIMIT);
  c.look(0, -20);
  assert.equal(c.pitch, -PITCH_LIMIT);
  c.look(2000, 0);
  assert.ok(Math.abs(c.yaw) < Math.PI * 2 + 1e-9, `yaw ${c.yaw}`);
  near(Math.cos(c.yaw), Math.cos(2000), 1e-6);
  near(Math.sin(c.yaw), Math.sin(2000), 1e-6);
  // look deltas inside update() work the same way
  const d = spawn(0).c;
  d.update(STEP, { dYaw: 0.5, dPitch: 0.25 });
  near(d.yaw, 0.5, 1e-9);
  near(d.pitch, 0.25, 1e-9);
});

test('teleport: takes the server position, keeps the old view when none is given, and only whole-number epochs', () => {
  const c = new PlayerController();
  c.yaw = 1.2;
  c.pitch = 0.3;
  c.vy = 5;
  c.teleport({ x: 3, y: 4, z: 5, yaw: NaN, pitch: undefined, epoch: 2.5 });
  assert.deepEqual([c.x, c.y, c.z], [3, 4, 5]);
  assert.equal(c.yaw, 1.2);
  assert.equal(c.pitch, 0.3);
  assert.equal(c.vy, 0);
  assert.equal(c.grounded, true);
  assert.equal(c.epoch, 0); // 2.5 is not an epoch
  c.teleport({ x: 0, y: 0, z: 0, yaw: 0.1, pitch: 9, epoch: 7 });
  assert.equal(c.yaw, 0.1);
  assert.equal(c.pitch, PITCH_LIMIT);
  assert.equal(c.epoch, 7);
});

test('resetPose clears stance, lean and aiming', () => {
  const { c } = spawn(0);
  c.update(STEP, { toggleProne: true, lean: 1, moveY: 1 }, { ads: true });
  c.resetPose();
  assert.deepEqual([c.stance, c.lean, c.sprinting, c.ads, c.moving], ['stand', 0, false, false, false]);
});

test('moveMessage carries exactly what the server expects', () => {
  const { c } = spawn(0.3);
  c.update(STEP, { moveY: 1, sprint: true, lean: -1 });
  const m = c.moveMessage();
  assert.deepEqual(Object.keys(m).sort(), ['ads', 'epoch', 'lean', 'pitch', 'sprinting', 'stance', 'x', 'y', 'yaw', 'z']);
  assert.equal(m.epoch, 1);
  assert.equal(m.sprinting, true);
  assert.equal(m.lean, -1);
  assert.equal(m.stance, 'stand');
});

test('DroneControl: sticks need a small push, vertical buttons map straight through', () => {
  const d = new DroneControl();
  d.start(1, 0.2);
  d.update({ moveY: 0.2, moveX: -0.2 });
  assert.deepEqual(d.input, { forward: false, backward: false, left: false, right: false, up: false, down: false });
  d.update({ moveY: 0.9, moveX: -0.9, droneUp: true });
  assert.deepEqual(d.input, { forward: true, backward: false, left: true, right: false, up: true, down: false });
  d.update({ moveY: -0.9, moveX: 0.9, droneDown: true });
  assert.deepEqual(d.input, { forward: false, backward: true, left: false, right: true, up: false, down: true });
  assert.deepEqual(Object.keys(d.message()).sort(), ['backward', 'down', 'forward', 'left', 'pitch', 'right', 'up', 'yaw']);
});

test('DroneControl: looking has the same limits, start() resets everything', () => {
  const d = new DroneControl();
  d.update({ dPitch: 9, dYaw: 0.5, moveY: 1 });
  assert.equal(d.pitch, PITCH_LIMIT);
  near(d.yaw, 0.5, 1e-9);
  d.start();
  assert.equal(d.yaw, 0);
  assert.equal(d.pitch, -0.15);
  assert.equal(d.input.forward, false);
});
