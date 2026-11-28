// Runs every automated check, one after the other, and prints a short summary.
//   node scripts/check-all.mjs            (or: npm test)
//   node scripts/check-all.mjs --e2e      also run the browser tests (needs Playwright + Chromium)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reads "N tests / N passed / N failed" from Node's test runner output (TAP or spec style). */
export function parseCounts(output) {
  const grab = (word) => {
    const m = new RegExp(`(?:^|\\n)\\s*(?:#|ℹ)\\s+${word}\\s+(\\d+)`).exec(output);
    return m ? Number(m[1]) : null;
  };
  const e2e = /(\d+) checks passed, (\d+) failed/.exec(output);
  if (e2e) return { tests: Number(e2e[1]) + Number(e2e[2]), pass: Number(e2e[1]), fail: Number(e2e[2]) };
  return { tests: grab('tests'), pass: grab('pass'), fail: grab('fail') };
}

export function steps({ e2e = false } = {}) {
  const list = [
    { name: 'shared files in sync', cwd: ROOT, args: ['scripts/sync-shared.mjs', '--check'] },
    { name: 'game server', cwd: path.join(ROOT, 'server'), args: ['--test'] },
    { name: 'backend API', cwd: path.join(ROOT, 'backend'), args: ['--test'] },
    { name: 'frontend (unit)', cwd: path.join(ROOT, 'frontend'), args: ['test/run-unit.mjs'] },
    { name: 'scripts', cwd: ROOT, args: ['--test', 'test/scripts.test.js'] },
    { name: 'frontend + backend + server together', cwd: ROOT, args: ['--test', 'test/integration/full-stack.test.js'] }
  ];
  if (e2e) list.push({ name: 'browser (Playwright)', cwd: ROOT, args: ['frontend/test/e2e/e2e.mjs'] });
  return list;
}

function main() {
  const wantE2e = process.argv.includes('--e2e');
  let failed = 0;
  let total = 0;
  console.log('');
  for (const step of steps({ e2e: wantE2e })) {
    const started = Date.now();
    const res = spawnSync(process.execPath, step.args, { cwd: step.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    const counts = parseCounts(output);
    const ok = res.status === 0 && (counts.fail ?? 0) === 0;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const detail = counts.tests !== null ? `${counts.pass ?? '?'} of ${counts.tests} passed` : ok ? 'ok' : 'failed';
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step.name.padEnd(40)} ${detail}  (${secs}s)`);
    if (counts.tests) total += counts.tests;
    if (!ok) {
      failed += 1;
      const tail = output.trim().split('\n').slice(-40).join('\n');
      console.log(`\n${tail}\n`);
    }
  }
  console.log(`\n  ${failed === 0 ? `All checks passed (${total} tests).` : `${failed} step(s) failed.`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
