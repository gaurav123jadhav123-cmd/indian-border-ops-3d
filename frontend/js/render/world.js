// The battlefield: Himalayan terrain, the mountains beyond it, sky, border fence, bunkers, flags.
// Heights and bunker boxes come from shared/world.js - the same code the server uses for
// collisions - so what you see is exactly what you bump into.
import * as THREE from 'three';
import { MAP_HALF_SIZE, OBSTACLES, getTerrainHeight } from '../shared/world.js';

export const SKY_HORIZON = 0x9dc0d8;
const SKY_ZENITH = 0x4d82b8;

const hash = (x, z) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/** Himalayan colouring by height: glacial ice -> slate -> granite -> snow, with a little grain. */
export function terrainColor(y, x = 0, z = 0) {
  let r;
  let g;
  let b;
  if (y < -1.4) [r, g, b] = [0.45, 0.68, 0.82];       // frozen river ice
  else if (y < 4.5) [r, g, b] = [0.42, 0.39, 0.34];   // rocky slate
  else if (y < 10.5) [r, g, b] = [0.55, 0.54, 0.52];  // high-altitude granite
  else [r, g, b] = [0.90, 0.94, 0.98];                 // snow-capped peaks
  const grain = (hash(x, z) - 0.5) * 0.07;
  return [Math.min(1, Math.max(0, r + grain)), Math.min(1, Math.max(0, g + grain)), Math.min(1, Math.max(0, b + grain))];
}

function fillHeights(geo, heightOf) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const { y, drawnY } = heightOf(x, z);
    pos.setY(i, y);
    const c = terrainColor(drawnY, x, z);
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

export function buildWorld({ scene, quality }) {
  const disposables = [];
  const added = [];
  const track = (obj) => { disposables.push(obj); return obj; };
  const add = (obj) => { scene.add(obj); added.push(obj); return obj; };

  const terrainMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.05 }));

  // --- the playable sector -------------------------------------------------
  const size = MAP_HALF_SIZE * 2;
  const terrainGeo = track(new THREE.PlaneGeometry(size, size, quality.terrainSegments, quality.terrainSegments));
  terrainGeo.rotateX(-Math.PI / 2);
  fillHeights(terrainGeo, (x, z) => { const y = getTerrainHeight(x, z); return { y, drawnY: y }; });
  const terrain = add(new THREE.Mesh(terrainGeo, terrainMat));
  terrain.receiveShadow = true;

  // --- mountains beyond the border, so there is no void at the edge -------------
  // Same height function, coarser grid. Under the playable sector it sits 1m lower (hidden),
  // at the edge it meets the terrain exactly.
  const ringHalf = 300;
  const ringGeo = track(new THREE.PlaneGeometry(ringHalf * 2, ringHalf * 2, quality.ringSegments, quality.ringSegments));
  ringGeo.rotateX(-Math.PI / 2);
  fillHeights(ringGeo, (x, z) => {
    const inside = Math.max(Math.abs(x), Math.abs(z)) < MAP_HALF_SIZE - 1e-6;
    const y = getTerrainHeight(x, z);
    return { y: y - (inside ? 1 : 0), drawnY: y };
  });
  add(new THREE.Mesh(ringGeo, terrainMat));

  // --- sky dome (follows the camera) ------------------------------------------
  const skyGeo = track(new THREE.SphereGeometry(quality.skyRadius, 24, 12));
  const sp = skyGeo.attributes.position;
  const skyColors = new Float32Array(sp.count * 3);
  const horizon = new THREE.Color(SKY_HORIZON);
  const zenith = new THREE.Color(SKY_ZENITH);
  for (let i = 0; i < sp.count; i++) {
    const t = Math.pow(Math.min(1, Math.max(0, sp.getY(i) / quality.skyRadius)), 0.55);
    skyColors[i * 3] = horizon.r + (zenith.r - horizon.r) * t;
    skyColors[i * 3 + 1] = horizon.g + (zenith.g - horizon.g) * t;
    skyColors[i * 3 + 2] = horizon.b + (zenith.b - horizon.b) * t;
  }
  skyGeo.setAttribute('color', new THREE.BufferAttribute(skyColors, 3));
  const skyMat = track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  const sky = add(new THREE.Mesh(skyGeo, skyMat));
  sky.frustumCulled = false;
  sky.renderOrder = -10;

  // --- border fence along the LAC (leaving a gap at the bridge) --------------------
  const postMat = track(new THREE.MeshStandardMaterial({ color: 0x3f4752, roughness: 0.7 }));
  const postGeo = track(new THREE.CylinderGeometry(0.12, 0.14, 3.2, 6));
  const postXs = [];
  for (let x = -120; x <= 120; x += 12) if (Math.abs(x) >= 10) postXs.push(x);
  const posts = add(new THREE.InstancedMesh(postGeo, postMat, postXs.length));
  const dummy = new THREE.Object3D();
  postXs.forEach((x, i) => {
    const z = Math.sin(x * 0.03) * 14 + 6;
    dummy.position.set(x, getTerrainHeight(x, z) + 1.6, z);
    dummy.updateMatrix();
    posts.setMatrixAt(i, dummy.matrix);
  });
  posts.instanceMatrix.needsUpdate = true;
  posts.castShadow = quality.shadows;
  posts.frustumCulled = false;

  const wirePts = [];
  for (let x = -130; x <= 130; x += 5) {
    const z = Math.sin(x * 0.03) * 14 + 6;
    wirePts.push(new THREE.Vector3(x, getTerrainHeight(x, z) + 2.5, z));
  }
  const wireGeo = track(new THREE.BufferGeometry().setFromPoints(wirePts));
  add(new THREE.Line(wireGeo, track(new THREE.LineBasicMaterial({ color: 0x8b9bb0 }))));

  // --- bunkers, checkpoint, watchtowers, sandbags (from the collision boxes) -----------
  const concreteMat = track(new THREE.MeshStandardMaterial({ color: 0x62676b, roughness: 0.9 }));
  const roofMat = track(new THREE.MeshStandardMaterial({ color: 0x3d4247, roughness: 0.85 }));
  const sandbagMat = track(new THREE.MeshStandardMaterial({ color: 0x8c7b5b, roughness: 0.95 }));
  for (const b of OBSTACLES) {
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const d = b.maxZ - b.minZ;
    const geo = track(new THREE.BoxGeometry(w, h, d));
    const mesh = add(new THREE.Mesh(geo, b.kind === 'sandbags' ? sandbagMat : concreteMat));
    mesh.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    mesh.castShadow = quality.shadows;
    mesh.receiveShadow = quality.shadows;
    if (b.kind === 'structure') {
      const roofGeo = track(new THREE.BoxGeometry(w + 0.6, 0.3, d + 0.6));
      const roof = add(new THREE.Mesh(roofGeo, roofMat));
      roof.position.set(mesh.position.x, b.maxY + 0.15, mesh.position.z);
      roof.castShadow = quality.shadows;
    }
  }

  // --- flags: Indian tricolour at the Bharat base, red banner at the OPFOR base ----------
  function flag(baseX, baseZ, bands) {
    const gy = getTerrainHeight(baseX, baseZ);
    const side = baseX < 0 ? 1 : -1; // flag hangs toward the middle of the base
    const pole = add(new THREE.Mesh(track(new THREE.CylinderGeometry(0.1, 0.1, 9, 8)), postMat));
    pole.position.set(baseX, gy + 4.5, baseZ);
    bands.forEach((color, i) => {
      const band = add(new THREE.Mesh(
        track(new THREE.BoxGeometry(3.2, 0.7, 0.08)),
        track(new THREE.MeshStandardMaterial({ color }))
      ));
      band.position.set(baseX + side * 1.6, gy + 8.6 - i * 0.7, baseZ);
    });
  }
  flag(-8, -95, [0xff9933, 0xffffff, 0x138808]);
  flag(8, 95, [0xb91c1c, 0x7f1d1d, 0xb91c1c]);

  return {
    sky,
    /** Keep the sky centred on the camera so it never gets closer or further away. */
    follow(x, y, z) {
      sky.position.set(x, y, z);
    },
    dispose() {
      for (const obj of added) scene.remove(obj);
      for (const d of disposables) d.dispose?.();
      added.length = 0;
      disposables.length = 0;
    }
  };
}
