// Visual effects: bullet tracers, impact sparks, explosions, smoke grenades, the red warning ring
// of an incoming missile and the screen shake. Meshes are pooled: after a short warm-up a long
// match creates no new objects, so the phone never stutters from garbage collection.
import * as THREE from 'three';
import { getTerrainHeight } from '../shared/world.js';

const lerp = (a, b, t) => a + (b - a) * t;

export class Effects {
  constructor({ scene, maxFx = 48 }) {
    this.scene = scene;
    this.maxFx = maxFx;
    this.geo = {
      tracer: new THREE.BoxGeometry(1, 1, 1),
      puff: new THREE.SphereGeometry(1, 8, 6),
      ring: new THREE.RingGeometry(0.9, 1, 40)
    };
    this.geo.ring.rotateX(-Math.PI / 2); // lie flat on the ground
    this.pools = { tracer: [], puff: [], ring: [] };
    this.all = [];
    this.active = [];
    this.markers = new Map();
    this.shakeAmp = 0;
  }

  // ------------------------------------------------------------------ pooling
  acquire(type) {
    let item = this.pools[type].pop();
    if (!item) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, fog: type !== 'ring' });
      const mesh = new THREE.Mesh(this.geo[type], material);
      this.scene.add(mesh);
      item = { type, mesh, material };
      this.all.push(item);
    }
    item.mesh.visible = true;
    return item;
  }

  release(item) {
    item.mesh.visible = false;
    this.pools[item.type].push(item);
  }

  /** Start an effect. Returns null when there are already too many (cheap effects are skipped). */
  spawn(type, o) {
    if (!o.important && this.active.length >= this.maxFx) return null;
    const item = this.acquire(type);
    const { mesh, material } = item;
    material.color.setHex(o.color ?? 0xffffff);
    material.blending = o.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    material.depthTest = o.depthTest !== false;
    material.opacity = o.o0 ?? 1;
    mesh.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.setScalar(o.s0 ?? 1);
    mesh.renderOrder = o.renderOrder ?? 0;
    Object.assign(item, {
      age: 0,
      life: Math.max(0.01, o.life ?? 0.3),
      s0: o.s0 ?? 1,
      s1: o.s1 ?? o.s0 ?? 1,
      o0: o.o0 ?? 1,
      o1: o.o1 ?? 0,
      y0: o.y ?? 0,
      rise: o.rise ?? 0,
      profile: o.profile ?? 'linear',
      pulse: o.pulse ?? false,
      fixedScale: false
    });
    this.active.push(item);
    return item;
  }

  // ------------------------------------------------------------------ effects
  tracer(origin, end) {
    const dx = end.x - origin.x;
    const dy = end.y - origin.y;
    const dz = end.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return;
    const item = this.spawn('tracer', {
      color: 0xfef08a, additive: true, o0: 0.9, o1: 0, life: 0.09, x: origin.x + dx / 2, y: origin.y + dy / 2, z: origin.z + dz / 2
    });
    if (!item) return;
    item.mesh.scale.set(0.03, 0.03, len);
    item.s0 = item.s1 = 0; // the size is fixed: only the fade runs
    item.fixedScale = true;
    item.mesh.lookAt(end.x, end.y, end.z);
  }

  impact(point, kind = 'world') {
    const color = kind === 'player' ? 0xb91c1c : kind === 'drone' ? 0xfbbf24 : 0xd6c7a1;
    this.spawn('puff', { color, x: point.x, y: point.y, z: point.z, s0: 0.08, s1: 0.45, o0: 0.8, o1: 0, life: 0.28, rise: 0.4 });
  }

  explosion({ x, y, z, radius = 6, kind = 'grenade' }) {
    const big = kind === 'missile';
    const r = Math.max(1.5, radius);
    this.spawn('puff', { color: 0xff6b00, additive: true, x, y: y + 0.5, z, s0: r * 0.2, s1: r * 0.6, o0: 0.9, o1: 0, life: big ? 0.8 : 0.5, important: true });
    this.spawn('puff', { color: 0xfff1c2, additive: true, x, y: y + 0.6, z, s0: r * 0.12, s1: r * 0.3, o0: 1, o1: 0, life: 0.18, important: true });
    this.spawn('ring', { color: 0xffd9a0, x, y: Math.max(y, getTerrainHeight(x, z)) + 0.25, z, s0: r * 0.3, s1: r * 1.3, o0: 0.7, o1: 0, life: 0.45, important: true, depthTest: false });
    const puffs = big ? 7 : 4;
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * Math.PI * 2 + Math.random();
      const d = r * (0.15 + Math.random() * 0.35);
      this.spawn('puff', {
        color: 0x3b3b3b, x: x + Math.cos(a) * d, y: y + 0.6, z: z + Math.sin(a) * d,
        s0: r * 0.2, s1: r * 0.55, o0: 0.55, o1: 0, life: 1.3 + Math.random() * 0.9, rise: r * (0.4 + Math.random() * 0.4)
      });
    }
  }

  /** Smoke grenade: a cloud that lasts `ms`. */
  smoke({ x, y, z, ms = 9000 }) {
    const life = ms / 1000;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const d = i === 0 ? 0 : 2.2;
      this.spawn('puff', {
        color: 0xd1d5db, x: x + Math.cos(a) * d, y: y + 2.2 + (i % 2) * 0.8, z: z + Math.sin(a) * d,
        s0: 1.5, s1: 5.2 + (i % 3) * 0.4, o0: 0.72, o1: 0, life, profile: 'cloud', rise: 1.5, important: true
      });
    }
  }

  /** Red warning ring on the ground where a missile will land. */
  missileMarker({ id, x, z, radius = 15, etaMs = 3000 }) {
    const y = getTerrainHeight(x, z) + 0.3;
    const common = { color: 0xef4444, x, y, z, life: etaMs / 1000 + 0.6, important: true, depthTest: false, renderOrder: 5, profile: 'marker' };
    const outer = this.spawn('ring', { ...common, s0: radius, s1: radius, o0: 0.9, o1: 0.9, pulse: true });
    const inner = this.spawn('ring', { ...common, s0: radius * 0.2, s1: radius * 0.9, o0: 0.7, o1: 0.2 });
    this.markers.set(id, { x, z, items: [outer, inner].filter(Boolean) });
  }

  /** The missile landed (or was cancelled): remove its ring. */
  clearMissileMarkerAt(x, z) {
    for (const [id, m] of this.markers) {
      if (Math.hypot(m.x - x, m.z - z) < 3) {
        for (const item of m.items) if (item.life) item.age = Math.max(item.age, item.life);
        this.markers.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------ shake
  shake(amount) {
    this.shakeAmp = Math.min(1, this.shakeAmp + amount);
  }

  shakeOffset() {
    const a = this.shakeAmp;
    if (a < 0.005) return { x: 0, y: 0, roll: 0 };
    return { x: (Math.random() - 0.5) * a * 0.14, y: (Math.random() - 0.5) * a * 0.14, roll: (Math.random() - 0.5) * a * 0.06 };
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    this.shakeAmp = this.shakeAmp < 0.005 ? 0 : this.shakeAmp * Math.exp(-dt * 5);
    for (let i = this.active.length - 1; i >= 0; i--) {
      const it = this.active[i];
      it.age += dt;
      const t = Math.min(1, it.age / it.life);
      if (it.age >= it.life) {
        this.active.splice(i, 1);
        this.release(it);
        continue;
      }
      let o;
      if (it.profile === 'cloud') {
        // fade in quickly, hold, fade out over the last 1.5 s
        const fadeIn = Math.min(1, it.age / 0.6);
        const fadeOut = Math.min(1, (it.life - it.age) / 1.5);
        o = it.o0 * fadeIn * fadeOut;
      } else if (it.pulse) {
        o = 0.45 + 0.4 * Math.abs(Math.sin(it.age * 6));
      } else {
        o = lerp(it.o0, it.o1, t);
      }
      it.material.opacity = o;
      if (!it.fixedScale) it.mesh.scale.setScalar(lerp(it.s0, it.s1, it.profile === 'cloud' ? Math.min(1, t * 3) : t));
      if (it.rise) it.mesh.position.y = it.y0 + it.rise * t;
    }
    // drop bookkeeping for markers whose rings have ended
    for (const [id, m] of this.markers) {
      if (m.items.every((item) => !this.active.includes(item))) this.markers.delete(id);
    }
  }

  dispose() {
    for (const item of this.all) {
      this.scene.remove(item.mesh);
      item.material.dispose();
    }
    for (const g of Object.values(this.geo)) g.dispose();
    this.all.length = 0;
    this.active.length = 0;
    this.markers.clear();
    for (const k of Object.keys(this.pools)) this.pools[k].length = 0;
  }
}
