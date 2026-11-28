import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveScale, FpsMeter, QUALITY_PRESETS, pickAuto, resolveQuality } from '../../js/render/quality.js';

test('presets get heavier from low to high', () => {
  const { low, medium, high } = QUALITY_PRESETS;
  assert.ok(low.pixelRatio <= medium.pixelRatio && medium.pixelRatio <= high.pixelRatio);
  assert.ok(low.terrainSegments < medium.terrainSegments && medium.terrainSegments < high.terrainSegments);
  assert.ok(low.maxFx < medium.maxFx && medium.maxFx < high.maxFx);
  assert.equal(low.shadows, false);
  assert.equal(high.shadows, true);
  assert.ok(Object.isFrozen(low) && Object.isFrozen(QUALITY_PRESETS));
  for (const p of Object.values(QUALITY_PRESETS)) {
    assert.ok(p.far > 200 && p.skyRadius < p.far + 200, p.name); // the sky dome must fit inside the far plane (plus margin)
    assert.ok(p.terrainSegments >= 32);
  }
});

test('auto: a PC gets high, a phone depends on how strong it is', () => {
  assert.equal(pickAuto({ isTouch: false }), 'high');
  assert.equal(pickAuto({ isTouch: false, cores: 2, memoryGb: 1 }), 'high');
  assert.equal(pickAuto({ isTouch: true, cores: 4, memoryGb: 8 }), 'low');
  assert.equal(pickAuto({ isTouch: true, cores: 8, memoryGb: 3 }), 'low');
  assert.equal(pickAuto({ isTouch: true, cores: 8, memoryGb: 6 }), 'medium');
  assert.equal(pickAuto({ isTouch: true }), 'low'); // unknown device defaults: 4 cores
});

test('resolveQuality: a chosen preset wins, anything else means auto', () => {
  assert.equal(resolveQuality('high', { isTouch: true }), QUALITY_PRESETS.high);
  assert.equal(resolveQuality('low', { isTouch: false }), QUALITY_PRESETS.low);
  assert.equal(resolveQuality('auto', { isTouch: false }), QUALITY_PRESETS.high);
  assert.equal(resolveQuality('auto', { isTouch: true, cores: 8, memoryGb: 8 }), QUALITY_PRESETS.medium);
  assert.equal(resolveQuality(undefined, { isTouch: true }), QUALITY_PRESETS.low);
  assert.equal(resolveQuality('ultra', { isTouch: false }), QUALITY_PRESETS.high);
});

const feed = (a, ms, frames) => { for (let i = 0; i < frames; i++) a.sample(ms); };

test('AdaptiveScale: smooth frames never lower the resolution', () => {
  const a = new AdaptiveScale();
  feed(a, 16, 2000);
  assert.equal(a.scale, 1);
  assert.equal(a.changed, false);
});

test('AdaptiveScale: sustained slow frames step the resolution down, then give it time', () => {
  const a = new AdaptiveScale({ targetMs: 22, step: 0.1, slowFrames: 45 });
  let first = null;
  for (let i = 0; i < 200 && first === null; i++) {
    a.sample(60);
    if (a.changed) first = i;
  }
  assert.ok(first !== null, 'should have stepped down');
  assert.equal(a.scale, 0.9);
  // right after a change the estimate is reset, so one more slow frame must not step again
  a.sample(60);
  assert.equal(a.changed, false);
  assert.equal(a.scale, 0.9);
});

test('AdaptiveScale: after a step down the new resolution gets a fair trial before the next one', () => {
  const a = new AdaptiveScale({ targetMs: 22, step: 0.1, slowFrames: 45 });
  let frames = 0;
  while (!a.changed && frames < 1000) { a.sample(60); frames += 1; }
  assert.equal(a.scale, 0.9);
  let next = 0;
  a.changed = false;
  while (!a.changed && next < 1000) { a.sample(60); next += 1; }
  assert.equal(a.scale, 0.8);
  assert.ok(next > 45, `the second step came after only ${next} slow frames`);
});

test('AdaptiveScale: never below the minimum, never goes back up', () => {
  const a = new AdaptiveScale({ min: 0.55 });
  feed(a, 80, 5000);
  assert.equal(a.scale, 0.55);
  feed(a, 8, 5000);
  assert.equal(a.scale, 0.55);
});

test('AdaptiveScale: a tab switch or a single hitch is ignored', () => {
  const a = new AdaptiveScale();
  feed(a, 16, 100);
  for (let i = 0; i < 100; i++) a.sample(5000); // tab in the background
  a.sample(0);
  a.sample(-5);
  a.sample(NaN);
  a.sample(300);
  assert.equal(a.scale, 1);
  feed(a, 16, 500);
  assert.equal(a.scale, 1);
});

test('AdaptiveScale: short bursts of slow frames between good ones do not add up', () => {
  const a = new AdaptiveScale();
  for (let round = 0; round < 40; round++) {
    feed(a, 16, 30);
    feed(a, 60, 4);
  }
  assert.equal(a.scale, 1);
});

test('FpsMeter averages over about a second', () => {
  const m = new FpsMeter();
  let fps = 0;
  for (let i = 0; i < 60; i++) fps = m.sample(1000 / 60 + 0.001);
  assert.equal(fps, 60);
  for (let i = 0; i < 30; i++) fps = m.sample(1000 / 30 + 0.001);
  assert.equal(fps, 30);
  // between updates it keeps showing the last value
  assert.equal(m.sample(5), 30);
});
