// Things that fly, fall or sit on the ground: air-drop crates, drones, grenades, rockets and
// incoming missiles. The server sends their positions 20 times a second; between two snapshots
// they are moved along their known velocity so they glide instead of stuttering.
import * as THREE from 'three';

const MAX_EXTRAPOLATE_S = 0.12;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Keeps a Map of views in step with a list from the snapshot. */
function syncMap(map, list, create, update, destroy) {
  const seen = new Set();
  for (const item of list) {
    seen.add(item.id);
    let entry = map.get(item.id);
    if (!entry) {
      entry = create(item);
      map.set(item.id, entry);
    }
    update(entry, item);
  }
  for (const [id, entry] of map) {
    if (!seen.has(id)) {
      destroy(entry);
      map.delete(id);
    }
  }
}

export class EntityRenderer {
  constructor({ scene }) {
    this.scene = scene;
    this.time = 0;
    this.crates = new Map();
    this.drones = new Map();
    this.grenades = new Map();
    this.rockets = new Map();
    this.missiles = new Map();

    const g = (geo) => geo;
    this.geo = {
      crate: g(new THREE.BoxGeometry(1.6, 1.4, 1.6)),
      beacon: g(new THREE.CylinderGeometry(0.15, 0.4, 14, 8)),
      canopy: g(new THREE.SphereGeometry(2.4, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2)),
      line: g(new THREE.CylinderGeometry(0.02, 0.02, 3, 4)),
      droneBody: g(new THREE.BoxGeometry(0.5, 0.12, 0.5)),
      arm: g(new THREE.BoxGeometry(0.9, 0.04, 0.06)),
      rotor: g(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 10)),
      warhead: g(new THREE.CylinderGeometry(0.1, 0.1, 0.3, 8)),
      lens: g(new THREE.SphereGeometry(0.1, 8, 8)),
      grenade: g(new THREE.SphereGeometry(0.11, 8, 8)),
      rocketBody: g(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8)),
      rocketGlow: g(new THREE.ConeGeometry(0.1, 0.9, 8)),
      missileBody: g(new THREE.CylinderGeometry(0.32, 0.32, 3, 10)),
      missileNose: g(new THREE.ConeGeometry(0.32, 1, 10)),
      fin: g(new THREE.BoxGeometry(1.1, 0.5, 0.05))
    };
    this.mat = {
      crate: new THREE.MeshStandardMaterial({ color: 0xea580c, roughness: 0.6 }),
      beacon: new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.4, fog: false, depthWrite: false }),
      canopy: new THREE.MeshStandardMaterial({ color: 0xf5f5f4, roughness: 0.9, side: THREE.DoubleSide }),
      line: new THREE.MeshBasicMaterial({ color: 0xd6d3d1 }),
      droneBody: new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.5, metalness: 0.4 }),
      rotor: new THREE.MeshBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.55 }),
      fpv: new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.6 }),
      recon: new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
      fragGrenade: new THREE.MeshStandardMaterial({ color: 0x3f6212, roughness: 0.7 }),
      smokeGrenade: new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.7 }),
      rocketBody: new THREE.MeshStandardMaterial({ color: 0x4d5a3d, roughness: 0.6 }),
      rocketGlow: new THREE.MeshBasicMaterial({ color: 0xffb703, transparent: true, opacity: 0.8, fog: false }),
      missile: new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.4, metalness: 0.6 }),
      missileNose: new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 })
    };
  }

  // ------------------------------------------------------------------ builders
  makeCrate() {
    const group = new THREE.Group();
    const box = new THREE.Mesh(this.geo.crate, this.mat.crate);
    box.position.y = 0.7;
    box.castShadow = true;
    const beacon = new THREE.Mesh(this.geo.beacon, this.mat.beacon);
    beacon.position.y = 7;
    const chute = new THREE.Group();
    const canopy = new THREE.Mesh(this.geo.canopy, this.mat.canopy);
    canopy.position.y = 4.2;
    chute.add(canopy);
    for (let i = 0; i < 4; i++) {
      const line = new THREE.Mesh(this.geo.line, this.mat.line);
      const a = (i / 4) * Math.PI * 2;
      line.position.set(Math.cos(a) * 1.15, 2.6, Math.sin(a) * 1.15);
      line.rotation.set(Math.sin(a) * 0.34, 0, -Math.cos(a) * 0.34);
      chute.add(line);
    }
    group.add(box, beacon, chute);
    this.scene.add(group);
    return { group, beacon, chute };
  }

  makeDrone(mode) {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this.geo.droneBody, this.mat.droneBody));
    const rotors = [];
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const rotor = new THREE.Mesh(this.geo.rotor, this.mat.rotor);
      rotor.position.set(sx * 0.4, 0.07, sz * 0.4);
      group.add(rotor);
      rotors.push(rotor);
    }
    const arm1 = new THREE.Mesh(this.geo.arm, this.mat.droneBody);
    arm1.rotation.y = Math.PI / 4;
    const arm2 = new THREE.Mesh(this.geo.arm, this.mat.droneBody);
    arm2.rotation.y = -Math.PI / 4;
    group.add(arm1, arm2);
    if (mode === 'fpv') {
      const head = new THREE.Mesh(this.geo.warhead, this.mat.fpv);
      head.rotation.x = Math.PI / 2;
      head.position.set(0, -0.02, -0.32);
      group.add(head);
    } else {
      const lens = new THREE.Mesh(this.geo.lens, this.mat.recon);
      lens.position.set(0, -0.1, -0.15);
      group.add(lens);
    }
    this.scene.add(group);
    return { group, rotors, pos: null, yaw: 0 };
  }

  makeGrenade(type) {
    const mesh = new THREE.Mesh(this.geo.grenade, type === 'smoke' ? this.mat.smokeGrenade : this.mat.fragGrenade);
    mesh.castShadow = true;
    this.scene.add(mesh);
    return { group: mesh };
  }

  makeRocket() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.geo.rocketBody, this.mat.rocketBody);
    body.rotation.x = Math.PI / 2;
    const glow = new THREE.Mesh(this.geo.rocketGlow, this.mat.rocketGlow);
    glow.rotation.x = -Math.PI / 2; // flame tip points backward (-Z)
    glow.position.z = -0.75;        // lookAt() turns +Z toward the flight direction, so -Z is behind
    group.add(body, glow);
    this.scene.add(group);
    return { group };
  }

  makeMissile() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.geo.missileBody, this.mat.missile);
    const nose = new THREE.Mesh(this.geo.missileNose, this.mat.missileNose);
    nose.rotation.x = Math.PI; // tip points down
    nose.position.y = -2;
    group.add(body, nose);
    for (let i = 0; i < 2; i++) {
      const fin = new THREE.Mesh(this.geo.fin, this.mat.missile);
      fin.position.y = 1.2;
      fin.rotation.y = (i * Math.PI) / 2;
      group.add(fin);
    }
    this.scene.add(group);
    return { group };
  }

  remove(entry) {
    this.scene.remove(entry.group);
  }

  // ------------------------------------------------------------------ per snapshot
  /**
   * state: GameState. now: client time in ms. opts.hideDroneId: do not draw the drone whose
   * camera we are looking through. rules: { rocketSpeed, missileFallSpeed, grenadeGravity }
   */
  sync(state, now, { hideDroneId = null } = {}) {
    const age = Math.min(MAX_EXTRAPOLATE_S, Math.max(0, (now - state.snapshotAt) / 1000));
    const rules = state.rules ?? {};
    const rocketSpeed = rules.rocketSpeed ?? 70;
    const fall = rules.missileFallSpeed ?? 38;
    const gravity = rules.grenadeGravity ?? 14;

    syncMap(this.crates, state.airdrops, () => this.makeCrate(), (e, c) => {
      e.group.position.set(c.x, c.y, c.z);
      e.chute.visible = !c.landed;
      e.beacon.visible = !!c.landed;
    }, (e) => this.remove(e));

    syncMap(this.drones, state.drones, (d) => this.makeDrone(d.mode), (e, d) => {
      e.target = d;
      e.group.visible = d.id !== hideDroneId;
      if (!e.pos) {
        e.pos = new THREE.Vector3(d.x, d.y, d.z);
        e.yaw = d.yaw;
        e.group.position.copy(e.pos);
        e.group.rotation.y = d.yaw;
      }
    }, (e) => this.remove(e));

    syncMap(this.grenades, state.grenades, (gr) => this.makeGrenade(gr.type), (e, gr) => {
      e.group.position.set(
        gr.x + gr.vx * age,
        gr.y + gr.vy * age - 0.5 * gravity * age * age,
        gr.z + gr.vz * age
      );
    }, (e) => this.remove(e));

    syncMap(this.rockets, state.rockets, () => this.makeRocket(), (e, r) => {
      const d = rocketSpeed * age;
      e.group.position.set(r.x + r.dx * d, r.y + r.dy * d, r.z + r.dz * d);
      // turn the model (its +Z axis) toward the flight direction
      e.group.lookAt(e.group.position.x + r.dx, e.group.position.y + r.dy, e.group.position.z + r.dz);
    }, (e) => this.remove(e));

    syncMap(this.missiles, state.missiles, () => this.makeMissile(), (e, m) => {
      e.group.position.set(m.x, m.y - fall * age, m.z);
    }, (e) => this.remove(e));
  }

  /** Called every frame: spin rotors, pulse beacons, glide drones. */
  update(dt) {
    this.time += dt;
    const k = 1 - Math.exp(-dt * 16);
    for (const e of this.drones.values()) {
      if (e.target && e.pos) {
        e.pos.x += (e.target.x - e.pos.x) * k;
        e.pos.y += (e.target.y - e.pos.y) * k;
        e.pos.z += (e.target.z - e.pos.z) * k;
        let dy = (e.target.yaw - e.yaw) % (Math.PI * 2);
        if (dy > Math.PI) dy -= Math.PI * 2;
        else if (dy < -Math.PI) dy += Math.PI * 2;
        e.yaw += dy * k;
        e.group.position.copy(e.pos);
        e.group.rotation.y = e.yaw;
      }
      for (const r of e.rotors) r.rotation.y += dt * 60;
    }
    const pulse = 0.3 + 0.2 * Math.sin(this.time * 4);
    this.mat.beacon.opacity = clamp01(pulse);
  }

  dispose() {
    for (const map of [this.crates, this.drones, this.grenades, this.rockets, this.missiles]) {
      for (const e of map.values()) this.remove(e);
      map.clear();
    }
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
  }
}
