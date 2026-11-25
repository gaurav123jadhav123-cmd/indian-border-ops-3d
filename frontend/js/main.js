import * as THREE from 'three';
import { buildBorderTerrain } from './terrain.js';
import { createWeaponViewModel, playSound } from './weapons.js';
import { createSoldierMesh, animateSoldierMesh, LocalPlayerController } from './player.js';
import { createDroneMesh, applyDroneCamera } from './drones.js';
import { MobileControls } from './mobileControls.js';
import { fetchArsenal, fetchLeaderboard, loginPlayer, savePlayerLoadout, connectGameServer } from './network.js';

const lobbyScreen = document.getElementById('lobby-screen');
const hud = document.getElementById('hud');
const deployBtn = document.getElementById('deploy-btn');
const lobbyStatus = document.getElementById('lobby-status');
const primarySelect = document.getElementById('primary-select');
const secondarySelect = document.getElementById('secondary-select');
const launcherSelect = document.getElementById('launcher-select');
const weaponPreviewInfo = document.getElementById('weapon-preview-info');
const leaderboardList = document.getElementById('leaderboard-list');
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;

let arsenalData = null;
let authToken = null;
let socket = null;
let localPlayerId = null;
let activeDroneId = null;
let lastSnapshot = null;
let slotIndex = 0;
const slots = ['primary', 'secondary', 'launcher'];

let weaponRecoil = 0;
let reloadTilt = 0;
let isReloading = false;
let screenShake = 0;
let respawnTimer = null;

const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9dc0d8);
scene.fog = new THREE.FogExp2(0xcbddee, 0.0042);

const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, 600);
scene.add(camera);

const hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x3f433a, 0.9);
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xfff6e0, 1.35);
sunLight.position.set(70, 115, -55);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -95;
sunLight.shadow.camera.right = 95;
sunLight.shadow.camera.top = 95;
sunLight.shadow.camera.bottom = -95;
scene.add(sunLight);

const snowParticles = buildBorderTerrain(scene, renderer);

const controller = new LocalPlayerController(camera, canvas);
let localThirdPersonMesh = null;
let currentViewModel = null;
const remotePlayers = new Map();
const airdropMeshes = new Map();
const droneMeshes = new Map();
const grenadeMeshes = new Map();
const rocketMeshes = new Map();
const missileMeshes = new Map();
const fxList = [];
const bullets = [];

function fireWeaponOrDrone() {
  if (!socket || !localPlayerId || isReloading) return;
  if (activeDroneId) {
    socket.emit('control_drone', { detonate: true });
    return;
  }
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const origin = { x: camera.position.x, y: camera.position.y, z: camera.position.z };

  socket.emit('shoot', { origin, dir: { x: dir.x, y: dir.y, z: dir.z } });
  playSound('rifle');

  // Local firing animation: kickback, muzzle flash, bullet projectile
  weaponRecoil = 0.09;
  screenShake = 0.025;
  spawnBulletProjectile(origin, dir);

  if (currentViewModel) {
    const flash = currentViewModel.getObjectByName('muzzleFlash');
    const light = currentViewModel.getObjectByName('muzzleLight');
    if (flash) {
      flash.visible = true;
      if (light) light.visible = true;
      setTimeout(() => {
        flash.visible = false;
        if (light) light.visible = false;
      }, 55);
    }
  }
}

const mobileControls = new MobileControls({
  onLook: (dx, dy) => controller.addLookDelta(dx, dy),
  onFire: () => fireWeaponOrDrone(),
  onAds: (down) => { controller.ads = down; },
  onJump: () => controller.triggerJump(),
  onCrouch: () => controller.toggleCrouch(),
  onProne: () => controller.toggleProne(),
  onReload: () => { if (socket) socket.emit('reload'); },
  onToggleCam: () => { controller.thirdPerson = !controller.thirdPerson; },
  onSwapWeapon: () => {
    if (!socket) return;
    slotIndex = (slotIndex + 1) % slots.length;
    const slot = slots[slotIndex];
    socket.emit('switch_weapon', slot);
    const me = lastSnapshot?.players?.find((p) => p.id === localPlayerId);
    setViewModel(me?.loadout?.[slot] || 'sig716');
  },
  onFrag: () => {
    if (!socket) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    socket.emit('throw_grenade', { type: 'frag', origin: camera.position, dir });
    showAlert('Frag Grenade Thrown!');
  },
  onSmoke: () => {
    if (!socket) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    socket.emit('throw_grenade', { type: 'smoke', origin: camera.position, dir });
    showAlert('Smoke Grenade Deployed!');
  },
  onMissile: () => {
    if (!socket) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    socket.emit('call_missile', { targetX: controller.x + dir.x * 35, targetZ: controller.z + dir.z * 35 });
  },
  onFpvDrone: () => socket && socket.emit('deploy_drone', { mode: 'fpv' }),
  onReconDrone: () => socket && socket.emit('deploy_drone', { mode: 'recon' }),
  onDroneExit: () => {
    if (socket && activeDroneId) {
      socket.emit('control_drone', { exit: true });
      activeDroneId = null;
      document.getElementById('drone-overlay').classList.add('hidden');
      mobileControls.setDroneMode(false);
    }
  },
  onLean: (dir) => {
    controller._mobileLean = dir !== 0;
    controller.lean = dir;
  },
  onHeal: () => {
    if (!socket) return;
    const me = lastSnapshot?.players?.find((p) => p.id === localPlayerId);
    if (!me) return;
    if (me.hp < 50 && me.inventory.medkit > 0) socket.emit('use_heal', { item: 'medkit' });
    else if (me.hp < 75 && me.inventory.firstAid > 0) socket.emit('use_heal', { item: 'firstAid' });
    else if (me.hp < 95 && me.inventory.bandage > 0) socket.emit('use_heal', { item: 'bandage' });
    else if (me.inventory.energyDrink > 0) socket.emit('use_heal', { item: 'energyDrink' });
    else showAlert('No healing items left');
  }
});

document.getElementById('airdrop-prompt').addEventListener('click', () => {
  const promptEl = document.getElementById('airdrop-prompt');
  if (socket && !promptEl.classList.contains('hidden')) {
    socket.emit('loot_airdrop', { crateId: promptEl.dataset.crateId });
  }
});

function setViewModel(weaponId) {
  if (currentViewModel) camera.remove(currentViewModel);
  const w = arsenalData?.weapons?.[weaponId];
  currentViewModel = createWeaponViewModel(weaponId, w?.color || 0x2b2d2f);
  camera.add(currentViewModel);
}

function showAlert(msg) {
  const el = document.getElementById('alert-banner');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function showFloatingDamage(damage, headshot, worldPos) {
  const container = document.getElementById('damage-numbers');
  if (!container || !worldPos) return;
  const v = new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z);
  v.project(camera);
  if (v.z > 1) return;

  const x = (v.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
  const el = document.createElement('div');
  el.className = headshot ? 'dmg-float headshot' : 'dmg-float';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.textContent = headshot ? `-${damage} HS!` : `-${damage}`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

function spawnBulletProjectile(origin, dir) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.9),
    new THREE.MeshBasicMaterial({ color: 0xfef08a })
  );
  mesh.position.set(origin.x, origin.y - 0.05, origin.z);
  mesh.lookAt(origin.x + dir.x * 10, origin.y + dir.y * 10, origin.z + dir.z * 10);
  scene.add(mesh);
  bullets.push({
    mesh,
    vx: dir.x * 140,
    vy: dir.y * 140,
    vz: dir.z * 140,
    life: 0.45
  });
}

function spawnExplosionFx(x, y, z, radius = 8) {
  playSound('explosion');
  screenShake = Math.max(screenShake, 0.16);

  // 1. Fireball Core
  const fireball = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.42, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xff5500, transparent: true, opacity: 0.95 })
  );
  fireball.position.set(x, y + 0.6, z);
  scene.add(fireball);
  fxList.push({ mesh: fireball, life: 0.5, maxLife: 0.5, grow: 1.8 });

  // 2. Shockwave Ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.6, 1.4, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, y + 0.2, z);
  scene.add(ring);
  fxList.push({ mesh: ring, life: 0.45, maxLife: 0.45, grow: 7.5 });

  // 3. Rising Smoke Plume
  const smoke = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.35, 10, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a2d30, transparent: true, opacity: 0.78 })
  );
  smoke.position.set(x, y + 1.4, z);
  scene.add(smoke);
  fxList.push({ mesh: smoke, life: 2.2, maxLife: 2.2, grow: 1.5, rise: 3.0 });

  // 4. Flying Embers / Sparks
  for (let i = 0; i < 12; i++) {
    const spark = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.18),
      new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 1 })
    );
    spark.position.set(x, y + 0.5, z);
    scene.add(spark);
    fxList.push({
      mesh: spark,
      life: 0.7,
      maxLife: 0.7,
      vx: (Math.random() - 0.5) * 18,
      vy: 6 + Math.random() * 12,
      vz: (Math.random() - 0.5) * 18
    });
  }
}

async function initLobby() {
  try {
    arsenalData = await fetchArsenal();
    const weapons = Object.values(arsenalData.weapons);

    for (const w of weapons) {
      const opt = new Option(`${w.name} (${w.caliber})`, w.id);
      if (['assault', 'smg', 'sniper', 'lmg'].includes(w.category) && !w.airdropOnly) primarySelect.add(opt);
      else if (w.category === 'sidearm') secondarySelect.add(opt);
      else if (w.category === 'launcher') launcherSelect.add(opt);
    }

    const updatePreview = () => {
      const w = arsenalData.weapons[primarySelect.value];
      if (!w) return;
      weaponPreviewInfo.innerHTML = `<b>${w.name}</b> • ${w.caliber}<br>Damage: ${w.damage} | Mag: ${w.magSize} | Range: ${w.range}m<br>${w.description}`;
    };
    primarySelect.addEventListener('change', updatePreview);
    updatePreview();

    const lb = await fetchLeaderboard();
    leaderboardList.innerHTML = lb.leaderboard.length
      ? lb.leaderboard.map((u, i) => `<div class="lb-row"><span>#${i + 1} [${u.rank || "Sepoy"}] ${u.callsign}</span><span>${u.stats.kills} K / ${u.stats.score} PTS</span></div>`).join('')
      : '<div class="lb-row">No matches recorded yet. Deploy to set the first score!</div>';
  } catch (err) {
    lobbyStatus.textContent = 'Backend waking up — refresh in a few seconds.';
  }
}

deployBtn.addEventListener('click', async () => {
  const callsign = document.getElementById('callsign-input').value.trim() || 'ParaSF_01';
  const password = document.getElementById('password-input').value;
  const mode = document.getElementById('mode-select').value;
  const roomId = document.getElementById('room-input').value.trim() || 'border-sector-1';

  const loadout = {
    primary: primarySelect.value || 'sig716',
    secondary: secondarySelect.value || 'pistol9mm',
    launcher: launcherSelect.value || 'carlGustaf'
  };

  // Request Fullscreen + Landscape Orientation on Mobile
  if (mobileControls.enabled) {
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch (_) {}
  }

  try {
    deployBtn.disabled = true;
    lobbyStatus.textContent = 'Connecting to 5v5 Game Server...';
    const auth = await loginPlayer(callsign, password);
    authToken = auth.token;
    await savePlayerLoadout(authToken, loadout);

    socket = connectGameServer();
    bindSocketEvents({ roomId, mode, callsign: auth.user.callsign, loadout });
  } catch (err) {
    deployBtn.disabled = false;
    lobbyStatus.textContent = err.message;
  }
});

function checkOrientationHint() {
  const hint = document.getElementById('rotate-hint');
  if (!hint || !mobileControls.enabled) return;
  if (window.innerHeight > window.innerWidth) hint.classList.remove('hidden');
  else hint.classList.add('hidden');
}

function bindSocketEvents(joinPayload) {
  socket.on('connect', () => {
    lobbyStatus.textContent = 'Connected! Joining 5v5 Border Sector...';
    socket.emit('join_match', joinPayload);
  });

  socket.on('connect_error', () => {
    lobbyStatus.textContent = 'Waking up Game Server... retrying automatically.';
  });

  socket.on('match_joined', (data) => {
    localPlayerId = data.playerId;
    controller.x = data.spawn.x;
    controller.y = data.spawn.y;
    controller.z = data.spawn.z;

    localThirdPersonMesh = createSoldierMesh(data.team, data.player.callsign);
    scene.add(localThirdPersonMesh);
    setViewModel(data.player.loadout.primary);

    lobbyScreen.classList.add('hidden');
    hud.classList.remove('hidden');
    deployBtn.disabled = false;
    checkOrientationHint();

    if (mobileControls.enabled) mobileControls.show();
    else canvas.requestPointerLock();
  });

  socket.on('state_snapshot', (snap) => {
    lastSnapshot = snap;
    syncWorldState(snap);
    updateHud(snap);
    drawMinimap(snap);
    if (snap.weather === 'blizzard_fog') {
      scene.fog.density = 0.0085;
      if (snowParticles) snowParticles.visible = true;
    } else if (snap.weather === 'clear') {
      scene.fog.density = 0.0028;
      if (snowParticles) snowParticles.visible = false;
    } else {
      scene.fog.density = 0.0045;
      if (snowParticles) snowParticles.visible = true;
    }
  });

  socket.on('shot_fired', ({ shooterId, origin, dir }) => {
    if (shooterId !== localPlayerId) {
      spawnBulletProjectile(origin, dir);
    }
  });

  socket.on('reloading', () => {
    isReloading = true;
    document.getElementById('reload-status').textContent = 'RELOADING...';
  });

  socket.on('reloaded', () => {
    isReloading = false;
    document.getElementById('reload-status').textContent = '[1] Primary • [2] Sidearm • [3] Bazooka';
  });

  socket.on('hit_confirm', ({ damage, headshot, targetPos }) => {
    const hm = document.getElementById('hitmarker');
    hm.classList.remove('hidden');
    setTimeout(() => hm.classList.add('hidden'), 130);
    showFloatingDamage(damage, headshot, targetPos);
  });

  socket.on('took_damage', () => {
    const vig = document.getElementById('damage-vignette');
    vig.style.opacity = '1';
    screenShake = Math.max(screenShake, 0.08);
    setTimeout(() => { vig.style.opacity = '0'; }, 240);
  });

  socket.on('player_killed', ({ respawnSec }) => {
    let left = respawnSec || 5;
    const secEl = document.getElementById('respawn-sec');
    secEl.textContent = left;
    document.getElementById('respawn-overlay').classList.remove('hidden');
    clearInterval(respawnTimer);
    respawnTimer = setInterval(() => {
      left = Math.max(0, left - 1);
      secEl.textContent = left;
      if (left <= 0) clearInterval(respawnTimer);
    }, 1000);
  });

  socket.on('killstreak_unlocked', ({ streak, reward }) => showAlert(`${streak} KILLSTREAK: ${reward}!`));
  socket.on('heal_applied', ({ itemKey }) => showAlert(`Used ${itemKey}`));
  socket.on('explosion', ({ x, y, z, radius }) => spawnExplosionFx(x, y, z, radius));

  socket.on('smoke_deployed', ({ x, y, z }) => {
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(5.5, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xd1d5db, transparent: true, opacity: 0.72 })
    );
    smoke.position.set(x, y + 2.2, z);
    scene.add(smoke);
    fxList.push({ mesh: smoke, life: 9.0, maxLife: 9.0 });
  });

  socket.on('airdrop_spawned', (crate) => showAlert(`AIR DROP INBOUND: ${crate.zoneName}`));
  socket.on('airdrop_looted', ({ callsign, label }) => showAlert(`${callsign} looted ${label}`));
  socket.on('missile_incoming', ({ caller }) => showAlert(`INCOMING TACTICAL MISSILE by ${caller}!`));

  socket.on('drone_deployed', (drone) => {
    if (drone.ownerId === localPlayerId) {
      activeDroneId = drone.id;
      document.getElementById('drone-overlay').classList.remove('hidden');
      document.getElementById('drone-label').textContent =
        drone.mode === 'fpv' ? 'FPV ATTACK DRONE [1ST PERSON]' : 'RECON OVERWATCH DRONE [3RD PERSON]';
      mobileControls.setDroneMode(true);
    }
  });

  socket.on('kill_feed', (ev) => {
    const kf = document.getElementById('kill-feed');
    const item = document.createElement('div');
    item.className = 'kill-item';
    item.textContent = `${ev.killer} [${ev.weapon}${ev.headshot ? ' HS' : ''}] ${ev.victim}`;
    kf.prepend(item);
    if (kf.children.length > 5) kf.lastChild.remove();
  });

  socket.on('respawned', (pos) => {
    controller.x = pos.x;
    controller.y = pos.y;
    controller.z = pos.z;
    activeDroneId = null;
    isReloading = false;
    clearInterval(respawnTimer);
    document.getElementById('respawn-overlay').classList.add('hidden');
    document.getElementById('drone-overlay').classList.add('hidden');
    mobileControls.setDroneMode(false);
  });

  socket.on('match_ended', (summary) => {
    if (document.pointerLockElement) document.exitPointerLock();
    alert(`MATCH OVER! Winner: ${summary.winnerTeam.toUpperCase()} (${summary.scores.bharat} - ${summary.scores.opfor})`);
    window.location.reload();
  });
}

function drawMinimap(snap) {
  if (!minimapCtx || !localPlayerId) return;
  const w = minimapCanvas.width;
  const h = minimapCanvas.height;
  minimapCtx.clearRect(0, 0, w, h);
  minimapCtx.fillStyle = 'rgba(10, 18, 28, 0.82)';
  minimapCtx.fillRect(0, 0, w, h);

  minimapCtx.strokeStyle = 'rgba(90, 170, 212, 0.55)';
  minimapCtx.lineWidth = 3;
  minimapCtx.beginPath();
  minimapCtx.moveTo(0, h / 2);
  minimapCtx.lineTo(w, h / 2);
  minimapCtx.stroke();

  const toMap = (val) => ((val + 140) / 280) * w;

  for (const c of snap.airdrops) {
    minimapCtx.fillStyle = '#f59e0b';
    minimapCtx.fillRect(toMap(c.x) - 3, toMap(c.z) - 3, 6, 6);
  }

  const me = snap.players.find((p) => p.id === localPlayerId);
  for (const p of snap.players) {
    if (!p.alive) continue;
    const mx = toMap(p.x);
    const mz = toMap(p.z);
    if (p.id === localPlayerId) {
      minimapCtx.fillStyle = '#ffffff';
      minimapCtx.beginPath();
      minimapCtx.arc(mx, mz, 4, 0, Math.PI * 2);
      minimapCtx.fill();
    } else {
      minimapCtx.fillStyle = me && p.team === me.team ? '#4ade80' : '#ef4444';
      minimapCtx.beginPath();
      minimapCtx.arc(mx, mz, 3, 0, Math.PI * 2);
      minimapCtx.fill();
    }
  }
}

function syncWorldState(snap) {
  const seenPlayers = new Set();
  for (const p of snap.players) {
    if (p.id === localPlayerId) continue;
    seenPlayers.add(p.id);
    let mesh = remotePlayers.get(p.id);
    if (!mesh) {
      mesh = createSoldierMesh(p.team, p.callsign);
      scene.add(mesh);
      remotePlayers.set(p.id, mesh);
    }
    const moved = Math.hypot(p.x - mesh.position.x, p.z - mesh.position.z) > 0.02;
    mesh.visible = p.alive;
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = p.yaw;
    mesh.scale.y = p.stance === 'prone' ? 0.42 : p.stance === 'crouch' ? 0.72 : 1.0;
    animateSoldierMesh(mesh, moved, 0.05);
  }
  for (const [id, mesh] of remotePlayers.entries()) {
    if (!seenPlayers.has(id)) {
      scene.remove(mesh);
      remotePlayers.delete(id);
    }
  }

  const seenDrops = new Set();
  for (const c of snap.airdrops) {
    seenDrops.add(c.id);
    let mesh = airdropMeshes.get(c.id);
    if (!mesh) {
      mesh = new THREE.Group();
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.4, 1.6),
        new THREE.MeshStandardMaterial({ color: 0xea580c, roughness: 0.6 })
      );
      box.position.y = 0.7;
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.4, 14, 8),
        new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.4 })
      );
      beacon.position.y = 7;
      mesh.add(box, beacon);
      scene.add(mesh);
      airdropMeshes.set(c.id, mesh);
    }
    mesh.position.set(c.x, c.y, c.z);
  }
  for (const [id, mesh] of airdropMeshes.entries()) {
    if (!seenDrops.has(id)) {
      scene.remove(mesh);
      airdropMeshes.delete(id);
    }
  }

  const seenDrones = new Set();
  let myActiveDroneGone = activeDroneId !== null;
  for (const d of snap.drones) {
    seenDrones.add(d.id);
    if (d.id === activeDroneId) myActiveDroneGone = false;
    let mesh = droneMeshes.get(d.id);
    if (!mesh) {
      mesh = createDroneMesh(d.mode);
      scene.add(mesh);
      droneMeshes.set(d.id, mesh);
    }
    mesh.position.set(d.x, d.y, d.z);
    mesh.rotation.y = d.yaw;
  }
  if (myActiveDroneGone) {
    activeDroneId = null;
    document.getElementById('drone-overlay').classList.add('hidden');
    mobileControls.setDroneMode(false);
  }
  for (const [id, mesh] of droneMeshes.entries()) {
    if (!seenDrones.has(id)) {
      scene.remove(mesh);
      droneMeshes.delete(id);
    }
  }

  syncProjectiles(snap.grenades, grenadeMeshes, 0x16a34a, 0.2, true);
  syncProjectiles(snap.rockets || [], rocketMeshes, 0xff6b00, 0.24, false);
  syncProjectiles(snap.missiles, missileMeshes, 0xfacc15, 0.52, false);
}

function syncProjectiles(list, map, color, size, spin) {
  const seen = new Set();
  for (const item of list) {
    seen.add(item.id);
    let m = map.get(item.id);
    if (!m) {
      m = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 8), new THREE.MeshBasicMaterial({ color }));
      scene.add(m);
      map.set(item.id, m);
    }
    m.position.set(item.x, item.y, item.z);
    if (spin) m.rotation.x += 0.35;
  }
  for (const [id, m] of map.entries()) {
    if (!seen.has(id)) {
      scene.remove(m);
      map.delete(id);
    }
  }
}

function updateHud(snap) {
  document.getElementById('score-bharat').textContent = snap.scores.bharat;
  document.getElementById('score-opfor').textContent = snap.scores.opfor;
  const mins = String(Math.floor(snap.timeLeftSec / 60)).padStart(2, '0');
  const secs = String(snap.timeLeftSec % 60).padStart(2, '0');
  document.getElementById('match-timer').textContent = `${mins}:${secs}`;

  const me = snap.players.find((p) => p.id === localPlayerId);
  if (!me) return;

  document.getElementById('hp-val').textContent = me.hp;
  document.getElementById('hp-bar').style.width = `${me.hp}%`;
  document.getElementById('armor-val').textContent = Math.round(me.armor);
  document.getElementById('armor-bar').style.width = `${me.armor}%`;
  document.getElementById('boost-val').textContent = Math.round(me.boost);
  document.getElementById('boost-bar').style.width = `${me.boost}%`;
  document.getElementById('stance-val').textContent = me.stance.toUpperCase();
  document.getElementById('cam-val').textContent = controller.thirdPerson ? '3RD' : '1ST';

  const weaponId = me.loadout[me.activeSlot];
  const stats = arsenalData?.weapons?.[weaponId];
  document.getElementById('weapon-name').textContent = stats ? stats.name : weaponId;
  document.getElementById('ammo-val').textContent = me.ammo[me.activeSlot];
  document.getElementById('mag-val').textContent = stats ? stats.magSize : 20;

  document.getElementById('gear-frag').innerHTML = `[G] Frag: <b>${me.inventory.frag}</b>`;
  document.getElementById('gear-smoke').innerHTML = `[T] Smoke: <b>${me.inventory.smoke}</b>`;
  document.getElementById('gear-missile').innerHTML = `[4] Missile: <b>${me.inventory.missileReady ? 'RDY' : 'CD'}</b>`;
  document.getElementById('gear-fpv').innerHTML = `[5] FPV: <b>${me.inventory.fpvDroneReady ? 'RDY' : 'CD'}</b>`;
  document.getElementById('gear-recon').innerHTML = `[6] Recon: <b>${me.inventory.reconDroneReady ? 'RDY' : 'CD'}</b>`;

  const nearDrop = snap.airdrops.find((c) => c.landed && Math.hypot(c.x - me.x, c.z - me.z) < 5);
  const promptEl = document.getElementById('airdrop-prompt');
  if (nearDrop) {
    promptEl.classList.remove('hidden');
    promptEl.dataset.crateId = nearDrop.id;
  } else {
    promptEl.classList.add('hidden');
  }
}

canvas.addEventListener('click', () => {
  if (!mobileControls.enabled && !hud.classList.contains('hidden') && !controller.locked) {
    canvas.requestPointerLock();
  }
});

window.addEventListener('mousedown', (e) => {
  if (!controller.locked || !socket) return;
  if (e.button === 2) controller.ads = true;
  if (e.button === 0) fireWeaponOrDrone();
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 2) controller.ads = false;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (!socket || !localPlayerId) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  if (e.code === 'Digit1') { socket.emit('switch_weapon', 'primary'); setViewModel(lastSnapshot?.players?.find(p => p.id === localPlayerId)?.loadout.primary || 'sig716'); }
  if (e.code === 'Digit2') { socket.emit('switch_weapon', 'secondary'); setViewModel('pistol9mm'); }
  if (e.code === 'Digit3') { socket.emit('switch_weapon', 'launcher'); setViewModel('carlGustaf'); }
  if (e.code === 'KeyR') socket.emit('reload');
  if (e.code === 'KeyG') socket.emit('throw_grenade', { type: 'frag', origin: camera.position, dir });
  if (e.code === 'KeyT') socket.emit('throw_grenade', { type: 'smoke', origin: camera.position, dir });
  if (e.code === 'Digit4') socket.emit('call_missile', { targetX: controller.x + dir.x * 35, targetZ: controller.z + dir.z * 35 });
  if (e.code === 'Digit5') socket.emit('deploy_drone', { mode: 'fpv' });
  if (e.code === 'Digit6') socket.emit('deploy_drone', { mode: 'recon' });
  if (e.code === 'KeyX' && activeDroneId) socket.emit('control_drone', { detonate: true });
  if (e.code === 'Escape' && activeDroneId) {
    socket.emit('control_drone', { exit: true });
    activeDroneId = null;
    document.getElementById('drone-overlay').classList.add('hidden');
  }
  if (e.code === 'Digit7') socket.emit('use_heal', { item: 'bandage' });
  if (e.code === 'Digit8') socket.emit('use_heal', { item: 'firstAid' });
  if (e.code === 'Digit9') socket.emit('use_heal', { item: 'medkit' });
  if (e.code === 'Digit0') socket.emit('use_heal', { item: 'energyDrink' });
  if (e.code === 'KeyF') {
    const promptEl = document.getElementById('airdrop-prompt');
    if (!promptEl.classList.contains('hidden')) {
      socket.emit('loot_airdrop', { crateId: promptEl.dataset.crateId });
    }
  }
});

let prevTime = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - prevTime) / 1000);
  prevTime = now;

  controller.virtualMoveX = mobileControls.moveX;
  controller.virtualMoveY = mobileControls.moveY;

  if (localPlayerId && socket) {
    const me = lastSnapshot?.players?.find((p) => p.id === localPlayerId);
    const activeDrone = activeDroneId && lastSnapshot?.drones?.find((d) => d.id === activeDroneId);

    if (activeDrone) {
      socket.emit('control_drone', {
        forward: !!controller.keys.KeyW || mobileControls.moveY > 0.2,
        backward: !!controller.keys.KeyS || mobileControls.moveY < -0.2,
        left: !!controller.keys.KeyA || mobileControls.moveX < -0.2,
        right: !!controller.keys.KeyD || mobileControls.moveX > 0.2,
        up: !!controller.keys.Space || mobileControls.droneUp,
        down: !!controller.keys.ShiftLeft || mobileControls.droneDown,
        yaw: controller.yaw,
        pitch: controller.pitch
      });
      applyDroneCamera(camera, activeDrone);
      if (currentViewModel) currentViewModel.visible = false;
    } else {
      const wId = me?.loadout?.[me.activeSlot];
      const mult = arsenalData?.weapons?.[wId]?.moveSpeedMult || 1.0;
      const moveState = controller.update(dt, me?.boost || 0, mult, false);
      socket.emit('player_move', moveState);

      if (currentViewModel) {
        currentViewModel.visible = !controller.thirdPerson;
        // Weapon firing recoil + reload tilt animation
        weaponRecoil *= 0.8;
        const targetTilt = isReloading ? -0.55 : 0;
        reloadTilt += (targetTilt - reloadTilt) * 0.2;
        currentViewModel.position.set(controller.ads ? 0 : 0.24, -0.22 + reloadTilt * 0.15, -0.45 + weaponRecoil);
        currentViewModel.rotation.x = weaponRecoil * 1.4 + reloadTilt;
      }

      if (localThirdPersonMesh) {
        localThirdPersonMesh.visible = controller.thirdPerson;
        localThirdPersonMesh.position.set(controller.x, controller.y, controller.z);
        localThirdPersonMesh.rotation.y = controller.yaw;
      }
    }
  }

  // Camera shake decay
  if (screenShake > 0.002) {
    camera.position.x += (Math.random() - 0.5) * screenShake;
    camera.position.y += (Math.random() - 0.5) * screenShake;
    screenShake *= 0.82;
  }

  // Flying bullet projectiles
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    b.mesh.position.x += b.vx * dt;
    b.mesh.position.y += b.vy * dt;
    b.mesh.position.z += b.vz * dt;
    if (b.life <= 0) {
      scene.remove(b.mesh);
      bullets.splice(i, 1);
    }
  }

  // Multi-stage explosions & smoke FX
  for (let i = fxList.length - 1; i >= 0; i--) {
    const fx = fxList[i];
    fx.life -= dt;
    if (fx.grow) fx.mesh.scale.addScalar(fx.grow * dt * 4);
    if (fx.rise) fx.mesh.position.y += fx.rise * dt;
    if (fx.vx !== undefined) {
      fx.mesh.position.x += fx.vx * dt;
      fx.mesh.position.y += fx.vy * dt;
      fx.mesh.position.z += fx.vz * dt;
      fx.vy -= 22 * dt;
    }
    if (fx.mesh.material.opacity !== undefined) {
      fx.mesh.material.opacity = Math.max(0, fx.life / fx.maxLife);
    }
    if (fx.life <= 0) {
      scene.remove(fx.mesh);
      fxList.splice(i, 1);
    }
  }

  if (snowParticles) {
    snowParticles.position.y -= dt * 1.6;
    if (snowParticles.position.y < -15) snowParticles.position.y = 15;
  }

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  checkOrientationHint();
});

initLobby();
requestAnimationFrame(animate);
