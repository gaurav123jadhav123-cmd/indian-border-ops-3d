// Graphics presets and the automatic "make it lighter if the phone struggles" logic.
// No 3D engine in here, so it can be tested on its own.

export const QUALITY_PRESETS = Object.freeze({
  low: Object.freeze({
    name: 'low', pixelRatio: 1, antialias: false, shadows: false, shadowMapSize: 0,
    terrainSegments: 64, ringSegments: 30, fogDensity: 0.0065, far: 520, skyRadius: 400, maxFx: 28, nameTags: true
  }),
  medium: Object.freeze({
    name: 'medium', pixelRatio: 1.5, antialias: false, shadows: true, shadowMapSize: 1024,
    terrainSegments: 96, ringSegments: 60, fogDensity: 0.0055, far: 650, skyRadius: 500, maxFx: 48, nameTags: true
  }),
  high: Object.freeze({
    name: 'high', pixelRatio: 2, antialias: true, shadows: true, shadowMapSize: 2048,
    terrainSegments: 128, ringSegments: 60, fogDensity: 0.005, far: 700, skyRadius: 550, maxFx: 80, nameTags: true
  })
});

/** Which preset "auto" means on this device. */
export function pickAuto({ isTouch = false, cores = 4, memoryGb = 4 } = {}) {
  if (!isTouch) return 'high';
  if (cores <= 4 || memoryGb <= 3) return 'low';
  return 'medium';
}

export function resolveQuality(setting, deviceInfo) {
  const name = setting && setting !== 'auto' && QUALITY_PRESETS[setting] ? setting : pickAuto(deviceInfo);
  return QUALITY_PRESETS[name];
}

/**
 * Lowers the render resolution (never raises it again) when frames take too long for a while.
 * Feed it the time of every frame in milliseconds; it returns the resolution scale to use (0.55 - 1).
 */
export class AdaptiveScale {
  constructor({ targetMs = 22, min = 0.55, step = 0.1, slowFrames = 45 } = {}) {
    this.targetMs = targetMs;
    this.min = min;
    this.step = step;
    this.slowFrames = slowFrames;
    this.scale = 1;
    this.ema = targetMs;
    this.slow = 0;
    this.changed = false;
  }

  sample(dtMs) {
    this.changed = false;
    if (!(dtMs > 0) || dtMs > 250) return this.scale; // tab switch or a one-off hitch: ignore
    this.ema = this.ema * 0.9 + dtMs * 0.1;
    if (this.ema > this.targetMs * 1.3) this.slow += 1;
    else this.slow = Math.max(0, this.slow - 1);

    if (this.slow >= this.slowFrames && this.scale > this.min) {
      this.scale = Math.max(this.min, Math.round((this.scale - this.step) * 100) / 100);
      this.slow = 0;
      this.ema = this.targetMs; // give the new resolution time to prove itself
      this.changed = true;
    }
    return this.scale;
  }
}

/** Frames per second, averaged over about a second. */
export class FpsMeter {
  constructor() {
    this.frames = 0;
    this.acc = 0;
    this.fps = 0;
  }

  sample(dtMs) {
    this.frames += 1;
    this.acc += dtMs;
    if (this.acc >= 1000) {
      this.fps = Math.round((this.frames * 1000) / this.acc);
      this.frames = 0;
      this.acc = 0;
    }
    return this.fps;
  }
}
