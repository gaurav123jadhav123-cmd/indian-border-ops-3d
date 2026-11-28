// REST client for the backend. `fetchFn` is injectable so it can be tested without a network.

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function createApi({ baseUrl, fetchFn = (...args) => globalThis.fetch(...args), timeoutMs = 8000 }) {
  const base = baseUrl.replace(/\/+$/, '');

  async function request(method, path, { body, token } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (err) {
      throw new ApiError(
        err?.name === 'AbortError'
          ? 'The server took too long to answer. Please try again.'
          : 'Cannot reach the server. Check that the backend is running and the address is right.'
      );
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = await res.json();
    } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError(data?.error || `The server answered with an error (${res.status}).`, res.status);
    return data ?? {};
  }

  return {
    guest: (callsign) => request('POST', '/api/auth/guest', { body: { callsign } }),
    register: (callsign, password) => request('POST', '/api/auth/register', { body: { callsign, password } }),
    login: (callsign, password) => request('POST', '/api/auth/login', { body: { callsign, password } }),
    me: (token) => request('GET', '/api/auth/me', { token }),
    arsenal: () => request('GET', '/api/arsenal'),
    leaderboard: () => request('GET', '/api/leaderboard'),
    saveLoadout: (token, loadout) => request('POST', '/api/loadout/save', { token, body: loadout })
  };
}
