// The lobby: pick a callsign (guest or account), mode, room and weapons, then deploy.
// Everything shown comes from the backend when it is reachable (weapon list, leaderboard) and from
// the bundled shared data when it is not, so the screen never stays empty.
import {
  ARSENAL as BUNDLED_ARSENAL, SLOT_RULES as BUNDLED_RULES, LOADOUT_SLOTS,
  sanitizeLoadout, isAllowedForSlot
} from '../shared/arsenal.js';
import { el, setChildren, storage } from '../util.js';

export const SESSION_KEY = 'bop.session.v1';
const PREFS_KEY = 'bop.lobby.v1';
const ROOM_RE = /^[A-Za-z0-9_-]{1,24}$/;
const CALLSIGN_RE = /^[A-Za-z0-9_.-]{2,18}$/;

const SLOT_LABELS = { primary: 'Primary weapon', secondary: 'Sidearm', launcher: 'Launcher' };
const MODES = [
  { id: 'TDM', label: 'Team Deathmatch', hint: 'Bharat vs OPFOR. First team to the score limit wins.' },
  { id: 'FFA', label: 'Free For All', hint: 'Every soldier for themselves. First to the kill limit wins.' }
];

export class Lobby {
  constructor({ doc, root, api, isTouch = false, onDeploy, onGesture = () => {}, onOpenSettings = () => {}, onFullscreen = null }) {
    this.doc = doc;
    this.root = root;
    this.api = api;
    this.isTouch = isTouch;
    this.onDeploy = onDeploy;
    this.onGesture = onGesture; // runs inside the tap on DEPLOY: the only moment a browser allows sound / full screen
    this.onOpenSettings = onOpenSettings;
    this.onFullscreen = onFullscreen;

    this.session = null;
    this.tab = 'guest'; // guest | login | register
    this.busy = false;
    this.arsenal = BUNDLED_ARSENAL;
    this.slotRules = BUNDLED_RULES;
    this.prefs = { callsign: '', mode: 'TDM', room: 'public', loadout: {}, ...(storage.get(PREFS_KEY, {}) || {}) };
    this.loadout = sanitizeLoadout(this.prefs.loadout);
    this.build();
  }

  // ------------------------------------------------------------------ session
  loadSession() {
    const s = storage.get(SESSION_KEY, null);
    return s && typeof s.token === 'string' && typeof s.callsign === 'string' ? s : null;
  }

  saveSession(session) {
    this.session = session;
    storage.set(SESSION_KEY, session);
    this.renderAccount();
  }

  clearSession() {
    this.session = null;
    storage.remove(SESSION_KEY);
    this.renderAccount();
  }

  /** Called on start-up: remember who was signed in, and check the token is still good. */
  async restore() {
    const saved = this.loadSession();
    if (!saved) return;
    this.session = saved;
    this.renderAccount();
    try {
      const { user } = await this.api.me(saved.token);
      this.saveSession({ ...saved, callsign: user.callsign, guest: !!user.guest });
      if (!user.guest && user.loadout) this.setLoadout(user.loadout);
    } catch (err) {
      // only a definite "your token is no good" signs the player out; a network problem does not
      if (err.status === 401) {
        this.clearSession();
        this.setNotice('Your session expired. Please sign in again.');
      }
    }
  }

  // ------------------------------------------------------------------ data
  async loadArsenal() {
    try {
      const data = await this.api.arsenal();
      if (data?.weapons && data?.slotRules) {
        this.arsenal = data.weapons;
        this.slotRules = data.slotRules;
        this.loadout = sanitizeLoadout(this.loadout);
        this.renderLoadout();
      }
      this.setOnline(true);
    } catch {
      this.setOnline(false); // the bundled copy is identical, so the lobby still works
    }
  }

  async loadLeaderboard() {
    this.boardBody.replaceChildren(el(this.doc, 'div', { class: 'muted', text: 'Loading...' }));
    try {
      const { leaderboard, recentMatches } = await this.api.leaderboard();
      this.renderBoard(leaderboard ?? [], recentMatches ?? []);
      this.setOnline(true);
    } catch (err) {
      this.boardBody.replaceChildren(el(this.doc, 'div', { class: 'muted', text: err.message || 'Leaderboard unavailable.' }));
      this.setOnline(false);
    }
  }

  setOnline(on) {
    this.onlineChip.textContent = on ? 'Server online' : 'Server offline';
    this.onlineChip.classList.toggle('on', on);
    this.onlineChip.classList.toggle('off', !on);
  }

  // ------------------------------------------------------------------ building
  build() {
    const h = (tag, props, ...kids) => el(this.doc, tag, props, ...kids);

    this.onlineChip = h('span', { class: 'chip', id: 'online-chip', text: 'Connecting...' });
    const header = h('header', { class: 'lobby-head' },
      h('div', { class: 'tricolor' }, h('i'), h('i'), h('i')),
      h('h1', { text: 'INDIAN BORDER OPS' }),
      h('div', { class: 'sub', text: 'HIMALAYAN LAC · 3D MULTIPLAYER FPS' }),
      this.onlineChip);

    this.notice = h('div', { class: 'notice hidden', id: 'lobby-notice', role: 'status' });
    this.error = h('div', { class: 'error hidden', id: 'lobby-error', role: 'alert' });

    // --- account card
    this.accountBody = h('div', { class: 'account-body' });
    const accountCard = h('section', { class: 'card' }, h('h2', { text: 'Soldier' }), this.accountBody);

    // --- match card
    this.modeSelect = h('select', { id: 'mode', 'aria-label': 'Game mode' },
      ...MODES.map((m) => h('option', { value: m.id, text: m.label })));
    this.modeSelect.value = MODES.some((m) => m.id === this.prefs.mode) ? this.prefs.mode : 'TDM';
    this.modeHint = h('div', { class: 'hint' });
    this.roomInput = h('input', {
      id: 'room', type: 'text', value: this.prefs.room || 'public', maxlength: '24',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Room code'
    });
    this.modeSelect.addEventListener('change', () => this.updateModeHint());
    this.updateModeHint();
    const matchCard = h('section', { class: 'card' },
      h('h2', { text: 'Match' }),
      h('label', { class: 'field' }, h('span', { text: 'Mode' }), this.modeSelect),
      this.modeHint,
      h('label', { class: 'field' }, h('span', { text: 'Room' }), this.roomInput),
      h('div', { class: 'hint', text: 'Friends who type the same room code land in the same match.' }));

    // --- loadout card
    this.loadoutBody = h('div', { class: 'loadout-body' });
    this.weaponInfo = h('div', { class: 'weapon-info', id: 'weapon-info' });
    const loadoutCard = h('section', { class: 'card' }, h('h2', { text: 'Loadout' }), this.loadoutBody, this.weaponInfo);

    // --- deploy
    this.deployBtn = h('button', { class: 'deploy', id: 'deploy', type: 'button', text: 'DEPLOY', onclick: () => this.deploy() });
    this.deployRow = h('div', { class: 'deploy-row' }, this.deployBtn);

    // --- leaderboard
    this.boardBody = h('div', { class: 'board-body' });
    const boardCard = h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { text: 'Leaderboard' }),
        h('button', { class: 'link', type: 'button', text: 'Refresh', onclick: () => this.loadLeaderboard() })),
      this.boardBody);

    // --- controls help
    const helpRows = this.isTouch
      ? [
        ['Left thumb', 'Move. Push the stick all the way out to sprint.'],
        ['Right thumb', 'Drag on the screen to look around.'],
        ['FIRE / AIM', 'Shoot, and zoom in on the sights.'],
        ['MORE', 'Missile strike, drones, healing items and camera view.']
      ]
      : [
        ['W A S D', 'Move · Shift sprint · Space jump · C crouch · Z prone · Q/E lean'],
        ['Mouse', 'Look · Left click fire · Right click aim · Wheel or 1-3 switch weapon'],
        ['R / G / T', 'Reload · Frag grenade · Smoke grenade'],
        ['4 / 5 / 6', 'Missile strike · FPV drone · Recon drone'],
        ['7 8 9 0', 'Bandage · First aid · Medkit · Energy drink'],
        ['F · V · Tab', 'Loot air-drop · Third-person view · Scoreboard']
      ];
    const help = h('details', { class: 'card help' },
      h('summary', { text: 'How to play' }),
      ...helpRows.map(([k, v]) => h('div', { class: 'help-row' }, h('b', { text: k }), h('span', { text: v }))));

    const tools = h('div', { class: 'lobby-tools' },
      h('button', { class: 'ghost', type: 'button', id: 'btn-settings', text: 'Settings', onclick: () => this.onOpenSettings() }),
      this.onFullscreen ? h('button', { class: 'ghost', type: 'button', id: 'btn-fullscreen', text: 'Full screen', onclick: () => this.onFullscreen() }) : null);

    this.root.replaceChildren(header, this.notice, this.error,
      h('div', { class: 'lobby-grid' },
        h('div', { class: 'col' }, accountCard, matchCard, loadoutCard, this.deployRow),
        h('div', { class: 'col' }, boardCard, help, tools)),
      h('footer', { class: 'lobby-foot', text: 'Jai Hind. Play fair.' }));

    this.renderAccount();
    this.renderLoadout();
  }

  updateModeHint() {
    this.modeHint.textContent = MODES.find((m) => m.id === this.modeSelect.value)?.hint ?? '';
  }

  // ------------------------------------------------------------------ account card
  renderAccount() {
    const h = (tag, props, ...kids) => el(this.doc, tag, props, ...kids);
    if (this.session) {
      this.accountBody.replaceChildren(
        h('div', { class: 'who' },
          h('span', { class: 'who-name', id: 'who-name', text: this.session.callsign }),
          h('span', { class: `badge-chip ${this.session.guest ? 'guest' : 'acct'}`, text: this.session.guest ? 'GUEST' : 'ACCOUNT' })),
        h('div', { class: 'hint', text: this.session.guest ? 'Guests are not saved to the leaderboard.' : 'Your kills count toward the leaderboard.' }),
        h('button', { class: 'ghost', type: 'button', id: 'btn-signout', text: 'Switch soldier', onclick: () => this.clearSession() }));
      return;
    }

    const tabBtn = (id, label) => h('button', {
      type: 'button', class: `tab${this.tab === id ? ' on' : ''}`, dataset: { tab: id }, text: label,
      onclick: () => { this.tab = id; this.renderAccount(); }
    });
    this.callsignInput = h('input', {
      id: 'callsign', type: 'text', maxlength: '18', value: this.prefs.callsign || '',
      autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', placeholder: 'e.g. Rajput_07', 'aria-label': 'Callsign'
    });
    this.passwordInput = h('input', {
      id: 'password', type: 'password', maxlength: '128',
      autocomplete: this.tab === 'register' ? 'new-password' : 'current-password', 'aria-label': 'Password'
    });
    this.passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.deploy(); });
    this.callsignInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.deploy(); });

    setChildren(this.accountBody,
      h('div', { class: 'tabs', role: 'tablist' }, tabBtn('guest', 'Guest'), tabBtn('login', 'Sign in'), tabBtn('register', 'Create account')),
      h('label', { class: 'field' }, h('span', { text: 'Callsign' }), this.callsignInput),
      this.tab === 'guest' ? null : h('label', { class: 'field' }, h('span', { text: 'Password' }), this.passwordInput),
      h('div', { class: 'hint', text: {
        guest: 'Jump straight in. Nothing is saved.',
        login: 'Sign in with your callsign and password.',
        register: '2-18 letters, numbers, dot, dash or underscore. Password: 6 or more characters.'
      }[this.tab] }));
  }

  // ------------------------------------------------------------------ loadout card
  setLoadout(loadout) {
    this.loadout = sanitizeLoadout(loadout);
    this.renderLoadout();
  }

  weaponsFor(slot) {
    const cats = this.slotRules[slot]?.categories ?? [];
    return Object.values(this.arsenal)
      .filter((w) => cats.includes(w.category) && !w.airdropOnly)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  renderLoadout() {
    const h = (tag, props, ...kids) => el(this.doc, tag, props, ...kids);
    this.selects = {};
    const rows = LOADOUT_SLOTS.map((slot) => {
      const select = h('select', { id: `slot-${slot}`, 'aria-label': SLOT_LABELS[slot] },
        ...this.weaponsFor(slot).map((w) => h('option', { value: w.id, text: w.name })));
      select.value = this.loadout[slot];
      select.addEventListener('change', () => {
        if (isAllowedForSlot(slot, select.value)) this.loadout[slot] = select.value;
        this.focusSlot = slot;
        this.renderWeaponInfo();
      });
      select.addEventListener('focus', () => { this.focusSlot = slot; this.renderWeaponInfo(); });
      this.selects[slot] = select;
      return h('label', { class: 'field' }, h('span', { text: SLOT_LABELS[slot] }), select);
    });
    this.loadoutBody.replaceChildren(...rows);
    this.focusSlot = this.focusSlot ?? 'primary';
    this.renderWeaponInfo();
  }

  renderWeaponInfo() {
    const h = (tag, props, ...kids) => el(this.doc, tag, props, ...kids);
    const w = this.arsenal[this.loadout[this.focusSlot ?? 'primary']];
    if (!w) {
      this.weaponInfo.replaceChildren();
      return;
    }
    const stat = (label, value, max, text) => h('div', { class: 'stat' },
      h('span', { class: 'stat-label', text: label }),
      h('div', { class: 'stat-bar' }, h('i', { style: `width:${Math.max(4, Math.min(100, (value / max) * 100)).toFixed(0)}%` })),
      h('span', { class: 'stat-val', text }));
    this.weaponInfo.replaceChildren(
      h('div', { class: 'wi-head' }, h('b', { text: w.name }), h('span', { class: 'muted', text: ` ${w.caliber}` })),
      h('div', { class: 'wi-desc', text: w.description }),
      stat('Damage', w.damage, 130, String(w.damage)),
      stat('Fire rate', 1000 / w.fireRateMs, 14, `${(1000 / w.fireRateMs).toFixed(1)}/s`),
      stat('Range', w.range, 300, `${w.range} m`),
      stat('Magazine', w.magSize, 100, String(w.magSize)),
      stat('Mobility', (w.moveSpeedMult - 0.8) , 0.3, `${Math.round(w.moveSpeedMult * 100)}%`));
  }

  // ------------------------------------------------------------------ leaderboard card
  renderBoard(rows, matches) {
    const h = (tag, props, ...kids) => el(this.doc, tag, props, ...kids);
    if (!rows.length) {
      this.boardBody.replaceChildren(h('div', { class: 'muted', text: 'No ranked matches yet. Create an account and be the first.' }));
      return;
    }
    const table = h('div', { class: 'board' },
      h('div', { class: 'brow bhead' }, h('span', { text: '#' }), h('span', { class: 'bname', text: 'Callsign' }), h('span', { text: 'Score' }), h('span', { text: 'K/D' }), h('span', { text: 'Wins' })),
      ...rows.slice(0, 10).map((r) => h('div', { class: 'brow' },
        h('span', { text: r.rank }),
        h('span', { class: 'bname', text: r.callsign }),
        h('span', { text: r.stats.score }),
        h('span', { text: `${r.stats.kills}/${r.stats.deaths}` }),
        h('span', { text: r.stats.wins }))));
    const recent = matches.slice(0, 5).map((m) => {
      const result = m.draw ? 'Draw' : m.winnerTeam ? `${m.winnerTeam === 'bharat' ? 'Bharat' : 'OPFOR'} won` : m.winnerCallsign ? `${m.winnerCallsign} won` : 'Finished';
      const score = m.scores ? ` ${m.scores.bharat}-${m.scores.opfor}` : '';
      return h('div', { class: 'recent-row', text: `${m.mode} · ${result}${score}` });
    });
    setChildren(this.boardBody, table, recent.length ? h('div', { class: 'recent' }, h('h3', { text: 'Recent matches' }), ...recent) : null);
  }

  // ------------------------------------------------------------------ messages
  setNotice(text) {
    this.notice.textContent = text || '';
    this.notice.classList.toggle('hidden', !text);
  }

  setError(text) {
    this.error.textContent = text || '';
    this.error.classList.toggle('hidden', !text);
  }

  setBusy(on, label = 'DEPLOYING...') {
    this.busy = !!on;
    this.deployBtn.disabled = !!on;
    this.deployBtn.textContent = on ? label : 'DEPLOY';
  }

  show() {
    this.root.classList.remove('hidden');
    this.setBusy(false);
  }

  hide() {
    this.root.classList.add('hidden');
  }

  // ------------------------------------------------------------------ deploy
  /** Validates the form, signs in if needed, then hands over to the game. */
  async deploy() {
    if (this.busy) return;
    this.setError('');
    this.setNotice('');

    const room = this.roomInput.value.trim() || 'public';
    if (!ROOM_RE.test(room)) {
      this.setError('Room code can only use letters, numbers, dash and underscore (up to 24 characters).');
      return;
    }
    const mode = this.modeSelect.value;
    try {
      this.onGesture();
    } catch { /* sound or full screen refused: the game still starts */ }
    this.setBusy(true, this.session ? 'DEPLOYING...' : 'SIGNING IN...');

    try {
      let session = this.session;
      if (!session) {
        const callsign = this.callsignInput.value.trim();
        const password = this.passwordInput?.value ?? '';
        if (this.tab === 'guest') {
          if (callsign && !CALLSIGN_RE.test(callsign)) throw new Error('Callsign must be 2-18 characters: letters, numbers, dot, dash or underscore.');
        } else {
          if (!CALLSIGN_RE.test(callsign)) throw new Error('Callsign must be 2-18 characters: letters, numbers, dot, dash or underscore.');
          if (!password) throw new Error('Enter your password.');
          if (this.tab === 'register' && password.length < 6) throw new Error('Password must be at least 6 characters.');
        }
        const call = this.tab === 'guest' ? this.api.guest(callsign)
          : this.tab === 'login' ? this.api.login(callsign, password)
            : this.api.register(callsign, password);
        const { token, user } = await call;
        session = { token, callsign: user.callsign, guest: !!user.guest, id: user.id };
        this.prefs.callsign = this.tab === 'guest' && !callsign ? '' : user.callsign;
        this.saveSession(session);
        if (!user.guest && this.tab === 'login' && user.loadout) this.setLoadout(user.loadout);
      }

      this.prefs = { ...this.prefs, mode, room, loadout: { ...this.loadout } };
      storage.set(PREFS_KEY, this.prefs);

      // registered players keep their weapons between visits (a failure here must not stop the game)
      if (!session.guest) this.api.saveLoadout(session.token, this.loadout).catch(() => {});

      this.setBusy(true, 'CONNECTING...');
      await this.onDeploy({ session, mode, roomId: room, loadout: { ...this.loadout } });
    } catch (err) {
      this.setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      this.setBusy(false);
    }
  }
}
