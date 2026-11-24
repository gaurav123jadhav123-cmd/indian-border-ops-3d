// Authoritative Server Ballistics & Hitbox Detection

const WEAPON_STATS = {
  sig716: { name: 'SIG 716 G2', damage: 42, headshotMult: 2.1, fireRateMs: 135, magSize: 20, range: 240, blastRadius: 0 },
  ak203: { name: 'AK-203', damage: 36, headshotMult: 2.0, fireRateMs: 105, magSize: 30, range: 190, blastRadius: 0 },
  insas: { name: 'INSAS 1B1', damage: 28, headshotMult: 1.9, fireRateMs: 92, magSize: 30, range: 180, blastRadius: 0 },
  tavor: { name: 'Tavor TAR-21', damage: 31, headshotMult: 1.95, fireRateMs: 85, magSize: 30, range: 175, blastRadius: 0 },
  asmi: { name: 'ASMI 9mm', damage: 23, headshotMult: 1.75, fireRateMs: 70, magSize: 33, range: 95, blastRadius: 0 },
  svd: { name: 'Dragunov SVD', damage: 72, headshotMult: 2.4, fireRateMs: 420, magSize: 10, range: 360, blastRadius: 0 },
  trg42: { name: 'Sako TRG-42', damage: 98, headshotMult: 2.6, fireRateMs: 1150, magSize: 5, range: 450, blastRadius: 0 },
  vidhwansak: { name: 'Vidhwansak AMR', damage: 135, headshotMult: 2.5, fireRateMs: 1400, magSize: 3, range: 500, blastRadius: 0 },
  negev: { name: 'Negev NG7', damage: 34, headshotMult: 1.85, fireRateMs: 95, magSize: 100, range: 220, blastRadius: 0 },
  pistol9mm: { name: 'Pistol Auto 9mm 1A', damage: 24, headshotMult: 1.8, fireRateMs: 180, magSize: 13, range: 65, blastRadius: 0 },
  carlGustaf: { name: 'Carl Gustaf M4', damage: 120, headshotMult: 1.0, fireRateMs: 2500, magSize: 1, range: 260, blastRadius: 8.5 }
};

function getStanceCenterY(player) {
  if (player.stance === 'prone') return player.y + 0.35;
  if (player.stance === 'crouch') return player.y + 0.75;
  return player.y + 1.05;
}

function getHeadY(player) {
  if (player.stance === 'prone') return player.y + 0.45;
  if (player.stance === 'crouch') return player.y + 1.15;
  return player.y + 1.62;
}

// Ray-sphere intersection test
function raySphereDist(origin, dir, center, radius) {
  const ocx = origin.x - center.x;
  const ocy = origin.y - center.y;
  const ocz = origin.z - center.z;
  const b = ocx * dir.x + ocy * dir.y + ocz * dir.z;
  const c = ocx * ocx + ocy * ocy + ocz * ocz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

function traceShot(shooter, origin, dir, weaponId, playersMap, maxRange = 300) {
  const stats = WEAPON_STATS[weaponId] || WEAPON_STATS.sig716;
  const range = Math.min(maxRange, stats.range);

  // Normalize direction
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const ndir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };

  let closestHit = null;

  for (const target of playersMap.values()) {
    if (target.id === shooter.id || !target.alive) continue;
    if (shooter.mode === 'TDM' && target.team === shooter.team) continue;

    // Check head sphere first
    const headDist = raySphereDist(origin, ndir, { x: target.x, y: getHeadY(target), z: target.z }, 0.32);
    if (headDist !== null && headDist <= range) {
      if (!closestHit || headDist < closestHit.dist) {
        closestHit = { target, dist: headDist, headshot: true };
      }
      continue;
    }

    // Check torso sphere
    const bodyDist = raySphereDist(origin, ndir, { x: target.x, y: getStanceCenterY(target), z: target.z }, 0.62);
    if (bodyDist !== null && bodyDist <= range) {
      if (!closestHit || bodyDist < closestHit.dist) {
        closestHit = { target, dist: bodyDist, headshot: false };
      }
    }
  }

  return { closestHit, stats, ndir };
}

function applyDamage(target, rawDamage, armorBypass = false) {
  let damage = rawDamage;
  if (!armorBypass && target.armor > 0) {
    const absorbed = Math.min(target.armor, damage * 0.45);
    target.armor = Math.max(0, target.armor - absorbed);
    damage -= absorbed;
  }
  target.hp = Math.max(0, target.hp - Math.round(damage));
  return Math.round(damage);
}

module.exports = { WEAPON_STATS, traceShot, applyDamage };
