import * as THREE from 'three';

export const MAP_HALF_SIZE = 140;

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

function createHighResGroundMaps(maxAniso = 8) {
  const size = 1024;
  const albedoCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  albedoCanvas.width = bumpCanvas.width = size;
  albedoCanvas.height = bumpCanvas.height = size;

  const actx = albedoCanvas.getContext('2d');
  const bctx = bumpCanvas.getContext('2d');

  actx.fillStyle = '#8b8b8b';
  actx.fillRect(0, 0, size, size);
  bctx.fillStyle = '#808080';
  bctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 32000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const w = 1 + Math.random() * 5;
    const h = 1 + Math.random() * 3;
    const shade = 92 + Math.floor(Math.random() * 80);
    actx.fillStyle = `rgb(${shade},${shade - 2},${shade - 4})`;
    actx.fillRect(x, y, w, h);

    const b = 75 + Math.floor(Math.random() * 120);
    bctx.fillStyle = `rgb(${b},${b},${b})`;
    bctx.fillRect(x, y, w, h);
  }

  const albedoTex = new THREE.CanvasTexture(albedoCanvas);
  const bumpTex = new THREE.CanvasTexture(bumpCanvas);
  for (const t of [albedoTex, bumpTex]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(44, 44);
    t.anisotropy = maxAniso;
  }
  return { albedoTex, bumpTex };
}

function createSkyDome(scene) {
  const skyGeo = new THREE.SphereGeometry(440, 32, 24);
  const pos = skyGeo.attributes.position;
  const cols = [];
  const topCol = new THREE.Color(0x0d2c54);
  const midCol = new THREE.Color(0x4b8bc2);
  const horCol = new THREE.Color(0xe6f0fa);

  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.max(0, Math.min(1, y / 290));
    const c = t < 0.32
      ? horCol.clone().lerp(midCol, t / 0.32)
      : midCol.clone().lerp(topCol, (t - 0.32) / 0.68);
    cols.push(c.r, c.g, c.b);
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  scene.add(new THREE.Mesh(
    skyGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })
  ));

  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(11, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xfffbeb, fog: false })
  );
  sun.position.set(120, 175, -160);
  scene.add(sun);
}

function buildMilitaryVehicle(scene, x, z, yaw, color = 0x3f4a32) {
  const y = getTerrainHeight(x, z);
  const v = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.25 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181a, roughness: 0.92 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.8, roughness: 0.15 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 4.4), bodyMat);
  chassis.position.y = 0.85;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.85, 2.2), bodyMat);
  cab.position.set(0, 1.65, -0.3);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.55, 0.1), glassMat);
  windshield.position.set(0, 1.68, -1.41);

  for (const [wx, wz] of [[-1.1, -1.4], [1.1, -1.4], [-1.1, 1.4], [1.1, 1.4]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.35, 14), tireMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.45, wz);
    v.add(wheel);
  }
  v.add(chassis, cab, windshield);
  v.position.set(x, y, z);
  v.rotation.y = yaw;
  v.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(v);
}

function buildOpenBunker(scene, x, z, w, h, d, concreteMat, roofMat, sandbagMat) {
  const y = getTerrainHeight(x, z);
  const g = new THREE.Group();

  // Floor & Roof Slab
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), concreteMat);
  floor.position.y = 0.15;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, 0.45, d + 0.8), roofMat);
  roof.position.y = h;
  g.add(floor, roof);

  // Corner Pillars + Half-Height Firing Parapet Walls (walkable doorways!)
  for (const [px, pz] of [[-w / 2 + 0.4, -d / 2 + 0.4], [w / 2 - 0.4, -d / 2 + 0.4], [-w / 2 + 0.4, d / 2 - 0.4], [w / 2 - 0.4, d / 2 - 0.4]]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.8, h, 0.8), concreteMat);
    pillar.position.set(px, h / 2, pz);
    g.add(pillar);
  }

  const wallFront = new THREE.Mesh(new THREE.BoxGeometry(w - 1.4, 1.2, 0.45), concreteMat);
  wallFront.position.set(0, 0.6, -d / 2 + 0.3);
  const wallBack = new THREE.Mesh(new THREE.BoxGeometry(w - 1.4, 1.2, 0.45), concreteMat);
  wallBack.position.set(0, 0.6, d / 2 - 0.3);
  g.add(wallFront, wallBack);

  // Stacked Sandbag Row
  for (let i = -3; i <= 3; i++) {
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.42, 0.6), sandbagMat);
    bag.position.set(i * 0.92, 0.25, d / 2 + 1.1);
    g.add(bag);
  }

  g.position.set(x, y - 0.15, z);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(g);
}

export function buildBorderTerrain(scene, renderer) {
  createSkyDome(scene);
  const maxAniso = renderer ? Math.min(16, renderer.capabilities.getMaxAnisotropy()) : 4;
  const { albedoTex, bumpTex } = createHighResGroundMaps(maxAniso);

  const size = MAP_HALF_SIZE * 2;
  const segments = 180;
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = [];

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = getTerrainHeight(x, z);
    pos.setY(i, y);

    const noise = (Math.sin(x * 0.35) + Math.cos(z * 0.35)) * 0.03;
    if (y < -1.5) colors.push(0.26, 0.48, 0.66);
    else if (y < 0.8) colors.push(0.35 + noise, 0.41 + noise, 0.30);
    else if (y < 5.5) colors.push(0.44 + noise, 0.40 + noise, 0.35);
    else if (y < 10.5) colors.push(0.55 + noise, 0.55 + noise, 0.57);
    else colors.push(0.95, 0.97, 1.0);
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const terrainMesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: albedoTex,
      bumpMap: bumpTex,
      bumpScale: 0.7,
      roughness: 0.88,
      metalness: 0.05
    })
  );
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // Reflective Glacial River
  const riverMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, 36),
    new THREE.MeshStandardMaterial({
      color: 0x5aaad4,
      roughness: 0.08,
      metalness: 0.55,
      transparent: true,
      opacity: 0.78
    })
  );
  riverMesh.rotation.x = -Math.PI / 2;
  riverMesh.position.set(0, -1.65, 0);
  riverMesh.receiveShadow = true;
  scene.add(riverMesh);

  // LAC Border Perimeter Fence
  const postMat = new THREE.MeshStandardMaterial({ color: 0x3b424d, roughness: 0.5, metalness: 0.6 });
  const wireMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
  for (let x = -124; x <= 124; x += 10) {
    if (Math.abs(x) < 10) continue;
    const z = Math.sin(x * 0.03) * 14 + 6;
    const y = getTerrainHeight(x, z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 3.2, 8), postMat);
    post.position.set(x, y + 1.6, z);
    post.castShadow = true;
    scene.add(post);
  }
  const linePts = [];
  for (let x = -130; x <= 130; x += 5) {
    const z = Math.sin(x * 0.03) * 14 + 6;
    linePts.push(new THREE.Vector3(x, getTerrainHeight(x, z) + 2.6, z));
  }
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), wireMat));

  // Himalayan Pines & Craggy Rocks
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3525, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x1f402b, roughness: 0.85 });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b7075, bumpMap: bumpTex, bumpScale: 0.45, roughness: 0.9 });

  for (let i = 0; i < 110; i++) {
    const tx = Math.sin(i * 19.7) * 124;
    const tz = Math.cos(i * 31.3) * 120;
    const ty = getTerrainHeight(tx, tz);
    if (ty < -0.5 || ty > 11 || (Math.abs(tx) < 15 && Math.abs(tz) < 15)) continue;

    if (i % 2 === 0) {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 2.2, 8), trunkMat);
      trunk.position.y = 1.1;
      const c1 = new THREE.Mesh(new THREE.ConeGeometry(1.75, 3.2, 9), leafMat);
      c1.position.y = 3.0;
      const c2 = new THREE.Mesh(new THREE.ConeGeometry(1.35, 2.6, 9), leafMat);
      c2.position.y = 4.4;
      const c3 = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.0, 9), leafMat);
      c3.position.y = 5.6;
      tree.add(trunk, c1, c2, c3);
      tree.position.set(tx, ty - 0.1, tz);
      tree.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      scene.add(tree);
    } else {
      const s = 0.8 + (i % 4) * 0.45;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 1), rockMat);
      rock.position.set(tx, ty + s * 0.35, tz);
      rock.rotation.set(i, i * 0.7, 0);
      rock.castShadow = true;
      rock.receiveShadow = true;
      scene.add(rock);
    }
  }

  // Open Walkable Bunkers & Watchtowers
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0x5c6268, bumpMap: bumpTex, bumpScale: 0.25, roughness: 0.88 });
  const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x917f5e, roughness: 0.95 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x333940, roughness: 0.6, metalness: 0.35 });

  buildOpenBunker(scene, -45, -20, 8, 3.4, 8, concreteMat, roofMat, sandbagMat);
  buildOpenBunker(scene, 45, 20, 8, 3.4, 8, concreteMat, roofMat, sandbagMat);
  buildOpenBunker(scene, 0, 0, 12, 3.2, 6, concreteMat, roofMat, sandbagMat);
  buildOpenBunker(scene, -24, -72, 5, 7.2, 5, concreteMat, roofMat, sandbagMat);
  buildOpenBunker(scene, 24, 72, 5, 7.2, 5, concreteMat, roofMat, sandbagMat);

  // Armored Patrol Vehicles near Outposts
  buildMilitaryVehicle(scene, -16, -64, 0.3, 0x3f4a32);
  buildMilitaryVehicle(scene, 18, 64, Math.PI - 0.2, 0x453b35);

  // Indian Tricolor Outpost Flag at Bharat Base
  const flagY = getTerrainHeight(0, -76);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 9.5, 10), postMat);
  pole.position.set(-8, flagY + 4.75, -76);
  pole.castShadow = true;
  scene.add(pole);

  const saffron = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.72, 0.08), new THREE.MeshStandardMaterial({ color: 0xff9933 }));
  saffron.position.set(-6.3, flagY + 9.0, -76);
  const white = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.72, 0.08), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  white.position.set(-6.3, flagY + 8.28, -76);
  const green = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.72, 0.08), new THREE.MeshStandardMaterial({ color: 0x138808 }));
  green.position.set(-6.3, flagY + 7.56, -76);
  scene.add(saffron, white, green);

  // Ambient Snow Particles
  const snowCount = 1200;
  const snowPos = new Float32Array(snowCount * 3);
  for (let i = 0; i < snowCount; i++) {
    snowPos[i * 3] = (Math.random() - 0.5) * 240;
    snowPos[i * 3 + 1] = Math.random() * 45;
    snowPos[i * 3 + 2] = (Math.random() - 0.5) * 240;
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snowPoints = new THREE.Points(
    snowGeo,
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.26, transparent: true, opacity: 0.65 })
  );
  scene.add(snowPoints);
  return snowPoints;
}
