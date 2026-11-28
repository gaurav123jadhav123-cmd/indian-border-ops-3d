// Full-screen panels that sit on top of the game: pause menu, settings, match result and error.
// One panel is open at a time. Everything is built with textContent (never innerHTML).
import { el, fmtClock } from '../util.js';
import { QUALITY_CHOICES } from '../settings.js';

const QUALITY_LABELS = { auto: 'Auto (recommended)', low: 'Low (fastest)', medium: 'Medium', high: 'High (best looking)' };

const REASON_TEXT = {
  limit: 'Score limit reached',
  time: 'Time is up',
  shutdown: 'The server is restarting'
};

/** Works out the headline of the result screen from the server's `match_ended` payload. */
export function describeResult(payload, { myId, team }) {
  const players = Array.isArray(payload.players) ? payload.players : [];
  const me = players.find((p) => p.id === myId);
  const myTeam = me?.team ?? team;
  const reason = REASON_TEXT[payload.reason] ?? 'Match finished';

  if (payload.mode === 'TDM') {
    const s = payload.scores ?? { bharat: 0, opfor: 0 };
    const line = `BHARAT ${s.bharat}  —  ${s.opfor} OPFOR`;
    if (payload.draw || !payload.winnerTeam) return { title: 'DRAW', tone: 'draw', line, reason };
    const won = payload.winnerTeam === myTeam;
    return { title: won ? 'VICTORY' : 'DEFEAT', tone: won ? 'win' : 'loss', line, reason };
  }

  if (payload.draw || !payload.winnerId) return { title: 'DRAW', tone: 'draw', line: 'Nobody came out on top.', reason };
  const won = payload.winnerId === myId;
  return {
    title: won ? 'VICTORY' : 'MATCH OVER',
    tone: won ? 'win' : 'loss',
    line: won ? 'You finished first.' : `Winner: ${payload.winnerCallsign ?? 'unknown'}`,
    reason
  };
}

export class Overlays {
  constructor({ doc, root, settings, isTouch = false }) {
    this.doc = doc;
    this.root = root;
    this.settings = settings;
    this.isTouch = isTouch;
    this.current = null; // 'menu' | 'settings' | 'result' | 'error'
    this.onKey = (e) => {
      if (e.key === 'Escape' && this.escape) {
        e.preventDefault();
        this.escape();
      }
    };
    doc.addEventListener('keydown', this.onKey);
    this.root.classList.add('hidden');
  }

  get isOpen() {
    return this.current !== null;
  }

  close() {
    this.current = null;
    this.escape = null;
    this.root.classList.add('hidden');
    this.root.replaceChildren();
  }

  open(kind, panel, { escape = null, focus = null } = {}) {
    this.current = kind;
    this.escape = escape;
    this.root.classList.remove('hidden');
    this.root.replaceChildren(el(this.doc, 'div', { class: 'overlay-backdrop' }, panel));
    (focus ?? panel.querySelector('button'))?.focus?.({ preventScroll: true });
  }

  h(tag, props, ...kids) {
    return el(this.doc, tag, props, ...kids);
  }

  button(label, onclick, { primary = false, danger = false, id = null } = {}) {
    return this.h('button', {
      type: 'button',
      id,
      class: `btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}`,
      text: label,
      onclick
    });
  }

  // ------------------------------------------------------------------ pause menu
  showMenu({ onResume, onSettings, onLeave }) {
    const resume = this.button('RESUME', () => { this.close(); onResume(); }, { primary: true, id: 'menu-resume' });
    const panel = this.h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu' },
      this.h('h2', { text: 'PAUSED' }),
      this.h('p', { class: 'hint', text: 'The match keeps running while you are in this menu.' }),
      resume,
      this.button('SETTINGS', () => onSettings(), { id: 'menu-settings' }),
      this.button('LEAVE MATCH', () => { this.close(); onLeave(); }, { danger: true, id: 'menu-leave' }));
    this.open('menu', panel, { escape: () => { this.close(); onResume(); }, focus: resume });
  }

  // ------------------------------------------------------------------ settings
  showSettings({ onClose }) {
    const s = this.settings;
    const h = (...a) => this.h(...a);

    const slider = (id, label, key, min, max, step, fmt) => {
      const value = h('span', { class: 'val', text: fmt(s.get(key)) });
      const input = h('input', { id, type: 'range', min, max, step, value: s.get(key), 'aria-label': label });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        s.set({ [key]: v });
        value.textContent = fmt(s.get(key));
      });
      return h('label', { class: 'row' }, h('span', { class: 'lbl', text: label }), input, value);
    };
    const toggle = (id, label, key) => {
      const input = h('input', { id, type: 'checkbox', checked: s.get(key) ? true : null });
      input.checked = !!s.get(key);
      input.addEventListener('change', () => s.set({ [key]: input.checked }));
      return h('label', { class: 'row check' }, h('span', { class: 'lbl', text: label }), input);
    };

    const quality = h('select', { id: 'set-quality', 'aria-label': 'Graphics quality' },
      ...QUALITY_CHOICES.map((q) => h('option', { value: q, text: QUALITY_LABELS[q] })));
    quality.value = s.get('quality');
    quality.addEventListener('change', () => s.set({ quality: quality.value }));

    const close = this.button('DONE', () => { this.close(); onClose(); }, { primary: true, id: 'settings-done' });
    const panel = h('div', { class: 'panel wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
      h('h2', { text: 'SETTINGS' }),
      h('div', { class: 'settings-grid' },
        slider('set-sens', 'Look speed', 'sensitivity', 0.3, 2.5, 0.05, (v) => `${v.toFixed(2)}x`),
        toggle('set-invert', 'Invert vertical look', 'invertY'),
        h('label', { class: 'row' }, h('span', { class: 'lbl', text: 'Graphics' }), quality),
        h('div', { class: 'hint', text: 'Graphics changes apply from the next match. The game also lowers its resolution by itself if your device struggles.' }),
        toggle('set-sound', 'Sound', 'sound'),
        slider('set-volume', 'Volume', 'volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
        toggle('set-fps', 'Show FPS', 'showFps'),
        this.isTouch ? toggle('set-vibration', 'Vibration', 'vibration') : null),
      close);
    this.open('settings', panel, { escape: () => { this.close(); onClose(); }, focus: close });
  }

  // ------------------------------------------------------------------ result
  showResult(payload, ctx, { onAgain, onLobby }) {
    const h = (...a) => this.h(...a);
    const res = describeResult(payload, ctx);
    const players = [...(payload.players ?? [])].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.callsign.localeCompare(b.callsign));
    const teamMode = payload.mode === 'TDM';
    const rows = players.slice(0, 12).map((p, i) => h('div', { class: `sb-row${p.id === ctx.myId ? ' me' : ''}${p.present === false ? ' dead' : ''}` },
      h('span', { class: 'sb-rank', text: String(i + 1) }),
      h('span', { class: `sb-name${teamMode ? ` team-${p.team === 'bharat' ? 'bharat' : 'opfor'}` : ''}`, text: p.callsign }),
      h('span', { text: p.kills }), h('span', { text: p.deaths }), h('span', { text: p.headshots ?? 0 })));

    const again = this.button('PLAY AGAIN', async () => {
      again.disabled = true;
      again.textContent = 'JOINING...';
      try {
        await onAgain(); // reports its own problems by opening the error panel
      } finally {
        if (this.current === 'result') this.close();
      }
    }, { primary: true, id: 'result-again' });
    const panel = h('div', { class: `panel wide result ${res.tone}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Match result' },
      h('div', { class: 'result-title', id: 'result-title', text: res.title }),
      h('div', { class: 'result-line', text: res.line }),
      h('div', { class: 'hint', text: `${res.reason}${payload.durationSec ? ` · ${fmtClock(payload.durationSec)}` : ''}` }),
      h('div', { class: 'sb-table' },
        h('div', { class: 'sb-row sb-head' }, h('span', { class: 'sb-rank', text: '#' }), h('span', { class: 'sb-name', text: 'PLAYER' }), h('span', { text: 'K' }), h('span', { text: 'D' }), h('span', { text: 'HS' })),
        ...rows),
      h('div', { class: 'btn-row' }, again, this.button('LOBBY', () => { this.close(); onLobby(); }, { id: 'result-lobby' })));
    this.open('result', panel, { focus: again });
  }

  // ------------------------------------------------------------------ error
  showError(message, { title = 'Something went wrong', onBack }) {
    const back = this.button('BACK TO LOBBY', () => { this.close(); onBack(); }, { primary: true, id: 'error-back' });
    const panel = this.h('div', { class: 'panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      this.h('h2', { text: title }),
      this.h('p', { class: 'error-text', id: 'error-text', text: message }),
      back);
    this.open('error', panel, { focus: back });
  }

  destroy() {
    this.doc.removeEventListener('keydown', this.onKey);
    this.close();
  }
}
