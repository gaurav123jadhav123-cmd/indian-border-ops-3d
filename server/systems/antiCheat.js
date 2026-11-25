const { MAP_HALF_SIZE, getTerrainHeight } = require('./terrainHeight');
const { WEAPON_STATS } = require('./ballistics');

function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function validateAndClampMove(player, state, dtSec = 0.05) {
  if (!state || !isFiniteNum(state.x) || !isFiniteNum(state.z)) {
    return null;
  }

  const weaponId = player.loadout[player.activeSlot] || 'sig716';
  const wMult = (WEAPON_STATS[weaponId] && WEAPON_STATS[weaponId].moveSpeedMult) || 1.0;
  const boostMult = player.boost > 20 ? 1.15 : 1.0;
  const maxSpeed = 12.5 * wMult * boostMult; // Generous margin for network jitter
  const maxStep = Math.max(2.5, maxSpeed * Math.max(0.05, dtSec) * 2.2);

  const dx = state.x - player.x;
  const dz = state.z - player.z;
  const dist = Math.hypot(dx, dz);

  let nextX = state.x;
  let nextZ = state.z;
  if (dist > maxStep) {
    nextX = player.x + (dx / dist) * maxStep;
    nextZ = player.z + (dz / dist) * maxStep;
  }

  nextX = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, nextX));
  nextZ = Math.max(-MAP_HALF_SIZE, Math.min(MAP_HALF_SIZE, nextZ));

  const groundY = getTerrainHeight(nextX, nextZ);
  let nextY = isFiniteNum(state.y) ? state.y : groundY;
  // Prevent fly-hacking above terrain jump height
  if (nextY < groundY - 0.5) nextY = groundY;
  if (nextY > groundY + 6.5) nextY = groundY + 6.5;

  const validStances = ['stand', 'crouch', 'prone'];
  return {
    x: nextX,
    y: nextY,
    z: nextZ,
    yaw: isFiniteNum(state.yaw) ? state.yaw : player.yaw,
    pitch: isFiniteNum(state.pitch) ? Math.max(-1.5, Math.min(1.5, state.pitch)) : player.pitch,
    stance: validStances.includes(state.stance) ? state.stance : 'stand',
    lean: isFiniteNum(state.lean) ? Math.max(-1, Math.min(1, state.lean)) : 0,
    sprinting: !!state.sprinting
  };
}

function validateShotPayload(data) {
  if (!data || !data.origin || !data.dir) return false;
  const { origin, dir } = data;
  return (
    isFiniteNum(origin.x) && isFiniteNum(origin.y) && isFiniteNum(origin.z) &&
    isFiniteNum(dir.x) && isFiniteNum(dir.y) && isFiniteNum(dir.z) &&
    Math.hypot(dir.x, dir.y, dir.z) > 0.001
  );
}

module.exports = { isFiniteNum, validateAndClampMove, validateShotPayload };
