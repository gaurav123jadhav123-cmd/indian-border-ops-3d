// Player settings, remembered in the browser. Always sanitized, so a damaged saved value can
// never break the game.
import { Emitter, clamp, storage } from './util.js';

export const QUALITY_CHOICES = Object.freeze(['auto', 'low', 'medium', 'high']);
const KEY = 'bop.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 1,   // look speed multiplier
  invertY: false,
  quality: 'auto',  // auto picks by device
  sound: true,
  volume: 0.8,
  showFps: false,
  vibration: true
});

export function sanitizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    sensitivity: num(s.sensitivity, 0.3, 2.5, DEFAULT_SETTINGS.sensitivity),
    invertY: bool(s.invertY, DEFAULT_SETTINGS.invertY),
    quality: QUALITY_CHOICES.includes(s.quality) ? s.quality : DEFAULT_SETTINGS.quality,
    sound: bool(s.sound, DEFAULT_SETTINGS.sound),
    volume: num(s.volume, 0, 1, DEFAULT_SETTINGS.volume),
    showFps: bool(s.showFps, DEFAULT_SETTINGS.showFps),
    vibration: bool(s.vibration, DEFAULT_SETTINGS.vibration)
  };
}

export class Settings extends Emitter {
  constructor(store = storage) {
    super();
    this.store = store;
    this.values = sanitizeSettings(store.get(KEY, null));
  }

  get(key) {
    return this.values[key];
  }

  set(patch) {
    this.values = sanitizeSettings({ ...this.values, ...patch });
    this.store.set(KEY, this.values);
    this.emit('change', this.values);
  }
}
