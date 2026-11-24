const express = require('express');
const { loginUser, registerUser, getUserByToken, sanitizeUser } = require('../data/store');

const router = express.Router();

router.post('/login', (req, res) => {
  try {
    const { callsign, password } = req.body || {};
    if (!callsign) return res.status(400).json({ error: 'Callsign is required.' });
    const result = loginUser(callsign, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/register', (req, res) => {
  try {
    const { callsign, password } = req.body || {};
    if (!callsign) return res.status(400).json({ error: 'Callsign is required.' });
    const result = registerUser(callsign, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user: sanitizeUser(user) });
});

module.exports = router;
