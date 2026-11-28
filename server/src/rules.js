// Every gameplay number in one place, so balancing the game never means hunting through code.
// Times are milliseconds unless the name says otherwise.

export const RULES = Object.freeze({
  tickHz: 30,
  snapshotHz: 20,

  // Match
  matchSeconds: 480,
  tdmScoreLimit: 25,
  ffaKillLimit: 15,
  respawnMs: 4500,
  spawnProtectionMs: 3000,
  reconnectGraceMs: 30000,

  // Player actions
  equipDelayMs: 250,        // after switching weapons you cannot fire for this long
  throwCooldownMs: 800,
  fireTolerance: 0.1,       // network jitter allowance on the fire rate

  // Movement validation (light anti-cheat)
  move: {
    burstSeconds: 0.75,     // how much "saved up" movement a player may spend at once
    slackMeters: 0.6,
    correctionDistance: 2.5 // snap the client back when it is further off than this
  },

  // Energy drink boost: slow health regeneration while the bar drains
  boost: { decayPerSec: 2.0, regenHpPerSec: 1.5 },

  grenade: {
    speed: 22, lift: 5.5, gravity: 14, fuseMs: 2400, restitution: 0.35, friction: 0.7,
    frag: { radius: 8.5, damage: 110 },
    smokeMs: 9000
  },

  rocket: { speed: 70, armDelayMs: 150, hitPadding: 0.5 },

  // The strike lands where the caller aims (first thing the aim ray hits), at most maxRange
  // meters away and never closer than minRange, so nobody can call it onto their own head.
  missile: { cooldownMs: 45000, fallSpeed: 38, height: 95, radius: 15, damage: 145, maxRange: 120, minRange: 22 },

  drone: {
    fpv:   { hp: 40, ttlMs: 22000, speed: 24, vertical: 12, cooldownMs: 35000, blastRadius: 9, blastDamage: 115 },
    recon: { hp: 65, ttlMs: 30000, speed: 14, vertical: 8,  cooldownMs: 35000 },
    hitRadius: 0.6,
    minAboveGround: 1.2,
    maxAltitude: 70
  },

  airdrop: {
    firstDelayMs: 20000,
    intervalMs: 45000,
    maxActive: 3,
    dropHeight: 48,
    fallSpeed: 7.5,
    lootRadius: 5,
    lingerMs: 120000
  },

  // Capacity (RoomManager)
  maxRooms: 20,
  roomCapacity: 12
});

/** Shallow-merge overrides (used by tests and the config file) */
export function withRules(overrides = {}) {
  const merged = { ...RULES };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...RULES[key], ...value }
      : value;
  }
  return Object.freeze(merged);
}
