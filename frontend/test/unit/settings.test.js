import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, QUALITY_CHOICES, Settings, sanitizeSettings } from '../../js/settings.js';

const memoryStore = (initial = null) => {
  let value = initial;
  return {
    get: (_key, fallback) => (value === null ? fallback : value),
    set: (_key, v) => { value = v; },
    peek: () => value
  };
};

test('defaults are used for missing or nonsense input', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings('text'), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ sensitivity: 'fast', invertY: 'yes', quality: 'ultra', sound: 1, volume: NaN, showFps: null, vibration: 'no' }), DEFAULT_SETTINGS);
});

test('numbers are clamped, booleans and quality names are validated', () => {
  const s = sanitizeSettings({ sensitivity: 99, volume: -3, invertY: true, quality: 'low', sound: false, showFps: true, vibration: false });
  assert.equal(s.sensitivity, 2.5);
  assert.equal(s.volume, 0);
  assert.equal(s.invertY, true);
  assert.equal(s.quality, 'low');
  assert.equal(s.sound, false);
  assert.equal(s.showFps, true);
  assert.equal(s.vibration, false);
  assert.equal(sanitizeSettings({ sensitivity: 0 }).sensitivity, 0.3);
  assert.equal(sanitizeSettings({ volume: 7 }).volume, 1);
  assert.equal(sanitizeSettings({ sensitivity: Infinity }).sensitivity, DEFAULT_SETTINGS.sensitivity);
  for (const q of QUALITY_CHOICES) assert.equal(sanitizeSettings({ quality: q }).quality, q);
});

test('Settings loads what was saved, saves every change and announces it', () => {
  const store = memoryStore({ sensitivity: 1.5, quality: 'medium', volume: 5 });
  const s = new Settings(store);
  assert.equal(s.get('sensitivity'), 1.5);
  assert.equal(s.get('quality'), 'medium');
  assert.equal(s.get('volume'), 1); // a damaged saved value is repaired

  const changes = [];
  s.on('change', (v) => changes.push(v));
  s.set({ invertY: true, sensitivity: 100 });
  assert.equal(s.get('invertY'), true);
  assert.equal(s.get('sensitivity'), 2.5);
  assert.equal(store.peek().invertY, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].sensitivity, 2.5);

  // unknown keys are dropped
  s.set({ hacker: 'x' });
  assert.equal('hacker' in s.values, false);
  assert.equal('hacker' in store.peek(), false);
});

test('Settings with nothing saved starts from the defaults', () => {
  const s = new Settings(memoryStore());
  assert.deepEqual(s.values, DEFAULT_SETTINGS);
});
