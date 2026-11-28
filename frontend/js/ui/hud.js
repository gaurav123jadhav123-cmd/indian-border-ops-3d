// The heads-up display: score, timer, health, ammo, kill feed, hit markers, damage direction,
// banners, scoreboard, drone and respawn overlays. Built with textContent only (never innerHTML),
// so a hostile callsign can never inject markup.
import { ARSENAL, HEALING_ITEMS } from '../shared/arsenal.js';
import { el, fmtClock, fmtCooldown } from '../util.js';

const setText = (node, value) => {
  const v = String(value);
  if (node._v !== v) {
    node._v = v;
    node.textContent = v;
  }
};
const setClass = (node, name, on) => node.classList.toggle(name, !!on);
const setWidth = (node, pct) => {
  const v = `${Math.max(0, Math.min(100, pct)).toFixed(0)}%`;
  if (node._w !== v) {
    node._w = v;
    node.style.width = v;
  }
};

const SLOT_KEYS = { primary: '1', secondary: '2', launcher: '3' };
const GEAR = [
  { id: 'frag', key: 'G', label: 'Frag', get: (me) => me.inventory.frag },
  { id: 'smoke', key: 'T', label: 'Smoke', get: (me) => me.inventory.smoke },
  { id: 'missile', key: '4', label: 'Missile', get: (me) => fmtCooldown(me.cooldowns.missileMs) },
  { id: 'fpv', key: '5', label: 'FPV', get: (me) => fmtCooldown(me.cooldowns.fpvMs) },
  { id: 'recon', key: '6', label: 'Recon', get: (me) => fmtCooldown(me.cooldowns.reconMs) },
  { id: 'bandage', key: '7', label: 'Bandage', get: (me) => me.inventory.bandage },
  { id: 'firstAid', key: '8', label: 'First Aid', get: (me) => me.inventory.firstAid },
  { id: 'medkit', key: '9', label: 'Medkit', get: (me) => me.inventory.medkit },
  { id: 'energyDrink', key: '0', label: 'Energy', get: (me) => me.inventory.energyDrink }
];

export class Hud {
  constructor({ doc, root, isTouch = false, onMenu = () => {}, onScoreboard = () => {} }) {
    this.doc = doc;
    this.root = root;
    this.isTouch = isTouch;
    this.onMenu = onMenu;
    this.onScoreboard = onScoreboard;
    this.timers = new Map();
    this.scoreboardOpen = false;
    this.deathUntil = 0;
    this.build();
  }

  // ------------------------------------------------------------------ building
  build() {
    const h = (tag, props, ...kids) => el(this.doc, tag, props, ...kids);
    const bar = (cls) => {
      const fill = h('div', { class: `bar-fill ${cls}` });
      return { wrap: h('div', { class: 'bar' }, fill), fill };
    };

    this.menuBtn = h('button', { class: 'hud-btn', id: 'btn-menu', type: 'button', 'aria-label': 'Menu', text: '☰', onclick: () => this.onMenu() });
    this.scoresBtn = h('button', {
      class: 'hud-btn', id: 'btn-scores', type: 'button', 'aria-label': 'Scoreboard', text: '≣',
      onpointerdown: () => this.onScoreboard(true),
      onpointerup: () => this.onScoreboard(false),
      onpointercancel: () => this.onScoreboard(false)
    });

    this.scoreA = h('span', { class: 'score team-bharat', id: 'score-a', text: '0' });
    this.scoreB = h('span', { class: 'score team-opfor', id: 'score-b', text: '0' });
    this.labelA = h('span', { class: 'score-label team-bharat', text: 'BHARAT' });
    this.labelB = h('span', { class: 'score-label team-opfor', text: 'OPFOR' });
    this.timer = h('span', { class: 'timer', id: 'timer', text: '00:00' });
    this.modeLine = h('div', { class: 'mode-line', id: 'mode-line' });
    this.scoreBox = h('div', { class: 'score-box', id: 'score-box' },
      h('div', { class: 'score-row' }, this.labelA, this.scoreA, this.timer, this.scoreB, this.labelB),
      this.modeLine);
    this.killFeed = h('div', { class: 'kill-feed', id: 'kill-feed' });

    const top = h('div', { class: 'hud-top' },
      h('div', { class: 'hud-top-left' }, this.menuBtn, this.scoresBtn),
      this.scoreBox,
      this.killFeed);

    this.crosshair = h('div', { class: 'crosshair', id: 'crosshair' },
      h('i', { class: 'ch-t' }), h('i', { class: 'ch-b' }), h('i', { class: 'ch-l' }), h('i', { class: 'ch-r' }));
    this.hitmarker = h('div', { class: 'hitmarker hidden', id: 'hitmarker' },
      h('i'), h('i'), h('i'), h('i'));
    this.scope = h('div', { class: 'scope hidden', id: 'scope' }, h('i', { class: 'scope-h' }), h('i', { class: 'scope-v' }));
    this.vignette = h('div', { class: 'dmg-vignette', id: 'dmg-vignette' });
    this.arrows = h('div', { class: 'dmg-arrows', id: 'dmg-arrows' });
    this.banner = h('div', { class: 'banner hidden', id: 'banner' });
    this.prompt = h('div', { class: 'prompt hidden', id: 'prompt' });

    this.progressLabel = h('span', { class: 'progress-label' });
    this.progressFill = h('div', { class: 'progress-fill' });
    this.progress = h('div', { class: 'progress hidden', id: 'progress' }, this.progressLabel, h('div', { class: 'progress-bar' }, this.progressFill));

    // vitals
    this.hpVal = h('b', { text: '100' });
    this.armorVal = h('b', { text: '0' });
    this.boostVal = h('b', { text: '0' });
    const hp = bar('hp');
    const armor = bar('armor');
    const boost = bar('boost');
    this.hpFill = hp.fill;
    this.armorFill = armor.fill;
    this.boostFill = boost.fill;
    this.stanceLine = h('div', { class: 'stance-line', id: 'stance-line' });
    this.vitals = h('div', { class: 'vitals', id: 'vitals' },
      h('div', { class: 'stat-row' }, h('span', { text: 'HP' }), hp.wrap, this.hpVal),
      h('div', { class: 'stat-row' }, h('span', { text: 'ARMOR' }), armor.wrap, this.armorVal),
      h('div', { class: 'stat-row' }, h('span', { text: 'BOOST' }), boost.wrap, this.boostVal),
      this.stanceLine);

    // weapon box
    this.weaponName = h('div', { class: 'weapon-name', id: 'weapon-name' });
    this.ammoMag = h('span', { class: 'ammo-mag', id: 'ammo-mag', text: '0' });
    this.ammoReserve = h('span', { class: 'ammo-reserve', id: 'ammo-reserve', text: '0' });
    this.slotChips = {};
    const slots = h('div', { class: 'slot-row' });
    for (const slot of ['primary', 'secondary', 'launcher']) {
      const chip = h('span', { class: 'slot-chip', dataset: { slot } });
      this.slotChips[slot] = chip;
      slots.append(chip);
    }
    this.weaponBox = h('div', { class: 'weapon-box', id: 'weapon-box' },
      this.weaponName,
      h('div', { class: 'ammo-count' }, this.ammoMag, h('span', { class: 'ammo-sep', text: '/' }), this.ammoReserve),
      slots);

    // gear chips (desktop shows them with their keys; touch shows the same numbers on the buttons)
    this.gearBox = h('div', { class: 'gear-box', id: 'gear-box' });
    this.gearChips = {};
    for (const g of GEAR) {
      const value = h('b');
      const chip = h('div', { class: 'gear-chip', dataset: { gear: g.id } },
        this.isTouch ? null : h('span', { class: 'key', text: `[${g.key}]` }), `${g.label} `, value);
      this.gearChips[g.id] = { chip, value, def: g };
      this.gearBox.append(chip);
    }

    const bottom = h('div', { class: 'hud-bottom' }, this.vitals, this.gearBox, this.weaponBox);

    // overlays
    this.droneLabel = h('div', { class: 'drone-label', id: 'drone-label' });
    this.droneTime = h('div', { class: 'drone-time', id: 'drone-time' });
    this.droneHint = h('div', { class: 'drone-hint', id: 'drone-hint' });
    this.droneOverlay = h('div', { class: 'drone-overlay hidden', id: 'drone-overlay' },
      h('div', { class: 'drone-top' }, this.droneLabel, this.droneTime), this.droneHint);

    this.deathTitle = h('div', { class: 'death-title', text: 'ELIMINATED' });
    this.deathBy = h('div', { class: 'death-by', id: 'death-by' });
    this.deathCount = h('div', { class: 'death-count', id: 'death-count' });
    this.respawn = h('div', { class: 'respawn-overlay hidden', id: 'respawn-overlay' }, this.deathTitle, this.deathBy, this.deathCount);

    this.scoreboard = h('div', { class: 'scoreboard hidden', id: 'scoreboard' });
    this.conn = h('div', { class: 'conn-banner hidden', id: 'conn-banner' });
    this.fps = h('div', { class: 'fps hidden', id: 'fps' });
    this.protect = h('div', { class: 'protect hidden', id: 'protect', text: 'SPAWN PROTECTION' });

    this.root.replaceChildren(
      top, this.vignette, this.arrows, this.crosshair, this.hitmarker, this.scope,
      this.banner, this.prompt, this.protect, this.progress, bottom,
      this.droneOverlay, this.respawn, this.scoreboard, this.conn, this.fps);
  }

  // ------------------------------------------------------------------ visibility
  show() {
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  reset() {
    this.killFeed.replaceChildren();
    this.arrows.replaceChildren();
    for (const n of [this.banner, this.prompt, this.progress, this.droneOverlay, this.respawn, this.scoreboard, this.hitmarker, this.scope, this.protect]) {
      n.classList.add('hidden');
    }
    this.vignette.style.opacity = '0';
    this.root.classList.remove('in-drone');
    this.scoreboardOpen = false;
    this.deathUntil = 0;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Run `fn` once after `ms`; calling again with the same key restarts the timer. */
  later(key, ms, fn) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); fn(); }, ms));
  }

  // ------------------------------------------------------------------ per snapshot
  /** ctx: { state, arsenal, pose, now } */
  update({ state, now }) {
    const me = state.me;
    if (!me) return;
    const teamMode = state.mode === 'TDM' && state.scores;

    // scores & timer
    setText(this.timer, fmtClock(state.timeLeftSec));
    if (teamMode) {
      setClass(this.scoreBox, 'ffa', false);
      setText(this.scoreA, state.scores.bharat);
      setText(this.scoreB, state.scores.opfor);
      setText(this.modeLine, `Team Deathmatch · first to ${state.rules.tdmScoreLimit ?? '-'}`);
      setClass(this.labelA, 'mine', state.team === 'bharat');
      setClass(this.labelB, 'mine', state.team === 'opfor');
    } else {
      setClass(this.scoreBox, 'ffa', true);
      let top = null;
      for (const { data } of state.players.values()) if (!top || data.kills > top.kills) top = data;
      setText(this.labelA, 'YOU');
      setText(this.scoreA, me.kills);
      setText(this.labelB, top && top.id !== state.myId ? top.callsign.slice(0, 10) : 'LEAD');
      setText(this.scoreB, top ? top.kills : 0);
      setText(this.modeLine, `Free For All · first to ${state.rules.ffaKillLimit ?? '-'} kills`);
    }

    // vitals
    setText(this.hpVal, me.hp);
    setWidth(this.hpFill, me.hp);
    setClass(this.hpFill, 'low', me.hp <= 30);
    setText(this.armorVal, me.armor);
    setWidth(this.armorFill, me.armor);
    setText(this.boostVal, me.boost);
    setWidth(this.boostFill, me.boost);
    const pub = state.myPublic();
    setText(this.stanceLine, `${(pub?.stance ?? 'stand').toUpperCase()}  ·  K ${me.kills}  D ${me.deaths}${me.streak >= 3 ? `  ·  STREAK ${me.streak}` : ''}`);
    setClass(this.protect, 'hidden', !(me.alive && me.protectedMs > 0));

    // weapon
    const weaponId = me.loadout[me.activeSlot];
    const w = ARSENAL[weaponId];
    setText(this.weaponName, w ? w.name : weaponId);
    const ammo = me.ammo[me.activeSlot];
    setText(this.ammoMag, ammo.mag);
    setText(this.ammoReserve, ammo.reserve);
    setClass(this.ammoMag, 'low', w && ammo.mag <= Math.max(1, Math.floor(w.magSize * 0.25)));
    for (const [slot, chip] of Object.entries(this.slotChips)) {
      const id = me.loadout[slot];
      const sw = ARSENAL[id];
      setText(chip, `${this.isTouch ? '' : `${SLOT_KEYS[slot]} `}${sw ? shortName(sw.name) : id}`);
      setClass(chip, 'active', slot === me.activeSlot);
    }

    // gear
    for (const { chip, value, def } of Object.values(this.gearChips)) {
      const v = def.get(me);
      setText(value, v);
      setClass(chip, 'empty', v === 0);
      setClass(chip, 'cooling', typeof v === 'string' && v !== 'RDY');
    }

    // reload / heal progress
    let progress = null;
    if (me.reload) {
      progress = { label: 'RELOADING', frac: 1 - me.reload.remainingMs / Math.max(1, me.reload.totalMs) };
    } else if (me.heal) {
      progress = { label: `USING ${(HEALING_ITEMS[me.heal.item]?.name ?? me.heal.item).toUpperCase()}`, frac: 1 - me.heal.remainingMs / Math.max(1, me.heal.totalMs) };
    }
    setClass(this.progress, 'hidden', !progress || !me.alive);
    if (progress) {
      setText(this.progressLabel, progress.label);
      setWidth(this.progressFill, progress.frac * 100);
    }

    // death overlay
    if (!me.alive) {
      if (!this.respawn.classList.contains('hidden') || this.deathUntil) {
        const left = Math.max(0, me.respawnInMs);
        setText(this.deathCount, left > 0 ? `Respawning in ${Math.ceil(left / 1000)}` : 'Respawning...');
      }
    }

    // keep the kill feed to what is recent
    this.pruneFeed(now);
    if (this.scoreboardOpen) this.renderScoreboard(state);
  }

  /** Reload / heal progress as 0..1 for the weapon animation, or null. */
  reloadFraction(me) {
    return me && me.reload ? 1 - me.reload.remainingMs / Math.max(1, me.reload.totalMs) : null;
  }

  // ------------------------------------------------------------------ events
  hitMarker({ headshot = false, killed = false, blocked = false } = {}) {
    const m = this.hitmarker;
    m.classList.remove('hidden');
    setClass(m, 'headshot', headshot);
    setClass(m, 'kill', killed);
    setClass(m, 'blocked', blocked);
    this.later('hit', killed ? 320 : 130, () => m.classList.add('hidden'));
  }

  /** `fromYaw`: the direction the damage came from, relative to where we look (radians, 0 = ahead). */
  damage({ amount = 0, relativeAngle = null }) {
    this.vignette.style.opacity = String(Math.min(0.75, 0.25 + amount / 120));
    this.later('vignette', 260, () => { this.vignette.style.opacity = '0'; });
    if (relativeAngle === null || !Number.isFinite(relativeAngle)) return;
    const arrow = el(this.doc, 'div', { class: 'dmg-arrow' }, el(this.doc, 'i'));
    arrow.style.transform = `rotate(${relativeAngle}rad)`;
    this.arrows.append(arrow);
    while (this.arrows.children.length > 4) this.arrows.firstChild.remove();
    setTimeout(() => arrow.remove(), 1300);
  }

  addKill(ev, state) {
    const mine = ev.killerId === state.myId;
    const died = ev.victimId === state.myId;
    const row = el(this.doc, 'div', { class: `kill-item${mine ? ' mine' : ''}${died ? ' died' : ''}` });
    row.dataset.at = String(Date.now());
    const team = (t) => (t === 'bharat' ? 'team-bharat' : t === 'opfor' ? 'team-opfor' : '');
    row.append(
      el(this.doc, 'span', { class: team(ev.killerTeam), text: ev.suicide ? ev.victim : ev.killer }),
      el(this.doc, 'span', { class: 'kf-weapon', text: ev.suicide ? ` [${ev.weapon}] ` : ` [${ev.weapon}${ev.headshot ? ' • HS' : ''}] ` }),
      ev.suicide ? '' : el(this.doc, 'span', { class: team(ev.victimTeam), text: ev.victim })
    );
    this.killFeed.prepend(row);
    while (this.killFeed.children.length > 5) this.killFeed.lastChild.remove();
  }

  pruneFeed(now = Date.now()) {
    for (const row of [...this.killFeed.children]) {
      if (Date.now() - Number(row.dataset.at) > 7000) row.remove();
    }
  }

  notify(text, kind = 'info') {
    this.banner.className = `banner ${kind}`;
    this.banner.textContent = text;
    this.later('banner', 3200, () => this.banner.classList.add('hidden'));
  }

  setPrompt(text) {
    if (!text) {
      this.prompt.classList.add('hidden');
      return;
    }
    this.prompt.classList.remove('hidden');
    setText(this.prompt, text);
  }

  setScoped(on) {
    setClass(this.scope, 'hidden', !on);
    setClass(this.crosshair, 'hidden', !!on);
  }

  setAds(on) {
    setClass(this.crosshair, 'ads', on);
  }

  showDeath({ killer, weapon, headshot, respawnInMs }) {
    this.respawn.classList.remove('hidden');
    setText(this.deathBy, killer ? `Killed by ${killer} [${weapon}${headshot ? ' • HEADSHOT' : ''}]` : 'You died');
    setText(this.deathCount, `Respawning in ${Math.ceil(respawnInMs / 1000)}`);
    this.deathUntil = Date.now() + respawnInMs;
  }

  hideDeath() {
    this.respawn.classList.add('hidden');
    this.deathUntil = 0;
  }

  setDrone({ on, mode = null, ttlMs = 0 }) {
    setClass(this.droneOverlay, 'hidden', !on);
    this.root.classList.toggle('in-drone', !!on); // the soldier's weapon panel is not in use while flying
    if (!on) return;
    setText(this.droneLabel, mode === 'fpv' ? 'FPV ATTACK DRONE' : 'RECON OVERWATCH DRONE');
    setText(this.droneTime, `${Math.max(0, Math.ceil(ttlMs / 1000))}s`);
    const keys = mode === 'fpv'
      ? (this.isTouch ? 'Stick: fly · drag: look · BOOM: detonate · EXIT: recall' : 'WASD fly · Space/Shift up/down · Click or X: detonate · B: recall')
      : (this.isTouch ? 'Stick: fly · drag: look · EXIT: recall' : 'WASD fly · Space/Shift up/down · B: recall');
    setText(this.droneHint, keys);
  }

  setConnection(text) {
    if (!text) {
      this.conn.classList.add('hidden');
      return;
    }
    this.conn.classList.remove('hidden');
    setText(this.conn, text);
  }

  setFps(fps, scale, on) {
    setClass(this.fps, 'hidden', !on);
    if (on) setText(this.fps, `${fps} fps · ${(scale * 100).toFixed(0)}%`);
  }

  // ------------------------------------------------------------------ scoreboard
  setScoreboard(open, state) {
    this.scoreboardOpen = !!open;
    setClass(this.scoreboard, 'hidden', !open);
    if (open && state) this.renderScoreboard(state);
  }

  renderScoreboard(state) {
    const rows = [...state.players.values()].map((e) => e.data).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.callsign.localeCompare(b.callsign));
    const teamMode = state.mode === 'TDM';
    const head = el(this.doc, 'div', { class: 'sb-row sb-head' },
      el(this.doc, 'span', { class: 'sb-name', text: 'PLAYER' }),
      el(this.doc, 'span', { text: 'K' }), el(this.doc, 'span', { text: 'D' }));
    const lines = rows.slice(0, 16).map((p) => el(this.doc, 'div', { class: `sb-row${p.id === state.myId ? ' me' : ''}${p.alive ? '' : ' dead'}` },
      el(this.doc, 'span', { class: `sb-name ${teamMode ? (p.team === 'bharat' ? 'team-bharat' : 'team-opfor') : ''}`, text: p.callsign }),
      el(this.doc, 'span', { text: p.kills }), el(this.doc, 'span', { text: p.deaths })));
    this.scoreboard.replaceChildren(
      el(this.doc, 'div', { class: 'sb-title', text: teamMode ? `BHARAT ${state.scores?.bharat ?? 0}  —  ${state.scores?.opfor ?? 0} OPFOR` : 'FREE FOR ALL' }),
      head, ...lines);
  }
}

function shortName(name) {
  return name.replace(/\s*(G2|1B1|TAR-21|M4|1A)$/i, '').replace('Pistol Auto 9mm', 'Pistol').slice(0, 12);
}

/** Angle (radians, 0 = straight ahead, + = to the right) at which damage came from (srcX, srcZ). */
export function damageAngle(me, src) {
  if (!src) return null;
  const dx = src.x - me.x;
  const dz = src.z - me.z;
  if (Math.hypot(dx, dz) < 0.5) return null;
  // forward / right vectors at the player's yaw (yaw 0 looks toward -Z)
  const fx = -Math.sin(me.yaw);
  const fz = -Math.cos(me.yaw);
  const rx = Math.cos(me.yaw);
  const rz = -Math.sin(me.yaw);
  return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
}
