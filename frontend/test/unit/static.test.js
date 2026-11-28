// Guards that read the source files: they catch whole classes of mistakes (a typo in an import,
// unsafe HTML, the 3D engine leaking into game logic) without running the game.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JS = path.join(ROOT, 'js');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const files = walk(JS).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(f, 'utf8');
const rel = (f) => path.relative(ROOT, f);

/** Source with comments removed, so a warning in a comment does not trip a guard. */
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('there is source to check', () => {
  assert.ok(files.length >= 25, `only ${files.length} files`);
});

test('every relative import points at a file that exists', () => {
  const bad = [];
  for (const f of files) {
    const src = code(f);
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2];
      if (!fs.existsSync(path.resolve(path.dirname(f), spec))) bad.push(`${rel(f)} -> ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('imports that name things (import { a } from) only name things the module really exports', async () => {
  const problems = [];
  for (const f of files) {
    if (f.includes(`${path.sep}render${path.sep}`) && f !== path.join(JS, 'render', 'quality.js')) continue; // needs the 3D engine
    const src = code(f);
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(f), m[2]);
      if (target.includes(`${path.sep}render${path.sep}`) && !target.endsWith('quality.js')) continue;
      const mod = await import(target);
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name && !(name in mod)) problems.push(`${rel(f)} imports "${name}" which ${rel(target)} does not export`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('no unsafe HTML or dynamic code anywhere in the game page', () => {
  const forbidden = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/];
  const hits = [];
  for (const f of files) {
    const src = code(f);
    for (const re of forbidden) if (re.test(src)) hits.push(`${rel(f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('the 3D engine is only used inside js/render/ (game logic stays testable without it)', () => {
  const hits = [];
  for (const f of files) {
    if (f.includes(`${path.sep}render${path.sep}`)) continue;
    if (/from\s*['"]three['"]|\bTHREE\./.test(code(f))) hits.push(rel(f));
  }
  assert.deepEqual(hits, []);
});

test('only the render facade and loader reach for the render folder', () => {
  const hits = [];
  for (const f of files) {
    if (f.includes(`${path.sep}render${path.sep}`)) continue;
    for (const m of code(f).matchAll(/['"](\.[^'"]*\/render\/[^'"]+)['"]/g)) {
      if (!/render\/(index|quality)\.js$/.test(m[1])) hits.push(`${rel(f)} -> ${m[1]}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('index.html: pinned library versions, existing local files, no stray external scripts', () => {
  const html = read(path.join(ROOT, 'index.html'));
  assert.match(html, /three@0\.\d+\.\d+\/build\/three\.module\.js/, 'three.js must be pinned to an exact version');
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  for (const src of scripts) {
    if (/^https?:/.test(src)) assert.fail(`external script tag: ${src}`);
    assert.ok(fs.existsSync(path.join(ROOT, src)), `missing ${src}`);
  }
  for (const m of html.matchAll(/(?:href|src)="((?!https?:|#|data:)[^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, m[1])), `missing ${m[1]}`);
  }
  assert.match(html, /<meta name="viewport"[^>]*viewport-fit=cover/);
  const modules = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(modules.includes('js/main.js'));
});

test('the web app manifest is valid JSON with an icon that exists', () => {
  const manifest = JSON.parse(read(path.join(ROOT, 'manifest.webmanifest')));
  assert.ok(manifest.name && manifest.start_url);
  for (const icon of manifest.icons ?? []) assert.ok(fs.existsSync(path.join(ROOT, icon.src)), icon.src);
});

test('the stylesheet loads nothing from other websites', () => {
  const css = read(path.join(ROOT, 'css', 'style.css'));
  assert.equal(/url\(\s*['"]?https?:/.test(css), false);
  assert.equal(/@import/.test(css), false);
});

test('shared game rules are in sync with the server copy', () => {
  const server = path.resolve(ROOT, '..', 'server', 'src', 'shared');
  if (!fs.existsSync(server)) return; // the frontend was copied out on its own
  for (const name of ['arsenal.js', 'world.js']) {
    assert.equal(read(path.join(JS, 'shared', name)), read(path.join(server, name)), `${name} differs: run "npm run sync" in the project root`);
  }
});
