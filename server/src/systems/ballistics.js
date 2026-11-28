// Server-side bullet physics: hit volumes, line-of-sight, spread and damage.
import { ARSENAL } from '../shared/arsenal.js';
import { raycastWorld, STANCE_SCALE, EYE_HEIGHT } from '../shared/world.js';

export function weaponStats(weaponId) {
  return ARSENAL[weaponId] || ARSENAL.sig716;
}

/** Head + chest + legs spheres. They shrink with stance, matching the squashed soldier model. */
export function hitSpheres(p) {
  const s = STANCE_SCALE[p.stance] ?? 1;
  const rScale = Math.max(0.6, s);
  return [
    { kind: 'head', x: p.x, y: p.y + 1.62 * s, z: p.z, r: 0.26 * rScale },
    { kind: 'body', x: p.x, y: p.y + 1.1 * s, z: p.z, r: 0.44 * rScale },
    { kind: 'body', x: p.x, y: p.y + 0.55 * s, z: p.z, r: 0.42 * rScale }
  ];
}

/** Distance along the (normalized) ray to the sphere, 0 if the origin is inside, else null. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = ox - cx;
  const ly = oy - cy;
  const lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t = -b - root;
  if (t >= 0) return t;
  return -b + root >= 0 ? 0 : null;
}

/** Randomly bend a direction inside a cone of `spread` radians. */
export function applySpread(dir, spread, rng = Math.random) {
  if (!(spread > 0)) return dir;
  let ux;
  let uy;
  let uz;
  if (Math.abs(dir.y) < 0.99) {
    ux = -dir.z; uy = 0; uz = dir.x; // dir x up
  } else {
    ux = 0; uy = dir.z; uz = -dir.y; // dir x right(1,0,0)
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = dir.y * uz - dir.z * uy; // v = dir x u
  const vy = dir.z * ux - dir.x * uz;
  const vz = dir.x * uy - dir.y * ux;

  const angle = rng() * Math.PI * 2;
  const mag = spread * Math.sqrt(rng());
  const a = Math.cos(angle) * mag;
  const b = Math.sin(angle) * mag;
  const x = dir.x + ux * a + vx * b;
  const y = dir.y + uy * a + vy * b;
  const z = dir.z + uz * a + vz * b;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/**
 * How wide the bullet cone is right now. Aiming down sights tightens it; moving widens it;
 * crouching and lying prone tighten it again.
 */
export function effectiveSpread(weapon, player, moving) {
  let spread = player.ads ? weapon.adsSpread : weapon.spread;
  if (moving) spread *= 1.5;
  if (player.stance === 'crouch') spread *= 0.8;
  else if (player.stance === 'prone') spread *= 0.6;
  return spread;
}

/**
 * Trace one bullet. Terrain and structures stop it. Returns
 * { hit: { kind, target, dist, headshot } | null, end: {x,y,z}, world }
 */
export function traceShot({ shooter, origin, dir, range, players, drones = [], teamMode }) {
  const world = raycastWorld(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, range);
  const maxDist = world ? world.dist : range;
  let best = null;

  for (const target of players) {
    if (target.id === shooter.id || !target.alive || !target.connected) continue;
    if (teamMode && target.team === shooter.team) continue;
    for (const s of hitSpheres(target)) {
      const d = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, s.x, s.y, s.z, s.r);
      if (d !== null && d <= maxDist && (!best || d < best.dist)) {
        best = { kind: 'player', target, dist: d, headshot: s.kind === 'head' };
      }
    }
  }

  for (const drone of drones) {
    if (drone.ownerId === shooter.id) continue;
    if (teamMode && drone.team === shooter.team) continue;
    const d = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, drone.x, drone.y, drone.z, 0.6);
    if (d !== null && d <= maxDist && (!best || d < best.dist)) {
      best = { kind: 'drone', target: drone, dist: d, headshot: false };
    }
  }

  const reach = best ? best.dist : maxDist;
  return {
    hit: best,
    world,
    end: { x: origin.x + dir.x * reach, y: origin.y + dir.y * reach, z: origin.z + dir.z * reach }
  };
}

/** Armor soaks 45% of each bullet until it is used up. Explosions can ignore armor. */
export function applyDamage(target, rawDamage, armorBypass = false) {
  let damage = Math.max(0, rawDamage);
  if (!armorBypass && target.armor > 0) {
    const absorbed = Math.min(target.armor, damage * 0.45);
    target.armor = Math.max(0, target.armor - absorbed);
    damage -= absorbed;
  }
  const dealt = Math.round(damage);
  target.hp = Math.max(0, target.hp - dealt);
  return dealt;
}

export { EYE_HEIGHT };
