// The complete API as data: [{ method, path, limit?, handler({ body, query, headers, ip, services }) }]
import { metaRoutes } from './meta.js';
import { authRoutes } from './auth.js';
import { loadoutRoutes } from './loadout.js';
import { leaderboardRoutes } from './leaderboard.js';

export const routes = [...metaRoutes, ...authRoutes, ...loadoutRoutes, ...leaderboardRoutes];
