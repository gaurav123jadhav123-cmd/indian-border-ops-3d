// Owns every running match and the single game loop that advances all of them.
import { MatchRoom } from './MatchRoom.js';
import { RULES } from '../rules.js';

const silent = { info() {}, warn() {}, error() {} };

export class RoomManager {
  constructor({
    rules = RULES,
    rng = Math.random,
    clock = () => performance.now(),
    maxRooms = rules.maxRooms,
    capacity = rules.roomCapacity,
    endedLingerMs = 20000,
    onMatchEnd = null,
    log = silent,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    this.rules = rules;
    this.rng = rng;
    this.clock = clock;
    this.maxRooms = maxRooms;
    this.capacity = capacity;
    this.endedLingerMs = endedLingerMs;
    this.onMatchEnd = onMatchEnd;
    this.log = log;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.rooms = new Map();
    this.timer = null;
  }

  get(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  /**
   * The room a joining player should go to. A finished room under the same id is replaced by a
   * fresh match, which is how "Play again" works. Returns { room } or { error }.
   */
  acquire(roomId, mode) {
    let room = this.rooms.get(roomId);
    if (room && room.ended) room = null;
    if (!room) {
      this.prune(this.clock());
      if (this.rooms.size >= this.maxRooms) {
        return { error: 'The server is busy right now. Please try again in a minute.' };
      }
      room = new MatchRoom({
        roomId,
        mode,
        rules: this.rules,
        rng: this.rng,
        clock: this.clock,
        capacity: this.capacity,
        onEnd: (report, summary) => this.matchEnded(report, summary)
      });
      this.rooms.set(roomId, room);
      this.log.info(`room ${roomId} created (${room.mode})`);
    }
    return { room };
  }

  matchEnded(report, summary) {
    this.log.info(`match ${summary.matchId} ended: ${summary.reason}`);
    if (this.onMatchEnd) {
      try { this.onMatchEnd(report, summary); } catch (err) { this.log.warn('onMatchEnd failed', err); }
    }
  }

  /** Remove rooms nobody needs any more. */
  prune(now) {
    for (const [id, room] of this.rooms) {
      const finishedLongAgo = room.ended && now - room.endedAt >= this.endedLingerMs;
      const abandoned = room.ended ? room.connectedCount() === 0 : room.isEmpty();
      if (finishedLongAgo || abandoned) {
        this.rooms.delete(id);
        this.log.info(`room ${id} removed`);
      }
    }
  }

  /** One simulation step for every room. A bug in one match cannot take the others down. */
  tick(dt, now = this.clock()) {
    for (const room of this.rooms.values()) {
      try {
        room.update(dt, now);
      } catch (err) {
        this.log.error(`room ${room.roomId} crashed, ending it`, err);
        try { room.finish('error', now); } catch { /* nothing more to do */ }
      }
    }
    this.prune(now);
  }

  /** Drift-corrected loop: steady 30Hz even when a tick runs a little late. */
  start() {
    if (this.timer) return;
    const stepMs = 1000 / this.rules.tickHz;
    let last = this.clock();
    let next = last + stepMs;
    const loop = () => {
      const now = this.clock();
      const dt = (now - last) / 1000;
      last = now;
      this.tick(dt, now);
      next += stepMs;
      if (next < now - stepMs * 5) next = now + stepMs; // far behind (suspended?): do not try to catch up
      this.timer = this.setTimer(loop, Math.max(0, next - this.clock()));
    };
    this.timer = this.setTimer(loop, stepMs);
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Graceful shutdown: tell every player the match is over. */
  shutdown() {
    this.stop();
    const now = this.clock();
    for (const room of this.rooms.values()) {
      try { room.finish('shutdown', now); } catch { /* ignore */ }
    }
  }

  stats() {
    let players = 0;
    for (const room of this.rooms.values()) players += room.connectedCount();
    return { rooms: this.rooms.size, players };
  }

  list() {
    return Array.from(this.rooms.values()).map((r) => r.info());
  }
}
