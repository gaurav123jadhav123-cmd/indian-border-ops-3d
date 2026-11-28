// A tiny stand-in for three.js (r160 API subset), used ONLY by the offline tests.
// It runs the real render code (world, soldiers, weapons, effects, camera, ...) without a GPU, so
// wiring mistakes show up: calling a method that does not exist, wrong argument order, reading an
// object that was never created. It cannot say how the scene LOOKS - that needs a real device.
//
// Strict on purpose: only methods the game really uses are implemented. Calling anything else
// throws "is not a function", which is exactly the signal we want.

const stats = { renders: 0, created: 0, setSize: null, pixelRatio: null };
if (typeof window !== 'undefined') window.__THREE_STUB__ = stats;

export const SRGBColorSpace = 'srgb';
export const PCFSoftShadowMap = 2;
export const NormalBlending = 1;
export const AdditiveBlending = 2;
export const FrontSide = 0;
export const BackSide = 1;
export const DoubleSide = 2;

const toLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : ((c * 0.9478672986 + 0.0521327014) ** 2.4));

export class Color {
  constructor(r = 1, g, b) {
    this.r = 1; this.g = 1; this.b = 1;
    if (g === undefined && b === undefined) this.set(r);
    else { this.r = r; this.g = g; this.b = b; }
  }

  set(v) {
    if (v instanceof Color) return this.copy(v);
    return this.setHex(v);
  }

  setHex(hex) {
    this.r = toLinear(((hex >> 16) & 255) / 255);
    this.g = toLinear(((hex >> 8) & 255) / 255);
    this.b = toLinear((hex & 255) / 255);
    return this;
  }

  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  clone() { return new Color(this.r, this.g, this.b); }
}

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}

class Euler {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order; }
  set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; return this; }
  copy(e) { return this.set(e.x, e.y, e.z, e.order); }
}

/** Rotate (x, y, z) by an Euler rotation (the orders the game uses). */
function rotateByEuler(v, e) {
  const rx = (p) => ({ x: p.x, y: p.y * Math.cos(e.x) - p.z * Math.sin(e.x), z: p.y * Math.sin(e.x) + p.z * Math.cos(e.x) });
  const ry = (p) => ({ x: p.x * Math.cos(e.y) + p.z * Math.sin(e.y), y: p.y, z: -p.x * Math.sin(e.y) + p.z * Math.cos(e.y) });
  const rz = (p) => ({ x: p.x * Math.cos(e.z) - p.y * Math.sin(e.z), y: p.x * Math.sin(e.z) + p.y * Math.cos(e.z), z: p.z });
  const steps = { X: rx, Y: ry, Z: rz };
  // THREE applies "XYZ" as R = Rx * Ry * Rz, so the vector goes through Z first, X last
  let p = { x: v.x, y: v.y, z: v.z };
  for (const axis of [...e.order].reverse()) p = steps[axis](p);
  return p;
}

export class Object3D {
  constructor() {
    stats.created++;
    this.position = new Vector3();
    this.rotation = new Euler();
    this.scale = new Vector3(1, 1, 1);
    this.matrix = { elements: new Array(16).fill(0) };
    this.children = [];
    this.parent = null;
    this.visible = true;
    this.userData = {};
    this.name = '';
    this.renderOrder = 0;
    this.castShadow = false;
    this.receiveShadow = false;
    this.frustumCulled = true;
  }

  add(...objs) {
    for (const o of objs) {
      if (!(o instanceof Object3D)) throw new TypeError('THREE stub: Object3D.add() needs an Object3D');
      if (o.parent) o.parent.remove(o);
      o.parent = this;
      this.children.push(o);
    }
    return this;
  }

  remove(...objs) {
    for (const o of objs) {
      const i = this.children.indexOf(o);
      if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
    }
    return this;
  }

  lookAt(x, y, z) {
    const t = x instanceof Vector3 ? x : new Vector3(x, y, z);
    const dx = t.x - this.position.x; const dy = t.y - this.position.y; const dz = t.z - this.position.z;
    this.rotation.y = Math.atan2(dx, dz);
    this.rotation.x = -Math.atan2(dy, Math.hypot(dx, dz));
  }

  updateMatrix() { this.matrix.elements[12] = this.position.x; this.matrix.elements[13] = this.position.y; this.matrix.elements[14] = this.position.z; }
  updateMatrixWorld() {}

  localToWorld(v) {
    const r = rotateByEuler(v, this.rotation);
    return v.set(r.x * this.scale.x + this.position.x, r.y * this.scale.y + this.position.y, r.z * this.scale.z + this.position.z);
  }

  traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }

  getObjectByName(name) {
    if (this.name === name) return this;
    for (const c of this.children) {
      const found = c.getObjectByName(name);
      if (found) return found;
    }
    return undefined;
  }
}

export class Group extends Object3D {}
export class Scene extends Object3D {
  constructor() { super(); this.background = null; this.fog = null; }
}
export class FogExp2 { constructor(color, density) { this.color = new Color(color); this.density = density; } }

class OrthoShadowCamera extends Object3D {
  constructor() { super(); this.left = 0; this.right = 0; this.top = 0; this.bottom = 0; this.near = 0; this.far = 0; }
  updateProjectionMatrix() {}
}

export class PerspectiveCamera extends Object3D {
  constructor(fov, aspect, near, far) { super(); Object.assign(this, { fov, aspect, near, far }); }
  updateProjectionMatrix() {}
}

export class HemisphereLight extends Object3D {
  constructor(sky, ground, intensity) { super(); this.color = new Color(sky); this.groundColor = new Color(ground); this.intensity = intensity; }
}

export class DirectionalLight extends Object3D {
  constructor(color, intensity) {
    super();
    this.color = new Color(color);
    this.intensity = intensity;
    this.target = new Object3D();
    this.shadow = { mapSize: new Vector3(), camera: new OrthoShadowCamera(), bias: 0, normalBias: 0 };
    this.shadow.mapSize.set = function set(w, h) { this.x = w; this.y = h; return this; };
  }
}

// ---------------------------------------------------------------- geometry
export class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = Math.floor(array.length / itemSize);
    this.needsUpdate = false;
  }

  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
  setX(i, v) { this.array[i * this.itemSize] = v; return this; }
  setY(i, v) { this.array[i * this.itemSize + 1] = v; return this; }
  setZ(i, v) { this.array[i * this.itemSize + 2] = v; return this; }
  setXYZ(i, x, y, z) { this.setX(i, x); this.setY(i, y); this.setZ(i, z); return this; }
}

export class BufferGeometry {
  constructor() { stats.created++; this.attributes = {}; this.index = null; }
  setAttribute(name, attr) {
    if (!(attr instanceof BufferAttribute)) throw new TypeError('THREE stub: setAttribute needs a BufferAttribute');
    this.attributes[name] = attr;
    return this;
  }

  getAttribute(name) { return this.attributes[name]; }
  setFromPoints(points) {
    const arr = new Float32Array(points.length * 3);
    points.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
    return this.setAttribute('position', new BufferAttribute(arr, 3));
  }

  computeVertexNormals() {}
  dispose() {}

  rotateX(a) {
    const p = this.attributes.position;
    const c = Math.cos(a); const s = Math.sin(a);
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i); const z = p.getZ(i);
      p.setY(i, y * c - z * s);
      p.setZ(i, y * s + z * c);
    }
    return this;
  }

  rotateZ(a) {
    const p = this.attributes.position;
    const c = Math.cos(a); const s = Math.sin(a);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i); const y = p.getY(i);
      p.setX(i, x * c - y * s);
      p.setY(i, x * s + y * c);
    }
    return this;
  }

  translate(x, y, z) {
    const p = this.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + x, p.getY(i) + y, p.getZ(i) + z);
    return this;
  }
}

const boxLike = (geo, w, h, d) => {
  const a = new Float32Array(24);
  let k = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) { a[k++] = sx * w / 2; a[k++] = sy * h / 2; a[k++] = sz * d / 2; }
  geo.setAttribute('position', new BufferAttribute(a, 3));
};

export class BoxGeometry extends BufferGeometry {
  constructor(w = 1, h = 1, d = 1) { super(); boxLike(this, w, h, d); }
}
export class CylinderGeometry extends BufferGeometry {
  constructor(rt = 1, rb = 1, h = 1) { super(); boxLike(this, Math.max(rt, rb) * 2, h, Math.max(rt, rb) * 2); }
}
export class ConeGeometry extends BufferGeometry {
  constructor(r = 1, h = 1) { super(); boxLike(this, r * 2, h, r * 2); }
}
export class RingGeometry extends BufferGeometry {
  constructor(inner = 0.5, outer = 1, segments = 32) {
    super();
    const a = new Float32Array((segments + 1) * 2 * 3);
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      a.set([Math.cos(t) * inner, Math.sin(t) * inner, 0, Math.cos(t) * outer, Math.sin(t) * outer, 0], i * 6);
    }
    this.setAttribute('position', new BufferAttribute(a, 3));
  }
}

export class PlaneGeometry extends BufferGeometry {
  constructor(width = 1, height = 1, ws = 1, hs = 1) {
    super();
    const gx = ws + 1; const gy = hs + 1;
    const a = new Float32Array(gx * gy * 3);
    for (let iy = 0; iy < gy; iy++) {
      for (let ix = 0; ix < gx; ix++) {
        const i = (iy * gx + ix) * 3;
        a[i] = ix * (width / ws) - width / 2;
        a[i + 1] = -(iy * (height / hs) - height / 2);
        a[i + 2] = 0;
      }
    }
    this.setAttribute('position', new BufferAttribute(a, 3));
  }
}

export class SphereGeometry extends BufferGeometry {
  constructor(radius = 1, wSeg = 8, hSeg = 6) {
    super();
    const w = Math.max(3, Math.floor(wSeg)); const h = Math.max(2, Math.floor(hSeg));
    const a = new Float32Array((w + 1) * (h + 1) * 3);
    let k = 0;
    for (let iy = 0; iy <= h; iy++) {
      const v = iy / h;
      for (let ix = 0; ix <= w; ix++) {
        const u = ix / w;
        a[k++] = -radius * Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
        a[k++] = radius * Math.cos(v * Math.PI);
        a[k++] = radius * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
      }
    }
    this.setAttribute('position', new BufferAttribute(a, 3));
  }
}

// ---------------------------------------------------------------- materials
class Material {
  constructor(params = {}) {
    stats.created++;
    this.color = new Color(0xffffff);
    this.opacity = 1;
    this.transparent = false;
    this.depthWrite = true;
    this.depthTest = true;
    this.fog = true;
    this.blending = NormalBlending;
    this.side = FrontSide;
    for (const [k, v] of Object.entries(params)) {
      if (k === 'color') this.color.set(v);
      else this[k] = v;
    }
  }

  dispose() {}
}
export class MeshStandardMaterial extends Material {}
export class MeshBasicMaterial extends Material {}
export class LineBasicMaterial extends Material {}
export class SpriteMaterial extends Material {}

export class CanvasTexture {
  constructor(canvas) { this.image = canvas; this.needsUpdate = true; this.colorSpace = ''; }
  dispose() {}
}

// ---------------------------------------------------------------- objects
export class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}
export class Line extends Mesh {}
export class Sprite extends Object3D {
  constructor(material) { super(); this.material = material; }
}
export class InstancedMesh extends Mesh {
  constructor(geometry, material, count) { super(geometry, material); this.count = count; this.instanceMatrix = { needsUpdate: false }; }
  setMatrixAt() {}
}

// ---------------------------------------------------------------- renderer
export class WebGLRenderer {
  constructor(params = {}) {
    this.domElement = params.canvas ?? document.createElement('canvas');
    this.shadowMap = { enabled: false, type: 0 };
    this.params = params;
  }

  setPixelRatio(r) { stats.pixelRatio = r; }
  setSize(w, h, updateStyle) { stats.setSize = [w, h, updateStyle]; }
  render(scene, camera) {
    if (!(scene instanceof Scene) || !(camera instanceof PerspectiveCamera)) throw new TypeError('THREE stub: render(scene, camera)');
    stats.renders++;
  }

  dispose() {}
  forceContextLoss() {}
}
