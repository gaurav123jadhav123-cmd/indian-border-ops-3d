// The 3D side of the game behind one small interface. The game logic (game/Game.js) never touches
// the 3D engine directly: it hands this object a description of the current frame.
//
// frame = {
//   now, state (GameState), view: 'first' | 'third' | 'drone', alive,
//   pose: { x, y, z, yaw, pitch, lean, stance, ads, sprinting, moving },
//   kick, weapon (arsenal entry or null), reload (0..1 or null),
//   drone: null | { id, mode, yaw, pitch, pos: {x, y, z} },
//   teamMode, myTeam
// }
import * as THREE from 'three';
import { createStage } from './scene.js';
import { buildWorld } from './world.js';
import { SoldierFactory } from './soldiers.js';
import { EntityRenderer } from './entities.js';
import { Effects } from './effects.js';
import { CameraRig } from './camera.js';
import { ViewModel } from './weapons.js';
import { AdaptiveScale, FpsMeter } from './quality.js';

const NAME_TAG_RANGE = 90;

export function createRenderer({ canvas, doc = globalThis.document, quality, width, height, devicePixelRatio }) {
  const stage = createStage({ canvas, quality, width, height, devicePixelRatio });
  const world = buildWorld({ scene: stage.scene, quality });
  const factory = new SoldierFactory({ doc });
  const entities = new EntityRenderer({ scene: stage.scene });
  const effects = new Effects({ scene: stage.scene, maxFx: quality.maxFx });
  const rig = new CameraRig({ camera: stage.camera, effects });
  const viewModel = new ViewModel({ camera: stage.camera });
  const adaptive = new AdaptiveScale();
  const fpsMeter = new FpsMeter();

  const views = new Map(); // player id -> SoldierView
  let selfView = null;
  let selfTeam = null;
  const muzzle = new THREE.Vector3();

  function syncSoldiers(f) {
    const { state } = f;
    const seen = new Set();
    for (const entry of state.others()) {
      const data = entry.data;
      seen.add(data.id);
      const pose = entry.interp.sample(f.now);
      if (!pose) continue;
      let view = views.get(data.id);
      if (!view) {
        view = factory.create(data.team, data.callsign, { nameTag: quality.nameTags && f.teamMode });
        stage.scene.add(view.group);
        views.set(data.id, view);
      }
      const near = Math.hypot(pose.x - rig.position.x, pose.z - rig.position.z) < NAME_TAG_RANGE;
      view.apply(pose, data, { showTag: f.teamMode && data.team === f.myTeam && near });
    }
    for (const [id, view] of views) {
      if (!seen.has(id)) {
        stage.scene.remove(view.group);
        view.dispose();
        views.delete(id);
      }
    }

    // yourself, only visible in third-person view
    const showSelf = f.view === 'third' && f.alive;
    if (showSelf) {
      const team = f.teamMode ? f.myTeam : 'bharat';
      if (!selfView || selfTeam !== team) {
        if (selfView) {
          stage.scene.remove(selfView.group);
          selfView.dispose();
        }
        selfView = factory.create(team, '', { nameTag: false });
        selfTeam = team;
        stage.scene.add(selfView.group);
      }
      const me = state.myPublic();
      selfView.apply(f.pose, { alive: true, stance: f.pose.stance, lean: f.pose.lean, prot: !!me?.prot }, { showTag: false });
    } else if (selfView) {
      selfView.setVisible(false);
    }
  }

  return {
    stage,
    effects,
    resize: (w, h) => stage.resize(w, h),

    get fps() {
      return fpsMeter.fps;
    },
    get scale() {
      return adaptive.scale;
    },

    /** Where the muzzle of the weapon in your hands is, in world coordinates (for tracers). */
    muzzleWorld() {
      stage.camera.updateMatrixWorld();
      muzzle.set(0.22, -0.17, -0.85);
      stage.camera.localToWorld(muzzle);
      return { x: muzzle.x, y: muzzle.y, z: muzzle.z };
    },

    /** Camera position of the last frame. */
    cameraPosition: () => rig.position,

    /** A shot fired by you: flash and kick on the weapon model. */
    fire(recoil) {
      viewModel.fire(recoil);
    },

    render(f, dtSec) {
      const dt = Math.min(0.1, Math.max(0, dtSec));
      const cam = rig.update(dt, f);
      world.follow(cam.x, cam.y, cam.z);
      if (quality.shadows) stage.followSun(f.pose.x, f.pose.y, f.pose.z);

      syncSoldiers(f);
      entities.sync(f.state, f.now, { hideDroneId: f.drone && f.drone.mode === 'fpv' ? f.drone.id : null });
      entities.update(dt);
      effects.update(dt);

      if (f.weapon) viewModel.setWeapon(f.weapon.id, f.weapon.color);
      else viewModel.setWeapon(null);
      const scoped = !!(f.weapon && f.pose.ads && f.weapon.adsFov <= 26 && f.view === 'first');
      viewModel.update(dt, {
        ads: f.pose.ads,
        sprinting: f.pose.sprinting,
        moving: f.pose.moving,
        reload: f.reload,
        hidden: f.view !== 'first' || !f.alive || scoped
      });

      fpsMeter.sample(dt * 1000);
      const before = adaptive.scale;
      adaptive.sample(dt * 1000);
      if (adaptive.scale !== before) stage.setScale(adaptive.scale);

      stage.render();
    },

    dispose() {
      viewModel.dispose();
      effects.dispose();
      entities.dispose();
      for (const view of views.values()) {
        stage.scene.remove(view.group);
        view.dispose();
      }
      views.clear();
      if (selfView) {
        stage.scene.remove(selfView.group);
        selfView.dispose();
        selfView = null;
      }
      factory.dispose();
      world.dispose();
      stage.dispose();
    }
  };
}
