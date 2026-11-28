// Environment configuration for the REST backend.
//   PORT           port to listen on (default 4000)
//   SHARED_SECRET  MUST be identical on backend and game server (required when NODE_ENV=production)
//   DATA_DIR       where db.json is stored (default backend/data)
//   CORS_ORIGIN    comma separated list of allowed website origins, or * (default *)
//   TRUST_PROXY    set to 1 behind Render / Railway / nginx so rate limits see the real client IP
//   SERVE_FRONTEND set to 0 to stop this server from also serving ../frontend (default: serve it)
//   FRONTEND_DIR   override the folder that is served
//   TOKEN_TTL_DAYS how long a login stays valid (default 7)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..');

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function parseOrigins(value) {
  if (!value || value.trim() === '*') return '*';
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback"
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const usingDevSecret = !env.SHARED_SECRET;
  if (usingDevSecret && production) {
    throw new Error(
      'SHARED_SECRET is not set. Set the SAME long random value on the backend and the game server ' +
      '(for example: SHARED_SECRET=$(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")).'
    );
  }
  return {
    production,
    port: toInt(env.PORT, 4000),
    secret: env.SHARED_SECRET || 'dev-only-secret-change-me',
    usingDevSecret,
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(BACKEND_ROOT, 'data'),
    corsOrigins: parseOrigins(env.CORS_ORIGIN),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    serveFrontend: env.SERVE_FRONTEND !== '0',
    frontendDir: env.FRONTEND_DIR ? path.resolve(env.FRONTEND_DIR) : path.resolve(BACKEND_ROOT, '..', 'frontend'),
    userTokenTtlMs: toInt(env.TOKEN_TTL_DAYS, 7) * 24 * 60 * 60 * 1000,
    guestTokenTtlMs: 12 * 60 * 60 * 1000
  };
}
