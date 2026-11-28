// Connects the route table to Express. Express and cors are passed in (index.js imports them), so the
// rest of the backend - and this file - can be tested without them installed.
import { createDispatcher } from './dispatch.js';
import { securityHeaders, errorHandler } from './middleware/security.js';

const silent = { info() {}, warn() {}, error() {} };

/** One Express handler per route; all the real work is in dispatch(), which never throws. */
export function expressHandler(dispatch, route) {
  return async (req, res) => {
    const out = await dispatch(route.method, route.path, {
      body: req.body,
      query: req.query,
      headers: req.headers,
      ip: req.ip
    });
    if (out.headers) res.set(out.headers);
    res.status(out.status).json(out.body);
  };
}

export function createApp({ express, cors, routes, services, config, log = silent }) {
  const dispatch = createDispatcher({ routes, services });
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(cors({ origin: config.corsOrigins }));
  app.use(securityHeaders);
  app.use('/api', express.json({ limit: '16kb' }));

  for (const route of routes) {
    app[route.method.toLowerCase()](route.path, expressHandler(dispatch, route));
  }
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // Convenient for phone / local play: the same server also hosts the game page.
  if (config.serveFrontend && config.frontendDir) {
    app.use(express.static(config.frontendDir, { maxAge: '5m' }));
  }

  app.use(errorHandler(log));
  return app;
}
