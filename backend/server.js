const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const loadoutRoutes = require('./routes/loadout');
const leaderboardRoutes = require('./routes/leaderboard');
const { ARSENAL, HEALING_ITEMS } = require('./data/arsenal');
const { getUserCount } = require('./data/store');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Lightweight In-Memory Rate Limiter for Auth Endpoints
const rateBuckets = new Map();
function authRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60000;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > 40) {
    return res.status(429).json({ error: 'Too many requests, please wait a moment.' });
  }
  next();
}

// REST API Endpoints
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'indian-border-ops-backend',
    registeredOperators: getUserCount(),
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/arsenal', (req, res) => {
  res.json({ weapons: ARSENAL, healing: HEALING_ITEMS });
});

app.use('/api/auth', authRateLimit, authRoutes);
app.use('/api/loadout', loadoutRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// Serve Frontend Static Files with No-Cache on HTML/JS so mobile browsers always get latest updates
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
  }
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(frontendDir, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Backend API] Running on http://localhost:${PORT}`);
  });
}

module.exports = { app };
