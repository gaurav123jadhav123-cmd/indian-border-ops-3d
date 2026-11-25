const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'db.json');
const TMP_PATH = path.join(__dirname, 'db.json.tmp');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const DEFAULT_LOADOUT = {
  primary: 'sig716',
  secondary: 'pistol9mm',
  launcher: 'carlGustaf',
  tactical: 'smoke',
  lethal: 'frag'
};

const RANKS = [
  { minScore: 0, title: 'Sepoy' },
  { minScore: 500, title: 'Naik' },
  { minScore: 1500, title: 'Havildar' },
  { minScore: 3000, title: 'Subedar' },
  { minScore: 6000, title: 'Captain' },
  { minScore: 10000, title: 'Major' },
  { minScore: 18000, title: 'Colonel' },
  { minScore: 30000, title: 'Brigadier' }
];

function getRankTitle(score) {
  let title = RANKS[0].title;
  for (const r of RANKS) {
    if (score >= r.minScore) title = r.title;
  }
  return title;
}

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
    fs.writeFileSync(TMP_PATH, JSON.stringify(db, null, 2));
    fs.renameSync(TMP_PATH, DB_PATH);
  } catch (err) {
    console.error('Failed to persist db.json:', err.message);
  }
}

function pruneExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, sess] of Object.entries(db.sessions)) {
    if (!sess || now - sess.createdAt > SESSION_TTL_MS) {
      delete db.sessions[token];
      changed = true;
    }
  }
  if (changed) saveDb();
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
  const clean = String(callsign || '').trim();
  const key = clean.toLowerCase();
  if (!/^[a-zA-Z0-9_-]{2,20}$/.test(clean)) {
    throw new Error('Callsign must be 2-20 characters (letters, numbers, _ or -).');
  }
  if (db.users[key]) {
    throw new Error('Callsign already registered.');
  }
  const user = {
    id: crypto.randomUUID(),
    callsign: clean,
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
  const clean = String(callsign || '').trim();
  const key = clean.toLowerCase();
  const user = db.users[key];
  if (!user) {
    return registerUser(clean, password);
  }
  if (password && !verifyPassword(password, user.passwordHash)) {
    throw new Error('Invalid password for existing callsign.');
  }
  const token = createSession(user.callsign);
  saveDb();
  return { token, user: sanitizeUser(user) };
}

function createSession(callsign) {
  pruneExpiredSessions();
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { callsign, createdAt: Date.now() };
  return token;
}

function getUserByToken(token) {
  if (!token || !db.sessions[token]) return null;
  const sess = db.sessions[token];
  if (Date.now() - sess.createdAt > SESSION_TTL_MS) {
    delete db.sessions[token];
    saveDb();
    return null;
  }
  return db.users[sess.callsign.toLowerCase()] || null;
}

function updateLoadout(callsign, loadout) {
  const key = callsign.toLowerCase();
  if (!db.users[key]) throw new Error('User not found.');
  db.users[key].loadout = { ...db.users[key].loadout, ...loadout };
  saveDb();
  return db.users[key].loadout;
}

function recordMatchResult({ winnerTeam, players = [], mode = 'TDM', scores = {} }) {
  db.matches.unshift({
    id: crypto.randomUUID(),
    mode,
    winnerTeam,
    scores,
    players,
    endedAt: new Date().toISOString()
  });
  if (db.matches.length > 50) db.matches.length = 50;

  for (const p of players) {
    const key = String(p.callsign || '').toLowerCase();
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
  const kd = u.stats.deaths > 0 ? Number((u.stats.kills / u.stats.deaths).toFixed(2)) : u.stats.kills;
  return {
    id: u.id,
    callsign: u.callsign,
    rank: getRankTitle(u.stats.score),
    loadout: u.loadout,
    stats: { ...u.stats, kd }
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
  getUserCount: () => Object.keys(db.users).length,
  getRecentMatches: () => db.matches.slice(0, 15)
};
