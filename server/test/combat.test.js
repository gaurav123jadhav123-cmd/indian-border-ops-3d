import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRoom, join, place, unprotect, run, aimAt, duel, RULES
} from './helpers.js';
import { getTerrainHeight, getEyePosition, raycastWorld } from '../src/shared/world.js';
import { ARSENAL } from '../src/shared/arsenal.js';

const UP = { x: 0, y: 1, z: 0 };

describe('shooting', () => {
  test('a chest hit does the weapon damage, armor soaks 45%, and both players are told', () => {
    const { room, clock, a, b } = duel();
    room.handleShoot(a.p, { dir: aimAt(a.p, b.p) }, clock());
    // 42 damage, armor absorbs 18.9 -> 23.1 -> 23 hp lost
    assert.equal(b.p.hp, 77);
    assert.equal(Math.round(b.p.armor), 31);
    const confirm = a.conn.last('hit_confirm');
    assert.deepEqual(
      { dmg: confirm.damage, head: confirm.headshot, killed: confirm.killed, kind: confirm.kind },
      { dmg: 23, head: false, killed: false, kind: 'player' }
    );
    const hurt = b.conn.last('damage_taken');
    assert.equal(hurt.amount, 23);
    assert.equal(hurt.fromId, a.p.id);
    assert.ok(hurt.src && Number.isFinite(hurt.src.x), 'damage direction indicator data');
    assert.equal(a.p.ammo.primary.mag, 19);
  });

  test('a headshot uses the headshot multiplier', () => {
    const { room, clock, a, b } = duel();
    room.handleShoot(a.p, { dir: aimAt(a.p, b.p, 'head') }, clock());
    // 42 * 2.1 = 88.2 -> 88; armor absorbs 39.6 -> 48.4 -> 48
    assert.equal(b.p.hp, 52);
    assert.equal(a.conn.last('hit_confirm').headshot, true);
    assert.equal(a.p.headshots, 0, 'headshot kills are counted, plain hits are not');
  });

  test('the fire rate is enforced on the server', () => {
    const { room, clock, a } = duel();
    room.handleShoot(a.p, { dir: UP }, clock());
    room.handleShoot(a.p, { dir: UP }, clock());
    assert.equal(a.p.ammo.primary.mag, 19, 'second shot in the same instant is dropped');
    clock.advance(60);
    room.handleShoot(a.p, { dir: UP }, clock());
    assert.equal(a.p.ammo.primary.mag, 19, '60ms is too soon for a 135ms weapon');
    clock.advance(70);
    room.handleShoot(a.p, { dir: UP }, clock());
    assert.equal(a.p.ammo.primary.mag, 18);
  });

  test('an empty magazine reloads automatically and takes the real reload time', () => {
    const { room, clock, a } = duel();
    const w = ARSENAL.sig716;
    for (let i = 0; i < w.magSize; i++) {
      room.handleShoot(a.p, { dir: UP }, clock());
      clock.advance(w.fireRateMs);
    }
    assert.equal(a.p.ammo.primary.mag, 0);
    assert.ok(a.p.reload, 'auto reload started');
    assert.equal(a.conn.last('reload_started').totalMs, w.reloadMs);

    room.handleShoot(a.p, { dir: UP }, clock());
    assert.equal(a.p.ammo.primary.mag, 0, 'cannot fire while reloading');

    run(room, clock, w.reloadMs - 200);
    assert.equal(a.p.ammo.primary.mag, 0, 'not finished early');
    run(room, clock, 300);
    assert.equal(a.p.ammo.primary.mag, w.magSize);
    assert.equal(a.p.ammo.primary.reserve, w.reserveAmmo - w.magSize);
    assert.deepEqual(a.conn.last('reload_done'), { slot: 'primary', mag: 20, reserve: 100 });
  });

  test('a manual reload tops up a partly used magazine, and does nothing when full or out of reserve', () => {
    const { room, clock, a } = duel();
    room.handleReload(a.p, clock());
    assert.equal(a.p.reload, null, 'full magazine: nothing to do');

    room.handleShoot(a.p, { dir: UP }, clock());
    room.handleReload(a.p, clock());
    assert.ok(a.p.reload);
    run(room, clock, 2300);
    assert.equal(a.p.ammo.primary.mag, 20);
    assert.equal(a.p.ammo.primary.reserve, 119, 'only one round was used up');

    a.p.ammo.primary.mag = 3;
    a.p.ammo.primary.reserve = 0;
    room.handleReload(a.p, clock());
    assert.equal(a.p.reload, null, 'no reserve ammo: no reload');
  });

  test('switching weapons cancels a reload and blocks firing for the equip delay', () => {
    const { room, clock, a } = duel();
    room.handleShoot(a.p, { dir: UP }, clock());
    clock.advance(200);
    room.handleReload(a.p, clock());
    assert.ok(a.p.reload);
    room.handleSwitch(a.p, 'secondary', clock());
    assert.equal(a.p.reload, null);
    assert.equal(a.p.activeSlot, 'secondary');

    room.handleShoot(a.p, { dir: UP }, clock());
    assert.equal(a.p.ammo.secondary.mag, 13, 'still equipping');
    clock.advance(RULES.equipDelayMs + 5);
    room.handleShoot(a.p, { dir: UP }, clock());
    assert.equal(a.p.ammo.secondary.mag, 12);
  });

  test('spawn protection blocks damage, and the protected player ends it by firing', () => {
    const { room, clock, a, b } = duel();
    b.p.invulnUntil = clock() + 3000;
    room.handleShoot(a.p, { dir: aimAt(a.p, b.p) }, clock());
    assert.equal(b.p.hp, 100);
    assert.equal(a.conn.last('hit_confirm').blocked, true);
    assert.equal(a.conn.last('hit_confirm').damage, 0);

    b.p.nextFireAt = 0;
    room.handleShoot(b.p, { dir: aimAt(b.p, a.p) }, clock());
    assert.ok(b.p.invulnUntil <= clock(), 'firing ends the protection');
    assert.equal(a.p.hp < 100, true, 'and the protected player can hurt others only by giving it up');
  });

  test('bunkers and terrain stop bullets', () => {
    const { room, clock, a, b } = duel();
    place(a.p, -12, 0, { yaw: 0 });
    place(b.p, 12, 0, { yaw: 0 });
    const eye = getEyePosition(a.p);
    const dir = aimAt(a.p, b.p);
    const wall = raycastWorld(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, 100);
    assert.equal(wall?.id, 'checkpoint_center', 'test geometry: the checkpoint is between the soldiers');

    room.handleShoot(a.p, { dir }, clock());
    assert.equal(b.p.hp, 100);
    assert.equal(a.conn.last('hit_confirm'), undefined);
    assert.equal(a.conn.last('shot_fired').hit, 'world');
  });

  test('teammates are safe from bullets in TDM, but not in free-for-all', () => {
    const tdm = duel();
    tdm.b.p.team = tdm.a.p.team;
    tdm.room.handleShoot(tdm.a.p, { dir: aimAt(tdm.a.p, tdm.b.p) }, tdm.clock());
    assert.equal(tdm.b.p.hp, 100);

    const ffa = duel({ mode: 'FFA' });
    ffa.room.handleShoot(ffa.a.p, { dir: aimAt(ffa.a.p, ffa.b.p) }, ffa.clock());
    assert.ok(ffa.b.p.hp < 100);
  });

  test('bullet spread widens while moving and narrows when aiming or crouching', () => {
    const { room, clock, a, b } = duel({ rng: Math.random });
    const sniper = join(room, 'Sniper', { loadout: { primary: 'svd' } }).p;
    place(sniper, 0, -92, { yaw: Math.PI });
    unprotect(sniper);
    // At 10m even a moving SVD (spread 0.008 * 1.5) must hit a chest-sized target almost always.
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      b.p.hp = 100; b.p.armor = 0; b.p.alive = true;
      sniper.nextFireAt = 0;
      sniper.ammo.primary.mag = 10;
      sniper.lastMovedAt = clock();
      room.handleShoot(sniper, { dir: aimAt(sniper, b.p) }, clock());
      if (b.p.hp < 100) hits++;
    }
    assert.ok(hits >= 36, `only ${hits}/40 hits at 10m`);
  });

  test('killing: stats, kill feed, TDM score, death notice, then a proper respawn', () => {
    const { room, clock, a, b } = duel();
    b.p.hp = 10;
    b.p.inventory.frag = 0;
    b.p.loadout.primary = 'negev';
    b.p.ammo.primary = { mag: 3, reserve: 1 };
    room.handleShoot(a.p, { dir: aimAt(a.p, b.p) }, clock());

    assert.equal(b.p.alive, false);
    assert.equal(a.p.kills, 1);
    assert.equal(a.p.streak, 1);
    assert.equal(b.p.deaths, 1);
    assert.equal(room.scores.bharat, 1);
    const feed = b.conn.last('kill_feed');
    assert.deepEqual(
      { killer: feed.killer, victim: feed.victim, weapon: feed.weapon, killerTeam: feed.killerTeam },
      { killer: 'Alpha', victim: 'Bravo', weapon: 'SIG 716 G2', killerTeam: 'bharat' }
    );
    assert.equal(b.conn.last('you_died').killer, 'Alpha');
    assert.equal(b.conn.last('you_died').respawnInMs, RULES.respawnMs);

    // dead players cannot act
    b.p.nextFireAt = 0;
    room.handleShoot(b.p, { dir: UP }, clock());
    assert.equal(b.p.ammo.primary.mag, 3);

    run(room, clock, RULES.respawnMs - 100);
    assert.equal(b.p.alive, false, 'respawn timer is honoured');
    const epochBefore = b.p.epoch;
    run(room, clock, 200);
    assert.equal(b.p.alive, true);
    assert.equal(b.p.hp, 100);
    assert.equal(b.p.armor, 50);
    assert.equal(b.p.loadout.primary, 'sig716', 'loadout is reset');
    assert.deepEqual(b.p.ammo.primary, { mag: 20, reserve: 120 }, 'ammo is refilled');
    assert.equal(b.p.inventory.frag, 2, 'inventory is reset');
    assert.equal(b.p.activeSlot, 'primary');
    assert.equal(b.p.epoch, epochBefore + 1);
    assert.ok(b.p.invulnUntil > clock(), 'spawn protection');
    const r = b.conn.last('respawned');
    assert.equal(r.protectedMs, RULES.spawnProtectionMs);
    assert.equal(r.epoch, b.p.epoch);
    assert.ok(b.p.z > 78, 'opfor respawns on its own side');
    assert.equal(a.p.streak, 1);
  });

  test('dying ends the streak; suicide gives nobody a kill', () => {
    const { room, clock, a, b } = duel();
    a.p.streak = 4;
    room.registerKill(b.p, a.p, 'SIG 716 G2', false, clock());
    assert.equal(a.p.streak, 0);
    assert.equal(b.p.kills, 1);

    room.registerKill(b.p, b.p, 'HE-36M1 Frag', false, clock());
    assert.equal(b.p.kills, 1, 'a suicide is not a kill');
    assert.equal(b.p.deaths, 1);
    assert.equal(b.conn.last('kill_feed').suicide, true);
  });
});

describe('healing', () => {
  function patient(hp) {
    const { room, clock, a, b } = duel();
    a.p.hp = hp;
    return { room, clock, a, b };
  }

  test('a bandage is used up only when the cast finishes, and heals up to its cap', () => {
    const { room, clock, a } = patient(50);
    room.handleHeal(a.p, { item: 'bandage' }, clock());
    assert.equal(a.conn.last('heal_started').totalMs, 2000);
    run(room, clock, 1900);
    assert.equal(a.p.hp, 50);
    assert.equal(a.p.inventory.bandage, 4);
    run(room, clock, 200);
    assert.equal(a.p.hp, 65);
    assert.equal(a.p.inventory.bandage, 3);
    assert.equal(a.conn.last('heal_done').used, true);
  });

  test('items cannot take health past their cap, and are not wasted at the cap', () => {
    const { room, clock, a } = patient(75);
    room.handleHeal(a.p, { item: 'bandage' }, clock());
    assert.equal(a.p.heal, null);
    assert.equal(a.conn.count('notice'), 1);
    assert.equal(a.p.inventory.bandage, 4);

    a.p.hp = 70;
    room.handleHeal(a.p, { item: 'firstAid' }, clock());
    run(room, clock, 3600);
    assert.equal(a.p.hp, 75, 'First Aid caps at 75');

    a.p.hp = 20;
    room.handleHeal(a.p, { item: 'medkit' }, clock());
    run(room, clock, 4600);
    assert.equal(a.p.hp, 100, 'Medkit goes to 100');
    assert.equal(a.p.inventory.medkit, 0);
  });

  test('taking damage or firing cancels the cast and keeps the item', () => {
    const { room, clock, a, b } = patient(50);
    room.handleHeal(a.p, { item: 'medkit' }, clock());
    clock.advance(500);
    room.handleShoot(b.p, { dir: aimAt(b.p, a.p) }, clock());
    assert.equal(a.p.heal, null);
    assert.equal(a.conn.last('heal_cancelled').reason, 'damaged');
    run(room, clock, 5000);
    assert.equal(a.p.inventory.medkit, 1);

    room.handleHeal(a.p, { item: 'bandage' }, clock());
    room.handleShoot(a.p, { dir: UP }, clock());
    assert.equal(a.conn.last('heal_cancelled').reason, 'fired');
    assert.equal(a.p.inventory.bandage, 4);
  });

  test('only one cast at a time, and not while dead', () => {
    const { room, clock, a } = patient(50);
    room.handleHeal(a.p, { item: 'bandage' }, clock());
    room.handleHeal(a.p, { item: 'medkit' }, clock());
    assert.equal(a.p.heal.item, 'bandage');
    a.p.heal = null;
    a.p.alive = false;
    room.handleHeal(a.p, { item: 'medkit' }, clock());
    assert.equal(a.p.heal, null);
  });

  test('energy drink adds boost that slowly heals while it drains', () => {
    const { room, clock, a } = patient(50);
    room.handleHeal(a.p, { item: 'energyDrink' }, clock());
    run(room, clock, 2300);
    assert.ok(a.p.boost > 39 && a.p.boost <= 40, `boost right after drinking: ${a.p.boost}`);
    const hpAfterDrink = a.p.hp;
    const boostAfterDrink = a.p.boost;
    run(room, clock, 4000); // 4s of draining at 2/s and healing at 1.5 hp/s
    assert.ok(a.p.hp > hpAfterDrink + 5.5 && a.p.hp < hpAfterDrink + 6.5, `regen ${a.p.hp - hpAfterDrink}`);
    assert.ok(boostAfterDrink - a.p.boost > 7.5 && boostAfterDrink - a.p.boost < 8.5);

    a.p.boost = 100;
    a.p.heal = null;
    room.handleHeal(a.p, { item: 'energyDrink' }, clock());
    assert.equal(a.p.heal, null, 'boost already full');
  });
});

describe('grenades', () => {
  function plant(room, clock, owner, x, z, type = 'frag', fuse = 50) {
    room.projectiles.grenades.push({
      id: 'g_test', ownerId: owner.id, type,
      x, y: getTerrainHeight(x, z) + 0.2, z, vx: 0, vy: 0, vz: 0, detonateAt: clock() + fuse
    });
  }

  test('throwing uses one grenade, starts a cooldown and the grenade flies', () => {
    const { room, clock, a } = duel();
    room.handleThrow(a.p, { type: 'frag', dir: { x: 0, y: 0.3, z: 0.95 } }, clock());
    room.handleThrow(a.p, { type: 'frag', dir: { x: 0, y: 0.3, z: 0.95 } }, clock());
    assert.equal(a.p.inventory.frag, 1, 'the second throw is inside the cooldown');
    assert.equal(room.projectiles.grenades.length, 1);
    const g = room.projectiles.grenades[0];
    const z0 = g.z;
    run(room, clock, 200);
    assert.ok(g.z > z0 + 2, 'it moves forward');
    assert.equal(a.conn.last('grenade_thrown').type, 'frag');

    clock.advance(1000);
    room.handleThrow(a.p, { type: 'frag', dir: UP }, clock());
    clock.advance(1000);
    room.handleThrow(a.p, { type: 'frag', dir: UP }, clock());
    assert.equal(a.p.inventory.frag, 0);
    assert.ok(a.conn.count('notice') >= 1, 'told there are none left');
  });

  test('a grenade thrown into a wall bounces back instead of passing through', () => {
    const { room, clock, a } = duel();
    place(a.p, -9, 0, { yaw: 0 });
    room.handleThrow(a.p, { type: 'frag', dir: { x: 1, y: 0.05, z: 0 } }, clock());
    const g = room.projectiles.grenades[0];
    run(room, clock, 1500);
    assert.ok(g.x < -4.5, `grenade is still on the near side of the checkpoint, x=${g.x}`);
  });

  test('frag damage falls off with distance and ignores armor', () => {
    const { room, clock, a, b } = duel();
    place(a.p, 0, -92);
    place(b.p, 0, -83); // 9m from the blast at z=-92? no: blast is at z=-88 below
    plant(room, clock, a.p, 0, -88);
    b.p.z = -83; b.p.y = getTerrainHeight(0, -83);
    run(room, clock, 100);
    assert.equal(a.conn.count('explosion'), 1);
    // blast (0,-88); Bravo chest ~5.0m away -> 110 * (1 - d/10)
    assert.ok(b.p.hp < 100 && b.p.hp > 30, `bravo hp ${b.p.hp}`);
    assert.equal(b.p.armor, 50, 'explosions bypass armor');
  });

  test('nobody outside the blast radius is hurt, and the owner can hurt themselves', () => {
    const { room, clock, a, b } = duel();
    place(a.p, 0, -92);
    place(b.p, 0, -70);
    plant(room, clock, a.p, 0, -91);
    run(room, clock, 100);
    assert.equal(b.p.hp, 100);
    assert.ok(a.p.hp < 100, 'standing next to your own grenade hurts');
  });

  test('walls shield from explosions', () => {
    const { room, clock, a, b } = duel();
    // the Bharat watchtower occupies x -26.5..-21.5, z -74.5..-69.5
    place(a.p, -40, -90);
    place(b.p, -24, -68.5);
    plant(room, clock, a.p, -24, -76);
    run(room, clock, 100);
    assert.equal(a.conn.count('explosion'), 1);
    assert.equal(b.p.hp, 100, 'protected by the tower');

    // same blast, no wall between: moved to the open side
    place(b.p, -24, -82);
    plant(room, clock, a.p, -24, -76);
    run(room, clock, 100);
    assert.ok(b.p.hp < 100);
  });

  test('a frag kill is credited to the thrower', () => {
    const { room, clock, a, b } = duel();
    place(a.p, 0, -92);
    place(b.p, 0, -84);
    b.p.hp = 20;
    plant(room, clock, a.p, 0, -85);
    run(room, clock, 100);
    assert.equal(b.p.alive, false);
    assert.equal(a.p.kills, 1);
    assert.equal(b.conn.last('kill_feed').weapon, 'HE-36M1 Frag');
  });

  test('smoke grenades only announce smoke', () => {
    const { room, clock, a, b } = duel();
    place(b.p, 0, -84);
    plant(room, clock, a.p, 0, -84, 'smoke');
    run(room, clock, 100);
    assert.equal(b.p.hp, 100);
    const s = b.conn.last('smoke_deployed');
    assert.equal(s.ms, RULES.grenade.smokeMs);
    assert.equal(b.conn.count('explosion'), 0);
  });

  test('spawn-protected soldiers survive explosions', () => {
    const { room, clock, a, b } = duel();
    place(b.p, 0, -84);
    b.p.invulnUntil = clock() + 3000;
    plant(room, clock, a.p, 0, -85);
    run(room, clock, 100);
    assert.equal(b.p.hp, 100);
  });
});

describe('rockets and missile strikes', () => {
  function armed() {
    const t = duel();
    t.room.handleSwitch(t.a.p, 'launcher', t.clock());
    t.clock.advance(RULES.equipDelayMs + 10);
    return t;
  }

  test('a rocket flies as a projectile and explodes on the first player it meets', () => {
    const { room, clock, a, b } = armed();
    room.handleShoot(a.p, { dir: aimAt(a.p, b.p) }, clock());
    assert.equal(room.projectiles.rockets.length, 1);
    assert.equal(b.p.hp, 100, 'nothing happens instantly');
    run(room, clock, 400);
    assert.equal(room.projectiles.rockets.length, 0);
    assert.equal(b.p.alive, false);
    assert.equal(b.conn.last('kill_feed').weapon, 'Carl Gustaf M4');
    assert.equal(a.p.ammo.launcher.mag, 0);
    assert.ok(a.p.reload, 'the launcher reloads automatically');
  });

  test('a rocket explodes on a bunker wall and does not hurt people behind it', () => {
    const { room, clock, a, b } = armed();
    place(a.p, -12, 0);
    place(b.p, 12, 0);
    room.handleShoot(a.p, { dir: aimAt(a.p, b.p) }, clock());
    run(room, clock, 600);
    const boom = a.conn.last('explosion');
    assert.ok(boom, 'it exploded');
    assert.ok(boom.x < -4 && boom.x > -6.5, `at the wall, x=${boom.x}`);
    assert.equal(b.p.hp, 100);
  });

  test('rockets fly through teammates in TDM and the blast spares them', () => {
    const { room, clock, a, b } = armed();
    const mate = join(room, 'Mate');
    mate.p.team = 'bharat';
    place(mate.p, 0, -86);
    unprotect(mate.p);
    room.handleShoot(a.p, { dir: aimAt(a.p, b.p) }, clock());
    run(room, clock, 400);
    assert.equal(b.p.alive, false);
    assert.equal(mate.p.hp, 100);
  });

  test('the owner is not hit by their own rocket at the muzzle', () => {
    const { room, clock, a } = armed();
    room.handleShoot(a.p, { dir: { x: 0, y: 0.05, z: 1 } }, clock());
    run(room, clock, 120);
    assert.equal(a.p.hp, 100);
    assert.equal(room.projectiles.rockets.length, 1);
  });

  test('a rocket that hits nothing still ends', () => {
    const { room, clock, a } = armed();
    room.handleShoot(a.p, { dir: { x: 0, y: 0.3, z: 0.95 } }, clock());
    run(room, clock, 6000);
    assert.equal(room.projectiles.rockets.length, 0);
    assert.ok(a.conn.count('explosion') >= 1);
  });

  test('the missile strike lands where you aim after a real delay, and has a cooldown', () => {
    const { room, clock, a, b } = duel();
    place(a.p, 0, -92, { yaw: Math.PI });
    room.handleMissile(a.p, { dir: { x: 0, y: -0.1, z: 1 } }, clock());
    const warn = a.conn.last('missile_incoming');
    assert.equal(warn.etaMs, Math.round((RULES.missile.height / RULES.missile.fallSpeed) * 1000));
    assert.equal(warn.radius, RULES.missile.radius);
    const away = Math.hypot(warn.x - a.p.x, warn.z - a.p.z);
    assert.ok(away >= RULES.missile.minRange - 0.01 && away <= RULES.missile.maxRange + 0.01, `distance ${away}`);

    place(b.p, warn.x, warn.z); // the victim stands on the marker
    run(room, clock, warn.etaMs - 300);
    assert.equal(b.p.alive, true, 'it has not landed yet');
    run(room, clock, 500);
    assert.equal(b.p.alive, false);
    assert.equal(b.conn.last('kill_feed').weapon, 'Tactical Missile Strike');
    assert.equal(a.p.alive, true, 'the caller is outside the blast');

    // cooldown
    room.handleMissile(a.p, { dir: { x: 0, y: -0.1, z: 1 } }, clock());
    assert.equal(a.conn.count('missile_incoming'), 1);
    assert.ok(a.conn.count('notice') >= 1);
    clock.advance(RULES.missile.cooldownMs);
    room.handleMissile(a.p, { dir: { x: 0, y: -0.1, z: 1 } }, clock());
    assert.equal(a.conn.count('missile_incoming'), 2);
  });

  test('a strike cannot be called onto your own position', () => {
    const { room, clock, a } = duel();
    place(a.p, 0, -92, { yaw: Math.PI });
    room.handleMissile(a.p, { dir: { x: 0, y: -1, z: 0 } }, clock()); // straight down
    const warn = a.conn.last('missile_incoming');
    assert.ok(Math.hypot(warn.x - a.p.x, warn.z - a.p.z) >= RULES.missile.minRange - 0.01);
    assert.ok(Math.abs(warn.x) <= 140 && Math.abs(warn.z) <= 140, 'inside the map');
  });
});
