// Password hashing with scrypt (async, so a login never blocks the event loop).
//   new format:    s1$<salt hex>$<hash hex>
//   legacy format: <salt hex>:<hash hex>   (written by the first version of the game; still accepted,
//                                           and upgraded to the new format on the next successful login)
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 32;

export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 128; // scrypt costs CPU: never hash megabytes

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `s1$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || password.length > MAX_PASSWORD) return false;

  let salt;
  let expectedHex;
  if (stored.startsWith('s1$')) [, salt, expectedHex] = stored.split('$');
  else [salt, expectedHex] = stored.split(':');

  if (!salt || !expectedHex || !/^[0-9a-f]+$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  // An empty or truncated stored hash must never match anything.
  if (expected.length !== KEY_LENGTH) return false;

  const derived = await scrypt(password, salt, KEY_LENGTH);
  return crypto.timingSafeEqual(derived, expected);
}

export const needsRehash = (stored) => typeof stored === 'string' && !stored.startsWith('s1$');

let dummy = null;
/**
 * Burn the same CPU time as a real check. Used when the callsign does not exist, so that response
 * time does not reveal which callsigns are registered.
 */
export async function burnPasswordCheck(password) {
  dummy ??= await hashPassword('not-a-real-password');
  await verifyPassword(typeof password === 'string' ? password : '', dummy);
}
