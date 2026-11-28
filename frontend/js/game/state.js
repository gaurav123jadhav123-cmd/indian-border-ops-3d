// The client's picture of the match, built from `match_joined` and `state_snapshot`.
// No 3D engine in here: renderers read from it.
import { Interpolator } from './interp.js';

export class GameState {
  constructor() {
    this.reset();
  }

  reset() {
    this.joined = false;
    this.myId = null;
    this.mode = 'TDM';
    this.team = 'bharat';
    this.callsign = '';
    this.roomId = '';
    this.rules = {};
    this.me = null;            // private block from the latest snapshot
    this.players = new Map();  // id -> { data, interp }
    this.airdrops = [];
    this.drones = [];
    this.grenades = [];
    this.rockets = [];
    this.missiles = [];
    this.scores = null;
    this.timeLeftSec = 0;
    this.seq = 0;
    this.snapshotAt = 0;       // client time the last snapshot arrived
    this.gotFirstSnapshot = false;
  }

  applyJoin(payload, now) {
    this.reset();
    this.joined = true;
    this.myId = payload.playerId;
    this.mode = payload.mode;
    this.team = payload.team;
    this.callsign = payload.callsign;
    this.roomId = payload.roomId;
    this.rules = payload.rules ?? {};
    if (payload.snapshot) this.applySnapshot(payload.snapshot, now);
  }

  applySnapshot(snap, now) {
    if (!snap || typeof snap !== 'object') return;
    if (snap.seq !== undefined && snap.seq < this.seq && snap.seq !== 0) return; // out-of-order, ignore
    this.seq = snap.seq ?? this.seq;
    this.snapshotAt = now;
    this.gotFirstSnapshot = true;

    this.me = snap.me ?? this.me;
    this.scores = snap.scores ?? null;
    this.timeLeftSec = snap.timeLeftSec ?? this.timeLeftSec;
    this.airdrops = snap.airdrops ?? [];
    this.drones = snap.drones ?? [];
    this.grenades = snap.grenades ?? [];
    this.rockets = snap.rockets ?? [];
    this.missiles = snap.missiles ?? [];

    const seen = new Set();
    for (const p of snap.players ?? []) {
      seen.add(p.id);
      let entry = this.players.get(p.id);
      if (!entry) {
        entry = { data: p, interp: new Interpolator() };
        this.players.set(p.id, entry);
      }
      if (entry.data.alive !== p.alive) entry.interp.clear(); // died or respawned: do not slide
      entry.data = p;
      entry.interp.push(now, p);
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
  }

  /** Everybody except me. */
  others() {
    const list = [];
    for (const [id, entry] of this.players) if (id !== this.myId) list.push(entry);
    return list;
  }

  myPublic() {
    return this.players.get(this.myId)?.data ?? null;
  }

  /** Active drone I am flying, if any (from the snapshot). */
  myDrone() {
    const id = this.me?.droneId;
    return id ? this.drones.find((d) => d.id === id) ?? null : null;
  }

  /** The nearest landed crate within `radius` of (x, z), or null. */
  crateNear(x, z, radius) {
    let best = null;
    let bestDist = radius;
    for (const c of this.airdrops) {
      if (!c.landed) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d <= bestDist) { best = c; bestDist = d; }
    }
    return best;
  }
}
