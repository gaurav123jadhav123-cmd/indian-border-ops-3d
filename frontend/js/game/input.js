// One place that turns keyboard, mouse and touch into the same "intent" every frame.
// The touch buttons (ui/touch.js) feed this class through its public methods, the keyboard and
// mouse are read here directly. Nothing in here knows about the 3D engine.
import { Emitter, clamp } from '../util.js';

// Key -> one-shot action
const KEY_EDGES = Object.freeze({
  Space: 'jump',
  KeyR: 'reload',
  KeyC: 'crouch',
  KeyZ: 'prone',
  KeyV: 'view',
  KeyG: 'frag',
  KeyT: 'smoke',
  Digit1: 'slot:primary',
  Digit2: 'slot:secondary',
  Digit3: 'slot:launcher',
  Digit4: 'missile',
  Digit5: 'fpv',
  Digit6: 'recon',
  Digit7: 'heal:bandage',
  Digit8: 'heal:firstAid',
  Digit9: 'heal:medkit',
  Digit0: 'heal:energyDrink',
  KeyF: 'loot',
  KeyX: 'detonate',
  KeyB: 'recall',
  KeyH: 'cancelHeal'
});

// Keys the browser would otherwise scroll / tab / search with while playing
const SWALLOW = new Set([
  'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyF', 'KeyG', 'KeyH', 'KeyB'
]);

const isTypingTarget = (t) =>
  !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true);

export class InputManager extends Emitter {
  constructor({ target = globalThis.window, doc = globalThis.document, canvas = null, isTouch = false } = {}) {
    super();
    this.target = target;
    this.doc = doc;
    this.canvas = canvas;
    this.isTouch = isTouch;

    this.enabled = false;
    this.mode = 'body'; // 'body' | 'drone'
    this.locked = false;

    this.sensitivity = 1; // user setting
    this.invertY = false;
    this.adsScale = 1;    // set by the game: slower aim while zoomed in
    this.base = { mouse: 0.0022, touch: 0.0042 };

    this.keys = new Set();
    this.edges = new Set();
    this.look = { yaw: 0, pitch: 0 };
    this.stick = { x: 0, y: 0 };
    this.touchSprint = false;
    this.fireMouse = false;
    this.fireTouch = false;
    this.adsMouse = false;
    this.adsToggle = false;
    this.touchUp = false;
    this.touchDown = false;
    this.scoreboardTouch = false;

    this.onKeyDown = (e) => this.keyDown(e);
    this.onKeyUp = (e) => this.keyUp(e);
    this.onMouseMove = (e) => this.mouseMove(e);
    this.onMouseDown = (e) => this.mouseButton(e, true);
    this.onMouseUp = (e) => this.mouseButton(e, false);
    this.onWheel = (e) => this.wheel(e);
    this.onContextMenu = (e) => { if (this.enabled) e.preventDefault(); };
    this.onLockChange = () => {
      const was = this.locked;
      this.locked = !!this.canvas && this.doc?.pointerLockElement === this.canvas;
      if (!this.locked) this.releaseMouse();
      if (was !== this.locked) this.emit('lock', this.locked);
    };
    this.onLockError = () => this.emit('lockerror');
    this.onBlur = () => this.releaseAll();
    this.onVisibility = () => { if (this.doc?.hidden) this.releaseAll(); };

    const t = this.target;
    t?.addEventListener('keydown', this.onKeyDown);
    t?.addEventListener('keyup', this.onKeyUp);
    t?.addEventListener('mousemove', this.onMouseMove);
    t?.addEventListener('mousedown', this.onMouseDown);
    t?.addEventListener('mouseup', this.onMouseUp);
    t?.addEventListener('wheel', this.onWheel, { passive: true });
    t?.addEventListener('contextmenu', this.onContextMenu);
    t?.addEventListener('blur', this.onBlur);
    this.doc?.addEventListener('pointerlockchange', this.onLockChange);
    this.doc?.addEventListener('pointerlockerror', this.onLockError);
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
  }

  destroy() {
    const t = this.target;
    t?.removeEventListener('keydown', this.onKeyDown);
    t?.removeEventListener('keyup', this.onKeyUp);
    t?.removeEventListener('mousemove', this.onMouseMove);
    t?.removeEventListener('mousedown', this.onMouseDown);
    t?.removeEventListener('mouseup', this.onMouseUp);
    t?.removeEventListener('wheel', this.onWheel);
    t?.removeEventListener('contextmenu', this.onContextMenu);
    t?.removeEventListener('blur', this.onBlur);
    this.doc?.removeEventListener('pointerlockchange', this.onLockChange);
    this.doc?.removeEventListener('pointerlockerror', this.onLockError);
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.releaseAll();
  }

  // ------------------------------------------------------------------ switches
  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.releaseAll();
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    // a stick/button held while the controls change meaning would stick; start clean
    this.stick.x = 0;
    this.stick.y = 0;
    this.touchSprint = false;
    this.fireTouch = false;
    this.touchUp = false;
    this.touchDown = false;
    this.adsToggle = false;
  }

  requestLock() {
    if (!this.canvas || this.isTouch) return;
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* the browser refused (e.g. no recent click): the player clicks again */ }
  }

  exitLock() {
    try {
      this.doc?.exitPointerLock?.();
    } catch { /* ignore */ }
  }

  releaseMouse() {
    this.fireMouse = false;
    this.adsMouse = false;
  }

  /** Let go of everything (focus lost, menu opened, ...). Prevents "stuck" movement and firing. */
  releaseAll() {
    this.keys.clear();
    this.edges.clear();
    this.look.yaw = 0;
    this.look.pitch = 0;
    this.stick.x = 0;
    this.stick.y = 0;
    this.touchSprint = false;
    this.fireMouse = false;
    this.fireTouch = false;
    this.adsMouse = false;
    this.adsToggle = false;
    this.touchUp = false;
    this.touchDown = false;
    this.scoreboardTouch = false;
  }

  // ------------------------------------------------------------------ keyboard
  keyDown(e) {
    if (!this.enabled || isTypingTarget(e.target)) return;
    if (SWALLOW.has(e.code)) e.preventDefault?.();
    if (e.repeat) return;
    this.keys.add(e.code);
    const edge = KEY_EDGES[e.code];
    if (edge) this.edges.add(edge);
  }

  keyUp(e) {
    this.keys.delete(e.code);
  }

  // ------------------------------------------------------------------- mouse
  mouseMove(e) {
    if (!this.enabled || !this.locked) return;
    const k = this.base.mouse * this.sensitivity * this.adsScale;
    const dx = clamp(e.movementX || 0, -250, 250);
    const dy = clamp(e.movementY || 0, -250, 250);
    this.look.yaw -= dx * k;
    this.look.pitch -= dy * k * (this.invertY ? -1 : 1);
  }

  mouseButton(e, down) {
    if (!this.enabled) return;
    if (!down) {
      if (e.button === 0) this.fireMouse = false;
      if (e.button === 2) this.adsMouse = false;
      return;
    }
    if (!this.locked) return; // the first click only captures the mouse
    if (e.button === 0) {
      this.fireMouse = true;
      this.edges.add('fire');
    } else if (e.button === 2) {
      this.adsMouse = true;
    }
  }

  wheel(e) {
    if (!this.enabled || !this.locked || !e.deltaY) return;
    this.edges.add(e.deltaY > 0 ? 'slot:next' : 'slot:prev');
  }

  // ------------------------------------------------------------- touch (UI -> here)
  setStick(x, y) {
    this.stick.x = clamp(x, -1, 1);
    this.stick.y = clamp(y, -1, 1);
  }

  setTouchSprint(on) {
    this.touchSprint = !!on;
  }

  addLook(dxPx, dyPx) {
    const k = this.base.touch * this.sensitivity * this.adsScale;
    this.look.yaw -= dxPx * k;
    this.look.pitch -= dyPx * k * (this.invertY ? -1 : 1);
  }

  setFire(on) {
    this.fireTouch = !!on;
    if (on) this.edges.add('fire');
  }

  setAds(on) {
    this.adsToggle = !!on;
  }

  toggleAds() {
    this.adsToggle = !this.adsToggle;
    return this.adsToggle;
  }

  setDroneVertical(up, down) {
    this.touchUp = !!up;
    this.touchDown = !!down;
  }

  setScoreboard(on) {
    this.scoreboardTouch = !!on;
  }

  /** One-shot action from a button. */
  press(name) {
    if (this.enabled) this.edges.add(name);
  }

  // ------------------------------------------------------------------- per frame
  /** The player's wishes for this frame. Look deltas and one-shot actions are cleared by the call. */
  frame() {
    const k = this.keys;
    const axis = (a, b) => (k.has(a) ? 1 : 0) - (k.has(b) ? 1 : 0);
    const moveY = clamp(axis('KeyW', 'KeyS') + axis('ArrowUp', 'ArrowDown') + this.stick.y, -1, 1);
    const moveX = clamp(axis('KeyD', 'KeyA') + axis('ArrowRight', 'ArrowLeft') + this.stick.x, -1, 1);
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');

    const intent = {
      moveX,
      moveY,
      dYaw: this.look.yaw,
      dPitch: this.look.pitch,
      sprint: shift || this.touchSprint,
      fire: this.fireMouse || this.fireTouch,
      ads: this.adsMouse || this.adsToggle,
      lean: axis('KeyE', 'KeyQ'),
      droneUp: k.has('Space') || this.touchUp,
      droneDown: shift || this.touchDown,
      scoreboard: k.has('Tab') || this.scoreboardTouch,
      edges: this.edges
    };
    this.look.yaw = 0;
    this.look.pitch = 0;
    this.edges = new Set();
    return intent;
  }
}
