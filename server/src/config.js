// Environment configuration for the game server.
//   PORT           port to listen on (default 5000)
//   BACKEND_URL    where the REST backend lives (default http://localhost:4000)
//   SHARED_SECRET  MUST be identical on backend and server (required when NODE_ENV=production)
//   CORS_ORIGIN    comma separated list of allowed website origins, or * (default *)
//   MAX_ROOMS      maximum simultaneous matches (default 20)
//   ROOM_CAPACITY  maximum players per match (default 12)

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function parseOrigins(value) {
  if (!value || value.trim() === '*') return '*';
  return value.split(',').map((s) => s.trim()).filter(Boolean);
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
    port: toInt(env.PORT, 5000),
    backendUrl: (env.BACKEND_URL || 'http://localhost:4000').replace(/\/+$/, ''),
    secret: env.SHARED_SECRET || 'dev-only-secret-change-me',
    usingDevSecret,
    corsOrigins: parseOrigins(env.CORS_ORIGIN),
    maxRooms: toInt(env.MAX_ROOMS, 20),
    roomCapacity: toInt(env.ROOM_CAPACITY, 12)
  };
}
