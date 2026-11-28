// Movement of the local soldier and of the drone being piloted. No 3D engine in here.
// It uses the exact same world math as the game server (shared/world.js), so what you feel on
// screen is what the server accepts and the server rarely has to correct you.
import {
  MOVE, PLAYER_RADIUS, getTerrainHeight, resolveObstacles, moveSpeed, clampToMap
} from '../shared/world.js';
import { clamp } from '../util.js';

export const PITCH_LIMIT = 1.42;

export class PlayerController {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = -90;
    this.vy = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.stance = 'stand';
    this.lean = 0;
    this.sprinting = false;
    this.ads = false;
    this.grounded = true;
    this.moving = false;
    this.epoch = 0;
  }

  /** The server says where we are: join, respawn or a correction after we drifted too far. */
  teleport({ x, y, z, yaw, pitch, epoch }) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vy = 0;
    this.grounded = true;
    if (Number.isFinite(yaw)) this.yaw = yaw;
    if (Number.isFinite(pitch)) this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    if (Number.isInteger(epoch)) this.epoch = epoch;
  }

  resetPose() {
    this.stance = 'stand';
    this.lean = 0;
    this.sprinting = false;
    this.ads = false;
    this.moving = false;
  }

  look(dYaw, dPitch) {
    this.yaw += dYaw;
    // keep the number small so it never loses precision in a long match
    if (this.yaw > 1e3 || this.yaw < -1e3) this.yaw %= Math.PI * 2;
    this.pitch = clamp(this.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * intent: { moveX (right +), moveY (forward +), dYaw, dPitch, sprint, jump, toggleCrouch, toggleProne, lean }
   * opts:   { boost, weaponMult, ads }
   */
  update(dt, intent, { boost = 0, weaponMult = 1, ads = false } = {}) {
    this.look(intent.dYaw || 0, intent.dPitch || 0);

    if (intent.toggleCrouch) this.stance = this.stance === 'crouch' ? 'stand' : 'crouch';
    if (intent.toggleProne) this.stance = this.stance === 'prone' ? 'stand' : 'prone';
    this.lean = intent.lean === -1 || intent.lean === 1 ? intent.lean : 0;
    this.ads = !!ads;

    const moveX = clamp(intent.moveX || 0, -1, 1);
    const moveY = clamp(intent.moveY || 0, -1, 1);
    this.sprinting = !!intent.sprint && this.stance === 'stand' && !this.ads && moveY > 0.1;

    const speed = moveSpeed({ stance: this.stance, sprinting: this.sprinting, boost, weaponMult });
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const mx = fx * moveY + rx * moveX;
    const mz = fz * moveY + rz * moveX;
    const len = Math.hypot(mx, mz);

    this.moving = len > 0.05;
    if (len > 1e-4) {
      // a half-pushed stick walks slower, a full push (or any key) goes at full speed
      const k = Math.min(1, len) / len;
      this.x += mx * k * speed * dt;
      this.z += mz * k * speed * dt;
    }

    this.x = clampToMap(this.x);
    this.z = clampToMap(this.z);
    const fixed = resolveObstacles(this.x, this.z, PLAYER_RADIUS);
    this.x = fixed.x;
    this.z = fixed.z;

    if (intent.jump && this.grounded && this.stance === 'stand') {
      this.vy = MOVE.jumpVelocity;
      this.grounded = false;
    }
    this.vy -= MOVE.gravity * dt;
    this.y += this.vy * dt;
    const ground = getTerrainHeight(this.x, this.z);
    if (this.y <= ground) {
      this.y = ground;
      this.vy = 0;
      this.grounded = true;
    } else if (this.y > ground + 0.05) {
      this.grounded = false;
    }
  }

  /** What `player_move` carries. */
  moveMessage() {
    return {
      x: this.x, y: this.y, z: this.z,
      yaw: this.yaw, pitch: this.pitch,
      stance: this.stance, lean: this.lean,
      sprinting: this.sprinting, ads: this.ads,
      epoch: this.epoch
    };
  }
}

/** Steering for the drone being piloted: sticks + where it looks (the server flies it). */
export class DroneControl {
  constructor() {
    this.yaw = 0;
    this.pitch = -0.15;
    this.input = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  }

  start(yaw = 0, pitch = -0.15) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.input = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  }

  update(intent) {
    this.yaw += intent.dYaw || 0;
    if (this.yaw > 1e3 || this.yaw < -1e3) this.yaw %= Math.PI * 2;
    this.pitch = clamp(this.pitch + (intent.dPitch || 0), -PITCH_LIMIT, PITCH_LIMIT);
    const dead = 0.3; // a stick has to be pushed a little before it counts as a direction
    this.input = {
      forward: (intent.moveY || 0) > dead,
      backward: (intent.moveY || 0) < -dead,
      right: (intent.moveX || 0) > dead,
      left: (intent.moveX || 0) < -dead,
      up: !!intent.droneUp,
      down: !!intent.droneDown
    };
  }

  /** What `control_drone` carries. */
  message() {
    return { ...this.input, yaw: this.yaw, pitch: this.pitch };
  }
}
