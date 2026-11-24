const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'db.json');

const DEFAULT_LOADOUT = {
  primary: 'sig716',
  secondary: 'pistol9mm',
  launcher: 'carlGustaf',
  tactical: 'smoke',
  lethal: 'frag'
};

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load db.json, initializing fresh store:', err.message);
  }
  return { users: {}, sessions: {}, matches: [] };
}

let db = loadDb();

function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Failed to persist db.json:', err.message);
  }
}

function hashPassword(password, salt = crypto.randomBytes(8).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, key] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
}

function registerUser(callsign, password) {
  const key = callsign.trim().toLowerCase();
  if (!key || key.length < 2 || key.length > 20) {
    throw new Error('Callsign must be 2-20 characters.');
  }
  if (db.users[key]) {
    throw new Error('Callsign already registered.');
  }
  const user = {
    id: crypto.randomUUID(),
    callsign: callsign.trim(),
    passwordHash: hashPassword(password || 'borderops'),
    loadout: { ...DEFAULT_LOADOUT },
    stats: { kills: 0, deaths: 0, wins: 0, matchesPlayed: 0, score: 0 },
    createdAt: new Date().toISOString()
  };
  db.users[key] = user;
  const token = createSession(user.callsign);
  saveDb();
  return { token, user: sanitizeUser(user) };
}

function loginUser(callsign, password) {
  const key = callsign.trim().toLowerCase();
  const user = db.users[key];
  if (!user) {
    return registerUser(callsign, password);
  }
  if (password && !verifyPassword(password, user.passwordHash)) {
    throw new Error('Invalid password for existing callsign.');
  }
  const token = createSession(user.callsign);
  saveDb();
  return { token, user: sanitizeUser(user) };
}

function createSession(callsign) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { callsign, createdAt: Date.now() };
  return token;
}

function getUserByToken(token) {
  if (!token || !db.sessions[token]) return null;
  const key = db.sessions[token].callsign.toLowerCase();
  return db.users[key] || null;
}

function updateLoadout(callsign, loadout) {
  const key = callsign.toLowerCase();
  if (!db.users[key]) throw new Error('User not found.');
  db.users[key].loadout = { ...db.users[key].loadout, ...loadout };
  saveDb();
  return db.users[key].loadout;
}

function recordMatchResult({ winnerTeam, players = [], mode = 'TDM' }) {
  db.matches.unshift({
    id: crypto.randomUUID(),
    mode,
    winnerTeam,
    players,
    endedAt: new Date().toISOString()
  });
  if (db.matches.length > 50) db.matches.length = 50;

  for (const p of players) {
    const key = (p.callsign || '').toLowerCase();
    const user = db.users[key];
    if (user) {
      user.stats.kills += p.kills || 0;
      user.stats.deaths += p.deaths || 0;
      user.stats.matchesPlayed += 1;
      user.stats.score += (p.kills || 0) * 100 + (p.team === winnerTeam ? 250 : 0);
      if (p.team === winnerTeam) user.stats.wins += 1;
    }
  }
  saveDb();
}

function getLeaderboard(limit = 20) {
  return Object.values(db.users)
    .map(sanitizeUser)
    .sort((a, b) => b.stats.score - a.stats.score || b.stats.kills - a.stats.kills)
    .slice(0, limit);
}

function sanitizeUser(u) {
  return {
    id: u.id,
    callsign: u.callsign,
    loadout: u.loadout,
    stats: u.stats
  };
}

module.exports = {
  DEFAULT_LOADOUT,
  registerUser,
  loginUser,
  getUserByToken,
  updateLoadout,
  recordMatchResult,
  getLeaderboard,
  sanitizeUser,
  getRecentMatches: () => db.matches.slice(0, 15)
};
