// Accounts and guest play.
//   POST /api/auth/guest     { callsign? }            -> play at once, nothing is saved
//   POST /api/auth/register  { callsign, password }   -> create an account
//   POST /api/auth/login     { callsign, password }   -> sign in (a password is ALWAYS required)
//   GET  /api/auth/me                                 -> who am I (Bearer token)
import { DEFAULT_LOADOUT } from '../shared/arsenal.js';
import { badRequest, conflict, unauthorized } from '../errors.js';
import { hashPassword, verifyPassword, needsRehash, burnPasswordCheck, MIN_PASSWORD, MAX_PASSWORD } from '../services/passwords.js';
import { requireClaims } from './guards.js';

const CALLSIGN_RE = /^[A-Za-z0-9_.-]{2,18}$/;
const CALLSIGN_HELP = 'Callsign must be 2-18 characters: letters, numbers, dot, dash or underscore.';

const readCredentials = (body) => ({
  callsign: typeof body?.callsign === 'string' ? body.callsign.trim() : '',
  password: typeof body?.password === 'string' ? body.password : ''
});

export const publicUser = (user) => ({
  id: user.id,
  callsign: user.callsign,
  guest: false,
  loadout: { ...user.loadout },
  stats: { ...user.stats }
});

export const authRoutes = [
  {
    method: 'POST',
    path: '/api/auth/guest',
    limit: 'guest',
    handler: async ({ body, services }) => {
      const typed = typeof body?.callsign === 'string' ? body.callsign.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 18) : '';
      let callsign = typed.length >= 2 ? typed : '';
      if (callsign && services.store.findByCallsign(callsign)) {
        throw conflict('That callsign belongs to a registered player. Pick another one, or sign in.');
      }
      if (!callsign) callsign = `Guest_${Math.floor(1000 + Math.random() * 9000)}`;
      const { sub, token } = services.sessions.issueGuest(callsign);
      return {
        status: 201,
        body: { token, user: { id: sub, callsign, guest: true, loadout: { ...DEFAULT_LOADOUT }, stats: null } }
      };
    }
  },

  {
    method: 'POST',
    path: '/api/auth/register',
    limit: 'auth',
    handler: async ({ body, services }) => {
      const { callsign, password } = readCredentials(body);
      if (!CALLSIGN_RE.test(callsign)) throw badRequest(CALLSIGN_HELP);
      if (password.length < MIN_PASSWORD) throw badRequest(`Password must be at least ${MIN_PASSWORD} characters.`);
      if (password.length > MAX_PASSWORD) throw badRequest(`Password can be at most ${MAX_PASSWORD} characters.`);
      if (services.store.findByCallsign(callsign)) throw conflict('That callsign is already registered.');

      const passwordHash = await hashPassword(password);
      const user = services.store.createUser({ callsign, passwordHash }); // re-checks, in case of a race
      return { status: 201, body: { token: services.sessions.issueUser(user), user: publicUser(user) } };
    }
  },

  {
    method: 'POST',
    path: '/api/auth/login',
    limit: 'auth',
    handler: async ({ body, services }) => {
      const { callsign, password } = readCredentials(body);
      if (!callsign || !password) throw badRequest('Enter your callsign and password.');

      const user = services.store.findByCallsign(callsign);
      if (!user) {
        await burnPasswordCheck(password); // same response time as a wrong password
        throw unauthorized('Wrong callsign or password.');
      }
      if (!(await verifyPassword(password, user.passwordHash))) throw unauthorized('Wrong callsign or password.');
      if (needsRehash(user.passwordHash)) services.store.setPasswordHash(user, await hashPassword(password));

      return { body: { token: services.sessions.issueUser(user), user: publicUser(user) } };
    }
  },

  {
    method: 'GET',
    path: '/api/auth/me',
    limit: 'read',
    handler: async (ctx) => {
      const claims = requireClaims(ctx);
      if (claims.guest) {
        return {
          body: { user: { id: claims.sub, callsign: claims.name, guest: true, loadout: { ...DEFAULT_LOADOUT }, stats: null } }
        };
      }
      const user = ctx.services.store.findById(claims.sub);
      if (!user) throw unauthorized('This account no longer exists. Please sign in again.');
      return { body: { user: publicUser(user) } };
    }
  }
];
