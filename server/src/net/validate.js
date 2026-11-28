// Payload validation. Everything that arrives from a client is untrusted: every handler
// runs its payload through one of these first, and gets null back when it is garbage.
import { STANCES } from '../shared/world.js';
import { HEALING_ITEMS, sanitizeLoadout, LOADOUT_SLOTS } from '../shared/arsenal.js';

export const MODES = Object.freeze(['TDM', 'FFA']);
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
export const RESUME_KEY_RE = /^[a-f0-9]{16,64}$/;
export const HEAL_KEYS = Object.freeze(Object.keys(HEALING_ITEMS));
export const GRENADE_TYPES = Object.freeze(['frag', 'smoke']);
export const DRONE_MODES = Object.freeze(['fpv', 'recon']);
export const DRONE_ACTIONS = Object.freeze(['detonate', 'recall']);

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function clampNum(v, min, max, fallback = null) {
  if (!isNum(v)) return fallback;
  return v < min ? min : v > max ? max : v;
}

export function oneOf(v, list, fallback = null) {
  return typeof v === 'string' && list.includes(v) ? v : fallback;
}

/** Normalize a direction vector. Returns null for NaN / zero / non-object input. */
export function unitDir(v) {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.z)) return null;
  const len = Math.hypot(v.x, v.y, v.z);
  if (!(len > 1e-6) || len > 1e9) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function sanitizeJoin(raw) {
  if (!isObj(raw)) return null;
  const token = typeof raw.token === 'string' && raw.token.length <= 1024 ? raw.token : null;
  if (!token) return null;
  const roomId = typeof raw.roomId === 'string' && ROOM_ID_RE.test(raw.roomId) ? raw.roomId : 'border-sector-1';
  return {
    token,
    roomId,
    mode: oneOf(raw.mode, MODES, 'TDM'),
    loadout: sanitizeLoadout(raw.loadout),
    resumeKey: typeof raw.resumeKey === 'string' && RESUME_KEY_RE.test(raw.resumeKey) ? raw.resumeKey : null
  };
}

export function sanitizeMove(raw) {
  if (!isObj(raw)) return null;
  const x = clampNum(raw.x, -1000, 1000);
  const y = clampNum(raw.y, -1000, 1000);
  const z = clampNum(raw.z, -1000, 1000);
  if (x === null || y === null || z === null) return null;
  const yaw = clampNum(raw.yaw, -1e4, 1e4);
  const pitch = clampNum(raw.pitch, -1.5, 1.5);
  if (yaw === null || pitch === null) return null;
  return {
    x, y, z, yaw, pitch,
    stance: oneOf(raw.stance, STANCES, 'stand'),
    lean: raw.lean === -1 || raw.lean === 1 ? raw.lean : 0,
    sprinting: raw.sprinting === true,
    ads: raw.ads === true,
    epoch: Number.isInteger(raw.epoch) && raw.epoch >= 0 && raw.epoch < 1e9 ? raw.epoch : 0
  };
}

export function sanitizeSlot(raw) {
  const slot = isObj(raw) ? raw.slot : raw;
  return oneOf(slot, LOADOUT_SLOTS, null);
}

export function sanitizeShoot(raw) {
  if (!isObj(raw)) return null;
  const dir = unitDir(raw.dir);
  return dir ? { dir } : null;
}

export function sanitizeThrow(raw) {
  if (!isObj(raw)) return null;
  const type = oneOf(raw.type, GRENADE_TYPES, null);
  const dir = unitDir(raw.dir);
  return type && dir ? { type, dir } : null;
}

export function sanitizeMissile(raw) {
  if (!isObj(raw)) return null;
  const dir = unitDir(raw.dir);
  return dir ? { dir } : null;
}

export function sanitizeDeploy(raw) {
  if (!isObj(raw)) return null;
  const mode = oneOf(raw.mode, DRONE_MODES, null);
  return mode ? { mode } : null;
}

export function sanitizeDroneInput(raw) {
  if (!isObj(raw)) return null;
  return {
    forward: raw.forward === true,
    backward: raw.backward === true,
    left: raw.left === true,
    right: raw.right === true,
    up: raw.up === true,
    down: raw.down === true,
    yaw: clampNum(raw.yaw, -1e4, 1e4, 0),
    pitch: clampNum(raw.pitch, -1.5, 1.5, 0)
  };
}

export function sanitizeDroneAction(raw) {
  if (!isObj(raw)) return null;
  const action = oneOf(raw.action, DRONE_ACTIONS, null);
  return action ? { action } : null;
}

export function sanitizeHeal(raw) {
  if (!isObj(raw)) return null;
  const item = oneOf(raw.item, HEAL_KEYS, null);
  return item ? { item } : null;
}

export function sanitizeLoot(raw) {
  if (!isObj(raw)) return null;
  return typeof raw.crateId === 'string' && raw.crateId.length <= 24 ? { crateId: raw.crateId } : null;
}

/** Callsigns shown in game: letters, digits, _ . - and max 18 characters. */
export function cleanCallsign(value) {
  const s = typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 18) : '';
  return s.length >= 2 ? s : '';
}
