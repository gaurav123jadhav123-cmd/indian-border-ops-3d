// Validation of the match report the game server posts when a match ends.
// The endpoint is already restricted to the game server (service token); this adds belt and braces:
// every number is clamped, every string is capped and unknown fields are dropped.
import { badRequest } from '../errors.js';

export const REPORT_LIMITS = Object.freeze({ players: 40, kills: 100, deaths: 200, durationSec: 86400 });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : min);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const TEAMS = ['bharat', 'opfor', 'ffa'];

export function validateReport(raw) {
  if (!isObj(raw)) throw badRequest('The match report must be an object.');
  if (typeof raw.matchId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.matchId)) throw badRequest('Invalid matchId.');
  if (raw.mode !== 'TDM' && raw.mode !== 'FFA') throw badRequest('Invalid mode.');
  if (!Array.isArray(raw.players) || raw.players.length > REPORT_LIMITS.players) throw badRequest('Invalid players list.');

  const players = raw.players.filter(isObj).map((p) => {
    const kills = int(p.kills, 0, REPORT_LIMITS.kills);
    return {
      id: str(p.id, 24),
      callsign: str(p.callsign, 18),
      team: TEAMS.includes(p.team) ? p.team : 'ffa',
      kills,
      deaths: int(p.deaths, 0, REPORT_LIMITS.deaths),
      headshots: Math.min(kills, int(p.headshots, 0, REPORT_LIMITS.kills)),
      present: p.present !== false,
      userId: typeof p.userId === 'string' && p.userId.length > 0 && p.userId.length <= 64 ? p.userId : null
    };
  });

  const endedAtMs = Date.parse(raw.endedAt);
  return {
    matchId: raw.matchId,
    roomId: str(raw.roomId, 24),
    mode: raw.mode,
    reason: str(raw.reason, 16),
    durationSec: int(raw.durationSec, 0, REPORT_LIMITS.durationSec),
    draw: raw.draw === true,
    winnerTeam: raw.winnerTeam === 'bharat' || raw.winnerTeam === 'opfor' ? raw.winnerTeam : null,
    winnerId: typeof raw.winnerId === 'string' ? raw.winnerId.slice(0, 24) : null,
    winnerCallsign: str(raw.winnerCallsign, 18) || null,
    scores: isObj(raw.scores) ? { bharat: int(raw.scores.bharat, 0, 1000), opfor: int(raw.scores.opfor, 0, 1000) } : null,
    endedAt: Number.isFinite(endedAtMs) ? new Date(endedAtMs).toISOString() : new Date().toISOString(),
    players
  };
}

/** Did this player win? (draws have no winners) */
export function playerWon(report, player) {
  if (report.draw) return false;
  if (report.mode === 'TDM') return report.winnerTeam !== null && player.team === report.winnerTeam;
  return report.winnerId !== null && player.id === report.winnerId;
}
