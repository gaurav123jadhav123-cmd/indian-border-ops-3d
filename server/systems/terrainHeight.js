// Deterministic Himalayan Border Sector Heightmap & 3D Cover AABBs
// Shared math with frontend terrain so server physics, occlusion, and 3D client match 1:1.

const MAP_HALF_SIZE = 140; // 280m x 280m playable border sector

function getTerrainHeight(x, z) {
  const riverCenter = Math.sin(x * 0.03) * 14;
  const distFromRiver = Math.abs(z - riverCenter);
  const valleyDip = Math.max(0, 1 - distFromRiver / 26) * -3.2;

  const ridgeNorth = Math.max(0, (z - 35) * 0.14);
  const ridgeSouth = Math.max(0, (-z - 35) * 0.14);

  const hills =
    Math.sin(x * 0.045) * Math.cos(z * 0.045) * 4.5 +
    Math.sin(x * 0.11 + 1.3) * Math.cos(z * 0.09) * 1.6 +
    Math.cos((x + z) * 0.025) * 2.2;

  const bharatBaseDist = Math.hypot(x, z + 95);
  const opforBaseDist = Math.hypot(x, z - 95);
  const baseFlatten = bharatBaseDist < 22 || opforBaseDist < 22 ? 0.25 : 1.0;

  return hills * baseFlatten + valleyDip + ridgeNorth + ridgeSouth;
}

// Authoritative 3D Cover & Bunker Bounding Boxes (for bullet/LOS occlusion)
const BUNKERS = [
  { id: 'bunker_alpha', name: 'Bunker Alpha (West Ridge)', x: -45, z: -20, w: 8, d: 8, h: 3.4 },
  { id: 'bunker_bravo', name: 'Bunker Bravo (East Ridge)', x: 45, z: 20, w: 8, d: 8, h: 3.4 },
  { id: 'checkpoint_center', name: 'LAC Bridge Checkpoint', x: 0, z: 0, w: 12, d: 6, h: 3.2 },
  { id: 'watchtower_south', name: 'Bharat Watchtower', x: -24, z: -72, w: 5, d: 5, h: 7.2 },
  { id: 'watchtower_north', name: 'OPFOR Watchtower', x: 24, z: 72, w: 5, d: 5, h: 7.2 }
];

const COVER_WALLS = [
  { id: 'cov_1', x: -22, z: -16, w: 4.8, d: 1.5, h: 1.4 },
  { id: 'cov_2', x: 22, z: -18, w: 4.8, d: 1.5, h: 1.4 },
  { id: 'cov_3', x: -20, z: 18, w: 4.8, d: 1.5, h: 1.4 },
  { id: 'cov_4', x: 24, z: 16, w: 4.8, d: 1.5, h: 1.4 },
  { id: 'cov_5', x: 0, z: -32, w: 4.8, d: 1.5, h: 1.4 },
  { id: 'cov_6', x: 0, z: 32, w: 4.8, d: 1.5, h: 1.4 }
];

const ALL_OBSTACLES = [...BUNKERS, ...COVER_WALLS].map((o) => {
  const baseY = getTerrainHeight(o.x, o.z) - 0.15;
  return {
    id: o.id,
    minX: o.x - o.w / 2,
    maxX: o.x + o.w / 2,
    minY: baseY,
    maxY: baseY + o.h,
    minZ: o.z - o.d / 2,
    maxZ: o.z + o.d / 2
  };
});

// Ray-vs-AABB slab intersection
function rayBoxDist(origin, dir, box) {
  let tmin = -Infinity;
  let tmax = Infinity;

  const axes = [
    ['x', 'minX', 'maxX'],
    ['y', 'minY', 'maxY'],
    ['z', 'minZ', 'maxZ']
  ];

  for (const [ax, minK, maxK] of axes) {
    if (Math.abs(dir[ax]) < 1e-8) {
      if (origin[ax] < box[minK] || origin[ax] > box[maxK]) return null;
    } else {
      let t1 = (box[minK] - origin[ax]) / dir[ax];
      let t2 = (box[maxK] - origin[ax]) / dir[ax];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : tmax >= 0 ? tmax : null;
}

// Returns distance to nearest terrain ridge or bunker/cover obstacle along ray, or null
function raycastWorldOcclusion(origin, dir, maxDist) {
  let hitDist = null;

  for (const box of ALL_OBSTACLES) {
    const d = rayBoxDist(origin, dir, box);
    if (d !== null && d <= maxDist && (hitDist === null || d < hitDist)) {
      hitDist = d;
    }
  }

  // Coarse-to-fine terrain ray-march (1.5m step)
  const limit = hitDist !== null ? hitDist : maxDist;
  for (let d = 1.5; d <= limit; d += 1.5) {
    const px = origin.x + dir.x * d;
    const py = origin.y + dir.y * d;
    const pz = origin.z + dir.z * d;
    if (py <= getTerrainHeight(px, pz)) {
      return d;
    }
  }

  return hitDist;
}

module.exports = {
  MAP_HALF_SIZE,
  getTerrainHeight,
  BUNKERS,
  COVER_WALLS,
  ALL_OBSTACLES,
  raycastWorldOcclusion
};
