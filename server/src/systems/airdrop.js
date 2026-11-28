// Free Fire style supply crates: parachute down, glow, get looted, or expire.
import { ARSENAL, HEALING_ITEMS } from '../shared/arsenal.js';
import { getTerrainHeight, resolveObstacles } from '../shared/world.js';

export const AIRDROP_ZONES = Object.freeze([
  { name: 'LAC Bridge Drop Zone', x: 0, z: 8 },
  { name: 'West Ridge Overlook', x: -38, z: 5 },
  { name: 'East Valley Clearing', x: 42, z: -8 },
  { name: 'Frozen River Bend', x: -18, z: -28 },
  { name: 'Northern Pass', x: 18, z: 32 }
]);

// Each crate gives full armor plus what is listed here. The label is generated from this data,
// so what the HUD announces is always exactly what the player receives.
export const LOOT_TABLE = Object.freeze([
  { id: 'amr',  weapon: 'vidhwansak', slot: 'primary',  armor: 100, items: { medkit: 1 } },
  { id: 'trg',  weapon: 'trg42',      slot: 'primary',  armor: 100, items: { medkit: 1 } },
  { id: 'lmg',  weapon: 'negev',      slot: 'primary',  armor: 100, items: { energyDrink: 2 } },
  { id: 'carl', weapon: 'carlGustaf', slot: 'launcher', armor: 100, items: { energyDrink: 2 }, rockets: 3 }
]);

export function describeLoot(loot) {
  const weapon = ARSENAL[loot.weapon];
  const parts = [loot.rockets ? `${weapon.name} (+${loot.rockets} rockets)` : weapon.name];
  if (loot.armor) parts.push('Full Armor');
  for (const [item, count] of Object.entries(loot.items)) {
    const name = HEALING_ITEMS[item]?.name ?? item;
    parts.push(`${count} ${name}${count > 1 ? 's' : ''}`);
  }
  return parts.join(' + ');
}

export function publicCrate(c) {
  return {
    id: c.id,
    zoneName: c.zoneName,
    x: Math.round(c.x * 100) / 100,
    y: Math.round(c.y * 100) / 100,
    z: Math.round(c.z * 100) / 100,
    landed: c.landed,
    label: c.label
  };
}

export class AirdropManager {
  constructor({ rules, rng = Math.random, now }) {
    this.cfg = rules.airdrop;
    this.rng = rng;
    this.crates = [];
    this.seq = 1;
    this.nextSpawnAt = now + this.cfg.firstDelayMs;
  }

  /** Advance the crates. Returns events: airdrop_spawned / airdrop_landed / airdrop_expired */
  update(dt, now) {
    const events = [];

    if (now >= this.nextSpawnAt && this.crates.length < this.cfg.maxActive) {
      const crate = this.spawn(now);
      this.crates.push(crate);
      this.nextSpawnAt = now + this.cfg.intervalMs;
      events.push({ type: 'airdrop_spawned', crate });
    }

    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (!c.landed) {
        c.y -= this.cfg.fallSpeed * dt;
        if (c.y <= c.groundY) {
          c.y = c.groundY;
          c.landed = true;
          c.expiresAt = now + this.cfg.lingerMs;
          events.push({ type: 'airdrop_landed', crate: c });
        }
      } else if (now >= c.expiresAt) {
        this.crates.splice(i, 1);
        events.push({ type: 'airdrop_expired', crate: c });
      }
    }
    return events;
  }

  spawn() {
    const zone = AIRDROP_ZONES[Math.floor(this.rng() * AIRDROP_ZONES.length)];
    const loot = LOOT_TABLE[Math.floor(this.rng() * LOOT_TABLE.length)];
    const raw = {
      x: zone.x + (this.rng() - 0.5) * 14,
      z: zone.z + (this.rng() - 0.5) * 14
    };
    const { x, z } = resolveObstacles(raw.x, raw.z, 2); // never land inside a bunker
    const groundY = getTerrainHeight(x, z);
    return {
      id: `drop_${this.seq++}`,
      zoneName: zone.name,
      x, z, groundY,
      y: groundY + this.cfg.dropHeight,
      landed: false,
      expiresAt: Infinity,
      loot,
      label: describeLoot(loot)
    };
  }

  /** A landed crate by id, or undefined */
  find(crateId) {
    return this.crates.find((c) => c.id === crateId && c.landed);
  }

  remove(crate) {
    const idx = this.crates.indexOf(crate);
    if (idx !== -1) this.crates.splice(idx, 1);
  }
}
