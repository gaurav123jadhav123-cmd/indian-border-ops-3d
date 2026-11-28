// The weapon you hold in first person (attached to the camera), with its little animations:
// walking sway, sprint pose, aiming down the sights, recoil, reload dip and weapon raise.
import * as THREE from 'three';

const HIP = { x: 0.24, y: -0.22, z: -0.45 };
const ADS = { x: 0, y: -0.135, z: -0.34 };

const SNIPERS = new Set(['svd', 'trg42', 'vidhwansak']);

/** Builds the model for one weapon. Everything it creates is tracked in `own` for disposal. */
export function createWeaponModel(weaponId, colorHex = 0x2b2d2f, own = []) {
  const group = new THREE.Group();
  const track = (o) => { own.push(o); return o; };
  const metal = track(new THREE.MeshStandardMaterial({ color: colorHex, metalness: 0.65, roughness: 0.35 }));
  const grip = track(new THREE.MeshStandardMaterial({ color: 0x151719, roughness: 0.8 }));
  const mesh = (geo, mat) => new THREE.Mesh(track(geo), mat);

  if (weaponId === 'carlGustaf') {
    const tube = mesh(new THREE.CylinderGeometry(0.065, 0.065, 1.05, 12), metal);
    tube.rotation.x = Math.PI / 2;
    const sight = mesh(new THREE.BoxGeometry(0.03, 0.08, 0.12), grip);
    sight.position.set(0, 0.1, -0.1);
    group.add(tube, sight);
  } else if (weaponId === 'pistol9mm') {
    const slide = mesh(new THREE.BoxGeometry(0.045, 0.055, 0.24), metal);
    const handle = mesh(new THREE.BoxGeometry(0.04, 0.12, 0.055), grip);
    handle.position.set(0, -0.07, 0.07);
    handle.rotation.x = 0.2;
    group.add(slide, handle);
  } else {
    const isSniper = SNIPERS.has(weaponId);
    const barrelLen = isSniper ? 0.78 : 0.55;
    const body = mesh(new THREE.BoxGeometry(0.055, 0.08, 0.38), metal);
    const barrel = mesh(new THREE.CylinderGeometry(0.015, 0.015, barrelLen, 8), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.015, -barrelLen / 2 - 0.1);
    const mag = mesh(new THREE.BoxGeometry(0.04, 0.14, 0.07), grip);
    mag.position.set(0, -0.09, -0.04);
    mag.rotation.x = -0.18;
    group.add(body, barrel, mag);
    if (isSniper) {
      const scope = mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.24, 10), grip);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.068, -0.02);
      group.add(scope);
    }
  }

  const flash = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.055, 6, 6)),
    track(new THREE.MeshBasicMaterial({ color: 0xffb703 }))
  );
  flash.position.set(0, 0.015, weaponId === 'pistol9mm' ? -0.2 : -0.68);
  flash.visible = false;
  flash.name = 'muzzleFlash';
  group.add(flash);
  return group;
}

export class ViewModel {
  constructor({ camera }) {
    this.camera = camera;
    this.holder = new THREE.Group(); // moves/rotates for the animations
    camera.add(this.holder);
    this.model = null;
    this.own = [];
    this.weaponId = null;
    this.time = 0;
    this.kick = 0;
    this.equip = 1;        // 0 = just switched (lowered), 1 = raised
    this.flashLeft = 0;
    this.ads = 0;          // 0..1 smoothed
    this.sprint = 0;       // 0..1 smoothed
    this.visible = true;
  }

  setWeapon(weaponId, colorHex) {
    if (weaponId === this.weaponId) return;
    this.clearModel();
    this.weaponId = weaponId;
    if (!weaponId) return;
    this.model = createWeaponModel(weaponId, colorHex, this.own);
    this.holder.add(this.model);
    this.equip = 0;
  }

  clearModel() {
    if (this.model) this.holder.remove(this.model);
    for (const o of this.own) o.dispose?.();
    this.own.length = 0;
    this.model = null;
    this.weaponId = null;
  }

  /** One shot: flash and kick back. */
  fire(recoil = 0.02) {
    this.kick = Math.min(1, this.kick + 0.35 + recoil * 6);
    this.flashLeft = 0.055;
  }

  /**
   * dt in seconds. s: { ads, sprinting, moving, reload (0..1 or null), hidden }
   */
  update(dt, s) {
    if (!this.model) return;
    this.time += dt;
    const k = (rate) => 1 - Math.exp(-dt * rate);
    this.ads += ((s.ads ? 1 : 0) - this.ads) * k(14);
    this.sprint += ((s.sprinting && !s.ads ? 1 : 0) - this.sprint) * k(9);
    this.equip = Math.min(1, this.equip + dt * 4.5);
    this.kick = Math.max(0, this.kick - dt * 7);
    this.flashLeft = Math.max(0, this.flashLeft - dt);

    const flash = this.model.getObjectByName('muzzleFlash');
    if (flash) {
      flash.visible = this.flashLeft > 0;
      if (flash.visible) flash.scale.setScalar(0.8 + Math.random() * 0.6);
    }

    const sway = s.moving ? 1 : 0;
    const bobSpeed = s.sprinting ? 12 : 8;
    const bobAmt = (1 - this.ads) * sway * (s.sprinting ? 1.6 : 1);
    const bobX = Math.sin(this.time * bobSpeed * 0.5) * 0.008 * bobAmt;
    const bobY = Math.abs(Math.cos(this.time * bobSpeed * 0.5)) * 0.007 * bobAmt;

    const reload = s.reload == null ? 0 : Math.sin(Math.min(1, Math.max(0, s.reload)) * Math.PI);
    const raise = 1 - this.equip;

    const a = this.ads;
    this.holder.position.set(
      HIP.x + (ADS.x - HIP.x) * a + bobX - this.sprint * 0.1,
      HIP.y + (ADS.y - HIP.y) * a + bobY - reload * 0.18 - raise * 0.35 - this.sprint * 0.05,
      HIP.z + (ADS.z - HIP.z) * a + this.kick * 0.07
    );
    this.holder.rotation.set(
      this.kick * 0.1 - reload * 0.7 - raise * 0.5 - this.sprint * 0.35,
      this.sprint * 0.55,
      reload * 0.25
    );
    this.holder.visible = this.visible && !s.hidden;
  }

  dispose() {
    this.clearModel();
    this.camera.remove(this.holder);
  }
}
