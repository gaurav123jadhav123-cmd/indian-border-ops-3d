// On-screen controls for phones and tablets (Pointer Events, so several fingers work at once):
//   left side   floating joystick (move; push it all the way out to sprint)
//   right side  drag anywhere free to look around, buttons for fire / aim / jump / reload / ...
// It only talks to the InputManager; it knows nothing about the game or the 3D engine.
import { el, clamp } from '../util.js';

const DEAD_ZONE = 0.12;

// id, label, kind, which control mode shows it
const BUTTONS = [
  { id: 'fire', label: 'FIRE', kind: 'fire', modes: ['body'], cls: 'big fire' },
  { id: 'ads', label: 'AIM', kind: 'ads', modes: ['body'] },
  { id: 'jump', label: 'JUMP', kind: 'tap', action: 'jump', modes: ['body'] },
  { id: 'reload', label: 'RELOAD', kind: 'tap', action: 'reload', modes: ['body'] },
  { id: 'stance', label: 'STANCE', kind: 'tap', action: 'stanceCycle', modes: ['body'] },
  { id: 'frag', label: 'FRAG', kind: 'tap', action: 'frag', modes: ['body'], badge: true },
  { id: 'smoke', label: 'SMOKE', kind: 'tap', action: 'smoke', modes: ['body'], badge: true },
  { id: 'more', label: 'MORE', kind: 'drawer', modes: ['body'] },
  { id: 'loot', label: 'LOOT', kind: 'tap', action: 'loot', modes: ['body'], cls: 'loot hidden' },
  // drone piloting
  { id: 'up', label: 'UP', kind: 'hold-up', modes: ['drone'] },
  { id: 'down', label: 'DOWN', kind: 'hold-down', modes: ['drone'] },
  { id: 'boom', label: 'BOOM', kind: 'tap', action: 'detonate', modes: ['drone'], cls: 'boom' },
  { id: 'exit', label: 'EXIT', kind: 'tap', action: 'recall', modes: ['drone'] }
];

// what the MORE drawer holds
const DRAWER = [
  { id: 'missile', label: 'MISSILE', action: 'missile', badge: true },
  { id: 'fpv', label: 'FPV DRONE', action: 'fpv', badge: true },
  { id: 'recon', label: 'RECON', action: 'recon', badge: true },
  { id: 'view', label: 'VIEW', action: 'view' },
  { id: 'bandage', label: 'BANDAGE', action: 'heal:bandage', badge: true },
  { id: 'firstAid', label: 'FIRST AID', action: 'heal:firstAid', badge: true },
  { id: 'medkit', label: 'MEDKIT', action: 'heal:medkit', badge: true },
  { id: 'energyDrink', label: 'ENERGY', action: 'heal:energyDrink', badge: true },
  { id: 'cancelHeal', label: 'CANCEL', action: 'cancelHeal' }
];

export class TouchControls {
  constructor({ doc, root, input }) {
    this.doc = doc;
    this.root = root;
    this.input = input;
    this.mode = 'hidden';
    this.stickId = null;
    this.lookId = null;
    this.origin = { x: 0, y: 0 };
    this.lastLook = { x: 0, y: 0 };
    this.buttons = new Map();
    this.badges = new Map();
    this.drawerOpen = false;
    this.droneKind = 'fpv';
    this.firePointer = null; // while FIRE is held, sliding that thumb also turns the view
    this.fireLast = { x: 0, y: 0 };
    this.build();
  }

  // ------------------------------------------------------------------ building
  build() {
    const h = (tag, props, ...kids) => el(this.doc, tag, props, ...kids);

    this.lookZone = h('div', { class: 'look-zone', id: 'look-zone' });
    this.stickZone = h('div', { class: 'stick-zone', id: 'stick-zone' });
    this.knob = h('div', { class: 'stick-knob' });
    this.base = h('div', { class: 'stick-base hidden', id: 'stick-base' }, this.knob);
    this.hint = h('div', { class: 'stick-hint', id: 'stick-hint' });

    this.lookZone.addEventListener('pointerdown', (e) => this.lookDown(e));
    this.lookZone.addEventListener('pointermove', (e) => this.lookMove(e));
    for (const ev of ['pointerup', 'pointercancel']) this.lookZone.addEventListener(ev, (e) => this.lookUp(e));
    this.stickZone.addEventListener('pointerdown', (e) => this.stickDown(e));
    this.stickZone.addEventListener('pointermove', (e) => this.stickMove(e));
    for (const ev of ['pointerup', 'pointercancel']) this.stickZone.addEventListener(ev, (e) => this.stickUp(e));

    const nodes = [this.lookZone, this.stickZone, this.hint, this.base];
    for (const def of BUTTONS) {
      const node = this.makeButton(def);
      this.buttons.set(def.id, node);
      nodes.push(node);
    }

    this.drawer = h('div', { class: 'drawer hidden', id: 'drawer' });
    for (const def of DRAWER) {
      const node = h('button', { type: 'button', class: 'tbtn drawer-btn', dataset: { action: def.action, id: def.id } }, h('span', { class: 'tlabel', text: def.label }));
      if (def.badge) {
        const badge = h('span', { class: 'badge', text: '' });
        node.append(badge);
        this.badges.set(def.id, { badge, node });
      }
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.input.press(def.action);
        this.setDrawer(false);
      });
      this.drawer.append(node);
    }
    nodes.push(this.drawer);
    this.root.replaceChildren(...nodes);
    this.setMode('hidden');
  }

  makeButton(def) {
    const node = el(this.doc, 'button', {
      type: 'button',
      class: `tbtn t-${def.id} ${def.cls ?? ''}`.trim(),
      dataset: { id: def.id, modes: def.modes.join(' ') }
    }, el(this.doc, 'span', { class: 'tlabel', text: def.label }));
    if (def.badge) {
      const badge = el(this.doc, 'span', { class: 'badge', text: '' });
      node.append(badge);
      this.badges.set(def.id, { badge, node });
    }

    const press = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        node.setPointerCapture?.(e.pointerId);
      } catch { /* the pointer is already gone */ }
      node.classList.add('down');
      this.buttonDown(def, node, e);
    };
    const release = (e) => {
      e.stopPropagation();
      if (!node.classList.contains('down')) return;
      node.classList.remove('down');
      this.buttonUp(def);
    };
    node.addEventListener('pointerdown', press);
    if (def.kind === 'fire') {
      // hold FIRE and slide the thumb to aim at the same time
      node.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.firePointer) return;
        this.input.addLook(e.clientX - this.fireLast.x, e.clientY - this.fireLast.y);
        this.fireLast = { x: e.clientX, y: e.clientY };
      });
    }
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('lostpointercapture', release);
    node.addEventListener('contextmenu', (e) => e.preventDefault());
    return node;
  }

  buttonDown(def, node, e) {
    switch (def.kind) {
      case 'fire':
        this.firePointer = e?.pointerId ?? null;
        this.fireLast = { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
        this.input.setFire(true);
        break;
      case 'ads': node.classList.toggle('on', this.input.toggleAds()); break;
      case 'tap': this.input.press(def.action); break;
      case 'drawer': this.setDrawer(!this.drawerOpen); break;
      case 'hold-up': this.vertical(true, null); break;
      case 'hold-down': this.vertical(null, true); break;
      default: break;
    }
  }

  buttonUp(def) {
    if (def.kind === 'fire') {
      this.firePointer = null;
      this.input.setFire(false);
    } else if (def.kind === 'hold-up') this.vertical(false, null);
    else if (def.kind === 'hold-down') this.vertical(null, false);
  }

  vertical(up, down) {
    if (up !== null) this.heldUp = up;
    if (down !== null) this.heldDown = down;
    this.input.setDroneVertical(!!this.heldUp, !!this.heldDown);
  }

  // ------------------------------------------------------------------ joystick
  stickDown(e) {
    if (this.stickId !== null) return;
    e.preventDefault();
    this.stickId = e.pointerId;
    this.origin = { x: e.clientX, y: e.clientY };
    try {
      this.stickZone.setPointerCapture?.(e.pointerId);
    } catch { /* ignore */ }
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.classList.remove('hidden');
    this.hint.classList.add('hidden');
    this.knob.style.transform = 'translate(0px, 0px)';
    this.setDrawer(false);
  }

  stickMove(e) {
    if (e.pointerId !== this.stickId) return;
    const radius = (this.base.offsetWidth || 120) / 2;
    let dx = e.clientX - this.origin.x;
    let dy = e.clientY - this.origin.y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      // the thumb drifted past the edge: the stick follows it, so it never "runs out"
      const over = dist - radius;
      this.origin.x += (dx / dist) * over;
      this.origin.y += (dy / dist) * over;
      this.base.style.left = `${this.origin.x}px`;
      this.base.style.top = `${this.origin.y}px`;
      dx = e.clientX - this.origin.x;
      dy = e.clientY - this.origin.y;
    }
    let vx = clamp(dx / radius, -1, 1);
    let vy = clamp(dy / radius, -1, 1);
    const len = Math.hypot(vx, vy);
    this.knob.style.transform = `translate(${vx * radius * 0.6}px, ${vy * radius * 0.6}px)`;
    if (len < DEAD_ZONE) {
      vx = 0;
      vy = 0;
    } else {
      const k = (len - DEAD_ZONE) / (1 - DEAD_ZONE) / len;
      vx *= k;
      vy *= k;
    }
    this.input.setStick(vx, -vy);
    const sprint = len > 0.93 && -vy > 0.5;
    this.input.setTouchSprint(sprint);
    this.base.classList.toggle('sprint', sprint);
  }

  stickUp(e) {
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    this.base.classList.add('hidden');
    this.base.classList.remove('sprint');
    this.hint.classList.remove('hidden');
    this.input.setStick(0, 0);
    this.input.setTouchSprint(false);
  }

  // ------------------------------------------------------------------ look
  lookDown(e) {
    if (this.lookId !== null) return;
    e.preventDefault();
    this.lookId = e.pointerId;
    this.lastLook = { x: e.clientX, y: e.clientY };
    try {
      this.lookZone.setPointerCapture?.(e.pointerId);
    } catch { /* ignore */ }
    this.setDrawer(false);
  }

  lookMove(e) {
    if (e.pointerId !== this.lookId) return;
    const dx = e.clientX - this.lastLook.x;
    const dy = e.clientY - this.lastLook.y;
    this.lastLook = { x: e.clientX, y: e.clientY };
    this.input.addLook(dx, dy);
  }

  lookUp(e) {
    if (e.pointerId === this.lookId) this.lookId = null;
  }

  // ------------------------------------------------------------------ state from the game
  /** 'body' | 'drone' | 'dead' | 'hidden' */
  setMode(mode, { droneKind = null } = {}) {
    this.mode = mode;
    if (droneKind) this.droneKind = droneKind;
    this.root.dataset.mode = mode;
    this.root.classList.toggle('hidden', mode === 'hidden');
    for (const [id, node] of this.buttons) {
      const modes = node.dataset.modes.split(' ');
      let show = modes.includes(mode);
      if (id === 'boom' && this.droneKind !== 'fpv') show = false;
      node.classList.toggle('mode-off', !show);
    }
    this.lookZone.classList.toggle('mode-off', mode === 'dead' || mode === 'hidden');
    this.stickZone.classList.toggle('mode-off', mode === 'dead' || mode === 'hidden');
    this.hint.classList.toggle('mode-off', mode === 'dead' || mode === 'hidden');
    if (mode !== 'body') this.setDrawer(false);
    // let go of anything that was held while the controls changed
    this.stickUp({ pointerId: this.stickId });
    this.lookId = null;
    this.heldUp = false;
    this.heldDown = false;
    this.input.setDroneVertical(false, false);
    this.buttons.get('fire')?.classList.remove('down');
    this.buttons.get('ads')?.classList.remove('on');
  }

  setDrawer(open) {
    this.drawerOpen = !!open && this.mode === 'body';
    this.drawer.classList.toggle('hidden', !this.drawerOpen);
    this.buttons.get('more')?.classList.toggle('on', this.drawerOpen);
  }

  /** Show / hide the LOOT button (a crate is within reach). */
  setLoot(on) {
    this.buttons.get('loot')?.classList.toggle('hidden', !on);
  }

  setAds(on) {
    this.buttons.get('ads')?.classList.toggle('on', !!on);
  }

  /** me: the private block from the snapshot. */
  updateBadges(me) {
    if (!me) return;
    const values = {
      frag: me.inventory.frag,
      smoke: me.inventory.smoke,
      bandage: me.inventory.bandage,
      firstAid: me.inventory.firstAid,
      medkit: me.inventory.medkit,
      energyDrink: me.inventory.energyDrink,
      missile: me.cooldowns.missileMs > 0 ? `${Math.ceil(me.cooldowns.missileMs / 1000)}s` : 'RDY',
      fpv: me.cooldowns.fpvMs > 0 ? `${Math.ceil(me.cooldowns.fpvMs / 1000)}s` : 'RDY',
      recon: me.cooldowns.reconMs > 0 ? `${Math.ceil(me.cooldowns.reconMs / 1000)}s` : 'RDY'
    };
    for (const [id, { badge, node }] of this.badges) {
      const v = values[id];
      if (v === undefined) continue;
      const text = String(v);
      if (badge._v !== text) {
        badge._v = text;
        badge.textContent = text;
      }
      node.classList.toggle('empty', v === 0);
      node.classList.toggle('cooling', typeof v === 'string' && v !== 'RDY');
    }
  }
}
