// Deterministic Himalayan Border Sector Heightmap & Cover Zones
// Shared math with frontend/js/terrain.js so server physics & 3D client match 1:1.

const MAP_HALF_SIZE = 140; // 280m x 280m playable border sector

function getTerrainHeight(x, z) {
  // Glacial river valley running roughly along z = 0 with gentle S-curve
  const riverCenter = Math.sin(x * 0.03) * 14;
  const distFromRiver = Math.abs(z - riverCenter);
  const valleyDip = Math.max(0, 1 - distFromRiver / 26) * -3.2;

  // Northern & Southern Himalayan Ridges
  const ridgeNorth = Math.max(0, (z - 35) * 0.14);
  const ridgeSouth = Math.max(0, (-z - 35) * 0.14);

  // Rolling mountain undulation
  const hills =
    Math.sin(x * 0.045) * Math.cos(z * 0.045) * 4.5 +
    Math.sin(x * 0.11 + 1.3) * Math.cos(z * 0.09) * 1.6 +
    Math.cos((x + z) * 0.025) * 2.2;

  // Flatten spawn bases slightly
  const bharatBaseDist = Math.hypot(x - 0, z + 95);
  const opforBaseDist = Math.hypot(x - 0, z - 95);
  const baseFlatten =
    bharatBaseDist < 22 ? 0.25 : opforBaseDist < 22 ? 0.25 : 1.0;

  return (hills * baseFlatten) + valleyDip + ridgeNorth + ridgeSouth;
}

const BUNKERS = [
  { id: 'bunker_alpha', name: 'Bunker Alpha (West Ridge)', x: -45, z: -20, w: 8, d: 8, h: 3.5 },
  { id: 'bunker_bravo', name: 'Bunker Bravo (East Ridge)', x: 45, z: 20, w: 8, d: 8, h: 3.5 },
  { id: 'checkpoint_center', name: 'LAC Bridge Checkpoint', x: 0, z: 0, w: 10, d: 6, h: 3.2 },
  { id: 'watchtower_south', name: 'Bharat Watchtower', x: -24, z: -72, w: 5, d: 5, h: 7.5 },
  { id: 'watchtower_north', name: 'Northern Watchtower', x: 24, z: 72, w: 5, d: 5, h: 7.5 }
];

module.exports = { MAP_HALF_SIZE, getTerrainHeight, BUNKERS };
