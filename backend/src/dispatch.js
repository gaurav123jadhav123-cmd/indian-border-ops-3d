// Turns the declarative route table into one function: dispatch(method, path, request) -> response.
// It never throws and knows nothing about Express, so every route is testable without a server.
// (app.js is the only file that connects it to Express.)
import { HttpError } from './errors.js';

const silent = { info() {}, warn() {}, error() {} };

export function createDispatcher({ routes, services }) {
  const table = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
  const log = services.log ?? silent;

  /**
   * request: { body, query, headers, ip }
   * returns: { status, body, headers? }
   */
  return async function dispatch(method, path, request = {}) {
    const route = table.get(`${method.toUpperCase()} ${path}`);
    if (!route) return { status: 404, body: { error: 'Not found.' } };

    try {
      if (route.limit) {
        const verdict = services.limits[route.limit].check(request.ip);
        if (!verdict.ok) {
          return {
            status: 429,
            headers: { 'Retry-After': String(verdict.retryAfterSec) },
            body: { error: `Too many attempts. Please wait ${verdict.retryAfterSec}s and try again.` }
          };
        }
      }
      const out = await route.handler({
        body: request.body ?? {},
        query: request.query ?? {},
        headers: request.headers ?? {},
        ip: request.ip,
        services
      });
      return { status: out.status ?? 200, headers: out.headers, body: out.body };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
      log.error(`route ${method} ${path} failed`, err);
      return { status: 500, body: { error: 'Something went wrong on our side.' } };
    }
  };
}
