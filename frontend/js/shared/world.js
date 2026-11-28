// SHARED SOURCE FILE: edit /shared/world.js, then run `npm run sync`.
// Identical copies live in server/src/shared/ and frontend/js/shared/.
// Server physics and the 3D client MUST use the exact same world math, so this one file
// holds the terrain, the bunkers (as collision boxes), movement rules and ray casting.
//
// Coordinates: x = east/west, z = north/south, y = up. The Bharat base is at z = -95,
// the OPFOR base at z = +95. Yaw 0 looks toward -Z; forward = (-sin yaw, -cos yaw).

export const MAP_HALF_SIZE = 140; // 280m x 280m playable sector
export const PLAYER_RADIUS = 0.45;
export const STANCES = Object.freeze(['stand', 'crouch', 'prone']);
export const EYE_HEIGHT = Object.freeze({ stand: 1.65, crouch: 1.12, prone: 0.48 });
export const STANCE_SCALE = Object.freeze({ stand: 1.0, crouch: 0.72, prone: 0.42 });
export const LEAN_OFFSET = 0.45;

export const MOVE = Object.freeze({
  baseSpeed: 6.2,
  crouchMult: 0.62,
  proneMult: 0.34,
  sprintMult: 1.48,
  boostMult: 1.12,       // energy-drink speed boost
  boostThreshold: 20,
  jumpVelocity: 6.8,
  gravity: 18,
  maxRiseAboveGround: 2.4 // the server never accepts a player higher than this above the ground
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
export function getTerrainHeight(x, z) {
  // Glacial river valley with a gentle S-curve
  const riverCenter = Math.sin(x * 0.03) * 14;
  const distFromRiver = Math.abs(z - riverCenter);
  const valleyDip = Math.max(0, 1 - distFromRiver / 26) * -3.2;

  // Northern & southern Himalayan ridges
  const ridgeNorth = Math.max(0, (z - 35) * 0.14);
  const ridgeSouth = Math.max(0, (-z - 35) * 0.14);

  // Rolling mountain undulation
  const hills =
    Math.sin(x * 0.045) * Math.cos(z * 0.045) * 4.5 +
    Math.sin(x * 0.11 + 1.3) * Math.cos(z * 0.09) * 1.6 +
    Math.cos((x + z) * 0.025) * 2.2;

  // Calm the hills around both bases. Smooth blend: a hard cut would leave a cliff.
  const baseDist = Math.min(Math.hypot(x, z + 95), Math.hypot(x, z - 95));
  const t = clamp((baseDist - 16) / 14, 0, 1);
  const baseFlatten = 0.25 + 0.75 * (t * t * (3 - 2 * t));

  return hills * baseFlatten + valleyDip + ridgeNorth + ridgeSouth;
}

function terrainNormal(x, z) {
  const e = 0.5;
  const dhdx = (getTerrainHeight(x + e, z) - getTerrainHeight(x - e, z)) / (2 * e);
  const dhdz = (getTerrainHeight(x, z + e) - getTerrainHeight(x, z - e)) / (2 * e);
  const len = Math.hypot(dhdx, 1, dhdz);
  return { nx: -dhdx / len, ny: 1 / len, nz: -dhdz / len };
}

// ---------------------------------------------------------------------------
// Structures (bunkers, checkpoint, watchtowers) -> axis-aligned collision boxes
// ---------------------------------------------------------------------------
export const STRUCTURES = Object.freeze([
  { id: 'bunker_alpha',      name: 'Bunker Alpha (West Ridge)', x: -45, z: -20, w: 8,  d: 8, h: 3.5 },
  { id: 'bunker_bravo',      name: 'Bunker Bravo (East Ridge)', x: 45,  z: 20,  w: 8,  d: 8, h: 3.5 },
  { id: 'checkpoint_center', name: 'LAC Bridge Checkpoint',     x: 0,   z: 0,   w: 10, d: 6, h: 3.2 },
  { id: 'watchtower_south',  name: 'Bharat Watchtower',         x: -24, z: -72, w: 5,  d: 5, h: 7.5 },
  { id: 'watchtower_north',  name: 'Northern Watchtower',       x: 24,  z: 72,  w: 5,  d: 5, h: 7.5 }
]);

function groundRange(minX, maxX, minZ, maxZ) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const g = getTerrainHeight(minX + ((maxX - minX) * i) / 4, minZ + ((maxZ - minZ) * j) / 4);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
  }
  return { lo, hi };
}

function buildObstacles() {
  const boxes = [];
  for (const s of STRUCTURES) {
    const hw = s.w / 2;
    const hd = s.d / 2;
    const center = getTerrainHeight(s.x, s.z);
    const range = groundRange(s.x - hw, s.x + hw, s.z - hd, s.z + hd);
    boxes.push(Object.freeze({
      id: s.id, kind: 'structure',
      minX: s.x - hw, maxX: s.x + hw, minZ: s.z - hd, maxZ: s.z + hd,
      minY: range.lo - 0.6,           // sunk below the lowest ground so no gaps show
      maxY: center + s.h - 0.3
    }));

    // Sandbag wall on the +Z face
    const bagZ = s.z + hd + 1.2;
    const bagHalfW = (s.w + 2) / 2;
    const bagGround = getTerrainHeight(s.x, bagZ);
    const bagRange = groundRange(s.x - bagHalfW, s.x + bagHalfW, bagZ - 0.6, bagZ + 0.6);
    boxes.push(Object.freeze({
      id: `${s.id}_sandbags`, kind: 'sandbags',
      minX: s.x - bagHalfW, maxX: s.x + bagHalfW, minZ: bagZ - 0.6, maxZ: bagZ + 0.6,
      minY: bagRange.lo - 0.4,
      maxY: bagGround + 1.1
    }));
  }
  return Object.freeze(boxes);
}

export const OBSTACLES = buildObstacles();

/** Push a circle (x, z, radius) out of every obstacle. Returns the corrected {x, z}. */
export function resolveObstacles(x, z, radius = PLAYER_RADIUS) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const b of OBSTACLES) {
      if (x < b.minX - radius || x > b.maxX + radius || z < b.minZ - radius || z > b.maxZ + radius) continue;
      const cx = clamp(x, b.minX, b.maxX);
      const cz = clamp(z, b.minZ, b.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1e-9) {
        if (d2 >= radius * radius) continue;
        const d = Math.sqrt(d2);
        const push = radius - d;
        x += (dx / d) * push;
        z += (dz / d) * push;
        moved = true;
      } else {
        // Centre is inside the box: leave through the nearest face.
        const toLeft = x - b.minX;
        const toRight = b.maxX - x;
        const toBack = z - b.minZ;
        const toFront = b.maxZ - z;
        const m = Math.min(toLeft, toRight, toBack, toFront);
        if (m === toLeft) x = b.minX - radius;
        else if (m === toRight) x = b.maxX + radius;
        else if (m === toBack) z = b.minZ - radius;
        else z = b.maxZ + radius;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x, z };
}

/** Is this 3D point inside a structure? (used for drones) */
export function pointInObstacle(x, y, z, pad = 0) {
  for (const b of OBSTACLES) {
    if (x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad && y > b.minY && y < b.maxY + pad) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ray casting against the world (terrain + obstacles). Direction must be normalized.
// ---------------------------------------------------------------------------
function rayAabb(ox, oy, oz, dx, dy, dz, b, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  let axis = -1;
  let sign = 0;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [b.minX, b.minY, b.minZ];
  const hi = [b.maxX, b.maxY, b.maxZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null;
      continue;
    }
    let t1 = (lo[a] - o[a]) / d[a];
    let t2 = (hi[a] - o[a]) / d[a];
    let s = -1; // entering through the low face -> normal points to -axis
    if (t1 > t2) {
      const tmp = t1; t1 = t2; t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis === -1) return null; // starts inside the box: ignore
  const n = [0, 0, 0];
  n[axis] = sign;
  return {
    dist: tmin, kind: 'obstacle', id: b.id,
    x: ox + dx * tmin, y: oy + dy * tmin, z: oz + dz * tmin,
    nx: n[0], ny: n[1], nz: n[2]
  };
}

function terrainHit(ox, oy, oz, dx, dy, dz, t) {
  const x = ox + dx * t;
  const z = oz + dz * t;
  const n = terrainNormal(x, z);
  return { dist: t, kind: 'terrain', x, y: oy + dy * t, z, nx: n.nx, ny: n.ny, nz: n.nz };
}

function rayTerrain(ox, oy, oz, dx, dy, dz, maxDist) {
  const lim = MAP_HALF_SIZE + 10;
  let tEnd = maxDist;
  if (dx > 1e-9) tEnd = Math.min(tEnd, (lim - ox) / dx);
  else if (dx < -1e-9) tEnd = Math.min(tEnd, (-lim - ox) / dx);
  if (dz > 1e-9) tEnd = Math.min(tEnd, (lim - oz) / dz);
  else if (dz < -1e-9) tEnd = Math.min(tEnd, (-lim - oz) / dz);
  if (!(tEnd > 0)) return null;

  if (oy - getTerrainHeight(ox, oz) < 0) return terrainHit(ox, oy, oz, dx, dy, dz, 0);

  const STEP = 1.0;
  let prevT = 0;
  let t = 0;
  while (t < tEnd) {
    t = Math.min(t + STEP, tEnd);
    if (oy + dy * t - getTerrainHeight(ox + dx * t, oz + dz * t) < 0) {
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (oy + dy * mid - getTerrainHeight(ox + dx * mid, oz + dz * mid) < 0) hi = mid;
        else lo = mid;
      }
      return terrainHit(ox, oy, oz, dx, dy, dz, hi);
    }
    prevT = t;
  }
  return null;
}

/**
 * First solid thing along the ray, or null. Result: { dist, kind, x, y, z, nx, ny, nz }.
 * opts.terrain / opts.obstacles can be set to false to ignore that kind.
 */
export function raycastWorld(ox, oy, oz, dx, dy, dz, maxDist, opts = {}) {
  const limit = Number.isFinite(maxDist) ? maxDist : 1000;
  let best = null;
  if (opts.obstacles !== false) {
    for (const b of OBSTACLES) {
      const hit = rayAabb(ox, oy, oz, dx, dy, dz, b, limit);
      if (hit && (!best || hit.dist < best.dist)) best = hit;
    }
  }
  if (opts.terrain !== false) {
    const hit = rayTerrain(ox, oy, oz, dx, dy, dz, best ? best.dist : limit);
    if (hit && (!best || hit.dist < best.dist)) best = hit;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Movement & view helpers shared by client prediction and server validation
// ---------------------------------------------------------------------------
export function moveSpeed({ stance = 'stand', sprinting = false, boost = 0, weaponMult = 1 } = {}) {
  let speed = MOVE.baseSpeed * weaponMult;
  if (stance === 'crouch') speed *= MOVE.crouchMult;
  else if (stance === 'prone') speed *= MOVE.proneMult;
  else if (sprinting) speed *= MOVE.sprintMult; // sprint only while standing
  if (boost > MOVE.boostThreshold) speed *= MOVE.boostMult;
  return speed;
}

export function clampToMap(v, margin = 1) {
  return clamp(v, -MAP_HALF_SIZE + margin, MAP_HALF_SIZE - margin);
}

/** Camera / muzzle position for a player (includes the Q/E lean offset). */
export function getEyePosition({ x, y, z, yaw = 0, lean = 0, stance = 'stand' }) {
  const eye = EYE_HEIGHT[stance] ?? EYE_HEIGHT.stand;
  const off = lean * LEAN_OFFSET;
  return { x: x + Math.cos(yaw) * off, y: y + eye, z: z - Math.sin(yaw) * off };
}

/** Unit look direction from yaw / pitch (pitch > 0 looks up). */
export function forwardFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}
