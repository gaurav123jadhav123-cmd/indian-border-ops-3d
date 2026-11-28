// Browser test harness (needs Playwright with Chromium; NOT part of `npm test`).
//
// What is real:  the whole frontend (lobby, HUD, touch controls, game loop, network client, render
//                code), the real backend routes (accounts, loadouts, leaderboard) and the real game-server
//                logic (rooms, combat, anti-cheat).
// What is faked: Express and Socket.IO transports (calls go straight to the route/socket handlers)
//                and three.js (test/stubs/three-stub.js), because this machine has no network to
//                install them. So these tests prove the pieces are wired together correctly; they cannot
//                prove how the 3D scene looks or how fast it runs on a phone.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const FRONTEND = path.join(ROOT, 'frontend');
const require = createRequire(import.meta.url);

const { loadConfig } = await import(path.join(ROOT, 'backend/src/config.js'));
const { Store } = await import(path.join(ROOT, 'backend/src/services/store.js'));
const { createServices } = await import(path.join(ROOT, 'backend/src/services/index.js'));
const { createDispatcher } = await import(path.join(ROOT, 'backend/src/dispatch.js'));
const { routes } = await import(path.join(ROOT, 'backend/src/routes/index.js'));
const { RoomManager } = await import(path.join(ROOT, 'server/src/rooms/RoomManager.js'));
const { attachSocket } = await import(path.join(ROOT, 'server/src/net/handlers.js'));

export const SECRET = 'e2e-secret';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};
const silent = { info() {}, warn() {}, error() {} };

/** One fake connection on the server side: attachSocket() registers its handlers on it. */
function makeServerSocket(cid, deliver) {
  const handlers = new Map();
  const socket = {
    id: cid,
    on: (ev, fn) => handlers.set(ev, fn),
    emit: (ev, payload) => deliver(cid, ev, payload),
    volatile: { emit: (ev, payload) => deliver(cid, ev, payload) },
    disconnect() { deliver(cid, '__disconnect', 'io server disconnect'); queueMicrotask(() => handlers.get('disconnect')?.('server namespace disconnect')); }
  };
  return { socket, fire: (ev, payload, ack) => handlers.get(ev)?.(payload, ack), handlers };
}

export async function startHarness() {
  const { chromium } = require('playwright');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibo-e2e-'));

  // ---- backend (routes only)
  const config = loadConfig({ SHARED_SECRET: SECRET, DATA_DIR: dir });
  const store = new Store({ dir, saveDelayMs: 5, log: silent }).load();
  const services = createServices({ config, store, log: silent });
  const dispatch = createDispatcher({ routes, services });

  // ---- game server (rooms + socket handlers)
  const manager = new RoomManager({ log: silent });
  manager.start();

  // ---- static file server for the frontend
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(FRONTEND, rel);
    if (!file.startsWith(FRONTEND) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const stubThree = fs.readFileSync(path.join(FRONTEND, 'test/stubs/three-stub.js'), 'utf8');
  const stubIo = fs.readFileSync(path.join(FRONTEND, 'test/stubs/socketio-shim.js'), 'utf8');
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

  let pageCount = 0;
  const harness = {
    origin, config, store, services, dispatch, manager, secret: SECRET,
    errors: [],

    /** New page with the stubs, the fake backend and the fake game-server connection wired in. */
    async newPage({ viewport = { width: 1280, height: 720 }, touch = false, scale = 1, init = null } = {}) {
      const index = ++pageCount;
      const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: scale });
      const page = await context.newPage();
      const log = { errors: [], console: [] };
      page.log = log;
      page.on('pageerror', (e) => log.errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') log.errors.push(`console.error: ${m.text()}`);
        else log.console.push(m.text());
      });

      await context.route('https://unpkg.com/three@0.160.0/**', (r) => r.fulfill({ contentType: 'text/javascript', headers: cors, body: stubThree }));
      await context.route('https://cdn.socket.io/**', (r) => r.fulfill({ contentType: 'text/javascript', headers: cors, body: stubIo }));
      await context.route('**/api/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        let body;
        try {
          body = req.postData() ? JSON.parse(req.postData()) : undefined;
        } catch { /* leave undefined */ }
        const out = await dispatch(req.method(), url.pathname, {
          body, query: Object.fromEntries(url.searchParams), headers: req.headers(), ip: `10.0.0.${index}`
        });
        return route.fulfill({ status: out.status, contentType: 'application/json', headers: { ...(out.headers ?? {}), ...cors }, body: JSON.stringify(out.body) });
      });

      // ---- the fake Socket.IO connection to the real game server
      const conns = new Map();
      let next = 0;
      const queue = [];
      let flushing = false;
      const flush = async () => {
        if (flushing) return;
        flushing = true;
        await new Promise((r) => setImmediate(r));
        const batch = queue.splice(0);
        flushing = false;
        if (!batch.length || page.isClosed()) return;
        try {
          await page.evaluate((events) => events.forEach(([cid, ev, p]) => window.__deliver?.(cid, ev, p)), batch);
        } catch { /* page closed mid-flight */ }
      };
      const deliver = (cid, ev, payload) => { queue.push([cid, ev, payload]); flush(); };
      page.server = { conns };

      await page.exposeFunction('__srvConnect', () => {
        const cid = `e2e_${index}_${++next}`;
        const conn = makeServerSocket(cid, deliver);
        conns.set(cid, conn);
        attachSocket(conn.socket, { manager, secret: SECRET, log: silent });
        return cid;
      });
      await page.exposeFunction('__srvEmit', (cid, ev, payload) => { conns.get(cid)?.fire(ev, payload); });
      await page.exposeFunction('__srvDisconnect', (cid) => { conns.get(cid)?.fire('disconnect', 'transport close'); conns.delete(cid); });

      // pointer lock does not work in a headless page: fake it so mouse play can be tested
      await page.addInitScript(() => {
        window.__BOP_FAKE_LOCK__ = true;
        const setLock = (el) => {
          Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => el });
          document.dispatchEvent(new Event('pointerlockchange'));
        };
        HTMLCanvasElement.prototype.requestPointerLock = function request() { setLock(this); };
        document.exitPointerLock = () => setLock(null);
      });
      if (init) await page.addInitScript(init);
      return page;
    },

    /** Open the lobby with the test servers in the address. */
    async openLobby(page, { room = null, touch = false, debug = true } = {}) {
      const q = new URLSearchParams({ api: origin, server: origin });
      if (room) q.set('room', room);
      if (touch) q.set('touch', '1');
      if (debug) q.set('debug', '1');
      await page.goto(`${origin}/?${q}`);
      await page.waitForSelector('#deploy');
    },

    /** Join as a guest and wait until the match is running. */
    async deployGuest(page, { callsign = 'Tester', room = `room${pageCount}`, mode = 'TDM', touch = false, primary = null } = {}) {
      await harness.openLobby(page, { room, touch });
      await page.selectOption('#mode', mode);
      await page.fill('#callsign', callsign);
      if (primary) await page.selectOption('#slot-primary', primary);
      await page.click('#deploy');
      await page.waitForFunction(() => window.__game?.running === true, null, { timeout: 15000 });
      return room;
    },

    /** A scripted second soldier connected straight to the room (no browser). */
    bot({ name = 'Bot', roomId, mode = 'TDM', loadout = null, guest = true } = {}) {
      const events = [];
      const conn = makeServerSocket(`bot_${name}`, (cid, ev, payload) => events.push({ ev, payload }));
      attachSocket(conn.socket, { manager, secret: SECRET, log: silent });
      const token = services.sessions.issueGuest(name).token;
      const api = {
        events,
        conn,
        join() { conn.fire('join_match', { token, roomId, mode, loadout: loadout ?? undefined }); return api.last('match_joined'); },
        last: (ev) => [...events].reverse().find((e) => e.ev === ev)?.payload,
        all: (ev) => events.filter((e) => e.ev === ev).map((e) => e.payload),
        send: (ev, payload) => conn.fire(ev, payload),
        get player() { return manager.get(roomId)?.players.get(api.last('match_joined')?.playerId); },
        leave() { conn.fire('leave_match'); conn.fire('disconnect'); }
      };
      void guest;
      return api;
    },

    room: (roomId) => manager.get(roomId),

    async close() {
      await browser.close();
      manager.shutdown?.();
      store.flush?.();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  return harness;
}
