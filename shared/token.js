// SHARED SOURCE FILE: edit /shared/token.js, then run `npm run sync`.
// Identical copies live in backend/src/shared/ and server/src/shared/.
//
// Tiny signed-token helper (HMAC-SHA256). The backend signs login tokens, and the game
// server checks them with the same SHARED_SECRET, so nobody can join a match as
// somebody else's callsign. Format: base64url(json).base64url(hmac)

import crypto from 'node:crypto';

const b64u = (data) => Buffer.from(data).toString('base64url');

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest();
}

export function signToken(payload, secret, ttlMs, now = Date.now()) {
  if (!secret) throw new Error('signToken: secret is required');
  const body = b64u(JSON.stringify({ ...payload, exp: now + ttlMs }));
  return `${body}.${b64u(sign(body, secret))}`;
}

/** Returns the payload object, or null for anything invalid, tampered with or expired. */
export function verifyToken(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;

  const expected = sign(body, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || typeof payload.exp !== 'number') return null;
  if (payload.exp < now) return null;
  return payload;
}
