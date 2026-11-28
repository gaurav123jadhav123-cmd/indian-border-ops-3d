// Smooth movement of other players. The server sends ~20 snapshots a second; drawing them as they
// arrive would look jerky. Instead every entity keeps its last few snapshots and is drawn slightly
// in the past (delayMs), blending between the two snapshots around that moment.
import { lerp, lerpAngle } from '../util.js';

export class Interpolator {
  constructor({ delayMs = 100, maxExtrapolateMs = 120, maxSamples = 10, teleportDistance = 12 } = {}) {
    this.delayMs = delayMs;
    this.maxExtrapolateMs = maxExtrapolateMs;
    this.maxSamples = maxSamples;
    this.teleportDistance = teleportDistance;
    this.samples = [];
  }

  /** t = arrival time in ms on the client's clock; s = { x, y, z, yaw, pitch } */
  push(t, s) {
    const last = this.samples[this.samples.length - 1];
    if (last && Math.hypot(s.x - last.x, s.z - last.z) > this.teleportDistance) this.samples.length = 0; // respawn: do not slide across the map
    if (last && t <= last.t) return;
    this.samples.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  clear() {
    this.samples.length = 0;
  }

  /** Where the entity should be drawn at client time `now`, or null if nothing is known yet. */
  sample(now) {
    const n = this.samples.length;
    if (n === 0) return null;
    const first = this.samples[0];
    const last = this.samples[n - 1];
    const t = now - this.delayMs;

    if (n === 1 || t <= first.t) return { ...first };

    if (t >= last.t) {
      // ran out of snapshots: coast on the last known velocity for a moment, then hold
      const prev = this.samples[n - 2];
      const span = last.t - prev.t || 1;
      const ahead = Math.min(t - last.t, this.maxExtrapolateMs);
      const k = ahead / span;
      return {
        x: last.x + (last.x - prev.x) * k,
        y: last.y + (last.y - prev.y) * k,
        z: last.z + (last.z - prev.z) * k,
        yaw: last.yaw,
        pitch: last.pitch
      };
    }

    for (let i = n - 1; i > 0; i--) {
      const a = this.samples[i - 1];
      const b = this.samples[i];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / (b.t - a.t || 1);
        return {
          x: lerp(a.x, b.x, k),
          y: lerp(a.y, b.y, k),
          z: lerp(a.z, b.z, k),
          yaw: lerpAngle(a.yaw, b.yaw, k),
          pitch: lerp(a.pitch, b.pitch, k)
        };
      }
    }
    return { ...last };
  }
}
