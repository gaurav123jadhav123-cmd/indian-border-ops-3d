import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRoom, join, place, unprotect, run, duel, dirBetween, RULES
} from './helpers.js';
import { getTerrainHeight, getEyePosition } from '../src/shared/world.js';
import { withRules } from '../src/rules.js';
import { LOOT_TABLE, describeLoot } from '../src/systems/airdrop.js';
import { ARSENAL, HEALING_ITEMS } from '../src/shared/arsenal.js';

const fly = (over = {}) => ({
  forward: true, backward: false, left: false, right: false, up: false, down: false, yaw: Math.PI, pitch: 0, ...over
});

describe('drones', () => {
  test('deploying creates a drone the owner pilots, with a per-mode cooldown', () => {
    const { room, clock, a } = duel();
    room.handleDeploy(a.p, { mode: 'fpv' }, clock());
    const msg = a.conn.last('drone_deployed');
    assert.equal(msg.mode, 'fpv');
    assert.equal(msg.ttlMs, RULES.drone.fpv.ttlMs);
    assert.equal(a.p.droneId, msg.id);
    assert.ok(msg.y > a.p.y + 2.5);

    room.handleDeploy(a.p, { mode: 'recon' }, clock());
    assert.equal(a.conn.count('drone_deployed'), 1, 'one drone at a time');

    room.handleDroneAction(a.p, { action: 'recall' });
    assert.equal(a.p.droneId, null);
    room.handleDeploy(a.p, { mode: 'fpv' }, clock());
    assert.equal(a.conn.count('drone_deployed'), 1, 'FPV cooldown');
    assert.ok(a.conn.count('notice') >= 1);

    room.handleDeploy(a.p, { mode: 'recon' }, clock());
    assert.equal(a.conn.count('drone_deployed'), 2, 'recon has its own cooldown');
    room.handleDroneAction(a.p, { action: 'recall' });

    clock.advance(RULES.drone.fpv.cooldownMs);
    room.handleDeploy(a.p, { mode: 'fpv' }, clock());
    assert.equal(a.conn.count('drone_deployed'), 3);
  });

  test('flight distance depends on time, not on how many packets the client sends', () => {
    const distances = [];
    for (const packetsPerSecond of [5, 20]) {
      const { room, clock, a } = duel();
      room.handleDeploy(a.p, { mode: 'fpv' }, clock());
      const d = room.drones.get(a.p.droneId);
      const start = { x: d.x, z: d.z };
      const every = 1000 / packetsPerSecond;
      for (let i = 0; i < packetsPerSecond * 1.6; i++) { // 1.6 seconds of steering either way
        room.handleDroneInput(a.p, fly(), clock());
        run(room, clock, every);
      }
      distances.push(Math.hypot(d.x - start.x, d.z - start.z));
    }
    assert.ok(Math.abs(distances[0] - distances[1]) < 1.5, `5Hz flew ${distances[0]}m, 20Hz flew ${distances[1]}m`);
    assert.ok(distances[1] > 37 && distances[1] < 39.5, `1.6s at 24 m/s is about 38.4m, got ${distances[1]}`);
  });

  test('a drone that is not being steered stops', () => {
    const { room, clock, a } = duel();
    room.handleDeploy(a.p, { mode: 'recon' }, clock());
    const d = room.drones.get(a.p.droneId);
    room.handleDroneInput(a.p, fly(), clock());
    run(room, clock, 700);
    const z1 = d.z;
    run(room, clock, 1000);
    assert.equal(d.z, z1);
  });

  test('an FPV drone explodes when it hits a wall, a recon drone just stops', () => {
    for (const mode of ['fpv', 'recon']) {
      const { room, clock, a } = duel();
      place(a.p, -20, 0, { yaw: -Math.PI / 2 });
      room.handleDeploy(a.p, { mode }, clock());
      const d = room.drones.get(a.p.droneId);
      d.y = getTerrainHeight(0, 0) + 1.5;
      for (let i = 0; i < 40; i++) {
        room.handleDroneInput(a.p, fly({ yaw: -Math.PI / 2 }), clock());
        run(room, clock, 50);
      }
      if (mode === 'fpv') {
        assert.equal(a.conn.last('drone_ended').reason, 'detonated');
        assert.equal(a.conn.raw('explosion').at(-1).payload.kind, 'drone');
        assert.equal(a.p.droneId, null);
      } else {
        assert.equal(a.conn.count('explosion'), 0);
        assert.ok(room.drones.get(d.id), 'still flying');
        assert.ok(d.x < -4.7, `blocked by the checkpoint, x=${d.x}`);
      }
    }
  });

  test('detonate does damage around the drone and ignores armor; recon cannot detonate', () => {
    const { room, clock, a, b } = duel();
    room.handleDeploy(a.p, { mode: 'fpv' }, clock());
    const d = room.drones.get(a.p.droneId);
    d.x = b.p.x + 2; d.z = b.p.z; d.y = b.p.y + 1.2;
    room.handleDroneAction(a.p, { action: 'detonate' });
    assert.ok(b.p.hp < 40 && b.p.hp > 0, `bravo hp ${b.p.hp}`);
    assert.equal(b.p.armor, 50);
    assert.equal(a.conn.last('drone_ended').reason, 'detonated');

    clock.advance(RULES.drone.recon.cooldownMs);
    room.handleDeploy(a.p, { mode: 'recon' }, clock());
    room.handleDroneAction(a.p, { action: 'detonate' });
    assert.ok(a.p.droneId, 'recon drone is still up');
  });

  test('drones expire, and end when the pilot dies or disconnects', () => {
    const t1 = duel();
    t1.room.handleDeploy(t1.a.p, { mode: 'fpv' }, t1.clock());
    run(t1.room, t1.clock, RULES.drone.fpv.ttlMs + 100);
    assert.equal(t1.a.conn.last('drone_ended').reason, 'expired');
    assert.equal(t1.a.p.droneId, null);

    const t2 = duel();
    t2.room.handleDeploy(t2.a.p, { mode: 'recon' }, t2.clock());
    t2.room.registerKill(t2.b.p, t2.a.p, 'SIG 716 G2', false, t2.clock());
    assert.equal(t2.b.conn.last('drone_ended').reason, 'owner_died');
    assert.equal(t2.room.drones.list().length, 0);

    const t3 = duel();
    t3.room.handleDeploy(t3.a.p, { mode: 'recon' }, t3.clock());
    t3.room.detach(t3.a.p, t3.a.conn, t3.clock());
    assert.equal(t3.room.drones.list().length, 0);
  });

  test('enemy bullets can shoot a drone down, own and allied drones are safe', () => {
    const { room, clock, a, b } = duel();
    room.handleDeploy(b.p, { mode: 'fpv' }, clock());
    const d = room.drones.get(b.p.droneId);
    room.handleShoot(a.p, { dir: dirBetween(getEyePosition(a.p), d) }, clock());
    const confirm = a.conn.last('hit_confirm');
    assert.equal(confirm.kind, 'drone');
    assert.equal(confirm.killed, true);
    assert.equal(b.conn.last('drone_ended').reason, 'destroyed');
    assert.equal(b.p.droneId, null);
    assert.equal(b.conn.last('explosion').kind, 'drone_down');
    assert.equal(b.p.hp, 100, 'a downed drone does no damage');

    // an allied drone is ignored by bullets
    const ally = join(room, 'Ally');
    ally.p.team = a.p.team;
    place(ally.p, 3, -92);
    unprotect(ally.p);
    room.handleDeploy(ally.p, { mode: 'recon' }, clock());
    const d2 = room.drones.get(ally.p.droneId);
    a.p.nextFireAt = 0;
    room.handleShoot(a.p, { dir: dirBetween(getEyePosition(a.p), d2) }, clock());
    assert.ok(room.drones.get(d2.id), 'allied drone survives');
  });

  test('altitude and map limits hold', () => {
    const { room, clock, a } = duel();
    room.handleDeploy(a.p, { mode: 'recon' }, clock());
    const d = room.drones.get(a.p.droneId);
    for (let i = 0; i < 300; i++) {
      room.handleDroneInput(a.p, fly({ forward: false, up: true }), clock());
      run(room, clock, 50);
    }
    assert.ok(d.y <= RULES.drone.maxAltitude + 1e-9);
    for (let i = 0; i < 400; i++) {
      room.handleDroneInput(a.p, fly({ pitch: 0.4 }), clock());
      run(room, clock, 50);
      if (!room.drones.get(d.id)) break;
    }
    assert.ok(Math.abs(d.x) <= 140 && Math.abs(d.z) <= 140);
  });
});

describe('air drops', () => {
  const slowRules = withRules({ airdrop: { lingerMs: 1e9 } });

  function landedCrate(room, clock) {
    run(room, clock, RULES.airdrop.firstDelayMs + 100);
    run(room, clock, 7000);
    const crate = room.airdrops.crates[0];
    assert.ok(crate && crate.landed, 'a crate has landed');
    return crate;
  }

  test('the first crate drops after 20s, falls slowly, lands and is announced', () => {
    const { room, clock } = makeRoom();
    const a = join(room, 'Alpha');
    run(room, clock, RULES.airdrop.firstDelayMs - 500);
    assert.equal(a.conn.count('airdrop_spawned'), 0);
    run(room, clock, 700);
    const spawned = a.conn.last('airdrop_spawned');
    assert.ok(spawned.label.includes('Vidhwansak AMR'));
    assert.equal(spawned.landed, false);
    assert.ok(spawned.y > getTerrainHeight(spawned.x, spawned.z) + 40);
    run(room, clock, 3000);
    assert.equal(a.conn.count('airdrop_landed'), 0, 'still parachuting');
    run(room, clock, 4000);
    const landed = a.conn.last('airdrop_landed');
    assert.equal(landed.landed, true);
    assert.ok(Math.abs(landed.y - getTerrainHeight(landed.x, landed.z)) < 0.01);
  });

  test('the loot announced in the label is exactly what you receive', () => {
    for (const [index, loot] of LOOT_TABLE.entries()) {
      const { room, clock } = makeRoom({ rng: () => index / LOOT_TABLE.length + 0.01 });
      const a = join(room, 'Alpha');
      const before = { ...a.p.inventory };
      const hadSame = a.p.loadout[loot.slot] === loot.weapon;
      const reserveBefore = a.p.ammo[loot.slot].reserve;
      const crate = landedCrate(room, clock);
      assert.equal(crate.loot.id, loot.id);
      assert.equal(crate.label, describeLoot(loot));

      place(a.p, crate.x + 1, crate.z);
      unprotect(a.p);
      room.handleLoot(a.p, { crateId: crate.id }, clock());

      const w = ARSENAL[loot.weapon];
      assert.equal(a.p.loadout[loot.slot], loot.weapon, `${loot.id}: weapon`);
      assert.equal(a.p.ammo[loot.slot].mag, w.magSize);
      const expectedReserve = loot.rockets ? (hadSame ? reserveBefore : 0) + loot.rockets : w.reserveAmmo;
      assert.equal(a.p.ammo[loot.slot].reserve, expectedReserve, `${loot.id}: ammo is refilled`);
      assert.equal(a.p.armor, loot.armor);
      for (const [item, n] of Object.entries(loot.items)) {
        assert.equal(a.p.inventory[item], before[item] + n, `${loot.id}: ${item}`);
        assert.ok(crate.label.includes(HEALING_ITEMS[item].name), `label mentions ${item}`);
      }
      assert.ok(crate.label.includes(w.name));
      assert.equal(a.conn.last('airdrop_looted').label, crate.label);
      assert.equal(room.airdrops.crates.length, 0, 'the crate is gone');
    }
  });

  test('crates must be reached, cannot be looted twice and do not work while still falling', () => {
    const { room, clock } = makeRoom();
    const a = join(room, 'Alpha');
    const b = join(room, 'Bravo');
    unprotect(a.p, b.p);
    run(room, clock, RULES.airdrop.firstDelayMs + 100);
    const falling = room.airdrops.crates[0];
    place(a.p, falling.x, falling.z);
    room.handleLoot(a.p, { crateId: falling.id }, clock());
    assert.equal(a.p.loadout.primary, 'sig716', 'not landed yet');

    run(room, clock, 7000);
    place(a.p, falling.x + 12, falling.z);
    room.handleLoot(a.p, { crateId: falling.id }, clock());
    assert.equal(a.p.loadout.primary, 'sig716', 'too far away');

    place(a.p, falling.x + 2, falling.z);
    place(b.p, falling.x - 2, falling.z);
    room.handleLoot(a.p, { crateId: falling.id }, clock());
    room.handleLoot(b.p, { crateId: falling.id }, clock());
    assert.equal(a.p.loadout.primary, 'vidhwansak');
    assert.equal(b.p.loadout.primary, 'sig716', 'it was already taken');
    room.handleLoot(a.p, { crateId: 'nope' }, clock());
  });

  test('picking up a rocket crate adds rockets to the ones you carry', () => {
    const { room, clock } = makeRoom({ rng: () => 0.99 });
    const a = join(room, 'Alpha');
    const crate = landedCrate(room, clock);
    assert.equal(crate.loot.id, 'carl');
    a.p.ammo.launcher = { mag: 0, reserve: 1 };
    place(a.p, crate.x + 1, crate.z);
    room.handleLoot(a.p, { crateId: crate.id }, clock());
    assert.deepEqual(a.p.ammo.launcher, { mag: 1, reserve: 4 });
  });

  test('unclaimed crates disappear, and no more than three exist at once', () => {
    const { room, clock } = makeRoom();
    const a = join(room, 'Alpha');
    const first = landedCrate(room, clock);
    run(room, clock, RULES.airdrop.lingerMs + 500);
    assert.equal(a.conn.count('airdrop_expired'), 1);
    assert.equal(room.airdrops.crates.some((c) => c.id === first.id), false, 'the unclaimed crate is gone');

    const busy = makeRoom({ rules: slowRules });
    join(busy.room, 'Alpha');
    run(busy.room, busy.clock, 20000 + 45000 * 6);
    assert.equal(busy.room.airdrops.crates.length, RULES.airdrop.maxActive);
  });
});
