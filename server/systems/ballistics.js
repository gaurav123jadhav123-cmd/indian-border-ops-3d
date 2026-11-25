const { raycastWorldOcclusion } = require('./terrainHeight');

// Authoritative Indian Army Arsenal Ballistics & Damage Falloff
const WEAPON_STATS = {
  sig716: { name: 'SIG 716 G2', damage: 42, headshotMult: 2.1, fireRateMs: 135, magSize: 20, reloadMs: 2100, range: 240, falloffStart: 85, minMult: 0.65, moveSpeedMult: 0.94, blastRadius: 0 },
  ak203: { name: 'AK-203', damage: 36, headshotMult: 2.0, fireRateMs: 105, magSize: 30, reloadMs: 1950, range: 190, falloffStart: 65, minMult: 0.6, moveSpeedMult: 0.96, blastRadius: 0 },
  insas: { name: 'INSAS 1B1', damage: 28, headshotMult: 1.9, fireRateMs: 92, magSize: 30, reloadMs: 1850, range: 180, falloffStart: 60, minMult: 0.6, moveSpeedMult: 0.98, blastRadius: 0 },
  tavor: { name: 'Tavor TAR-21', damage: 31, headshotMult: 1.95, fireRateMs: 85, magSize: 30, reloadMs: 1800, range: 175, falloffStart: 58, minMult: 0.62, moveSpeedMult: 1.0, blastRadius: 0 },
  asmi: { name: 'ASMI 9mm', damage: 23, headshotMult: 1.75, fireRateMs: 70, magSize: 33, reloadMs: 1450, range: 95, falloffStart: 28, minMult: 0.45, moveSpeedMult: 1.05, blastRadius: 0 },
  svd: { name: 'Dragunov SVD', damage: 72, headshotMult: 2.4, fireRateMs: 420, magSize: 10, reloadMs: 2450, range: 360, falloffStart: 150, minMult: 0.78, moveSpeedMult: 0.90, blastRadius: 0 },
  trg42: { name: 'Sako TRG-42', damage: 98, headshotMult: 2.6, fireRateMs: 1150, magSize: 5, reloadMs: 2800, range: 450, falloffStart: 210, minMult: 0.85, moveSpeedMult: 0.87, blastRadius: 0 },
  vidhwansak: { name: 'Vidhwansak AMR', damage: 135, headshotMult: 2.5, fireRateMs: 1400, magSize: 3, reloadMs: 3100, range: 500, falloffStart: 250, minMult: 0.9, moveSpeedMult: 0.82, blastRadius: 0 },
  negev: { name: 'Negev NG7', damage: 34, headshotMult: 1.85, fireRateMs: 95, magSize: 100, reloadMs: 3600, range: 220, falloffStart: 75, minMult: 0.65, moveSpeedMult: 0.84, blastRadius: 0 },
  pistol9mm: { name: 'Pistol Auto 9mm 1A', damage: 24, headshotMult: 1.8, fireRateMs: 180, magSize: 13, reloadMs: 1250, range: 65, falloffStart: 22, minMult: 0.45, moveSpeedMult: 1.06, blastRadius: 0 },
  carlGustaf: { name: 'Carl Gustaf M4', damage: 130, headshotMult: 1.0, fireRateMs: 2500, magSize: 1, reloadMs: 2900, range: 260, falloffStart: 260, minMult: 1.0, moveSpeedMult: 0.85, blastRadius: 9.5 }
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

function computeDistanceDamage(stats, dist, headshot) {
  let mult = 1.0;
  if (dist > stats.falloffStart) {
    const t = Math.min(1, (dist - stats.falloffStart) / Math.max(1, stats.range - stats.falloffStart));
    mult = 1.0 - t * (1.0 - stats.minMult);
  }
  return Math.round(stats.damage * mult * (headshot ? stats.headshotMult : 1.0));
}

function traceShot(shooter, origin, dir, weaponId, playersMap) {
  const stats = WEAPON_STATS[weaponId] || WEAPON_STATS.sig716;
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const ndir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };

  // World occlusion check (cannot shoot through mountains, bunkers, or cover walls)
  const worldHitDist = raycastWorldOcclusion(origin, ndir, stats.range);
  const maxAllowedDist = worldHitDist !== null ? worldHitDist : stats.range;

  let closestHit = null;

  for (const target of playersMap.values()) {
    if (target.id === shooter.id || !target.alive) continue;
    if (shooter.mode === 'TDM' && target.team === shooter.team) continue;

    const headDist = raySphereDist(origin, ndir, { x: target.x, y: getHeadY(target), z: target.z }, 0.30);
    if (headDist !== null && headDist <= maxAllowedDist) {
      if (!closestHit || headDist < closestHit.dist) {
        closestHit = { target, dist: headDist, headshot: true };
      }
      continue;
    }

    const bodyDist = raySphereDist(origin, ndir, { x: target.x, y: getStanceCenterY(target), z: target.z }, 0.58);
    if (bodyDist !== null && bodyDist <= maxAllowedDist) {
      if (!closestHit || bodyDist < closestHit.dist) {
        closestHit = { target, dist: bodyDist, headshot: false };
      }
    }
  }

  return { closestHit, stats, ndir, worldHitDist };
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

module.exports = { WEAPON_STATS, traceShot, computeDistanceDamage, applyDamage };
