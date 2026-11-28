// Everything the route handlers need, created once at startup (and easy to fake in tests).
import { createSessions } from './session.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const silent = { info() {}, warn() {}, error() {} };

export function createServices({ config, store, log = silent, now = Date.now }) {
  return {
    config,
    store,
    log,
    now,
    sessions: createSessions({
      secret: config.secret,
      userTtlMs: config.userTokenTtlMs,
      guestTtlMs: config.guestTokenTtlMs,
      now
    }),
    // per client IP, per minute
    limits: {
      auth: createRateLimiter({ windowMs: 60_000, max: 12, now }),   // login + register: password guessing
      guest: createRateLimiter({ windowMs: 60_000, max: 30, now }),
      write: createRateLimiter({ windowMs: 60_000, max: 30, now }),
      read: createRateLimiter({ windowMs: 60_000, max: 120, now })
    }
  };
}
