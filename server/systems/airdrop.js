const { getTerrainHeight } = require('./terrainHeight');

const AIRDROP_ZONES = [
  { name: 'LAC Bridge Drop Zone', x: 0, z: 8 },
  { name: 'West Ridge Overlook', x: -38, z: 5 },
  { name: 'East Valley Clearing', x: 42, z: -8 },
  { name: 'Frozen River Bend', x: -18, z: -28 },
  { name: 'Northern Pass', x: 18, z: 32 }
];

const HIGH_TIER_LOOT = [
  { weaponId: 'vidhwansak', label: 'Vidhwansak 14.5mm AMR + Level 3 Armor' },
  { weaponId: 'trg42', label: 'Sako TRG-42 .338 Sniper + Medkit' },
  { weaponId: 'negev', label: 'Negev NG7 LMG + Level 3 Armor' },
  { weaponId: 'carlGustaf', label: 'Carl Gustaf 84mm + Energy Drinks' }
];

class AirdropManager {
  constructor() {
    this.crates = [];
    this.nextSpawnAt = Date.now() + 20000; // First airdrop 20s into match
    this.seq = 1;
  }

  update(now) {
    const events = [];
    if (now >= this.nextSpawnAt && this.crates.length < 3) {
      const zone = AIRDROP_ZONES[Math.floor(Math.random() * AIRDROP_ZONES.length)];
      const x = zone.x + (Math.random() - 0.5) * 14;
      const z = zone.z + (Math.random() - 0.5) * 14;
      const groundY = getTerrainHeight(x, z);
      const loot = HIGH_TIER_LOOT[Math.floor(Math.random() * HIGH_TIER_LOOT.length)];

      const crate = {
        id: `drop_${this.seq++}`,
        zoneName: zone.name,
        x,
        y: groundY + 48,
        groundY,
        z,
        landed: false,
        looted: false,
        weaponId: loot.weaponId,
        label: loot.label
      };
      this.crates.push(crate);
      this.nextSpawnAt = now + 45000;
      events.push({ type: 'airdrop_spawned', crate });
    }

    for (const c of this.crates) {
      if (!c.landed) {
        c.y -= 0.25; // Parachute descent per 33ms tick (~7.5 m/s)
        if (c.y <= c.groundY) {
          c.y = c.groundY;
          c.landed = true;
          events.push({ type: 'airdrop_landed', crate: c });
        }
      }
    }

    return events;
  }

  tryLoot(player, crateId) {
    const idx = this.crates.findIndex((c) => c.id === crateId && !c.looted && c.landed);
    if (idx === -1) return null;
    const crate = this.crates[idx];
    const dist = Math.hypot(player.x - crate.x, player.z - crate.z);
    if (dist > 5.0) return null;

    crate.looted = true;
    player.armor = 100;
    player.inventory.medkit += 1;
    player.inventory.energyDrink += 2;
    player.loadout.primary = crate.weaponId;
    player.activeSlot = 'primary';

    // Remove crate shortly after
    this.crates.splice(idx, 1);
    return crate;
  }
}

module.exports = { AirdropManager };
