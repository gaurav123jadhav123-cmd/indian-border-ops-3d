// Login tokens. They are signed (HMAC-SHA256) with SHARED_SECRET, which the game server also knows,
// so the game server can trust "who is this player" without calling the backend.
import crypto from 'node:crypto';
import { signToken, verifyToken } from '../shared/token.js';

export function createSessions({ secret, userTtlMs, guestTtlMs, now = Date.now }) {
  return {
    issueUser(user) {
      return signToken({ sub: user.id, name: user.callsign, guest: false, role: 'user' }, secret, userTtlMs, now());
    },
    issueGuest(callsign) {
      const sub = `g_${crypto.randomBytes(8).toString('hex')}`;
      return { sub, token: signToken({ sub, name: callsign, guest: true, role: 'user' }, secret, guestTtlMs, now()) };
    },
    /** Claims of a valid token, or null. */
    verify(token) {
      return verifyToken(token, secret, now());
    }
  };
}
