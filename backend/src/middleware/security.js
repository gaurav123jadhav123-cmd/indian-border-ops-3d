// Basic hardening headers and the final error handler. Plain (req, res, next) functions.
const silent = { info() {}, warn() {}, error() {} };

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
}

export function errorHandler(log = silent) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'That request was not valid JSON.' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'That request is too large.' });
    }
    const clientError = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
    if (!clientError) log.error('unhandled error', err);
    return res
      .status(clientError ? err.status : 500)
      .json({ error: clientError ? 'Bad request.' : 'Something went wrong on our side.' });
  };
}
