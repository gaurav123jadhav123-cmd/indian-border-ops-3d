const express = require('express');
const { getLeaderboard, recordMatchResult, getRecentMatches } = require('../data/store');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    leaderboard: getLeaderboard(20),
    recentMatches: getRecentMatches()
  });
});

router.post('/match', (req, res) => {
  try {
    const { winnerTeam, players, mode } = req.body || {};
    recordMatchResult({ winnerTeam, players, mode });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
