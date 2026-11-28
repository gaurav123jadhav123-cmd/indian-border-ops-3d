// Public leaderboard + the game server's end-of-match report.
import { validateReport } from '../services/matches.js';
import { requireService } from './guards.js';

export const leaderboardRoutes = [
  {
    method: 'GET',
    path: '/api/leaderboard',
    limit: 'read',
    handler: async ({ services }) => ({
      body: {
        leaderboard: services.store.leaderboard(20),
        recentMatches: services.store.recentMatches(15)
      }
    })
  },
  {
    // Only the game server may report results (it signs a short-lived service token).
    method: 'POST',
    path: '/api/leaderboard/match',
    handler: async (ctx) => {
      requireService(ctx);
      const report = validateReport(ctx.body);
      const result = ctx.services.store.recordMatch(report);
      return { body: { ok: true, ...result } };
    }
  }
];
