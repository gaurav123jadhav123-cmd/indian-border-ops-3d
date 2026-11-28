// Authentication helpers shared by the route handlers.
import { unauthorized, forbidden } from '../errors.js';

export function bearerToken(headers) {
  const header = headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

/** Claims of a valid player token (guest or registered). The game server's service token is refused. */
export function requireClaims(ctx) {
  const token = bearerToken(ctx.headers);
  const claims = token ? ctx.services.sessions.verify(token) : null;
  if (!claims || claims.role === 'server' || typeof claims.sub !== 'string') {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
  return claims;
}

/** The registered account behind the token. Guests get a polite 403. */
export function requireUser(ctx) {
  const claims = requireClaims(ctx);
  if (claims.guest) throw forbidden('Create an account to use this feature.');
  const user = ctx.services.store.findById(claims.sub);
  if (!user) throw unauthorized('This account no longer exists. Please sign in again.');
  return user;
}

/** Only the game server (service token) may pass. */
export function requireService(ctx) {
  const token = bearerToken(ctx.headers);
  const claims = token ? ctx.services.sessions.verify(token) : null;
  if (!claims || claims.role !== 'server') throw unauthorized('Only the game server may do this.');
}
