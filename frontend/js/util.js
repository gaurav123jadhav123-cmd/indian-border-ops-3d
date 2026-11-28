// Small helpers shared by the UI and game code. Nothing here touches the 3D engine.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest-way interpolation between two angles in radians. */
export function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const fmtClock = (totalSec) => {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Seconds left on a cooldown shown as "RDY" or "27s". */
export const fmtCooldown = (ms) => (ms > 0 ? `${Math.ceil(ms / 1000)}s` : 'RDY');

/** Build a DOM element. Children that are strings become text nodes (never HTML). */
export function el(doc, tag, props = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? doc.createTextNode(String(child)) : child);
  }
  return node;
}

/** Like node.replaceChildren(...), but skips null/undefined/false (the DOM would print them as text). */
export function setChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== undefined && c !== null && c !== false));
}

/** localStorage that never throws (private windows, blocked storage, ...). */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw === null || raw === undefined ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable: the setting just won't be remembered */ }
  },
  remove(key) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch { /* ignore */ }
  }
};

/** Tiny event emitter. */
export class Emitter {
  constructor() {
    this.handlers = new Map();
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[handler for "${event}" failed]`, err);
      }
    }
  }
}
