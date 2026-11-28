// SHARED SOURCE FILE: edit /shared/arsenal.js, then run `npm run sync`.
// Identical copies live in backend/src/shared/, server/src/shared/ and frontend/js/shared/.
// `npm run check` fails if a copy has drifted, so weapon stats can never disagree.
//
// Indian Army weapon catalog + healing items + loadout rules.

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const ARSENAL = deepFreeze({
  // ---- Assault & battle rifles ------------------------------------------
  sig716: {
    id: 'sig716', name: 'SIG 716 G2', category: 'assault', caliber: '7.62x51mm NATO',
    damage: 42, headshotMult: 2.1, fireRateMs: 135, auto: true,
    magSize: 20, reserveAmmo: 120, reloadMs: 2200, range: 240,
    spread: 0.012, adsSpread: 0.003, recoil: 0.028, adsFov: 52,
    moveSpeedMult: 0.94, airdropOnly: false, color: 0x2b2d2f,
    description: 'Frontline 7.62mm battle rifle used in high-altitude border sectors.'
  },
  ak203: {
    id: 'ak203', name: 'AK-203', category: 'assault', caliber: '7.62x39mm',
    damage: 36, headshotMult: 2.0, fireRateMs: 105, auto: true,
    magSize: 30, reserveAmmo: 150, reloadMs: 2000, range: 190,
    spread: 0.016, adsSpread: 0.005, recoil: 0.024, adsFov: 52,
    moveSpeedMult: 0.96, airdropOnly: false, color: 0x1f2224,
    description: 'Modernized Kalashnikov manufactured in Amethi for Indian Infantry.'
  },
  insas: {
    id: 'insas', name: 'INSAS 1B1', category: 'assault', caliber: '5.56x45mm NATO',
    damage: 28, headshotMult: 1.9, fireRateMs: 92, auto: true,
    magSize: 30, reserveAmmo: 180, reloadMs: 1900, range: 180,
    spread: 0.014, adsSpread: 0.004, recoil: 0.016, adsFov: 52,
    moveSpeedMult: 0.98, airdropOnly: false, color: 0x3b332b,
    description: 'Indian Small Arms System standard-issue rifle with low recoil.'
  },
  tavor: {
    id: 'tavor', name: 'Tavor TAR-21', category: 'assault', caliber: '5.56x45mm NATO',
    damage: 31, headshotMult: 1.95, fireRateMs: 85, auto: true,
    magSize: 30, reserveAmmo: 180, reloadMs: 1850, range: 175,
    spread: 0.013, adsSpread: 0.0035, recoil: 0.015, adsFov: 52,
    moveSpeedMult: 1.0, airdropOnly: false, color: 0x4b4d3f,
    description: 'Bullpup rifle favored by Para SF special forces for CQB & mountain ops.'
  },

  // ---- Submachine gun ----------------------------------------------------
  asmi: {
    id: 'asmi', name: 'ASMI 9mm', category: 'smg', caliber: '9x19mm Parabellum',
    damage: 23, headshotMult: 1.75, fireRateMs: 70, auto: true,
    magSize: 33, reserveAmmo: 198, reloadMs: 1500, range: 95,
    spread: 0.022, adsSpread: 0.008, recoil: 0.011, adsFov: 58,
    moveSpeedMult: 1.05, airdropOnly: false, color: 0x2c3035,
    description: 'Indigenous DRDO/Indian Army submachine gun built for rapid mobility.'
  },

  // ---- Snipers & marksman rifles -----------------------------------------
  svd: {
    id: 'svd', name: 'Dragunov SVD', category: 'sniper', caliber: '7.62x54mmR',
    damage: 72, headshotMult: 2.4, fireRateMs: 420, auto: false,
    magSize: 10, reserveAmmo: 50, reloadMs: 2500, range: 360,
    spread: 0.008, adsSpread: 0.001, recoil: 0.045, adsFov: 26,
    moveSpeedMult: 0.90, airdropOnly: false, color: 0x523f2d,
    description: 'Semi-automatic designated marksman rifle for ridge-to-ridge overwatch.'
  },
  trg42: {
    id: 'trg42', name: 'Sako TRG-42', category: 'sniper', caliber: '.338 Lapua Magnum',
    damage: 98, headshotMult: 2.6, fireRateMs: 1150, auto: false,
    magSize: 5, reserveAmmo: 25, reloadMs: 2900, range: 450,
    spread: 0.010, adsSpread: 0.0005, recoil: 0.065, adsFov: 18,
    moveSpeedMult: 0.87, airdropOnly: true, color: 0x3b443b,
    description: 'Long-range precision bolt-action sniper rifle (Air Drop Tier).'
  },
  vidhwansak: {
    id: 'vidhwansak', name: 'Vidhwansak AMR', category: 'sniper', caliber: '14.5x114mm',
    damage: 135, headshotMult: 2.5, fireRateMs: 1400, auto: false,
    magSize: 3, reserveAmmo: 15, reloadMs: 3200, range: 500,
    spread: 0.015, adsSpread: 0.0008, recoil: 0.09, adsFov: 16,
    moveSpeedMult: 0.82, airdropOnly: true, color: 0x262626,
    description: 'Indigenous anti-materiel rifle capable of penetrating heavy armor.'
  },

  // ---- Light machine gun --------------------------------------------------
  negev: {
    id: 'negev', name: 'Negev NG7', category: 'lmg', caliber: '7.62x51mm NATO',
    damage: 34, headshotMult: 1.85, fireRateMs: 95, auto: true,
    magSize: 100, reserveAmmo: 200, reloadMs: 3800, range: 220,
    spread: 0.025, adsSpread: 0.007, recoil: 0.022, adsFov: 56,
    moveSpeedMult: 0.84, airdropOnly: true, color: 0x363936,
    description: 'Heavy squad light machine gun for suppressing enemy bunkers.'
  },

  // ---- Sidearm -------------------------------------------------------------
  pistol9mm: {
    id: 'pistol9mm', name: 'Pistol Auto 9mm 1A', category: 'sidearm', caliber: '9x19mm',
    damage: 24, headshotMult: 1.8, fireRateMs: 180, auto: false,
    magSize: 13, reserveAmmo: 65, reloadMs: 1300, range: 65,
    spread: 0.018, adsSpread: 0.006, recoil: 0.014, adsFov: 62,
    moveSpeedMult: 1.06, airdropOnly: false, color: 0x1e2022,
    description: 'Standard-issue Indian Army sidearm.'
  },

  // ---- Anti-armor launcher -------------------------------------------------
  carlGustaf: {
    id: 'carlGustaf', name: 'Carl Gustaf M4', category: 'launcher', caliber: '84mm HE',
    damage: 120, headshotMult: 1.0, fireRateMs: 2500, auto: false,
    magSize: 1, reserveAmmo: 3, reloadMs: 3100, range: 260, blastRadius: 8.5,
    spread: 0.005, adsSpread: 0.002, recoil: 0.08, adsFov: 50,
    moveSpeedMult: 0.85, airdropOnly: false, color: 0x454f3b,
    description: '84mm recoilless anti-bunker & anti-armor launcher.'
  }
});

export const HEALING_ITEMS = deepFreeze({
  bandage:     { id: 'bandage',     name: 'Bandage',       healAmount: 15,  maxCap: 75,  castTimeMs: 2000, boostAmount: 0 },
  firstAid:    { id: 'firstAid',    name: 'First Aid Kit', healAmount: 60,  maxCap: 75,  castTimeMs: 3500, boostAmount: 0 },
  medkit:      { id: 'medkit',      name: 'Medkit',        healAmount: 100, maxCap: 100, castTimeMs: 4500, boostAmount: 0 },
  energyDrink: { id: 'energyDrink', name: 'Energy Drink',  healAmount: 0,   maxCap: 100, castTimeMs: 2200, boostAmount: 40 }
});

// What every soldier carries at spawn / respawn.
export const STARTING_INVENTORY = deepFreeze({
  frag: 2, smoke: 2, bandage: 4, firstAid: 2, medkit: 1, energyDrink: 2
});

// ---- Loadout rules (used by backend validation AND the game server) --------
export const SLOT_RULES = deepFreeze({
  primary:   { categories: ['assault', 'smg', 'sniper', 'lmg'] },
  secondary: { categories: ['sidearm'] },
  launcher:  { categories: ['launcher'] }
});

export const DEFAULT_LOADOUT = deepFreeze({
  primary: 'sig716',
  secondary: 'pistol9mm',
  launcher: 'carlGustaf'
});

export const LOADOUT_SLOTS = Object.freeze(['primary', 'secondary', 'launcher']);

/** Can this weapon be chosen for the slot in the lobby? (air-drop guns cannot) */
export function isAllowedForSlot(slot, weaponId) {
  const rule = SLOT_RULES[slot];
  const weapon = typeof weaponId === 'string' ? ARSENAL[weaponId] : undefined;
  if (!rule || !weapon || !Object.hasOwn(ARSENAL, weaponId)) return false;
  return rule.categories.includes(weapon.category) && !weapon.airdropOnly;
}

/** Full, always-valid loadout. Anything missing or illegal falls back to the default. */
export function sanitizeLoadout(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const slot of LOADOUT_SLOTS) {
    out[slot] = isAllowedForSlot(slot, src[slot]) ? src[slot] : DEFAULT_LOADOUT[slot];
  }
  return out;
}

/**
 * Strict validation for partial updates (backend). Returns { patch, error }.
 * Only provided fields are included, so nothing gets overwritten with undefined.
 */
export function validateLoadoutPatch(input) {
  const src = input && typeof input === 'object' ? input : {};
  const patch = {};
  for (const slot of LOADOUT_SLOTS) {
    if (src[slot] === undefined || src[slot] === null) continue;
    if (!isAllowedForSlot(slot, src[slot])) {
      return { patch: null, error: `Invalid ${slot} weapon.` };
    }
    patch[slot] = src[slot];
  }
  if (Object.keys(patch).length === 0) {
    return { patch: null, error: 'Nothing to save: send primary, secondary or launcher.' };
  }
  return { patch, error: null };
}
