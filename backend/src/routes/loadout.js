// Weapon loadouts. Rules (which weapon fits which slot, air-drop guns excluded) come from the
// shared arsenal, so the lobby, this API and the game server can never disagree.
import { DEFAULT_LOADOUT, validateLoadoutPatch } from '../shared/arsenal.js';
import { badRequest } from '../errors.js';
import { requireClaims, requireUser } from './guards.js';

export const loadoutRoutes = [
  {
    method: 'GET',
    path: '/api/loadout',
    limit: 'read',
    handler: async (ctx) => {
      const claims = requireClaims(ctx);
      if (claims.guest) return { body: { loadout: { ...DEFAULT_LOADOUT } } };
      const user = requireUser(ctx);
      return { body: { loadout: { ...user.loadout } } };
    }
  },
  {
    method: 'POST',
    path: '/api/loadout/save',
    limit: 'write',
    handler: async (ctx) => {
      const user = requireUser(ctx); // guests get "Create an account to use this feature."
      const { patch, error } = validateLoadoutPatch(ctx.body);
      if (error) throw badRequest(error);
      return { body: { loadout: ctx.services.store.updateLoadout(user, patch) } };
    }
  }
];
