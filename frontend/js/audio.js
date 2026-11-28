// Sound effects made on the fly with the Web Audio API (no audio files to download).
// Browsers only allow sound after a tap/click, so `unlock()` is called from the first gesture.
// Every call is wrapped: a sound problem must never break the game.

const MAX_VOICES = 28;

export class AudioEngine {
  constructor({ settings = null, AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
    this.settings = settings;
    this.AudioContextClass = AudioContextClass;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.voices = 0;
    settings?.on('change', () => this.applyVolume());
  }

  get available() {
    return !!this.AudioContextClass;
  }

  /** Call from a tap / click / key press. Safe to call many times. */
  unlock() {
    if (!this.AudioContextClass) return;
    try {
      if (!this.ctx) {
        this.ctx = new this.AudioContextClass();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.noise = this.makeNoise();
        this.applyVolume();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume?.();
    } catch {
      this.ctx = null;
    }
  }

  applyVolume() {
    if (!this.master) return;
    const on = this.settings ? this.settings.get('sound') : true;
    const vol = this.settings ? this.settings.get('volume') : 0.8;
    this.master.gain.value = on ? vol : 0;
  }

  makeNoise() {
    const len = Math.floor(this.ctx.sampleRate * 0.8);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  // ---------------------------------------------------------------- building blocks
  out(pan) {
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      p.connect(this.master);
      return p;
    }
    return this.master;
  }

  track(node, seconds) {
    this.voices += 1;
    const done = () => { this.voices = Math.max(0, this.voices - 1); };
    if (node && 'onended' in node) node.onended = done;
    else setTimeout(done, seconds * 1000 + 50);
  }

  tone({ type = 'square', from, to = from, dur = 0.1, gain = 0.2, delay = 0, pan = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(this.out(pan));
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    this.track(osc, dur);
  }

  burst({ dur = 0.2, filter = 'lowpass', freq = 800, to = freq, gain = 0.3, delay = 0, pan = 0, q = 0.7 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (to !== freq) f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(this.out(pan));
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    this.track(src, dur);
  }

  // ---------------------------------------------------------------- the sounds
  /** type: rifle smg pistol sniper launcher explosion reload empty hit headshot kill hurt pickup alarm heal throw */
  play(type, { volume = 1, pan = 0 } = {}) {
    if (!this.ctx || !this.master || this.voices > MAX_VOICES) return;
    if (this.settings && !this.settings.get('sound')) return;
    const v = Math.max(0, Math.min(1, volume));
    if (v < 0.02) return;
    try {
      this.synth(type, v, pan);
    } catch { /* never let audio break the game */ }
  }

  synth(type, v, pan) {
    switch (type) {
      case 'rifle':
        this.tone({ type: 'square', from: 240, to: 45, dur: 0.09, gain: 0.2 * v, pan });
        this.burst({ dur: 0.08, freq: 2400, to: 600, gain: 0.16 * v, pan });
        break;
      case 'smg':
        this.tone({ type: 'square', from: 300, to: 70, dur: 0.06, gain: 0.15 * v, pan });
        this.burst({ dur: 0.05, freq: 3000, to: 900, gain: 0.12 * v, pan });
        break;
      case 'pistol':
        this.tone({ type: 'square', from: 340, to: 80, dur: 0.07, gain: 0.17 * v, pan });
        this.burst({ dur: 0.06, freq: 3200, to: 1000, gain: 0.12 * v, pan });
        break;
      case 'sniper':
        this.tone({ type: 'sawtooth', from: 190, to: 38, dur: 0.22, gain: 0.26 * v, pan });
        this.burst({ dur: 0.3, freq: 1800, to: 200, gain: 0.26 * v, pan });
        break;
      case 'launcher':
        this.burst({ dur: 0.5, freq: 700, to: 90, gain: 0.32 * v, pan });
        this.tone({ type: 'sawtooth', from: 120, to: 40, dur: 0.35, gain: 0.2 * v, pan });
        break;
      case 'explosion':
        this.burst({ dur: 0.9, freq: 420, to: 60, gain: 0.55 * v, pan });
        this.tone({ type: 'sine', from: 70, to: 28, dur: 0.7, gain: 0.5 * v, pan });
        break;
      case 'reload':
        this.tone({ type: 'square', from: 1300, to: 900, dur: 0.04, gain: 0.1 * v, pan });
        this.tone({ type: 'square', from: 800, to: 500, dur: 0.05, gain: 0.1 * v, delay: 0.22, pan });
        break;
      case 'empty':
        this.tone({ type: 'square', from: 900, to: 700, dur: 0.03, gain: 0.08 * v, pan });
        break;
      case 'hit':
        this.tone({ type: 'sine', from: 1300, to: 1100, dur: 0.05, gain: 0.16 * v });
        break;
      case 'headshot':
        this.tone({ type: 'sine', from: 1900, to: 1500, dur: 0.06, gain: 0.2 * v });
        this.tone({ type: 'sine', from: 1500, to: 1200, dur: 0.07, gain: 0.16 * v, delay: 0.05 });
        break;
      case 'kill':
        this.tone({ type: 'sine', from: 160, to: 70, dur: 0.18, gain: 0.3 * v });
        this.tone({ type: 'sine', from: 1700, to: 1300, dur: 0.08, gain: 0.18 * v, delay: 0.04 });
        break;
      case 'hurt':
        this.tone({ type: 'sine', from: 110, to: 60, dur: 0.14, gain: 0.35 * v });
        this.burst({ dur: 0.1, freq: 500, to: 200, gain: 0.18 * v });
        break;
      case 'pickup':
        this.tone({ type: 'triangle', from: 520, to: 520, dur: 0.08, gain: 0.16 * v });
        this.tone({ type: 'triangle', from: 780, to: 780, dur: 0.12, gain: 0.16 * v, delay: 0.08 });
        break;
      case 'alarm':
        this.tone({ type: 'sawtooth', from: 760, to: 520, dur: 0.35, gain: 0.14 * v });
        this.tone({ type: 'sawtooth', from: 760, to: 520, dur: 0.35, gain: 0.14 * v, delay: 0.4 });
        break;
      case 'heal':
        this.tone({ type: 'sine', from: 440, to: 880, dur: 0.25, gain: 0.14 * v });
        break;
      case 'throw':
        this.burst({ dur: 0.18, filter: 'bandpass', freq: 400, to: 1800, gain: 0.14 * v, q: 1.2, pan });
        break;
      default:
        break;
    }
  }
}

/** Which sound a weapon makes. */
export function weaponSound(weapon) {
  if (!weapon) return 'rifle';
  if (weapon.category === 'sniper') return 'sniper';
  if (weapon.category === 'smg') return 'smg';
  if (weapon.category === 'sidearm') return 'pistol';
  if (weapon.category === 'launcher') return 'launcher';
  return 'rifle';
}
