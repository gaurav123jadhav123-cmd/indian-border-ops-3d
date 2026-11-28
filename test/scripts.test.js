// Tests for the helper scripts in /scripts (start-all, check-all, sync-shared).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lanAddresses, plan, ROOT } from '../scripts/start-all.mjs';
import { parseCounts, steps } from '../scripts/check-all.mjs';
import { syncShared, TARGETS } from '../scripts/sync-shared.mjs';

const installed = () => true;
const none = {};

test('start-all: default ports, a random secret, and the same secret for both servers', () => {
  const p = plan({ env: {}, exists: installed, interfaces: none, randomHex: () => 'abc123' });
  assert.deepEqual(p.problems, []);
  assert.equal(p.backend.env.PORT, '4000');
  assert.equal(p.game.env.PORT, '5000');
  assert.equal(p.backend.env.SHARED_SECRET, 'abc123');
  assert.equal(p.game.env.SHARED_SECRET, 'abc123');
  assert.equal(p.game.env.BACKEND_URL, 'http://127.0.0.1:4000');
  assert.equal(p.thisDevice, 'http://localhost:4000/');
  assert.equal(p.secretIsRandom, true);
  assert.equal(p.backend.cwd, path.join(ROOT, 'backend'));
  assert.equal(p.game.cwd, path.join(ROOT, 'server'));
});

test('start-all: a secret from the environment is kept, and custom ports are put in the address', () => {
  const p = plan({
    env: { SHARED_SECRET: 'mine', BACKEND_PORT: '8080', GAME_PORT: '8081', DATA_DIR: '/data' },
    exists: installed, interfaces: none
  });
  assert.equal(p.secretIsRandom, false);
  assert.equal(p.backend.env.SHARED_SECRET, 'mine');
  assert.equal(p.backend.env.DATA_DIR, '/data');
  assert.equal(p.game.env.BACKEND_URL, 'http://127.0.0.1:8080');
  const url = new URL(p.thisDevice);
  assert.equal(url.port, '8080');
  assert.equal(url.searchParams.get('api'), 'http://localhost:8080');
  assert.equal(url.searchParams.get('server'), 'http://localhost:8081');
});

test('start-all: silly port numbers fall back to the defaults', () => {
  const p = plan({ env: { BACKEND_PORT: 'abc', GAME_PORT: '99999' }, exists: installed, interfaces: none });
  assert.equal(p.backend.env.PORT, '4000');
  assert.equal(p.game.env.PORT, '5000');
});

test('start-all: tells the player what is missing (old Node, packages not installed)', () => {
  const p = plan({ env: {}, nodeVersion: '16.20.0', exists: () => false, interfaces: none });
  assert.equal(p.problems.length, 2);
  assert.match(p.problems[0], /Node\.js 18\.17/);
  assert.match(p.problems[1], /npm run install:all/);
  assert.deepEqual(plan({ env: {}, nodeVersion: '18.17.0', exists: installed, interfaces: none }).problems, []);
  assert.equal(plan({ env: {}, nodeVersion: '18.16.9', exists: installed, interfaces: none }).problems.length, 1);
});

test('start-all: lists the Wi-Fi addresses (ignores loopback and IPv6) and survives a phone that hides them', () => {
  const interfaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    wlan0: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.1.23', internal: false }
    ]
  };
  assert.deepEqual(lanAddresses(interfaces), ['192.168.1.23']);
  const p = plan({ env: {}, exists: installed, interfaces });
  assert.deepEqual(p.otherDevices, ['http://192.168.1.23:4000/']);
  assert.deepEqual(lanAddresses({}), []);
  assert.deepEqual(lanAddresses({ broken: undefined }), []);
});

test('start-all --dry: prints the addresses and starts nothing', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/start-all.mjs'), '--dry'], {
    encoding: 'utf8',
    env: { ...process.env, BACKEND_PORT: '4555' }
  });
  // It either stops with the "not installed" message (no packages here) or prints the plan: never starts anything.
  const out = `${res.stdout}${res.stderr}`;
  assert.ok(/dry run|Cannot start/.test(out), out);
  if (/dry run/.test(out)) assert.match(out, /localhost:4555/);
});

test('check-all: reads the counts from TAP, spec and browser-test output', () => {
  assert.deepEqual(parseCounts('# tests 102\n# suites 0\n# pass 100\n# fail 2\n'), { tests: 102, pass: 100, fail: 2 });
  assert.deepEqual(parseCounts('ℹ tests 41\nℹ suites 6\nℹ pass 41\nℹ fail 0\n'), { tests: 41, pass: 41, fail: 0 });
  assert.deepEqual(parseCounts('\n157 checks passed, 0 failed\n'), { tests: 157, pass: 157, fail: 0 });
  assert.deepEqual(parseCounts('nothing useful'), { tests: null, pass: null, fail: null });
});

test('check-all: the browser step is only added on request', () => {
  assert.ok(!steps().some((s) => /browser/.test(s.name)));
  assert.ok(steps({ e2e: true }).some((s) => /browser/.test(s.name)));
  for (const s of steps({ e2e: true })) assert.ok(fs.existsSync(s.cwd), s.cwd);
});

test('sync-shared: detects a changed or missing copy, and copying fixes it', () => {
  // work on a scratch copy so the real project is never touched
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ibo-sync-'));
  try {
    for (const file of Object.keys(TARGETS)) {
      fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'shared', file), path.join(tmp, 'shared', file));
    }
    // nothing copied yet: every target is reported as missing
    const total = Object.values(TARGETS).flat().length;
    const missing = syncShared({ check: true, base: tmp });
    assert.equal(missing.length, total);
    assert.ok(missing.every((m) => /is missing/.test(m)));

    const logged = console.log;
    console.log = () => {};
    try { syncShared({ base: tmp }); } finally { console.log = logged; }
    assert.deepEqual(syncShared({ check: true, base: tmp }), []);

    // edit one copy by hand: it is reported by name
    const victim = path.join(tmp, TARGETS['world.js'][0], 'world.js');
    fs.appendFileSync(victim, '\n// edited by hand\n');
    const drift = syncShared({ check: true, base: tmp });
    assert.equal(drift.length, 1);
    assert.match(drift[0], /world\.js differs from shared\/world\.js/);

    // changing the source file makes every copy stale until the next sync
    fs.appendFileSync(path.join(tmp, 'shared', 'arsenal.js'), '\n// new\n');
    assert.equal(syncShared({ check: true, base: tmp }).length, 1 + TARGETS['arsenal.js'].length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // and the real project must be in sync right now
  assert.deepEqual(syncShared({ check: true }), []);
});
