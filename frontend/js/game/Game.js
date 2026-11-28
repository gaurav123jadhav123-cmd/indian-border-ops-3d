// The game itself: one instance per match. It connects to the game server, turns what you do
// (keyboard, mouse or touch) into movement and actions, shows what the server tells it, and
// draws it through the renderer. The 3D engine is reached only through `renderer`, so everything
// here can be tested with a fake one.
import { ARSENAL, HEALING_ITEMS, LOADOUT_SLOTS } from '../shared/arsenal.js';
import { forwardFromAngles, getEyePosition, raycastWorld } from '../shared/world.js';
import { resolveQuality } from '../render/quality.js';
import { weaponSound } from '../audio.js';
import { GameClient } from '../net/socket.js';
import { Hud, damageAngle } from '../ui/hud.js';
import { TouchControls } from '../ui/touch.js';
import { clamp, el } from '../util.js';
import { GameState } from './state.js';
import { PlayerController, DroneControl, PITCH_LIMIT } from './controller.js';
import { InputManager } from './input.js';

const SEND_MS = 50;        // movement and drone sticks go out 20 times a second
const HUD_MS = 66;         // the numbers on screen refresh about 15 times a second
const MAX_DT = 0.1;        // a long pause (tab in background) must not teleport anybody
const KICK_DECAY = 7;      // recoil settles back in about a third of a second
const KICK_MAX = 0.16;
const MAX_FRAME_ERRORS = 6;

const DRONE_END_TEXT = {
  destroyed: 'Your drone was shot down.',
  expired: 'Your drone ran out of battery.',
  owner_died: ''
};

/** Distance along a ray (origin + dir * t) at which it passes within `radius` of a point, or null. */
export function rayHitsSphere(origin, dir, center, radius, maxT) {
  const vx = center.x - origin.x;
  const vy = center.y - origin.y;
  const vz = center.z - origin.z;
  const t = vx * dir.x + vy * dir.y + vz * dir.z;
  if (t < 1 || t >= maxT) return null;
  const d2 = vx * vx + vy * vy + vz * vz - t * t;
  return d2 <= radius * radius ? t : null;
}

export class Game {
  constructor({
    doc = globalThis.document,
    win = globalThis.window,
    stage,
    hudRoot,
    touchRoot,
    isTouch = false,
    settings,
    audio = null,
    serverUrl,
    ioFactory = null,
    rendererFactory,
    clock = null,
    callbacks = {}
  }) {
    this.doc = doc;
    this.win = win;
    this.stage = stage;
    this.hudRoot = hudRoot;
    this.touchRoot = touchRoot;
    this.isTouch = isTouch;
    this.settings = settings;
    this.audio = audio;
    this.rendererFactory = rendererFactory;
    this.callbacks = callbacks;
    this.clock = clock ?? {
      now: () => globalThis.performance.now(),
      raf: (fn) => win.requestAnimationFrame(fn),
      caf: (id) => win.cancelAnimationFrame(id)
    };

    this.state = new GameState();
    this.controller = new PlayerController();
    this.droneCtl = new DroneControl();
    this.client = new GameClient({ url: serverUrl, ioFactory });

    this.renderer = null;
    this.input = null;
    this.hud = null;
    this.touch = null;
    this.canvas = null;

    this.offs = [];
    this.running = false;
    this.stopped = false;
    this.ended = false;
    this.paused = false;
    this.rafId = null;
    this.frameErrors = 0;
    this.lastFrameAt = 0;
    this.resetMatchState();
  }

  /** Everything that belongs to one life / one match join. */
  resetMatchState() {
    this.view = 'first';
    this.kick = 0;
    this.nextShotAt = 0;
    this.nextThrowAt = 0;
    this.equipUntil = 0;
    this.lastEmptyAt = 0;
    this.lastMoveSent = 0;
    this.lastDroneSent = 0;
    this.lastHudAt = 0;
    this.droneMode = null; // { id, mode, endsAt, enteredAt }
    this.dead = false;
    this.lifeEventAt = -1; // when a you_died / respawned event last changed `dead`
    this.scoreboardOpen = false;
    this.flags = { scoped: null, ads: null, prompt: null, loot: null };
  }

  get rules() {
    return this.state.rules ?? {};
  }

  sfx(type, opts) {
    this.audio?.play(type, opts);
  }

  vibrate(ms) {
    if (!this.settings?.get('vibration')) return;
    try {
      this.win.navigator?.vibrate?.(ms);
    } catch { /* not supported */ }
  }

  // ================================================================== lifecycle
  /** Connects, joins and starts the loop. Rejects (after cleaning up) if anything fails. */
  async start({ session, mode, roomId, loadout }) {
    try {
      await this.setup();
      this.wire();
      await this.client.connect();
      await this.client.join({ token: session.token, roomId, mode, loadout });
      this.running = true;
      this.lastFrameAt = this.clock.now();
      this.rafId = this.clock.raf(this.tick);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  async setup() {
    const { doc, win } = this;
    this.canvas = el(doc, 'canvas', { class: 'game-canvas', id: 'game-canvas', tabindex: '-1' });
    this.stage.replaceChildren(this.canvas);

    const nav = win.navigator ?? {};
    const quality = resolveQuality(this.settings.get('quality'), {
      isTouch: this.isTouch, cores: nav.hardwareConcurrency || 4, memoryGb: nav.deviceMemory || 4
    });
    const { w, h } = this.viewSize();
    try {
      this.renderer = await this.rendererFactory({
        canvas: this.canvas, doc, quality, width: w, height: h, devicePixelRatio: win.devicePixelRatio || 1
      });
    } catch (err) {
      console.error('[renderer]', err);
      throw new Error('Could not start 3D graphics. Update your browser, or make sure hardware acceleration is on.');
    }

    this.input = new InputManager({ target: win, doc, canvas: this.canvas, isTouch: this.isTouch });
    this.applySettings();
    this.hud = new Hud({
      doc, root: this.hudRoot, isTouch: this.isTouch,
      onMenu: () => this.requestMenu(),
      onScoreboard: (on) => this.input.setScoreboard(on)
    });
    this.hud.reset();
    this.hud.show();
    if (this.isTouch) {
      this.touch = new TouchControls({ doc, root: this.touchRoot, input: this.input });
      this.touch.setMode('hidden');
      // the weapon chips double as slot buttons on a phone
      for (const [slot, chip] of Object.entries(this.hud.slotChips)) {
        chip.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.input.press(`slot:${slot}`);
        });
      }
    }
    this.input.setEnabled(false);

    // Esc (or switching to another window) makes the browser release the mouse: that opens the menu,
    // the way every shooter behaves. A phone never captures the mouse, so it never gets here.
    this.input.on('lock', (locked) => {
      if (!locked && this.running && !this.paused && !this.ended && !this.stopped && !this.isTouch) this.requestMenu();
    });

    // clicking the game captures the mouse (desktop)
    this.canvas.addEventListener('click', () => {
      if (!this.paused && !this.ended) this.input.requestLock();
    });
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.fatal('The graphics were interrupted by your device. Please go back to the lobby and join again.');
    });

    this.onResize = () => this.resize();
    win.addEventListener('resize', this.onResize);
    win.addEventListener('orientationchange', this.onResize);
    win.visualViewport?.addEventListener?.('resize', this.onResize);
    if (typeof win.ResizeObserver === 'function') {
      this.resizeObserver = new win.ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.stage);
    }
  }

  wire() {
    const on = (event, fn) => this.offs.push(this.client.on(event, fn));
    const inMatch = (fn) => (payload) => { if (!this.stopped) fn(payload ?? {}); };

    // --- connection
    on('connection_lost', inMatch(() => this.hud?.setConnection('Connection lost. Reconnecting...')));
    on('status', inMatch((s) => { if (s === 'connected') this.hud?.setConnection(''); }));
    on('rejoin_failed', inMatch(() => this.leaveWith('The match is no longer available.')));
    on('kicked', inMatch((p) => this.leaveWith(p.reason || 'You were removed from the match.')));

    // --- match
    on('match_joined', inMatch((p) => this.onJoined(p)));
    on('state_snapshot', inMatch((snap) => this.state.applySnapshot(snap, this.clock.now())));
    on('match_ended', inMatch((p) => this.onMatchEnded(p)));
    on('notice', inMatch((p) => this.hud?.notify(String(p.text ?? ''), 'warn')));

    // --- you
    on('correction', inMatch((p) => this.controller.teleport({ x: p.x, y: p.y, z: p.z, epoch: p.epoch })));
    on('respawned', inMatch((p) => this.onRespawned(p)));
    on('you_died', inMatch((p) => this.onDied(p)));
    on('damage_taken', inMatch((p) => this.onDamage(p)));
    on('hit_confirm', inMatch((p) => this.onHitConfirm(p)));
    on('reload_started', inMatch(() => this.sfx('reload')));
    on('heal_done', inMatch(() => this.sfx('heal')));
    on('heal_cancelled', inMatch(() => this.hud?.notify('Healing interrupted.', 'warn')));
    on('loot_received', inMatch((p) => {
      this.hud?.notify(`Looted: ${p.label ?? 'supplies'}`, 'good');
      this.sfx('pickup');
    }));

    // --- the battlefield
    on('kill_feed', inMatch((p) => this.hud?.addKill(p, this.state)));
    on('shot_fired', inMatch((p) => this.onShot(p)));
    on('explosion', inMatch((p) => this.onExplosion(p)));
    on('smoke_deployed', inMatch((p) => this.renderer?.effects.smoke(p)));
    on('grenade_thrown', inMatch((p) => { if (p.ownerId === this.state.myId) this.sfx('throw'); }));
    on('missile_incoming', inMatch((p) => this.onMissile(p)));
    on('drone_deployed', inMatch((p) => { if (p.ownerId === this.state.myId) this.enterDrone(p); }));
    on('drone_ended', inMatch((p) => { if (p.ownerId === this.state.myId) this.exitDrone(p.reason); }));
    on('airdrop_spawned', inMatch((p) => this.hud?.notify(`Supply drop incoming near ${p.zoneName ?? 'the field'}!`, 'info')));
    on('airdrop_landed', inMatch((p) => {
      this.hud?.notify(`Supply crate landed: ${p.zoneName ?? 'the field'}`, 'info');
      this.sfx('pickup', { volume: 0.6 });
    }));
    on('airdrop_looted', inMatch((p) => this.hud?.notify(`${p.by} looted ${p.label ?? 'a crate'}`, 'info')));
  }

  /** Leave the match and tell the page why. Safe to call more than once. */
  leaveWith(message) {
    if (this.stopped || this.ended) return;
    this.ended = true;
    this.stopLoop();
    this.input?.setEnabled(false);
    this.input?.exitLock();
    this.callbacks.onLeft?.(message);
  }

  fatal(message) {
    if (this.stopped) return;
    this.stopLoop();
    this.input?.setEnabled(false);
    this.input?.exitLock();
    this.callbacks.onFatal?.(message);
  }

  stopLoop() {
    this.running = false;
    if (this.rafId !== null) {
      this.clock.caf(this.rafId);
      this.rafId = null;
    }
  }

  /** Disconnects and removes everything this match created. Safe to call more than once. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopLoop();
    for (const off of this.offs) off();
    this.offs = [];
    try {
      this.client.leave();
      this.client.close();
    } catch { /* already closed */ }
    const { win } = this;
    win.removeEventListener('resize', this.onResize);
    win.removeEventListener('orientationchange', this.onResize);
    win.visualViewport?.removeEventListener?.('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.unsubSettings?.();
    this.input?.destroy();
    this.hud?.reset();
    this.hudRoot?.replaceChildren();
    this.touchRoot?.replaceChildren();
    try {
      this.renderer?.dispose();
    } catch (err) {
      console.error('[renderer dispose]', err);
    }
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  // ================================================================== pause / settings
  requestMenu() {
    this.callbacks.onMenuRequest?.();
  }

  setPaused(on) {
    this.paused = !!on;
    if (!this.input) return;
    this.input.setEnabled(!this.paused && !this.ended && this.state.joined);
    if (this.paused) this.input.exitLock();
    else this.input.requestLock();
  }

  applySettings() {
    if (!this.input) return;
    this.input.sensitivity = this.settings.get('sensitivity');
    this.input.invertY = this.settings.get('invertY');
    if (!this.unsubSettings) {
      this.unsubSettings = this.settings.on('change', () => this.applySettings());
    }
  }

  viewSize() {
    const w = this.stage.clientWidth || this.win.innerWidth || 800;
    const h = this.stage.clientHeight || this.win.innerHeight || 450;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  resize() {
    if (!this.renderer) return;
    const { w, h } = this.viewSize();
    this.renderer.resize(w, h);
  }

  // ================================================================== server events
  onJoined(p) {
    const now = this.clock.now();
    this.state.applyJoin(p, now);
    this.resetMatchState();
    const s = p.spawn ?? { x: 0, y: 0, z: -90, yaw: 0, pitch: 0 };
    this.controller.teleport({ x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, epoch: p.epoch });
    this.controller.resetPose();
    this.hud.reset();
    this.hud.setConnection('');
    this.input.setMode('body');
    this.input.setEnabled(!this.paused);
    this.touch?.setMode(this.state.me?.alive === false ? 'dead' : 'body');
    if (p.resumed) this.hud.notify('Reconnected.', 'good');
    else this.hud.notify(p.mode === 'TDM' ? `You are on team ${p.team === 'bharat' ? 'BHARAT' : 'OPFOR'}` : 'Free for all. Good luck!', 'info');
    this.input.requestLock();
  }

  onRespawned(p) {
    this.lifeEventAt = this.clock.now();
    this.controller.teleport({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, epoch: p.epoch });
    this.controller.resetPose();
    this.leaveDead();
    this.hud.notify('Spawn protection active.', 'good');
  }

  onDied(p) {
    this.lifeEventAt = this.clock.now();
    this.enterDead({ killer: p.killer, weapon: p.weapon, headshot: p.headshot, respawnInMs: p.respawnInMs ?? 0 });
    this.sfx('hurt');
    this.vibrate(180);
  }

  enterDead(info) {
    if (this.dead) return;
    this.dead = true;
    this.view = 'first';
    this.kick = 0;
    this.exitDrone('owner_died');
    this.input.setAds(false);
    this.touch?.setAds(false);
    this.touch?.setMode('dead');
    this.hud.setScoped(false);
    this.hud.setAds(false);
    this.hud.showDeath({
      killer: info.killer ?? null, weapon: info.weapon ?? '', headshot: !!info.headshot, respawnInMs: info.respawnInMs ?? 0
    });
  }

  leaveDead() {
    if (!this.dead) return;
    this.dead = false;
    this.hud.hideDeath();
    this.touch?.setMode(this.droneMode ? 'drone' : 'body', { droneKind: this.droneMode?.mode });
  }

  onDamage(p) {
    const c = this.controller;
    this.hud.damage({ amount: p.amount ?? 0, relativeAngle: damageAngle({ x: c.x, z: c.z, yaw: c.yaw }, p.src) });
    this.renderer?.effects.shake(clamp((p.amount ?? 0) / 90, 0.08, 0.5));
    this.sfx('hurt', { volume: 0.7 });
    this.vibrate(40);
  }

  onHitConfirm(p) {
    this.hud.hitMarker({ headshot: !!p.headshot, killed: !!p.killed, blocked: !!p.blocked });
    if (p.blocked) return;
    this.sfx(p.killed ? 'kill' : p.headshot ? 'headshot' : 'hit');
    if (p.killed) this.vibrate(30);
  }

  /** Volume and left/right balance of a sound that happens at (x, z). */
  spatial(x, z, range = 170) {
    const c = this.controller;
    const dx = x - c.x;
    const dz = z - c.z;
    const dist = Math.hypot(dx, dz);
    if (dist > range) return null;
    const volume = (1 - dist / range) ** 1.6;
    const pan = dist > 1 ? clamp((dx * Math.cos(c.yaw) + dz * -Math.sin(c.yaw)) / dist, -1, 1) * 0.85 : 0;
    return { volume, pan };
  }

  onShot(p) {
    const fx = this.renderer?.effects;
    if (!fx) return;
    const mine = p.shooterId === this.state.myId;
    const weapon = ARSENAL[p.weaponId];
    const o = p.origin;
    if (!mine && o) {
      const snd = this.spatial(o.x, o.z);
      if (snd) this.sfx(weaponSound(weapon), snd);
    }
    if (p.kind === 'bullet' && p.end) {
      if (!mine && o) {
        // start the tracer a little in front of the shooter so it does not come out of their face
        const dx = p.end.x - o.x;
        const dy = p.end.y - o.y;
        const dz = p.end.z - o.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const k = Math.min(1, 0.9 / len);
        fx.tracer({ x: o.x + dx * k, y: o.y - 0.12 + dy * k, z: o.z + dz * k }, p.end);
      }
      if (p.hit && p.hit !== 'none') fx.impact(p.end, p.hit);
    }
  }

  onExplosion(p) {
    const fx = this.renderer?.effects;
    if (!fx) return;
    fx.explosion(p);
    if (p.kind === 'missile') fx.clearMissileMarkerAt(p.x, p.z);
    const c = this.controller;
    const dist = Math.hypot(p.x - c.x, p.z - c.z);
    const power = p.kind === 'missile' ? 0.95 : 0.55;
    const shake = clamp(1 - dist / ((p.radius ?? 6) * 5 + 25), 0, 1) * power;
    if (shake > 0.02) fx.shake(shake);
    const snd = this.spatial(p.x, p.z, 260);
    if (snd) this.sfx('explosion', snd);
  }

  onMissile(p) {
    this.renderer?.effects.missileMarker({ id: p.id, x: p.x, z: p.z, radius: p.radius, etaMs: p.etaMs });
    const c = this.controller;
    const dist = Math.hypot(p.x - c.x, p.z - c.z);
    this.hud.notify(`${p.caller ?? 'Someone'} called a missile strike!`, dist < (p.radius ?? 15) + 25 ? 'danger' : 'warn');
    if (dist < (p.radius ?? 15) + 40) this.sfx('alarm');
  }

  onMatchEnded(p) {
    if (this.ended) return;
    this.ended = true;
    this.stopLoop();
    this.input.setEnabled(false);
    this.input.exitLock();
    this.callbacks.onMatchEnd?.(p, { myId: this.state.myId, team: this.state.team, mode: this.state.mode });
  }

  // ================================================================== drone mode
  enterDrone(p) {
    if (this.droneMode || this.dead) return;
    const now = this.clock.now();
    const mode = p.mode === 'recon' ? 'recon' : 'fpv';
    const ttl = p.ttlMs ?? (mode === 'fpv' ? this.rules.fpvTtlMs : this.rules.reconTtlMs) ?? 30000;
    this.droneMode = { id: p.id, mode, endsAt: now + ttl, enteredAt: now };
    this.droneCtl.start(this.controller.yaw, -0.15);
    this.input.setMode('drone');
    this.input.setAds(false);
    this.touch?.setAds(false);
    this.touch?.setMode('drone', { droneKind: mode });
    this.hud.setScoped(false);
    this.hud.setAds(false);
    this.hud.setDrone({ on: true, mode, ttlMs: ttl });
    this.lastDroneSent = 0;
  }

  exitDrone(reason) {
    if (!this.droneMode) return;
    this.droneMode = null;
    this.input?.setMode('body');
    this.touch?.setMode(this.dead ? 'dead' : 'body');
    this.hud?.setDrone({ on: false });
    const text = DRONE_END_TEXT[reason];
    if (text) this.hud?.notify(text, 'warn');
  }

  /** The server decides whether a drone exists; if our idea of it drifted, follow the server. */
  reconcileDrone(me, now) {
    if (!this.droneMode && me.droneId && me.alive) {
      const d = this.state.myDrone();
      if (d) this.enterDrone({ id: d.id, mode: d.mode });
    } else if (this.droneMode && !me.droneId && now - this.droneMode.enteredAt > 1500) {
      this.exitDrone('lost');
    }
  }

  // ================================================================== the loop
  tick = () => {
    if (!this.running || this.stopped) return;
    this.rafId = this.clock.raf(this.tick);
    const now = this.clock.now();
    const dt = clamp((now - this.lastFrameAt) / 1000, 0, MAX_DT);
    this.lastFrameAt = now;
    try {
      this.frame(now, dt);
      this.frameErrors = 0;
    } catch (err) {
      console.error('[frame]', err);
      if (++this.frameErrors >= MAX_FRAME_ERRORS) this.fatal('The game hit an unexpected problem. Please rejoin the match.');
    }
  };

  frame(now, dt) {
    const { state } = this;
    const me = state.me;
    if (!me || !this.renderer) return;

    const intent = this.input.frame();
    this.syncLife(me);
    this.reconcileDrone(me, now);

    if (this.kick > 0) {
      this.kick *= Math.exp(-dt * KICK_DECAY);
      if (this.kick < 1e-4) this.kick = 0;
    }

    if (this.droneMode) this.droneFrame(now, intent);
    else this.bodyFrame(now, dt, intent, me);

    if (intent.scoreboard !== this.scoreboardOpen) {
      this.scoreboardOpen = intent.scoreboard;
      this.hud.setScoreboard(this.scoreboardOpen, state);
    }
    if (now - this.lastHudAt >= HUD_MS) {
      this.lastHudAt = now;
      this.hudTick(now, me);
    }
    this.renderFrame(now, dt, me);
  }

  /** Makes sure the death screen matches what the server says, even if an event was missed. */
  syncLife(me) {
    // The you_died / respawned event arrives just ahead of the first snapshot that shows the change.
    // Until a snapshot newer than the event has come in, the old one must not undo what the event said
    // (it used to flash the death screen off and back on, losing the killer's name).
    if (this.state.snapshotAt <= this.lifeEventAt) return;
    if (!me.alive && !this.dead) this.enterDead({ respawnInMs: me.respawnInMs });
    else if (me.alive && this.dead) this.leaveDead();
  }

  bodyFrame(now, dt, intent, me) {
    const ctl = this.controller;
    const alive = me.alive && !this.paused;
    const weapon = ARSENAL[me.loadout[me.activeSlot]] ?? null;
    let jump = false;
    let toggleCrouch = false;
    let toggleProne = false;

    if (me.alive) {
      ctl.look(intent.dYaw, intent.dPitch); // look first, so what you do next uses where you now aim
      for (const edge of intent.edges) {
        if (edge === 'jump') jump = true;
        else if (edge === 'crouch') toggleCrouch = true;
        else if (edge === 'prone') toggleProne = true;
        else if (edge === 'stanceCycle') {
          if (ctl.stance === 'stand') toggleCrouch = true;
          else toggleProne = true;
        } else if (edge !== 'fire') this.act(edge, me, now);
      }

      const ads = !!intent.ads && !!weapon;
      ctl.update(dt, {
        moveX: intent.moveX, moveY: intent.moveY, dYaw: 0, dPitch: 0, sprint: intent.sprint,
        lean: intent.lean, jump, toggleCrouch, toggleProne
      }, { boost: me.boost, weaponMult: weapon?.moveSpeedMult ?? 1, ads });
      this.input.adsScale = ads && weapon ? clamp(weapon.adsFov / 74, 0.25, 1) : 1;

      if (alive) this.handleFire(intent, me, weapon, now);

      if (now - this.lastMoveSent >= SEND_MS) {
        this.lastMoveSent = now;
        this.client.sendFast('player_move', ctl.moveMessage());
      }
    }
  }

  droneFrame(now, intent) {
    const d = this.droneMode;
    this.droneCtl.update(intent);
    for (const edge of intent.edges) {
      if (edge === 'recall') this.client.send('drone_action', { action: 'recall' });
      else if (edge === 'detonate' || (edge === 'fire' && d.mode === 'fpv')) {
        if (d.mode === 'fpv') this.client.send('drone_action', { action: 'detonate' });
      }
    }
    if (now - this.lastDroneSent >= SEND_MS) {
      this.lastDroneSent = now;
      this.client.sendFast('control_drone', this.droneCtl.message());
    }
  }

  // ------------------------------------------------------------------ actions
  /** One-shot actions from keys and buttons. */
  act(edge, me, now) {
    const slot = me.activeSlot;
    switch (edge) {
      case 'reload': {
        const w = ARSENAL[me.loadout[slot]];
        const a = me.ammo[slot];
        if (w && !me.reload && a.mag < w.magSize && a.reserve > 0) this.client.send('reload');
        break;
      }
      case 'view':
        this.view = this.view === 'first' ? 'third' : 'first';
        break;
      case 'slot:next':
      case 'slot:prev': {
        const i = LOADOUT_SLOTS.indexOf(slot);
        const step = edge === 'slot:next' ? 1 : LOADOUT_SLOTS.length - 1;
        this.switchSlot(LOADOUT_SLOTS[(i + step) % LOADOUT_SLOTS.length], me, now);
        break;
      }
      case 'slot:primary':
      case 'slot:secondary':
      case 'slot:launcher':
        this.switchSlot(edge.slice(5), me, now);
        break;
      case 'frag':
      case 'smoke':
        this.throwGrenade(edge, me, now);
        break;
      case 'missile':
        if (me.cooldowns.missileMs > 0) this.hud.notify(`Missile strike ready in ${Math.ceil(me.cooldowns.missileMs / 1000)}s`, 'warn');
        else this.client.send('call_missile', { dir: this.aimDirection(now) });
        break;
      case 'fpv':
      case 'recon': {
        const left = me.cooldowns[`${edge}Ms`];
        if (left > 0) this.hud.notify(`${edge === 'fpv' ? 'FPV' : 'Recon'} drone ready in ${Math.ceil(left / 1000)}s`, 'warn');
        else this.client.send('deploy_drone', { mode: edge });
        break;
      }
      case 'cancelHeal':
        if (me.heal) this.client.send('cancel_heal');
        break;
      case 'loot': {
        const crate = this.state.crateNear(this.controller.x, this.controller.z, this.rules.lootRadius ?? 4);
        if (crate) this.client.send('loot_airdrop', { crateId: crate.id });
        else this.hud.notify('No supply crate within reach.', 'warn');
        break;
      }
      default:
        if (edge.startsWith('heal:')) this.useHeal(edge.slice(5), me);
        break;
    }
  }

  switchSlot(slot, me, now) {
    if (!LOADOUT_SLOTS.includes(slot) || slot === me.activeSlot) return;
    this.client.send('switch_weapon', { slot });
    this.equipUntil = now + (this.rules.equipDelayMs ?? 450);
    this.input.setAds(false);
    this.touch?.setAds(false);
  }

  throwGrenade(type, me, now) {
    if (!(me.inventory[type] > 0)) {
      this.hud.notify(`No ${type} grenades left.`, 'warn');
      return;
    }
    if (now < this.nextThrowAt) return;
    this.nextThrowAt = now + (this.rules.throwCooldownMs ?? 900);
    this.client.send('throw_grenade', { type, dir: this.aimDirection(now) });
  }

  useHeal(item, me) {
    const def = HEALING_ITEMS[item];
    if (!def) return;
    if (!(me.inventory[item] > 0)) {
      this.hud.notify(`No ${def.name} left.`, 'warn');
      return;
    }
    this.client.send('use_heal', { item });
  }

  handleFire(intent, me, weapon, now) {
    if (!weapon) return;
    const slot = me.activeSlot;
    const wants = weapon.auto ? intent.fire : intent.edges.has('fire');
    if (!wants || now < this.nextShotAt || now < this.equipUntil || me.reload) return;

    const ammo = me.ammo[slot];
    if (ammo.mag <= 0) {
      if (now - this.lastEmptyAt > 600) {
        this.lastEmptyAt = now;
        if (ammo.reserve > 0) {
          this.client.send('reload');
        } else {
          this.sfx('empty');
          this.hud.notify('Out of ammo!', 'warn');
        }
      }
      return;
    }

    const dir = this.aimDirection(now);
    this.client.send('shoot', { dir });
    this.nextShotAt = now + weapon.fireRateMs;
    this.localShotFeedback(weapon, dir);
  }

  /** What you see, hear and feel the instant you pull the trigger (the server confirms later). */
  localShotFeedback(weapon, dir) {
    const c = this.controller;
    this.sfx(weaponSound(weapon), { volume: weapon.category === 'launcher' ? 1 : 0.85 });
    this.renderer.fire(weapon.recoil);
    this.kick = Math.min(KICK_MAX, this.kick + weapon.recoil * (c.ads ? 0.7 : 1.4));

    if (weapon.category === 'launcher') {
      this.renderer.effects.shake(0.25);
      this.vibrate(30);
      return;
    }
    this.vibrate(6);
    const eye = getEyePosition(c);
    const hit = raycastWorld(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, weapon.range);
    const dist = hit ? hit.dist : Math.min(weapon.range, 160);
    const end = { x: eye.x + dir.x * dist, y: eye.y + dir.y * dist, z: eye.z + dir.z * dist };
    const origin = this.view === 'first'
      ? this.renderer.muzzleWorld()
      : { x: eye.x + dir.x * 0.7, y: eye.y - 0.15 + dir.y * 0.7, z: eye.z + dir.z * 0.7 };
    this.renderer.effects.tracer(origin, end);
  }

  /**
   * The direction your shots and throws take. In first person that is straight down the crosshair.
   * In third person the camera sits behind your shoulder, so the shot goes from your eyes to the
   * spot under the crosshair (the first thing the camera ray hits).
   */
  aimDirection(now) {
    const c = this.controller;
    const dir = forwardFromAngles(c.yaw, clamp(c.pitch + this.kick, -PITCH_LIMIT, PITCH_LIMIT));
    if (this.view !== 'third' || !this.renderer) return dir;

    const cam = this.renderer.cameraPosition();
    const hit = raycastWorld(cam.x, cam.y, cam.z, dir.x, dir.y, dir.z, 300);
    let t = hit ? hit.dist : 120;
    for (const entry of this.state.others()) {
      if (!entry.data.alive) continue;
      const p = entry.interp.sample(now);
      if (!p) continue;
      const hitT = rayHitsSphere(cam, dir, { x: p.x, y: p.y + 1.0, z: p.z }, 0.6, t);
      if (hitT !== null) t = hitT;
    }
    const eye = getEyePosition(c);
    const ax = cam.x + dir.x * t - eye.x;
    const ay = cam.y + dir.y * t - eye.y;
    const az = cam.z + dir.z * t - eye.z;
    const len = Math.hypot(ax, ay, az);
    return len < 1e-3 ? dir : { x: ax / len, y: ay / len, z: az / len };
  }

  // ------------------------------------------------------------------ screen
  hudTick(now, me) {
    const { hud, state, flags } = this;
    hud.update({ state, now });
    this.touch?.updateBadges(me);

    const c = this.controller;
    if (this.droneMode) hud.setDrone({ on: true, mode: this.droneMode.mode, ttlMs: this.droneMode.endsAt - now });

    const weapon = ARSENAL[me.loadout[me.activeSlot]] ?? null;
    const flying = !!this.droneMode;
    const ads = !!c.ads && me.alive && !flying;
    const scoped = ads && !!weapon && weapon.adsFov <= 26 && this.view === 'first';
    if (flags.ads !== ads) { flags.ads = ads; hud.setAds(ads); this.touch?.setAds(ads); }
    if (flags.scoped !== scoped) { flags.scoped = scoped; hud.setScoped(scoped); }

    const crate = me.alive && !flying ? state.crateNear(c.x, c.z, this.rules.lootRadius ?? 4) : null;
    if (flags.loot !== !!crate) { flags.loot = !!crate; this.touch?.setLoot(!!crate); }
    let prompt = '';
    if (crate) prompt = this.isTouch ? `Tap LOOT: ${crate.label ?? 'supply crate'}` : `Press F to loot: ${crate.label ?? 'supply crate'}`;
    else if (!this.isTouch && !this.input.locked && me.alive && !this.paused && !this.ended) prompt = 'Click the game to capture the mouse';
    if (flags.prompt !== prompt) { flags.prompt = prompt; hud.setPrompt(prompt); }

    hud.setFps(Math.round(this.renderer.fps), this.renderer.scale, !!this.settings.get('showFps'));
  }

  renderFrame(now, dt, me) {
    const c = this.controller;
    const state = this.state;
    const pose = {
      x: c.x, y: c.y, z: c.z, yaw: c.yaw, pitch: c.pitch, lean: c.lean,
      stance: c.stance, ads: c.ads, sprinting: c.sprinting, moving: c.moving
    };
    let view = this.view;
    let drone = null;
    if (this.droneMode) {
      const d = state.myDrone();
      if (d) {
        view = 'drone';
        drone = { id: d.id, mode: this.droneMode.mode, yaw: this.droneCtl.yaw, pitch: this.droneCtl.pitch, pos: { x: d.x, y: d.y, z: d.z } };
      }
    }
    const alive = !!me.alive;
    this.renderer.render({
      now,
      state,
      view,
      alive,
      pose,
      kick: this.kick,
      weapon: alive && !this.droneMode ? ARSENAL[me.loadout[me.activeSlot]] ?? null : null,
      reload: this.hud.reloadFraction(me),
      drone,
      teamMode: state.mode === 'TDM',
      myTeam: state.team
    }, dt);
  }

  /** For tests and the ?debug page: a small readable picture of the current state. */
  debugInfo() {
    const c = this.controller;
    const me = this.state.me;
    return {
      running: this.running,
      ended: this.ended,
      paused: this.paused,
      dead: this.dead,
      view: this.view,
      drone: this.droneMode ? this.droneMode.mode : null,
      pos: { x: c.x, y: c.y, z: c.z, yaw: c.yaw, pitch: c.pitch },
      epoch: c.epoch,
      hp: me?.hp ?? null,
      slot: me?.activeSlot ?? null,
      players: this.state.players.size
    };
  }
}
