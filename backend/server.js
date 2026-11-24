const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const loadoutRoutes = require('./routes/loadout');
const leaderboardRoutes = require('./routes/leaderboard');
const { ARSENAL, HEALING_ITEMS } = require('./data/arsenal');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// REST API Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'indian-border-ops-backend', timestamp: new Date().toISOString() });
});

app.get('/api/arsenal', (req, res) => {
  res.json({ weapons: ARSENAL, healing: HEALING_ITEMS });
});

app.use('/api/auth', authRoutes);
app.use('/api/loadout', loadoutRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// Serve Frontend Static Files (for unified local play)
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[Backend API] Running on http://localhost:${PORT}`);
});
