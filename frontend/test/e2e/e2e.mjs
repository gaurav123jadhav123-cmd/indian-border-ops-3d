// End-to-end browser tests. Run:  node frontend/test/e2e/e2e.mjs   (needs Playwright + Chromium)
// See harness.mjs for exactly what is real and what is faked.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { getTerrainHeight, getEyePosition } = await import(path.join(ROOT, 'server/src/shared/world.js'));
const { LOOT_TABLE, describeLoot } = await import(path.join(ROOT, 'server/src/systems/airdrop.js'));

const SHOTS = process.env.SHOT_DIR || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function until(fn, { timeout = 6000, step = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(step);
  }
}

// ---------------------------------------------------------------- helpers
const gameInfo = (page) => page.evaluate(() => window.__game?.debugInfo());
const visible = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return false;
  const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
}, sel);
const hasClass = (page, sel, cls) => page.evaluate(([s, c]) => document.querySelector(s)?.classList.contains(c) ?? null, [sel, cls]);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);

/** Count the server events the page receives. */
async function track(page, names) {
  await page.evaluate((list) => {
    window.__ev = {};
    for (const n of list) window.__game.client.on(n, (p) => { (window.__ev[n] ??= []).push(p); });
  }, names);
}
const events = (page, name) => page.evaluate((n) => window.__ev?.[n] ?? [], name);

const serverPlayer = (room, name) => [...room.players.values()].find((p) => p.callsign === name);

function place(room, p, x, z, yaw = 0) {
  p.x = x; p.z = z; p.y = getTerrainHeight(x, z); p.yaw = yaw; p.pitch = 0; p.stance = 'stand';
  p.invulnUntil = 0;
  room.correct(p, room.clock()); // tells the player's browser to move there
}

function dirTo(from, to, h = 1.1) {
  const e = getEyePosition(from);
  const dx = to.x - e.x; const dy = to.y + h - e.y; const dz = to.z - e.z;
  const l = Math.hypot(dx, dy, dz);
  return { x: dx / l, y: dy / l, z: dz / l };
}

async function center(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Multi-finger touch through Chrome's own touch input. */
async function fingers(page) {
  const client = await page.context().newCDPSession(page);
  const active = new Map();
  const points = () => [...active].map(([id, p]) => ({ x: p.x, y: p.y, id }));
  return {
    async down(id, x, y) { active.set(id, { x, y }); await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points() }); },
    async move(id, x, y) { active.set(id, { x, y }); await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points() }); },
    async up(id) { active.delete(id); await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: points() }); },
    async tap(x, y) { await this.down(99, x, y); await sleep(60); await this.up(99); }
  };
}

const run = async (name, fn) => {
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err.stack || err}`);
    console.log(`  FAIL ${name} threw: ${err.message}`);
  }
};

const noErrors = (page, label = 'no browser errors', { allow401 = false } = {}) => {
  const errors = page.log.errors.filter((e) => !(allow401 && /status of 401/.test(e)));
  check(label, errors.length === 0, JSON.stringify(errors.slice(0, 3)).slice(0, 600));
};

// ================================================================ the tests
const h = await startHarness();

try {
  // ---------------------------------------------------------------- lobby
  await run('lobby', async () => {
    const page = await h.newPage();
    await h.openLobby(page, { room: 'lobby1' });
    await page.waitForFunction(() => document.querySelector('#online-chip')?.textContent === 'Server online');
    const primary = await page.$$eval('#slot-primary option', (o) => o.map((x) => x.textContent));
    check('primary list has no air-drop-only guns', !primary.some((n) => /TRG|Vidhwansak|Negev/.test(n)) && primary.length === 6, primary.join('|'));
    check('sidearm and launcher lists', (await page.$$eval('#slot-secondary option', (o) => o.length)) === 1 && (await page.$$eval('#slot-launcher option', (o) => o.length)) === 1);
    check('no stray "null" text anywhere', !(await page.evaluate(() => document.body.innerText)).includes('null'));
    check('room code pre-filled from the address', (await page.inputValue('#room')) === 'lobby1');

    // bad inputs
    await page.fill('#room', 'bad room!');
    await page.click('#deploy');
    check('bad room code is refused', /Room code/.test(await text(page, '#lobby-error')));
    await page.fill('#room', 'lobby1');
    await page.fill('#callsign', 'x');
    await page.click('#deploy');
    check('bad callsign is refused', /Callsign/.test(await text(page, '#lobby-error')));

    // account tabs
    await page.click('.tab[data-tab=register]');
    check('register tab shows the password box', await visible(page, '#password'));
    await page.fill('#callsign', 'Rajput_07');
    await page.fill('#password', '123');
    await page.click('#deploy');
    check('short password is refused', /at least 6/.test(await text(page, '#lobby-error')));

    // settings from the lobby
    await page.click('#btn-settings');
    check('settings panel opens', await visible(page, '#set-sens'));
    await page.fill('#set-sens', '1.5');
    await page.check('#set-fps');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bop.settings.v1')));
    check('settings are saved', stored.sensitivity === 1.5 && stored.showFps === true, JSON.stringify(stored));
    await page.click('#settings-done');
    check('settings panel closes', !(await visible(page, '#set-sens')));
    noErrors(page);
    await page.context().close();
  });

  // ---------------------------------------------------------------- accounts
  await run('accounts and loadout', async () => {
    const page = await h.newPage();
    await h.openLobby(page, { room: 'acct1' });
    await page.click('.tab[data-tab=register]');
    await page.fill('#callsign', 'Veer_Param');
    await page.fill('#password', 'jaihind99');
    await page.selectOption('#slot-primary', 'ak203');
    await page.click('#deploy');
    await page.waitForFunction(() => window.__game?.running === true, null, { timeout: 15000 });
    const session = await page.evaluate(() => JSON.parse(localStorage.getItem('bop.session.v1')));
    check('registered account (not a guest)', session.guest === false && session.callsign === 'Veer_Param');
    const room = h.room('acct1');
    const p = serverPlayer(room, 'Veer_Param');
    check('server gave the chosen rifle', p?.loadout.primary === 'ak203', JSON.stringify(p?.loadout));
    await sleep(400);
    const saved = await h.dispatch('GET', '/api/loadout', { headers: { authorization: `Bearer ${session.token}` }, ip: '1.1.1.1' });
    check('loadout was saved to the account', saved.body.loadout?.primary === 'ak203', JSON.stringify(saved.body));

    // leave through the menu, then sign in again
    await page.click('#btn-menu');
    await page.click('#menu-leave');
    await page.waitForSelector('#deploy');
    check('back in the lobby', await visible(page, '#lobby') && !(await page.evaluate(() => document.body.classList.contains('playing'))));
    check('canvas removed after leaving', (await page.evaluate(() => document.querySelectorAll('#stage canvas').length)) === 0);
    check('still signed in', (await text(page, '#who-name')) === 'Veer_Param');
    await page.click('#btn-signout');
    await page.click('.tab[data-tab=login]');
    await page.fill('#callsign', 'Veer_Param');
    await page.fill('#password', 'wrongpass');
    await page.click('#deploy');
    await until(() => text(page, '#lobby-error').then((t) => t && t.length > 0));
    check('wrong password shows the server message', /password|callsign/i.test(await text(page, '#lobby-error') || ''), await text(page, '#lobby-error'));
    await page.fill('#password', 'jaihind99');
    await page.click('#deploy');
    await page.waitForFunction(() => window.__game?.running === true, null, { timeout: 15000 });
    check('signed in again, loadout remembered', (await page.evaluate(() => window.__game.state.me.loadout.primary)) === 'ak203');
    noErrors(page, "no browser errors (the 401 from the wrong password is expected)", { allow401: true });
    await page.context().close();
  });

  // ---------------------------------------------------------------- expired session
  await run('expired session', async () => {
    const page = await h.newPage({ init: () => localStorage.setItem('bop.session.v1', JSON.stringify({ token: 'bogus.token', callsign: 'Ghost', guest: true })) });
    await h.openLobby(page, { room: 'exp1' });
    const gone = await until(async () => /expired/.test((await text(page, '#lobby-notice')) || ''));
    check('expired session is noticed and cleared', gone && (await text(page, '#callsign')) !== 'Ghost');
    noErrors(page, "no browser errors (the 401 for the stale token is expected)", { allow401: true });
    await page.context().close();
  });

  // ---------------------------------------------------------------- keyboard + mouse play
  await run('desktop play: movement, stance, jump, look', async () => {
    const page = await h.newPage();
    const roomId = await h.deployGuest(page, { callsign: 'Desk', room: 'desk1' });
    const room = h.room(roomId);
    const sp = serverPlayer(room, 'Desk');
    await track(page, ['correction']);
    await sleep(300);
    const a = (await gameInfo(page)).pos;
    await page.keyboard.down('KeyW'); await sleep(800); await page.keyboard.up('KeyW');
    const b = (await gameInfo(page)).pos;
    const walked = Math.hypot(b.x - a.x, b.z - a.z);
    check('walking moves the soldier about 5m a second', walked > 3 && walked < 7, `walked ${walked.toFixed(2)}`);
    await sleep(200);
    check('the server agrees with the client position', Math.hypot(sp.x - b.x, sp.z - b.z) < 1.5, `server ${sp.x.toFixed(1)},${sp.z.toFixed(1)} client ${b.x.toFixed(1)},${b.z.toFixed(1)}`);
    check('no anti-cheat corrections for honest play', (await events(page, 'correction')).length === 0);

    const c = (await gameInfo(page)).pos;
    await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW'); await sleep(800);
    await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
    const d = (await gameInfo(page)).pos;
    check('sprinting is faster than walking', Math.hypot(d.x - c.x, d.z - c.z) > walked * 1.15, `sprint ${Math.hypot(d.x - c.x, d.z - c.z).toFixed(2)}`);

    await page.keyboard.press('KeyC');
    await until(() => sp.stance === 'crouch');
    check('crouch reaches the server', sp.stance === 'crouch', sp.stance);
    await page.keyboard.press('KeyZ');
    await until(() => sp.stance === 'prone');
    check('prone reaches the server', sp.stance === 'prone', sp.stance);
    await page.keyboard.press('KeyZ');
    await until(() => sp.stance === 'stand');
    check('standing up again', sp.stance === 'stand', sp.stance);

    const y0 = (await gameInfo(page)).pos.y;
    await page.keyboard.press('Space'); await sleep(250);
    const y1 = (await gameInfo(page)).pos.y;
    check('jump lifts the soldier', y1 > y0 + 0.4, `${y0.toFixed(2)} -> ${y1.toFixed(2)}`);
    await sleep(900);

    const yaw0 = (await gameInfo(page)).pos.yaw;
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousemove', { movementX: 100, movementY: 0 })));
    await sleep(50);
    const yaw1 = (await gameInfo(page)).pos.yaw;
    check('moving the mouse right turns right (yaw decreases)', yaw1 < yaw0 - 0.05, `${yaw0} -> ${yaw1}`);
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: -100 })));
    await sleep(50);
    check('moving the mouse up looks up', (await gameInfo(page)).pos.pitch > 0.05);

    await page.keyboard.press('KeyV');
    await sleep(120);
    check('V switches to third person', (await gameInfo(page)).view === 'third');
    await page.keyboard.press('KeyV');
    await sleep(120);
    check('and back', (await gameInfo(page)).view === 'first');

    await page.keyboard.down('Tab'); await sleep(100);
    check('Tab shows the scoreboard', await visible(page, '#scoreboard') && /Desk/.test(await text(page, '#scoreboard')));
    await page.keyboard.up('Tab'); await sleep(100);
    check('scoreboard hides again', !(await visible(page, '#scoreboard')));
    noErrors(page);
    await page.context().close();
  });

  // ---------------------------------------------------------------- shooting & being shot
  await run('combat: shoot, hit, get hit, die, respawn', async () => {
    const page = await h.newPage();
    const roomId = await h.deployGuest(page, { callsign: 'Hero', room: 'fight1' });
    const room = h.room(roomId);
    const hero = serverPlayer(room, 'Hero');
    const bot = h.bot({ name: 'Rival', roomId });
    bot.join();
    await sleep(100);
    const foe = bot.player;
    // opposite teams or the bullets pass through
    foe.team = hero.team === 'bharat' ? 'opfor' : 'bharat';
    place(room, hero, 0, -60, Math.PI);
    place(room, foe, 0, -50, 0);
    await sleep(300);
    await track(page, ['hit_confirm', 'shot_fired', 'damage_taken', 'you_died', 'kill_feed', 'respawned']);

    // aim at the rival and hold the mouse button
    await page.evaluate(([x, y, z]) => {
      const g = window.__game; const c = g.controller;
      const e = { x: c.x, y: c.y + 1.62, z: c.z };
      c.yaw = Math.atan2(-(x - e.x), -(z - e.z)); c.pitch = Math.atan2(y + 1.1 - e.y, Math.hypot(x - e.x, z - e.z));
    }, [foe.x, foe.y, foe.z]);
    const hp0 = foe.hp + foe.armor;
    await page.mouse.down(); await sleep(300); await page.mouse.up();
    await sleep(200);
    const hp1 = foe.hp + foe.armor;
    check('holding fire damages the rival', hp1 < hp0, `${hp0} -> ${hp1}`);
    check('a short burst does not kill a full-health rival', foe.alive);
    check('client sees the hit confirmations', (await events(page, 'hit_confirm')).length > 0);
    check('client sends several shots', (await events(page, 'shot_fired')).length >= 2, String((await events(page, 'shot_fired')).length));
    const ammo = await page.evaluate(() => window.__game.state.me.ammo.primary.mag);
    check('ammo counter goes down', ammo < 20 && ammo >= 15, String(ammo));
    check('ammo shows on the HUD', /^\d+$/.test((await text(page, '#ammo-mag')) || ''));

    // the rival shoots back
    place(room, foe, 0, -50, 0);
    foe.invulnUntil = 0; hero.invulnUntil = 0;
    foe.pitch = 0;
    const hpBefore = hero.hp + hero.armor;
    bot.send('shoot', { dir: dirTo(foe, hero) });
    await sleep(300);
    check('being shot lowers health', hero.hp + hero.armor < hpBefore);
    check('damage event reaches the browser', (await events(page, 'damage_taken')).length > 0);
    check('red arrow shows where it came from', (await page.evaluate(() => document.querySelectorAll('#dmg-arrows .dmg-arrow').length)) > 0);

    // kill the hero
    room.dealDamage(foe, hero, 9999, { weapon: 'sig716', headshot: true, src: { x: foe.x, z: foe.z }, now: room.clock() });
    await until(async () => visible(page, '#respawn-overlay'));
    check('death screen appears', await visible(page, '#respawn-overlay'));
    await shot(page, 'desktop-dead');
    check('death screen names the killer', /Rival/.test((await text(page, '#death-by')) || ''), await text(page, '#death-by'));
    check('kill feed shows the kill', /Rival/.test((await text(page, '#kill-feed')) || ''));
    check('controls are off while dead', (await page.evaluate(() => window.__game.dead)) === true);
    const diedAt = Date.now();
    await until(async () => !(await visible(page, '#respawn-overlay')), { timeout: 9000 });
    check('respawns after the countdown', !(await visible(page, '#respawn-overlay')) && Date.now() - diedAt > 3000, `${Date.now() - diedAt}ms`);
    // the respawn event comes just ahead of the first snapshot that shows the new health (at most 50 ms)
    await until(async () => (await gameInfo(page)).hp === 100, { timeout: 2000 });
    const info = await gameInfo(page);
    check('alive again with full health', info.dead === false && info.hp === 100, JSON.stringify(info));
    check('moved to a spawn point', Math.hypot(info.pos.x - 0, info.pos.z + 60) > 5, JSON.stringify(info.pos));
    await sleep(300);
    const sp2 = serverPlayer(room, 'Hero');
    await page.keyboard.down('KeyW'); await sleep(600); await page.keyboard.up('KeyW');
    await sleep(150);
    const after = (await gameInfo(page)).pos;
    check('movement still accepted after respawn (epoch in sync)', Math.hypot(sp2.x - after.x, sp2.z - after.z) < 1.5, `server ${sp2.x.toFixed(1)},${sp2.z.toFixed(1)} client ${after.x.toFixed(1)},${after.z.toFixed(1)}`);
    noErrors(page);
    await page.context().close();
  });

  // ---------------------------------------------------------------- grenades, missile, drones, healing
  await run('gear: grenade, missile, drone, healing', async () => {
    const page = await h.newPage();
    const roomId = await h.deployGuest(page, { callsign: 'Gear', room: 'gear1' });
    const room = h.room(roomId);
    const me = serverPlayer(room, 'Gear');
    me.invulnUntil = 0;
    await track(page, ['grenade_thrown', 'missile_incoming', 'drone_deployed', 'drone_ended', 'heal_started', 'heal_done', 'explosion']);
    await sleep(300);

    await page.keyboard.press('KeyG');
    await until(() => me.inventory.frag === 1);
    check('G throws a frag grenade', me.inventory.frag === 1 && (await events(page, 'grenade_thrown')).length === 1);
    await sleep(1100); // the throw cool-down
    await page.keyboard.press('KeyT');
    await until(() => me.inventory.smoke === 1);
    check('T throws a smoke grenade', me.inventory.smoke === 1);

    await page.keyboard.press('Digit4');
    await until(async () => (await events(page, 'missile_incoming')).length > 0);
    check('4 calls a missile strike', (await events(page, 'missile_incoming')).length === 1);
    check('warning banner is shown', /missile/i.test((await text(page, '#banner')) || ''), await text(page, '#banner'));

    await page.keyboard.press('Digit5');
    await until(async () => (await gameInfo(page)).drone === 'fpv');
    check('5 launches an FPV drone and switches to its camera', (await gameInfo(page)).drone === 'fpv');
    check('drone screen is up', await visible(page, '#drone-overlay'));
    await until(() => page.evaluate(() => !!window.__game.state.myDrone()));
    const d0 = await page.evaluate(() => { const d = window.__game.state.myDrone(); return d && { x: d.x, y: d.y, z: d.z }; });
    await page.keyboard.down('KeyW'); await sleep(700); await page.keyboard.up('KeyW');
    const d1 = await page.evaluate(() => { const d = window.__game.state.myDrone(); return d && { x: d.x, y: d.y, z: d.z }; });
    check('W flies the drone', d0 && d1 && Math.hypot(d1.x - d0.x, d1.y - d0.y, d1.z - d0.z) > 1, JSON.stringify([d0, d1]));
    await page.keyboard.press('KeyB');
    await until(async () => (await gameInfo(page)).drone === null);
    check('B recalls the drone and returns to the soldier', (await gameInfo(page)).drone === null && !(await visible(page, '#drone-overlay')));

    await sleep(500);
    me.hp = 40;
    await page.keyboard.press('Digit7');
    await until(async () => (await events(page, 'heal_started')).length > 0);
    check('7 starts a bandage', (await events(page, 'heal_started')).length === 1);
    check('progress bar is shown while healing', await until(() => visible(page, '#progress'), { timeout: 1500 }));
    await until(async () => (await events(page, 'heal_done')).length > 0, { timeout: 4000 });
    check('bandage heals', me.hp > 40 && me.inventory.bandage === 3, `hp ${me.hp} bandages ${me.inventory.bandage}`);

    // switching weapons and reloading
    await page.keyboard.press('Digit2');
    await until(() => me.activeSlot === 'secondary');
    check('2 switches to the pistol', me.activeSlot === 'secondary');
    await sleep(600);
    check('weapon name updates on the HUD', /Pistol/.test((await text(page, '#weapon-name')) || ''), await text(page, '#weapon-name'));
    await page.keyboard.press('Digit1');
    await until(() => me.activeSlot === 'primary');
    me.ammo.primary.mag = 5;
    await until(() => page.evaluate(() => window.__game.state.me.ammo.primary.mag === 5)); // the client has to see it first
    await page.keyboard.press('KeyR');
    await until(() => me.ammo.primary.mag === 20, { timeout: 4000 });
    check('R reloads the rifle', me.ammo.primary.mag === 20, String(me.ammo.primary.mag));
    noErrors(page);
    await page.context().close();
  });

  // ---------------------------------------------------------------- pause menu
  await run('pause menu and settings in game', async () => {
    const page = await h.newPage();
    await h.deployGuest(page, { callsign: 'Pauser', room: 'pause1' });
    await page.click('#btn-menu');
    check('menu opens', await visible(page, '#menu-resume'));
    check('game is paused for input', (await gameInfo(page)).paused === true);
    await page.click('#menu-settings');
    check('settings open from the menu', await visible(page, '#set-volume'));
    await shot(page, 'desktop-settings');
    await page.click('#settings-done');
    check('back to the menu', await visible(page, '#menu-resume'));
    await page.click('#menu-resume');
    check('resume closes the menu', !(await visible(page, '#menu-resume')) && (await gameInfo(page)).paused === false);
    // Esc (pointer lock lost) opens the menu by itself
    await page.evaluate(() => document.exitPointerLock());
    await until(async () => visible(page, '#menu-resume'));
    check('losing the mouse capture opens the menu', await visible(page, '#menu-resume'));
    await page.keyboard.press('Escape');
    check('Escape closes it again', !(await visible(page, '#menu-resume')));
    noErrors(page);
    await page.context().close();
  });

  // ---------------------------------------------------------------- end of match
  await run('match end, play again, leave', async () => {
    const page = await h.newPage();
    const roomId = await h.deployGuest(page, { callsign: 'Finisher', room: 'end1' });
    const room = h.room(roomId);
    const bot = h.bot({ name: 'Other', roomId });
    bot.join();
    await sleep(200);
    room.finish('time');
    await until(async () => visible(page, '#result-title'));
    check('result screen appears', await visible(page, '#result-title'), await text(page, '#result-title'));
    await shot(page, 'desktop-result');
    check('result has a headline', /VICTORY|DEFEAT|DRAW|MATCH OVER/.test((await text(page, '#result-title')) || ''));
    check('result lists the players', /Finisher/.test((await text(page, '.result')) || '') && /Other/.test((await text(page, '.result')) || ''));
    check('game loop stopped', (await gameInfo(page)).running === false);
    await page.click('#result-again');
    await page.waitForFunction(() => window.__game?.running === true && !window.__game.ended, null, { timeout: 15000 });
    check('play again joins a fresh match', (await gameInfo(page)).running === true && !(await visible(page, '#result-title')));
    check('a new room object was created', h.room('end1') !== room && !h.room('end1').ended);
    await page.click('#btn-menu');
    await page.click('#menu-leave');
    await page.waitForSelector('#deploy');
    check('leaving returns to the lobby', await visible(page, '#lobby'));
    noErrors(page);
    await page.context().close();
  });

  // ---------------------------------------------------------------- scope, FFA, supply crate
  await run('free-for-all, sniper scope, supply crate', async () => {
    const page = await h.newPage();
    const roomId = await h.deployGuest(page, { callsign: 'Sniper', room: 'edge1', mode: 'FFA', primary: 'svd' });
    const room = h.room(roomId);
    const me = serverPlayer(room, 'Sniper');
    check('free-for-all match: no teams', room.mode === 'FFA' && me.team === 'ffa', `${room.mode} ${me.team}`);
    await sleep(300);
    check('HUD says free for all', /FREE FOR ALL|FFA/i.test((await text(page, '#mode-line')) || ''), await text(page, '#mode-line'));
    check('server gave the sniper rifle', me.loadout.primary === 'svd', JSON.stringify(me.loadout));

    await page.mouse.down({ button: 'right' });
    await sleep(250);
    check('right mouse button aims down the sights', (await page.evaluate(() => window.__game.controller.ads)) === true);
    check('a sniper rifle shows the scope and hides the crosshair', await visible(page, '#scope') && (await hasClass(page, '#crosshair', 'hidden')) === true);
    await page.mouse.up({ button: 'right' });
    await sleep(250);
    check('letting go zooms back out', !(await visible(page, '#scope')) && (await hasClass(page, '#crosshair', 'hidden')) === false);

    // a supply crate lands next to the soldier
    const crate = room.airdrops.spawn();
    const loot = LOOT_TABLE.find((l) => l.id === 'trg');
    Object.assign(crate, { x: me.x + 1.5, z: me.z, loot, label: describeLoot(loot), landed: true, expiresAt: room.clock() + 60000 });
    crate.groundY = getTerrainHeight(crate.x, crate.z);
    crate.y = crate.groundY;
    room.airdrops.crates.push(crate);
    await until(() => visible(page, '#prompt'));
    check('a loot prompt appears next to the crate', /Press F to loot/.test((await text(page, '#prompt')) || ''), await text(page, '#prompt'));
    await page.keyboard.press('KeyF');
    await until(() => me.loadout.primary === 'trg42');
    check('F loots the crate: new rifle and armour', me.loadout.primary === 'trg42' && me.armor === 100, `${me.loadout.primary} ${me.armor}`);
    check('the crate is gone from the world', room.airdrops.crates.length === 0);
    await sleep(300);
    check('prompt disappears after looting', !(await visible(page, '#prompt')));
    noErrors(page);
    await page.context().close();
  });

  // ---------------------------------------------------------------- things going wrong
  await run('full room, offline backend, kicked out', async () => {
    // a room that is already full
    const bots = [];
    const probe = h.bot({ name: 'Seat0', roomId: 'full1' });
    probe.join();
    const room = h.room('full1');
    room.capacity = 1;
    bots.push(probe);
    const page = await h.newPage();
    await h.openLobby(page, { room: 'full1' });
    await page.fill('#callsign', 'Latecomer');
    await page.click('#deploy');
    await until(async () => /full/i.test((await text(page, '#lobby-error')) || ''));
    check('a full room says so, and the lobby stays usable', /full/i.test((await text(page, '#lobby-error')) || '') && await visible(page, '#lobby') && !(await page.evaluate(() => document.querySelector('#deploy').disabled)), await text(page, '#lobby-error'));
    check('nothing is left running or on screen', (await page.evaluate(() => document.querySelectorAll('#stage canvas').length)) === 0 && (await page.evaluate(() => !document.body.classList.contains('playing'))));
    await page.context().close();

    // the web API cannot be reached
    const offline = await h.newPage();
    await offline.route('**/api/**', (r) => r.abort('connectionrefused'));
    await h.openLobby(offline, { room: 'off1' });
    await until(async () => /offline|unreachable|not reachable/i.test((await text(offline, '#online-chip')) || ''));
    check('lobby shows the server as offline', /offline|unreachable|not reachable/i.test((await text(offline, '#online-chip')) || ''), await text(offline, '#online-chip'));
    await offline.fill('#callsign', 'Nobody');
    await offline.click('#deploy');
    await until(async () => ((await text(offline, '#lobby-error')) || '').length > 0);
    check('deploying says what is wrong', ((await text(offline, '#lobby-error')) || '').length > 5, await text(offline, '#lobby-error'));
    check('and the button works again', !(await offline.evaluate(() => document.querySelector('#deploy').disabled)));
    await offline.context().close();

    // the server removes a player mid-match
    const page2 = await h.newPage();
    await h.deployGuest(page2, { callsign: 'Removed', room: 'kick1' });
    const conn = [...page2.server.conns.values()].pop();
    conn.socket.emit('kicked', { reason: 'Too many requests. You were removed from the match.' });
    await until(async () => visible(page2, '#error-text'));
    check('being removed shows the reason', /Too many requests/.test((await text(page2, '#error-text')) || ''), await text(page2, '#error-text'));
    check('the game loop has stopped', (await gameInfo(page2)).running === false);
    await page2.click('#error-back');
    await page2.waitForSelector('#deploy');
    check('back to the lobby', await visible(page2, '#lobby'));
    noErrors(page2);
    await page2.context().close();
  });

  // ---------------------------------------------------------------- reconnect and takeover
  await run('connection loss, reconnect, second device', async () => {
    const page = await h.newPage();
    const roomId = await h.deployGuest(page, { callsign: 'Flaky', room: 'net1' });
    const room = h.room(roomId);
    const idBefore = await page.evaluate(() => window.__game.state.myId);
    await track(page, ['match_joined']);
    await page.evaluate(() => window.__sockets[0].__drop());
    await until(async () => visible(page, '#conn-banner'));
    check('"connection lost" banner appears', await visible(page, '#conn-banner'));
    await sleep(300);
    await page.evaluate(() => window.__sockets[0].__reconnect());
    await until(async () => !(await visible(page, '#conn-banner')));
    check('banner clears after reconnecting', !(await visible(page, '#conn-banner')));
    const idAfter = await page.evaluate(() => window.__game.state.myId);
    check('same soldier is resumed (no second body)', idBefore === idAfter && room.players.size === 1, `${idBefore} ${idAfter} players=${room.players.size}`);
    check('resume was reported', (await events(page, 'match_joined')).some((m) => m.resumed === true));
    check('still playing', (await gameInfo(page)).running === true);

    // the same account joins from another device: this one is told
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('bop.session.v1')).token);
    const other = h.bot({ name: 'Flaky', roomId });
    other.conn.fire('join_match', { token, roomId, mode: 'TDM' });
    await until(async () => visible(page, '#error-text'));
    check('first device is told it was replaced', /another|device|tab/i.test((await text(page, '#error-text')) || ''), await text(page, '#error-text'));
    await page.click('#error-back');
    await page.waitForSelector('#deploy');
    check('back to the lobby after being replaced', await visible(page, '#lobby'));
    noErrors(page);
    await page.context().close();
  });
} finally {
  // remaining sections run below (touch) in the same harness
}

// ================================================================ touch
const PHONE = { width: 844, height: 390 };
try {
  await run('touch: layout, stick, look, fire, aim, jump, stance, drawer, drone', async () => {
    const page = await h.newPage({ viewport: PHONE, touch: true, scale: 2 });
    const roomId = await h.deployGuest(page, { callsign: 'Phone', room: 'touch1', touch: true });
    const room = h.room(roomId);
    const me = serverPlayer(room, 'Phone');
    const f = await fingers(page);
    await sleep(400);
    check('touch layer is shown, keyboard hints are not', await visible(page, '.t-fire') && !(await visible(page, '.gear-box')));
    const onScreen = [];
    for (const id of ['fire', 'ads', 'jump', 'reload', 'stance', 'frag', 'smoke', 'more']) onScreen.push(await visible(page, `.t-${id}`));
    check('FIRE, AIM, JUMP, RELOAD, STANCE, FRAG, SMOKE, MORE are on screen', onScreen.every(Boolean), onScreen.join());
    check('drone buttons and LOOT are not shown yet', !(await visible(page, '.t-boom')) && !(await visible(page, '.t-up')) && !(await visible(page, '.t-loot')));
    check('idle ring shows where the move thumb goes', await visible(page, '.stick-hint'));

    // --- joystick
    const p0 = (await gameInfo(page)).pos;
    await f.down(1, 110, 300);
    await f.move(1, 110, 250);
    await sleep(900);
    check('floating stick appears under the thumb', await visible(page, '.stick-base'));
    await f.up(1);
    const p1 = (await gameInfo(page)).pos;
    check('pushing the stick up walks forward', Math.hypot(p1.x - p0.x, p1.z - p0.z) > 2.5, `${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2)}m`);
    await sleep(200);
    check('stick vanishes when released', !(await visible(page, '.stick-base')));
    await f.down(1, 110, 300);
    await f.move(1, 110, 220);
    await sleep(300);
    check('pushing the stick all the way sprints', await page.evaluate(() => document.querySelector('.stick-base')?.classList.contains('sprint') ?? false));
    await f.up(1);

    // --- look
    const y0 = (await gameInfo(page)).pos.yaw;
    await f.down(2, 480, 200);
    for (let i = 1; i <= 6; i++) await f.move(2, 480 + i * 15, 200);
    await f.up(2);
    const y1 = (await gameInfo(page)).pos.yaw;
    check('dragging right in the look zone turns right', y1 < y0 - 0.05, `${y0} -> ${y1}`);

    // --- AIM toggle
    const aim = await center(page, '.t-ads');
    await f.tap(aim.x, aim.y);
    await sleep(120);
    check('AIM turns the sights on', await page.evaluate(() => document.querySelector('.t-ads').classList.contains('on')) && (await page.evaluate(() => window.__game.controller.ads)) === true);
    await f.tap(aim.x, aim.y);
    await sleep(120);
    check('AIM turns the sights off again', (await page.evaluate(() => window.__game.controller.ads)) === false);

    // --- jump
    const jump = await center(page, '.t-jump');
    const yy0 = (await gameInfo(page)).pos.y;
    await f.down(3, jump.x, jump.y); await sleep(60); await f.up(3); await sleep(220);
    check('JUMP lifts the soldier', (await gameInfo(page)).pos.y > yy0 + 0.3);
    await sleep(900);

    // --- stance cycle stand -> crouch -> prone -> stand
    const st = await center(page, '.t-stance');
    await f.tap(st.x, st.y); await until(() => me.stance === 'crouch');
    check('STANCE once = crouch', me.stance === 'crouch', me.stance);
    await f.tap(st.x, st.y); await until(() => me.stance === 'prone');
    check('STANCE twice = prone', me.stance === 'prone', me.stance);
    await f.tap(st.x, st.y); await until(() => me.stance === 'stand');
    check('STANCE three times = stand', me.stance === 'stand', me.stance);

    // --- weapon chips are tappable
    const chip = await center(page, '.slot-chip[data-slot=secondary]');
    await f.tap(chip.x, chip.y);
    await until(() => me.activeSlot === 'secondary');
    check('tapping the pistol chip switches weapon', me.activeSlot === 'secondary');
    const chip1 = await center(page, '.slot-chip[data-slot=primary]');
    await f.tap(chip1.x, chip1.y);
    await until(() => me.activeSlot === 'primary');
    await sleep(600);

    // --- FIRE (hold) with a rival in front
    const bot = h.bot({ name: 'Target', roomId });
    bot.join();
    await sleep(100);
    const foe = bot.player;
    foe.team = me.team === 'bharat' ? 'opfor' : 'bharat';
    place(room, me, 0, -60, Math.PI);
    place(room, foe, 0, -50, 0);
    await sleep(300);
    await track(page, ['hit_confirm', 'shot_fired']);
    await page.evaluate(([x, y, z]) => {
      const c = window.__game.controller; const e = { x: c.x, y: c.y + 1.62, z: c.z };
      c.yaw = Math.atan2(-(x - e.x), -(z - e.z)); c.pitch = Math.atan2(y + 1.1 - e.y, Math.hypot(x - e.x, z - e.z));
    }, [foe.x, foe.y, foe.z]);
    const fire = await center(page, '.t-fire');
    const hpA = foe.hp + foe.armor;
    await f.down(4, fire.x, fire.y);
    await sleep(500);
    check('FIRE button shows pressed', await page.evaluate(() => document.querySelector('.t-fire').classList.contains('down')));
    // slide the thumb while firing: the view turns
    const yawA = (await gameInfo(page)).pos.yaw;
    for (let i = 1; i <= 5; i++) await f.move(4, fire.x + i * 6, fire.y);
    await sleep(100);
    const yawB = (await gameInfo(page)).pos.yaw;
    await f.up(4);
    await sleep(250);
    check('holding FIRE damages the rival', foe.hp + foe.armor < hpA, `${hpA} -> ${foe.hp + foe.armor}`);
    check('sliding the FIRE thumb turns the view', yawB < yawA - 0.02, `${yawA} -> ${yawB}`);
    check('FIRE released stops shooting', !(await page.evaluate(() => document.querySelector('.t-fire').classList.contains('down'))));

    // --- MORE drawer, missile, drone
    const more = await center(page, '.t-more');
    await f.tap(more.x, more.y);
    await sleep(150);
    check('MORE opens the drawer', await visible(page, '.drawer'));
    check('drawer has missile, drones, view, heals, cancel', (await page.$$eval('.drawer .tbtn', (n) => n.length)) >= 8);
    const drawerBox = await page.locator('.drawer').boundingBox();
    await shot(page, 'touch-drawer');
    check('drawer fits on screen', drawerBox.x >= 0 && drawerBox.y >= 0 && drawerBox.x + drawerBox.width <= PHONE.width && drawerBox.y + drawerBox.height <= PHONE.height, JSON.stringify(drawerBox));
    const fpv = await center(page, '.drawer [data-id=fpv], .drawer .tbtn:nth-child(2)');
    await f.tap(fpv.x, fpv.y);
    await until(async () => (await gameInfo(page)).drone !== null);
    check('FPV drone launches from the drawer', (await gameInfo(page)).drone === 'fpv');
    await sleep(200);
    check('drawer closed itself', !(await visible(page, '.drawer')));
    await shot(page, 'touch-drone');
    check('drone buttons replace soldier buttons', await visible(page, '.t-boom') && await visible(page, '.t-exit') && !(await visible(page, '.t-fire')));
    const up = await center(page, '.t-up');
    const dd0 = await page.evaluate(() => window.__game.state.myDrone().y);
    await f.down(5, up.x, up.y); await sleep(700); await f.up(5);
    const dd1 = await page.evaluate(() => window.__game.state.myDrone().y);
    check('UP climbs while held', dd1 > dd0 + 0.5, `${dd0.toFixed(1)} -> ${dd1.toFixed(1)}`);
    const exit = await center(page, '.t-exit');
    await f.tap(exit.x, exit.y);
    await until(async () => (await gameInfo(page)).drone === null);
    check('EXIT recalls the drone', (await gameInfo(page)).drone === null && await visible(page, '.t-fire'));
    noErrors(page);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'touch-after.png') });
    await page.context().close();
  });

  await run('touch: portrait shows the rotate notice; death hides the buttons', async () => {
    // a phone held upright: the match is covered by the "turn your phone" notice
    const tall = await h.newPage({ viewport: { width: 390, height: 844 }, touch: true, scale: 2 });
    await h.deployGuest(tall, { callsign: 'Portrait', room: 'touch2', touch: true });
    check('rotate-your-phone notice covers a portrait match', await visible(tall, '#rotate-hint'));
    noErrors(tall, 'no browser errors (portrait)');
    await tall.context().close();

    const page = await h.newPage({ viewport: PHONE, touch: true, scale: 2 });
    const roomId = await h.deployGuest(page, { callsign: 'Landscape', room: 'touch3', touch: true });
    check('no notice in landscape', !(await visible(page, '#rotate-hint')));
    const room = h.room(roomId);
    const me = serverPlayer(room, 'Landscape');
    const foe = h.bot({ name: 'Killer', roomId });
    foe.join();
    await sleep(100);
    me.invulnUntil = 0;
    room.dealDamage(foe.player, me, 9999, { weapon: 'sig716', now: room.clock() });
    await until(async () => visible(page, '#respawn-overlay'));
    check('death screen shows on a phone', await visible(page, '#respawn-overlay'));
    check('touch buttons are hidden while dead', !(await visible(page, '.t-fire')) && !(await visible(page, '.stick-hint')));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'touch-dead.png') });
    await until(async () => visible(page, '.t-fire'), { timeout: 9000 });
    check('and come back after respawn', await visible(page, '.t-fire') && await visible(page, '.stick-hint'));
    noErrors(page);
    await page.context().close();
  });

  // layout at the three target sizes, plus screenshots
  await run('touch layout at 740x360, 844x390 and 932x430', async () => {
    for (const [w, hgt] of [[740, 360], [844, 390], [932, 430]]) {
      const page = await h.newPage({ viewport: { width: w, height: hgt }, touch: true, scale: 2 });
      await h.deployGuest(page, { callsign: `L${w}`, room: `lay${w}`, touch: true });
      await sleep(300);
      const rects = await page.evaluate(() => [...document.querySelectorAll('.tbtn, .score-box, .vitals, .weapon-box, .kill-feed')]
        .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && getComputedStyle(n).display !== 'none'; })
        .map((n) => { const r = n.getBoundingClientRect(); return { c: n.className.toString(), x: r.left, y: r.top, w: r.width, h: r.height }; }));
      const btns = rects.filter((r) => r.c.startsWith('tbtn'));
      const hud = rects.filter((r) => !r.c.startsWith('tbtn'));
      const hit = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
      const bad = [];
      btns.forEach((a, i) => {
        if (a.x < 0 || a.y < 0 || a.x + a.w > w || a.y + a.h > hgt) bad.push(`off-screen ${a.c}`);
        btns.slice(i + 1).forEach((b) => hit(a, b) && bad.push(`${a.c} x ${b.c}`));
        hud.forEach((o) => hit(a, o) && bad.push(`${a.c} x ${o.c}`));
      });
      check(`${w}x${hgt}: no overlaps, everything on screen`, bad.length === 0, bad.join(' ; '));
      check(`${w}x${hgt}: every button is at least 43px`, btns.every((b) => Math.min(b.w, b.h) >= 43), btns.map((b) => Math.round(b.w)).join(','));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `touch-${w}x${hgt}.png`) });
      await page.context().close();
    }
  });
} finally {
  await h.close();
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
