// Sends the finished-match summary to the REST backend, signed with a short-lived service token.
import { signToken } from '../shared/token.js';

const silent = { info() {}, warn() {}, error() {} };
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createReporter({
  backendUrl,
  secret,
  fetchFn = globalThis.fetch,
  log = silent,
  attempts = 4,
  baseDelayMs = 1000,
  sleep = defaultSleep
}) {
  /** Resolves true when the backend accepted the report. Never throws. */
  return async function reportMatch(report) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const token = signToken({ role: 'server' }, secret, 5 * 60 * 1000);
        const res = await fetchFn(`${backendUrl}/api/leaderboard/match`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) return true;
        if (res.status >= 400 && res.status < 500) {
          log.warn(`backend rejected match ${report.matchId} (HTTP ${res.status}); not retrying`);
          return false; // our request is wrong, retrying cannot help
        }
        log.warn(`backend answered HTTP ${res.status} for match ${report.matchId}`);
      } catch (err) {
        log.warn(`could not reach backend for match ${report.matchId}: ${err.message}`);
      }
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    return false;
  };
}
