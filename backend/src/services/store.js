// The player database: one JSON file, kept in memory, saved safely.
//  - writes are debounced and atomic (temp file + rename), so a crash never leaves half a file
//  - a corrupt file is moved aside (never silently deleted) and a fresh database starts
//  - users live in Maps, so a callsign such as "__proto__" is just a name, never a prototype
//  - the original version's db.json (object keyed by callsign, "salt:hash" passwords) still loads
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_LOADOUT, sanitizeLoadout } from '../shared/arsenal.js';
import { conflict } from '../errors.js';
import { playerWon } from './matches.js';

const silent = { info() {}, warn() {}, error() {} };
const DB_VERSION = 2;
export const MAX_RECENT_MATCHES = 50;
const MAX_SEEN_IDS = 500;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const callsignKey = (callsign) => String(callsign).trim().toLowerCase();
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

const emptyStats = () => ({ kills: 0, deaths: 0, headshots: 0, wins: 0, matchesPlayed: 0, score: 0 });

function normalizeUser(u) {
  if (!isObj(u) || typeof u.callsign !== 'string' || !u.callsign.trim() || typeof u.passwordHash !== 'string') return null;
  const s = isObj(u.stats) ? u.stats : {};
  return {
    id: typeof u.id === 'string' && u.id ? u.id : crypto.randomUUID(),
    callsign: u.callsign.trim().slice(0, 20),
    passwordHash: u.passwordHash,
    loadout: sanitizeLoadout(u.loadout),
    stats: {
      kills: num(s.kills), deaths: num(s.deaths), headshots: num(s.headshots),
      wins: num(s.wins), matchesPlayed: num(s.matchesPlayed), score: num(s.score)
    },
    createdAt: typeof u.createdAt === 'string' ? u.createdAt : new Date().toISOString()
  };
}

export class Store {
  constructor({ dir, fileName = 'db.json', saveDelayMs = 300, log = silent, now = Date.now } = {}) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.saveDelayMs = saveDelayMs;
    this.log = log;
    this.now = now;
    this.byCallsign = new Map();
    this.byId = new Map();
    this.matches = [];
    this.seen = [];
    this.timer = null;
    this.dirty = false;
    this.writing = Promise.resolve();
  }

  // ------------------------------------------------------------------ loading
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) return this;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!isObj(raw)) throw new Error('the file does not contain an object');
    } catch (err) {
      const backup = `${this.file}.corrupt-${this.now()}`;
      try { fs.renameSync(this.file, backup); } catch { /* nothing more we can do */ }
      this.log.warn(`db.json could not be read (${err.message}). It was kept as ${path.basename(backup)} and a fresh database is used.`);
      return this;
    }

    const list = Array.isArray(raw.users) ? raw.users : isObj(raw.users) ? Object.values(raw.users) : [];
    for (const entry of list) {
      const user = normalizeUser(entry);
      if (!user) continue;
      this.byCallsign.set(callsignKey(user.callsign), user);
      this.byId.set(user.id, user);
    }
    this.matches = Array.isArray(raw.matches) ? raw.matches.filter(isObj).slice(0, MAX_RECENT_MATCHES) : [];
    this.seen = Array.isArray(raw.seen) ? raw.seen.filter((s) => typeof s === 'string').slice(-MAX_SEEN_IDS) : [];
    return this;
  }

  // ------------------------------------------------------------------- saving
  snapshot() {
    return { version: DB_VERSION, users: Array.from(this.byId.values()), matches: this.matches, seen: this.seen };
  }

  scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.saveDelayMs);
    this.timer.unref?.();
  }

  /** Write now (also used on shutdown). Never rejects, writes never overlap. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const tmp = `${this.file}.tmp-${process.pid}`;
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(this.snapshot()));
        await fs.promises.rename(tmp, this.file);
      } catch (err) {
        this.dirty = true; // keep the data and try again with the next change
        this.log.error(`could not save the database: ${err.message}`);
      }
    });
    return this.writing;
  }

  // -------------------------------------------------------------------- users
  findByCallsign(callsign) {
    return typeof callsign === 'string' ? this.byCallsign.get(callsignKey(callsign)) ?? null : null;
  }

  findById(id) {
    return typeof id === 'string' ? this.byId.get(id) ?? null : null;
  }

  createUser({ callsign, passwordHash }) {
    const key = callsignKey(callsign);
    if (this.byCallsign.has(key)) throw conflict('That callsign is already registered.');
    const user = {
      id: crypto.randomUUID(),
      callsign,
      passwordHash,
      loadout: { ...DEFAULT_LOADOUT },
      stats: emptyStats(),
      createdAt: new Date(this.now()).toISOString()
    };
    this.byCallsign.set(key, user);
    this.byId.set(user.id, user);
    this.scheduleSave();
    return user;
  }

  setPasswordHash(user, passwordHash) {
    user.passwordHash = passwordHash;
    this.scheduleSave();
  }

  updateLoadout(user, patch) {
    user.loadout = sanitizeLoadout({ ...user.loadout, ...patch });
    this.scheduleSave();
    return { ...user.loadout };
  }

  // ------------------------------------------------------------------ matches
  /** Apply a validated match report. Reporting the same matchId twice changes nothing. */
  recordMatch(report) {
    if (this.seen.includes(report.matchId)) return { recorded: false, duplicate: true, updated: 0 };
    this.seen.push(report.matchId);
    if (this.seen.length > MAX_SEEN_IDS) this.seen.shift();

    let updated = 0;
    for (const p of report.players) {
      if (!p.userId) continue; // guests have no account to credit
      const user = this.byId.get(p.userId);
      if (!user || !(p.kills + p.deaths > 0 || p.present)) continue;
      const won = playerWon(report, p);
      user.stats.kills += p.kills;
      user.stats.deaths += p.deaths;
      user.stats.headshots += p.headshots;
      user.stats.matchesPlayed += 1;
      user.stats.wins += won ? 1 : 0;
      user.stats.score += p.kills * 100 + (won ? 250 : 0);
      updated += 1;
    }

    this.matches.unshift({
      id: report.matchId,
      mode: report.mode,
      draw: report.draw,
      winnerTeam: report.winnerTeam,
      winnerCallsign: report.winnerCallsign,
      scores: report.scores,
      durationSec: report.durationSec,
      endedAt: report.endedAt,
      players: report.players.map((p) => ({ callsign: p.callsign, team: p.team, kills: p.kills, deaths: p.deaths }))
    });
    if (this.matches.length > MAX_RECENT_MATCHES) this.matches.length = MAX_RECENT_MATCHES;

    this.scheduleSave();
    return { recorded: true, duplicate: false, updated };
  }

  leaderboard(limit = 20) {
    return Array.from(this.byId.values())
      .filter((u) => u.stats.matchesPlayed > 0)
      .sort((a, b) =>
        b.stats.score - a.stats.score || b.stats.kills - a.stats.kills || a.callsign.localeCompare(b.callsign))
      .slice(0, limit)
      .map((u, i) => ({ rank: i + 1, callsign: u.callsign, stats: { ...u.stats } }));
  }

  recentMatches(limit = 15) {
    return this.matches.slice(0, limit).map((m) => ({
      id: m.id,
      mode: m.mode ?? 'TDM',
      draw: !!m.draw,
      winnerTeam: m.winnerTeam ?? null,
      winnerCallsign: m.winnerCallsign ?? null,
      scores: m.scores ?? null,
      endedAt: m.endedAt ?? null,
      players: Array.isArray(m.players)
        ? m.players.map((p) => ({ callsign: String(p.callsign ?? ''), team: p.team ?? '', kills: num(p.kills), deaths: num(p.deaths) }))
        : []
    }));
  }

  counts() {
    return { users: this.byId.size, matches: this.matches.length };
  }
}
