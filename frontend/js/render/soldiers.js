// Soldier models for other players (and for yourself in third-person view).
// Geometry and materials are shared between all soldiers; only the little groups are per player.
import * as THREE from 'three';
import { STANCE_SCALE } from '../shared/world.js';

const STYLE = {
  bharat: { uniform: 0x4b5d3b, vest: 0x2d3824, accent: '#ff9933' }, // olive drab
  opfor: { uniform: 0x5c3a32, vest: 0x2b2424, accent: '#f87171' }
};
const styleFor = (team) => (team === 'bharat' ? STYLE.bharat : STYLE.opfor);

function makeNameTag(doc, text, accent) {
  const canvas = doc?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!canvas || !ctx) return null;
  canvas.width = 256;
  canvas.height = 64;
  ctx.fillStyle = 'rgba(8, 12, 18, 0.62)';
  ctx.fillRect(0, 8, 256, 48);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 8, 6, 48);
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 131, 33, 236);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, fog: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.9, 0.475, 1);
  sprite.renderOrder = 10;
  return { sprite, texture, material };
}

export class SoldierFactory {
  constructor({ doc = globalThis.document } = {}) {
    this.doc = doc;
    this.geo = {
      torso: new THREE.BoxGeometry(0.55, 0.72, 0.32),
      vest: new THREE.BoxGeometry(0.58, 0.45, 0.36),
      head: new THREE.SphereGeometry(0.2, 10, 10),
      helmet: new THREE.SphereGeometry(0.22, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
      legs: new THREE.BoxGeometry(0.46, 0.7, 0.28),
      arm: new THREE.BoxGeometry(0.12, 0.12, 0.5),
      rifle: new THREE.BoxGeometry(0.07, 0.09, 0.78),
      shell: new THREE.SphereGeometry(1.15, 12, 10)
    };
    const mats = (s) => ({
      uniform: new THREE.MeshStandardMaterial({ color: s.uniform, roughness: 0.85 }),
      vest: new THREE.MeshStandardMaterial({ color: s.vest, roughness: 0.7 })
    });
    this.mat = {
      bharat: mats(STYLE.bharat),
      opfor: mats(STYLE.opfor),
      skin: new THREE.MeshStandardMaterial({ color: 0xc69c72, roughness: 0.7 }),
      gun: new THREE.MeshStandardMaterial({ color: 0x1c1f22, metalness: 0.5, roughness: 0.5 }),
      shell: new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22, depthWrite: false })
    };
  }

  /** team: 'bharat' draws olive, anything else the OPFOR brown. */
  create(team, callsign, { nameTag = false } = {}) {
    return new SoldierView(this, team, callsign, nameTag);
  }

  dispose() {
    for (const g of Object.values(this.geo)) g.dispose();
    for (const set of [this.mat.bharat, this.mat.opfor]) for (const m of Object.values(set)) m.dispose();
    this.mat.skin.dispose();
    this.mat.gun.dispose();
    this.mat.shell.dispose();
  }
}

export class SoldierView {
  constructor(factory, team, callsign, nameTag) {
    const { geo, mat } = factory;
    const set = team === 'bharat' ? mat.bharat : mat.opfor;
    this.team = team;
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);

    const part = (g, m, y, castShadow = true) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.y = y;
      mesh.castShadow = castShadow;
      this.body.add(mesh);
      return mesh;
    };
    part(geo.legs, set.uniform, 0.35);
    part(geo.torso, set.uniform, 1.05);
    part(geo.vest, set.vest, 1.12, false);
    part(geo.head, mat.skin, 1.62);
    part(geo.helmet, set.vest, 1.65, false);

    // the rifle is held in front and follows the soldier's aim up and down
    this.aim = new THREE.Group();
    this.aim.position.set(0, 1.3, 0);
    const gun = new THREE.Mesh(geo.rifle, mat.gun);
    gun.position.set(0.17, -0.12, -0.42);
    const arm = new THREE.Mesh(geo.arm, set.uniform);
    arm.position.set(0.17, -0.1, -0.2);
    const arm2 = new THREE.Mesh(geo.arm, set.uniform);
    arm2.position.set(-0.05, -0.12, -0.45);
    this.aim.add(gun, arm, arm2);
    this.body.add(this.aim);

    this.shell = new THREE.Mesh(geo.shell, mat.shell);
    this.shell.position.y = 1;
    this.shell.visible = false;
    this.group.add(this.shell);

    this.tag = null;
    if (nameTag) {
      this.tag = makeNameTag(factory.doc, callsign, styleFor(team).accent);
      if (this.tag) this.group.add(this.tag.sprite);
    }
  }

  /** pose: { x, y, z, yaw, pitch }  data: public player info from the snapshot. */
  apply(pose, data, { showTag = true } = {}) {
    this.group.visible = !!data.alive;
    this.group.position.set(pose.x, pose.y, pose.z);
    this.group.rotation.y = pose.yaw;
    const s = STANCE_SCALE[data.stance] ?? 1;
    this.body.scale.y = s;
    this.body.rotation.z = -(data.lean || 0) * 0.22;
    this.aim.rotation.x = pose.pitch;
    this.shell.visible = !!data.prot;
    if (this.tag) {
      this.tag.sprite.visible = showTag;
      this.tag.sprite.position.y = 2.2 * s + 0.15;
    }
  }

  setVisible(on) {
    this.group.visible = !!on;
  }

  dispose() {
    if (this.tag) {
      this.tag.texture.dispose();
      this.tag.material.dispose();
      this.tag = null;
    }
  }
}
