// A small in-memory fixed-window rate limiter (per client IP). Enough to stop password guessing and
// request floods on a single server; for several servers behind a balancer use an edge limiter.
export function createRateLimiter({ windowMs, max, now = Date.now, maxKeys = 20000 }) {
  const hits = new Map(); // key -> { count, resetAt }

  function prune(t) {
    for (const [key, h] of hits) if (t >= h.resetAt) hits.delete(key);
    if (hits.size > maxKeys) hits.clear(); // under a flood of unique IPs, forget rather than grow forever
  }

  return {
    /** { ok: true } or { ok: false, retryAfterSec } */
    check(key = 'unknown') {
      const t = now();
      if (hits.size > maxKeys / 2) prune(t);
      let h = hits.get(key);
      if (!h || t >= h.resetAt) {
        h = { count: 0, resetAt: t + windowMs };
        hits.set(key, h);
      }
      h.count += 1;
      if (h.count > max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((h.resetAt - t) / 1000)) };
      return { ok: true, retryAfterSec: 0 };
    },
    reset() {
      hits.clear();
    }
  };
}
