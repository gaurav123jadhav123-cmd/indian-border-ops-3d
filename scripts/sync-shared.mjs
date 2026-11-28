// Copies the files in /shared into every package that needs them.
// Usage: `npm run sync` (copy) or `npm run sync -- --check` (only verify, exit 1 on drift).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// shared file -> folders that get an identical copy
export const TARGETS = {
  'arsenal.js': ['backend/src/shared', 'server/src/shared', 'frontend/js/shared'],
  'token.js': ['backend/src/shared', 'server/src/shared'],
  'world.js': ['server/src/shared', 'frontend/js/shared']
};

export function syncShared({ check = false, base = root } = {}) {
  const problems = [];
  for (const [file, dirs] of Object.entries(TARGETS)) {
    const source = fs.readFileSync(path.join(base, 'shared', file));
    for (const dir of dirs) {
      const dest = path.join(base, dir, file);
      const current = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
      const same = current !== null && current.equals(source);
      if (same) continue;
      if (check) {
        problems.push(`${dir}/${file} ${current === null ? 'is missing' : 'differs from shared/' + file}`);
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, source);
        console.log(`synced shared/${file} -> ${dir}/${file}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const problems = syncShared({ check });
  if (check) {
    if (problems.length) {
      console.error('Shared files are out of sync:\n - ' + problems.join('\n - '));
      console.error('Run `npm run sync` to fix.');
      process.exit(1);
    }
    console.log('Shared files are in sync.');
  }
}
