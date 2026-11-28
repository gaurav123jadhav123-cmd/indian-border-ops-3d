import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../../js/game/input.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

/** Event classes that can carry extra fields (the real DOM events do). */
class Ev extends Event {
  constructor(type, init = {}) {
    super(type, { cancelable: true });
    Object.assign(this, init);
  }
}

function makeInput({ locked = false, isTouch = false } = {}) {
  const target = new EventTarget();
  const doc = new EventTarget();
  doc.pointerLockElement = null;
  doc.hidden = false;
  doc.exitCalls = 0;
  doc.exitPointerLock = () => { doc.exitCalls += 1; };
  const canvas = { requestCalls: 0, requestPointerLock() { canvas.requestCalls += 1; } };
  const input = new InputManager({ target, doc, canvas, isTouch });
  input.setEnabled(true);
  if (locked) {
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
  }
  return { input, target, doc, canvas };
}

const key = (target, type, code, extra = {}) => target.dispatchEvent(new Ev(type, { code, repeat: false, ...extra }));

test('keys: WASD moves, arrows too, opposite keys cancel', () => {
  const { input, target } = makeInput();
  key(target, 'keydown', 'KeyW');
  key(target, 'keydown', 'KeyD');
  let f = input.frame();
  assert.equal(f.moveY, 1);
  assert.equal(f.moveX, 1);
  key(target, 'keydown', 'KeyS');
  f = input.frame();
  assert.equal(f.moveY, 0);
  key(target, 'keyup', 'KeyW');
  key(target, 'keyup', 'KeyS');
  key(target, 'keyup', 'KeyD');
  key(target, 'keydown', 'ArrowLeft');
  key(target, 'keydown', 'ArrowDown');
  f = input.frame();
  assert.equal(f.moveX, -1);
  assert.equal(f.moveY, -1);
});

test('keyboard and stick add up but stay within -1..1', () => {
  const { input, target } = makeInput();
  key(target, 'keydown', 'KeyW');
  input.setStick(0.8, 0.8);
  const f = input.frame();
  assert.equal(f.moveY, 1);
  near(f.moveX, 0.8);
  input.setStick(5, -5);
  assert.deepEqual(input.stick, { x: 1, y: -1 });
});

test('one-shot keys arrive once as edges; holding a key does not repeat them', () => {
  const { input, target } = makeInput();
  key(target, 'keydown', 'KeyR');
  key(target, 'keydown', 'KeyR', { repeat: true });
  key(target, 'keydown', 'Digit4');
  key(target, 'keydown', 'KeyC');
  let f = input.frame();
  assert.deepEqual([...f.edges].sort(), ['crouch', 'missile', 'reload']);
  f = input.frame();
  assert.equal(f.edges.size, 0);
  // every documented key maps to an action
  const map = { Space: 'jump', KeyZ: 'prone', KeyV: 'view', KeyG: 'frag', KeyT: 'smoke', Digit1: 'slot:primary', Digit2: 'slot:secondary', Digit3: 'slot:launcher', Digit5: 'fpv', Digit6: 'recon', Digit7: 'heal:bandage', Digit8: 'heal:firstAid', Digit9: 'heal:medkit', Digit0: 'heal:energyDrink', KeyF: 'loot', KeyX: 'detonate', KeyB: 'recall', KeyH: 'cancelHeal' };
  for (const [code, action] of Object.entries(map)) {
    key(target, 'keydown', code);
    assert.ok(input.frame().edges.has(action), `${code} -> ${action}`);
    key(target, 'keyup', code);
  }
});

test('keys do nothing while the input is disabled, and typing in a text box is never a command', () => {
  const { input, target } = makeInput();
  input.setEnabled(false);
  key(target, 'keydown', 'KeyW');
  assert.equal(input.frame().moveY, 0);
  input.setEnabled(true);
  // dispatchEvent decides the real target itself, so call the handler directly with a text box as the source
  input.keyDown({ code: 'KeyW', repeat: false, target: { tagName: 'INPUT' } });
  input.keyDown({ code: 'KeyR', repeat: false, target: { tagName: 'TEXTAREA' } });
  input.keyDown({ code: 'KeyR', repeat: false, target: { tagName: 'SELECT' } });
  input.keyDown({ code: 'KeyR', repeat: false, target: { tagName: 'DIV', isContentEditable: true } });
  const f = input.frame();
  assert.equal(f.moveY, 0);
  assert.equal(f.edges.size, 0);
});

test('keys the browser would use to scroll or search are swallowed while playing', () => {
  const { input, target } = makeInput();
  const space = new Ev('keydown', { code: 'Space', repeat: false });
  target.dispatchEvent(space);
  assert.equal(space.defaultPrevented, true);
  const letter = new Ev('keydown', { code: 'KeyP', repeat: false });
  target.dispatchEvent(letter);
  assert.equal(letter.defaultPrevented, false);
  input.setEnabled(false);
  const tab = new Ev('keydown', { code: 'Tab', repeat: false });
  target.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false);
});

test('sprint (shift) and lean (Q/E) and scoreboard (Tab)', () => {
  const { input, target } = makeInput();
  key(target, 'keydown', 'ShiftLeft');
  key(target, 'keydown', 'KeyE');
  key(target, 'keydown', 'Tab');
  let f = input.frame();
  assert.equal(f.sprint, true);
  assert.equal(f.lean, 1);
  assert.equal(f.scoreboard, true);
  assert.equal(f.droneDown, true); // shift flies the drone down
  key(target, 'keyup', 'KeyE');
  key(target, 'keydown', 'KeyQ');
  f = input.frame();
  assert.equal(f.lean, -1);
});

test('mouse look needs the mouse captured; moving right turns right (yaw goes down)', () => {
  const free = makeInput();
  free.target.dispatchEvent(new Ev('mousemove', { movementX: 100, movementY: 50 }));
  assert.equal(free.input.frame().dYaw, 0);

  const { input, target } = makeInput({ locked: true });
  target.dispatchEvent(new Ev('mousemove', { movementX: 100, movementY: 0 }));
  let f = input.frame();
  assert.ok(f.dYaw < 0);
  near(f.dYaw, -100 * input.base.mouse);
  target.dispatchEvent(new Ev('mousemove', { movementX: 0, movementY: -100 }));
  f = input.frame();
  assert.ok(f.dPitch > 0); // moving the mouse up looks up
  near(f.dPitch, 100 * input.base.mouse);
  // the deltas are consumed by frame()
  assert.equal(input.frame().dYaw, 0);
});

test('mouse look: sensitivity, invert Y, zoom slow-down and a cap on one huge jump', () => {
  const { input, target } = makeInput({ locked: true });
  input.sensitivity = 2;
  input.adsScale = 0.5;
  target.dispatchEvent(new Ev('mousemove', { movementX: 10, movementY: 10 }));
  let f = input.frame();
  near(f.dYaw, -10 * input.base.mouse * 2 * 0.5);
  near(f.dPitch, -10 * input.base.mouse * 2 * 0.5);
  input.invertY = true;
  target.dispatchEvent(new Ev('mousemove', { movementX: 0, movementY: 10 }));
  f = input.frame();
  assert.ok(f.dPitch > 0);
  input.sensitivity = 1;
  input.adsScale = 1;
  input.invertY = false;
  target.dispatchEvent(new Ev('mousemove', { movementX: 100000, movementY: 0 }));
  near(input.frame().dYaw, -250 * input.base.mouse);
});

test('mouse buttons: the first click only captures the mouse; then left fires and right aims', () => {
  const { input, target } = makeInput();
  target.dispatchEvent(new Ev('mousedown', { button: 0 }));
  let f = input.frame();
  assert.equal(f.fire, false);
  assert.equal(f.edges.size, 0);

  const locked = makeInput({ locked: true });
  locked.target.dispatchEvent(new Ev('mousedown', { button: 0 }));
  f = locked.input.frame();
  assert.equal(f.fire, true);
  assert.ok(f.edges.has('fire'));
  locked.target.dispatchEvent(new Ev('mousedown', { button: 2 }));
  assert.equal(locked.input.frame().ads, true);
  locked.target.dispatchEvent(new Ev('mouseup', { button: 0 }));
  locked.target.dispatchEvent(new Ev('mouseup', { button: 2 }));
  f = locked.input.frame();
  assert.equal(f.fire, false);
  assert.equal(f.ads, false);
});

test('losing the mouse capture lets go of fire and aim, and announces it', () => {
  const { input, doc, canvas } = makeInput({ locked: true });
  const events = [];
  input.on('lock', (v) => events.push(v));
  input.mouseButton({ button: 0 }, true);
  input.mouseButton({ button: 2 }, true);
  doc.pointerLockElement = null;
  doc.dispatchEvent(new Event('pointerlockchange'));
  assert.deepEqual(events, [false]);
  assert.equal(input.locked, false);
  const f = input.frame();
  assert.equal(f.fire, false);
  assert.equal(f.ads, false);
  doc.pointerLockElement = canvas;
  doc.dispatchEvent(new Event('pointerlockchange'));
  assert.deepEqual(events, [false, true]);
  // a lock error is passed on too
  let errors = 0;
  input.on('lockerror', () => { errors += 1; });
  doc.dispatchEvent(new Event('pointerlockerror'));
  assert.equal(errors, 1);
});

test('requestLock / exitLock talk to the browser; a phone never asks for the mouse', () => {
  const { input, doc, canvas } = makeInput();
  input.requestLock();
  assert.equal(canvas.requestCalls, 1);
  input.exitLock();
  assert.equal(doc.exitCalls, 1);
  const phone = makeInput({ isTouch: true });
  phone.input.requestLock();
  assert.equal(phone.canvas.requestCalls, 0);
  // a refusing browser must not break the game
  const bad = makeInput();
  bad.canvas.requestPointerLock = () => { throw new Error('refused'); };
  assert.doesNotThrow(() => bad.input.requestLock());
  bad.canvas.requestPointerLock = () => Promise.reject(new Error('refused'));
  assert.doesNotThrow(() => bad.input.requestLock());
});

test('mouse wheel switches weapons only while the mouse is captured', () => {
  const free = makeInput();
  free.target.dispatchEvent(new Ev('wheel', { deltaY: 100 }));
  assert.equal(free.input.frame().edges.size, 0);
  const { input, target } = makeInput({ locked: true });
  target.dispatchEvent(new Ev('wheel', { deltaY: 100 }));
  assert.ok(input.frame().edges.has('slot:next'));
  target.dispatchEvent(new Ev('wheel', { deltaY: -100 }));
  assert.ok(input.frame().edges.has('slot:prev'));
  target.dispatchEvent(new Ev('wheel', { deltaY: 0 }));
  assert.equal(input.frame().edges.size, 0);
});

test('right click does not open the browser menu while playing', () => {
  const { input, target } = makeInput();
  const e = new Ev('contextmenu');
  target.dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
  input.setEnabled(false);
  const e2 = new Ev('contextmenu');
  target.dispatchEvent(e2);
  assert.equal(e2.defaultPrevented, false);
});

test('touch controls feed the same intent', () => {
  const { input } = makeInput({ isTouch: true });
  input.setStick(0.5, 1);
  input.setTouchSprint(true);
  input.setFire(true);
  input.toggleAds();
  input.setScoreboard(true);
  input.setDroneVertical(true, false);
  input.addLook(100, 50);
  let f = input.frame();
  assert.deepEqual([f.moveX, f.moveY], [0.5, 1]);
  assert.equal(f.sprint, true);
  assert.equal(f.fire, true);
  assert.ok(f.edges.has('fire'));
  assert.equal(f.ads, true);
  assert.equal(f.scoreboard, true);
  assert.equal(f.droneUp, true);
  near(f.dYaw, -100 * input.base.touch);
  near(f.dPitch, -50 * input.base.touch);
  assert.equal(input.toggleAds(), false);
  input.setFire(false);
  f = input.frame();
  assert.equal(f.fire, false);
  assert.equal(f.ads, false);
  input.press('reload');
  assert.ok(input.frame().edges.has('reload'));
  input.setEnabled(false);
  input.press('reload');
  input.setEnabled(true);
  assert.equal(input.frame().edges.size, 0);
});

test('releaseAll (focus lost, menu opened) clears everything that could get stuck', () => {
  const { input, target } = makeInput({ locked: true });
  key(target, 'keydown', 'KeyW');
  key(target, 'keydown', 'ShiftLeft');
  input.setStick(1, 1);
  input.setFire(true);
  input.setAds(true);
  input.mouseButton({ button: 0 }, true);
  input.addLook(10, 10);
  target.dispatchEvent(new Event('blur'));
  const f = input.frame();
  assert.deepEqual([f.moveX, f.moveY, f.dYaw, f.dPitch], [0, 0, 0, 0]);
  assert.equal(f.sprint, false);
  assert.equal(f.fire, false);
  assert.equal(f.ads, false);
  assert.equal(f.edges.size, 0);
  // disabling also lets go
  key(target, 'keydown', 'KeyW');
  input.setEnabled(false);
  input.setEnabled(true);
  assert.equal(input.frame().moveY, 0);
});

test('hiding the tab lets go of everything', () => {
  const { input, target, doc } = makeInput();
  key(target, 'keydown', 'KeyW');
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(input.frame().moveY, 0);
});

test('switching between soldier and drone controls starts clean', () => {
  const { input } = makeInput({ isTouch: true });
  input.setStick(1, 1);
  input.setTouchSprint(true);
  input.setFire(true);
  input.setDroneVertical(true, true);
  input.setAds(true);
  input.setMode('drone');
  const f = input.frame();
  assert.deepEqual([f.moveX, f.moveY, f.sprint, f.fire, f.droneUp, f.ads], [0, 0, false, false, false, false]);
  assert.equal(input.mode, 'drone');
  // same mode again changes nothing
  input.setStick(1, 0);
  input.setMode('drone');
  assert.equal(input.stick.x, 1);
});

test('destroy removes every listener', () => {
  const { input, target, doc } = makeInput({ locked: true });
  input.destroy();
  key(target, 'keydown', 'KeyW');
  target.dispatchEvent(new Ev('mousemove', { movementX: 50, movementY: 0 }));
  doc.pointerLockElement = null;
  doc.dispatchEvent(new Event('pointerlockchange'));
  const f = input.frame();
  assert.equal(f.moveY, 0);
  assert.equal(f.dYaw, 0);
  assert.equal(input.locked, true); // nobody is listening any more
});
