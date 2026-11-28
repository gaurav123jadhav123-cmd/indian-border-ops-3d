// Token-bucket rate limiter, one instance per socket. Events over the limit are dropped.
import { performance } from 'node:perf_hooks';

// events per second (rate) and how many may arrive in a burst
export const SOCKET_LIMITS = Object.freeze({
  join_match:    { rate: 1,  burst: 3 },
  player_move:   { rate: 45, burst: 90 },
  control_drone: { rate: 45, burst: 90 },
  shoot:         { rate: 25, burst: 30 },
  default:       { rate: 10, burst: 20 }
});

export class RateLimiter {
  constructor(limits = SOCKET_LIMITS, now = () => performance.now()) {
    this.limits = limits;
    this.now = now;
    this.buckets = new Map();
  }

  /** true = process this event, false = drop it */
  allow(event) {
    const rule = this.limits[event] || this.limits.default;
    const t = this.now();
    let bucket = this.buckets.get(event);
    if (!bucket) {
      bucket = { tokens: rule.burst, last: t };
      this.buckets.set(event, bucket);
    }
    bucket.tokens = Math.min(rule.burst, bucket.tokens + ((t - bucket.last) / 1000) * rule.rate);
    bucket.last = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
