const express = require('express');
const { ARSENAL, HEALING_ITEMS } = require('../data/arsenal');
const { getUserByToken, updateLoadout } = require('../data/store');

const router = express.Router();

router.get('/arsenal', (req, res) => {
  res.json({ weapons: ARSENAL, healing: HEALING_ITEMS });
});

router.post('/save', (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { primary, secondary, launcher } = req.body || {};
    if (primary && !ARSENAL[primary]) return res.status(400).json({ error: 'Invalid primary weapon.' });
    if (secondary && !ARSENAL[secondary]) return res.status(400).json({ error: 'Invalid secondary weapon.' });
    if (launcher && !ARSENAL[launcher]) return res.status(400).json({ error: 'Invalid launcher.' });

    const updated = updateLoadout(user.callsign, { primary, secondary, launcher });
    res.json({ loadout: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
