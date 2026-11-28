// Starts the backend (REST API + the game page) and the game server together, for local play on a
// PC or on a phone (Termux). Usage:  node scripts/start-all.mjs      (or: npm start)
//
// Optional environment variables:
//   BACKEND_PORT   default 4000        GAME_PORT   default 5000
//   SHARED_SECRET  default: a fresh random one on every start (fine for local play)
//   DATA_DIR       where the accounts file is kept (default backend/data)
//   --dry          only print what would be started
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [18, 17];

const toPort = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
};

/** Some Android versions refuse to list network interfaces: then we simply print no Wi-Fi address. */
function safeInterfaces() {
  try {
    return os.networkInterfaces();
  } catch {
    return {};
  }
}

export function lanAddresses(interfaces = safeInterfaces()) {
  const found = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) found.push(a.address);
    }
  }
  return found;
}

/** What to start and what to tell the player. Pure: nothing is started or printed here. */
export function plan({
  env = process.env,
  nodeVersion = process.versions.node,
  exists = fs.existsSync,
  interfaces = safeInterfaces(),
  randomHex = () => crypto.randomBytes(24).toString('hex')
} = {}) {
  const problems = [];
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    problems.push(`Node.js ${MIN_NODE.join('.')} or newer is needed (this is ${nodeVersion}).`);
  }
  const needed = [
    ['backend', 'express'],
    ['backend', 'cors'],
    ['server', 'socket.io']
  ];
  if (needed.some(([dir, pkg]) => !exists(path.join(ROOT, dir, 'node_modules', pkg, 'package.json')))) {
    problems.push('The packages are not installed yet. Run:  npm run install:all   (needs internet, once).');
  }

  const backendPort = toPort(env.BACKEND_PORT, 4000);
  const gamePort = toPort(env.GAME_PORT, 5000);
  const secret = env.SHARED_SECRET || randomHex();

  const common = { SHARED_SECRET: secret };
  const backend = {
    name: 'backend',
    cwd: path.join(ROOT, 'backend'),
    args: ['src/index.js'],
    env: { ...common, PORT: String(backendPort), ...(env.DATA_DIR ? { DATA_DIR: env.DATA_DIR } : {}) }
  };
  const game = {
    name: 'game',
    cwd: path.join(ROOT, 'server'),
    args: ['src/index.js'],
    env: { ...common, PORT: String(gamePort), BACKEND_URL: `http://127.0.0.1:${backendPort}` }
  };

  // The page finds the two servers by itself when they use the default ports; otherwise say where they are.
  const addressFor = (host) => {
    const q = [];
    if (backendPort !== 4000) q.push(`api=${encodeURIComponent(`http://${host}:${backendPort}`)}`);
    if (gamePort !== 5000) q.push(`server=${encodeURIComponent(`http://${host}:${gamePort}`)}`);
    return `http://${host}:${backendPort}/${q.length ? `?${q.join('&')}` : ''}`;
  };
  const lan = lanAddresses(interfaces);

  return {
    problems,
    secretIsRandom: !env.SHARED_SECRET,
    backend,
    game,
    thisDevice: addressFor('localhost'),
    otherDevices: lan.map(addressFor)
  };
}

function run(p) {
  const children = [];
  let stopping = false;

  const stopAll = (code) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
    setTimeout(() => process.exit(code), 1500).unref();
  };

  for (const part of [p.backend, p.game]) {
    const child = spawn(process.execPath, part.args, { cwd: part.cwd, env: { ...process.env, ...part.env }, stdio: 'inherit' });
    children.push(child);
    child.on('exit', (code, signal) => {
      if (stopping) return;
      console.error(`\n[start] the ${part.name} stopped (${signal ?? `exit code ${code}`}). Stopping everything.`);
      stopAll(code || 1);
    });
  }

  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = plan();
  if (p.problems.length) {
    console.error(`\nCannot start:\n${p.problems.map((m) => `  - ${m}`).join('\n')}\n`);
    process.exit(1);
  }
  console.log('\n  Indian Border Ops 3D');
  console.log('  --------------------');
  console.log(`  Play on this device:   ${p.thisDevice}`);
  if (p.otherDevices.length) {
    console.log('  Friends on the same Wi-Fi / hotspot:');
    for (const a of p.otherDevices) console.log(`                         ${a}`);
  } else {
    console.log('  (Could not find this device\'s Wi-Fi address. Look it up in the Wi-Fi settings and open http://<that address>:' + new URL(p.thisDevice).port + ')');
  }
  console.log('  Stop with Ctrl+C.\n');
  if (process.argv.includes('--dry')) {
    console.log(`  [dry run] would start: node ${p.backend.args[0]} in backend/ (port ${p.backend.env.PORT}) and in server/ (port ${p.game.env.PORT})`);
  } else {
    run(p);
  }
}
