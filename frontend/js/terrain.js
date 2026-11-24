import * as THREE from 'three';

export const MAP_HALF_SIZE = 140;

// Must match server/systems/terrainHeight.js 1:1
export function getTerrainHeight(x, z) {
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

export function buildBorderTerrain(scene) {
  const size = MAP_HALF_SIZE * 2;
  const segments = 128;
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = [];

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = getTerrainHeight(x, z);
    pos.setY(i, y);

    // Height-based Himalayan coloring: glacial river -> rocky pass -> snow ridges
    if (y < -1.4) {
      colors.push(0.45, 0.68, 0.82); // Frozen river ice
    } else if (y < 4.5) {
      colors.push(0.42, 0.39, 0.34); // Rocky mountain slate
    } else if (y < 10.5) {
      colors.push(0.55, 0.54, 0.52); // High-altitude granite
    } else {
      colors.push(0.90, 0.94, 0.98); // Snow-capped peaks
    }
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.05
  });
  const terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // Border Perimeter Fence & Barbed Wire Posts along LAC (z = 0 river line)
  const postMat = new THREE.MeshStandardMaterial({ color: 0x3f4752, roughness: 0.7 });
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x8b9bb0 });
  for (let x = -120; x <= 120; x += 12) {
    if (Math.abs(x) < 10) continue; // Center bridge gap
    const z = Math.sin(x * 0.03) * 14 + 6;
    const y = getTerrainHeight(x, z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 3.2, 6), postMat);
    post.position.set(x, y + 1.6, z);
    post.castShadow = true;
    scene.add(post);
  }
  // Border line marker
  const linePts = [];
  for (let x = -130; x <= 130; x += 5) {
    const z = Math.sin(x * 0.03) * 14 + 6;
    linePts.push(new THREE.Vector3(x, getTerrainHeight(x, z) + 2.5, z));
  }
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), wireMat));

  // Concrete Bunkers & Watchtowers
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0x62676b, roughness: 0.9 });
  const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x8c7b5b, roughness: 0.95 });

  const structures = [
    { x: -45, z: -20, w: 8, h: 3.5, d: 8 },
    { x: 45, z: 20, w: 8, h: 3.5, d: 8 },
    { x: 0, z: 0, w: 10, h: 3.2, d: 6 },
    { x: -24, z: -72, w: 5, h: 7.5, d: 5 },
    { x: 24, z: 72, w: 5, h: 7.5, d: 5 }
  ];

  for (const s of structures) {
    const y = getTerrainHeight(s.x, s.z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), concreteMat);
    mesh.position.set(s.x, y + s.h / 2 - 0.3, s.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Sandbag cover ring
    const bag = new THREE.Mesh(new THREE.BoxGeometry(s.w + 2, 1.1, 1.2), sandbagMat);
    bag.position.set(s.x, y + 0.55, s.z + s.d / 2 + 1.2);
    bag.castShadow = true;
    scene.add(bag);
  }

  // Indian Tricolor Outpost Flag at Bharat Base (z = -95)
  const flagY = getTerrainHeight(0, -95);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 9, 8), postMat);
  pole.position.set(-8, flagY + 4.5, -95);
  scene.add(pole);

  const saffron = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.7, 0.08), new THREE.MeshStandardMaterial({ color: 0xff9933 }));
  saffron.position.set(-6.4, flagY + 8.6, -95);
  const white = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.7, 0.08), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  white.position.set(-6.4, flagY + 7.9, -95);
  const green = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.7, 0.08), new THREE.MeshStandardMaterial({ color: 0x138808 }));
  green.position.set(-6.4, flagY + 7.2, -95);
  scene.add(saffron, white, green);
}
