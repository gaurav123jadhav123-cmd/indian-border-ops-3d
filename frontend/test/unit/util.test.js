import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp, lerp, lerpAngle, fmtClock, fmtCooldown, el, setChildren, storage, Emitter } from '../../js/util.js';
import { fakeDoc } from './helpers/fake-dom.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test('clamp and lerp', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
  assert.equal(lerp(10, 20, 0), 10);
  assert.equal(lerp(10, 20, 1), 20);
  assert.equal(lerp(10, 20, 0.25), 12.5);
});

test('lerpAngle takes the short way round', () => {
  near(lerpAngle(0, 1, 0.5), 0.5);
  // from just below +pi to just above -pi is a tiny step, not a whole turn
  const a = Math.PI - 0.1;
  const b = -Math.PI + 0.1;
  near(lerpAngle(a, b, 0.5), Math.PI, 1e-9);
  near(lerpAngle(b, a, 0.5), -Math.PI, 1e-9);
  near(lerpAngle(0.3, 0.3, 0.7), 0.3);
  near(lerpAngle(0, 2 * Math.PI + 0.2, 1), 0.2, 1e-9);
});

test('fmtClock and fmtCooldown', () => {
  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(65), '01:05');
  assert.equal(fmtClock(480), '08:00');
  assert.equal(fmtClock(-4), '00:00');
  assert.equal(fmtClock(59.9), '00:59');
  assert.equal(fmtCooldown(0), 'RDY');
  assert.equal(fmtCooldown(-10), 'RDY');
  assert.equal(fmtCooldown(1), '1s');
  assert.equal(fmtCooldown(27000), '27s');
  assert.equal(fmtCooldown(27001), '28s');
});

test('el builds elements: text is never treated as HTML', () => {
  const doc = fakeDoc();
  const clicked = [];
  const node = el(doc, 'div', { class: 'a b', id: 'x', dataset: { slot: 'primary' }, hidden: true, title: 5, skip: null, off: false, onClick: () => clicked.push(1) },
    'hello <b>world</b>', 7, null, undefined, false, [el(doc, 'span', { text: 'inner' })]);
  assert.equal(node.tag, 'div');
  assert.equal(node.className, 'a b');
  assert.equal(node.attrs.id, 'x');
  assert.equal(node.attrs.hidden, '');
  assert.equal(node.attrs.title, '5');
  assert.equal('skip' in node.attrs, false);
  assert.equal('off' in node.attrs, false);
  assert.deepEqual(node.dataset, { slot: 'primary' });
  node.listeners.click[0]();
  assert.deepEqual(clicked, [1]);
  assert.equal(node.children.length, 3);
  assert.deepEqual(node.children[0], { text: 'hello <b>world</b>' });
  assert.deepEqual(node.children[1], { text: '7' });
  assert.equal(node.children[2].tag, 'span');
  assert.equal(node.children[2].textContent, 'inner');
});

test('setChildren drops null, undefined and false (the DOM would print them as text)', () => {
  const doc = fakeDoc();
  const node = doc.createElement('div');
  const a = doc.createElement('a');
  const b = doc.createElement('b');
  setChildren(node, a, null, [b, undefined, false], undefined);
  assert.deepEqual(node.children, [a, b]);
  setChildren(node);
  assert.deepEqual(node.children, []);
});

test('storage works with a working localStorage', () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k)
  };
  try {
    assert.equal(storage.get('missing'), null);
    assert.equal(storage.get('missing', 'fallback'), 'fallback');
    storage.set('k', { a: 1, b: [2, 3] });
    assert.deepEqual(storage.get('k'), { a: 1, b: [2, 3] });
    data.set('broken', '{not json');
    assert.equal(storage.get('broken', 'safe'), 'safe');
    storage.remove('k');
    assert.equal(storage.get('k'), null);
  } finally {
    delete globalThis.localStorage;
  }
});

test('storage never throws when the browser blocks it', () => {
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  try {
    assert.equal(storage.get('k', 'fallback'), 'fallback');
    assert.doesNotThrow(() => storage.set('k', 1));
    assert.doesNotThrow(() => storage.remove('k'));
  } finally {
    delete globalThis.localStorage;
  }
  // and with no localStorage at all
  assert.equal(storage.get('k', 'x'), 'x');
  assert.doesNotThrow(() => storage.set('k', 1));
});

test('Emitter: on, off, once-per-handler delivery and isolated failures', () => {
  const e = new Emitter();
  const seen = [];
  const off = e.on('ping', (p) => seen.push(['a', p]));
  e.on('ping', (p) => seen.push(['b', p]));
  e.emit('ping', 1);
  off();
  e.emit('ping', 2);
  assert.deepEqual(seen, [['a', 1], ['b', 1], ['b', 2]]);

  // the same function registered twice is still called once
  const f = () => seen.push('f');
  e.on('x', f);
  e.on('x', f);
  e.emit('x');
  assert.equal(seen.filter((s) => s === 'f').length, 1);

  // a handler that throws does not stop the others, and does not throw out of emit
  const origError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a);
  try {
    const order = [];
    e.on('boom', () => { throw new Error('bad'); });
    e.on('boom', () => order.push('after'));
    assert.doesNotThrow(() => e.emit('boom'));
    assert.deepEqual(order, ['after']);
    assert.equal(logged.length, 1);
  } finally {
    console.error = origError;
  }

  // handlers may unsubscribe themselves while an event is being delivered
  const g = new Emitter();
  const calls = [];
  const offSelf = g.on('once', () => { calls.push('self'); offSelf(); });
  g.on('once', () => calls.push('other'));
  g.emit('once');
  g.emit('once');
  assert.deepEqual(calls, ['self', 'other', 'other']);
});
