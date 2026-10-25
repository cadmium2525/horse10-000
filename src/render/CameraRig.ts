import * as THREE from 'three';

export interface FollowTarget {
  x: number;
  y: number;
  z: number;
  /** course heading at the target (rad, 0 = +Z) */
  heading: number;
  speed: number;
}

/**
 * Third-person chase camera behind the player. Smoothed with frame-rate independent
 * exponential damping. Pulls back and up a little while jumping so the landing spot
 * stays visible (design §3).
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private heading = 0;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private initialised = false;
  /** 0..1 additional pull-back (e.g. while airborne) */
  private pull = 0;

  // high enough to read the gaps between the horses ahead (occluders on the
  // camera->player line are hidden by the renderer)
  distance = 10.5;
  height = 6.2;
  lookAhead = 18;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.3, 3200);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    // keep a wide horizontal view in portrait
    this.camera.fov = aspect < 1 ? 78 : 60;
    this.camera.updateProjectionMatrix();
  }

  update(t: FollowTarget, dt: number): void {
    const k = (rate: number) => 1 - Math.exp(-rate * dt);
    if (!this.initialised) {
      this.heading = t.heading;
    } else {
      this.heading += (t.heading - this.heading) * k(4);
    }
    const airborne = Math.min(1, Math.max(0, t.y / 1.2));
    this.pull += (airborne - this.pull) * k(airborne > this.pull ? 6 : 2.5);
    const dist = this.distance + this.pull * 2.5 + Math.max(0, t.speed - 18) * 0.25;
    const height = this.height + this.pull * 1.6;
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    const tx = t.x - sh * dist;
    const tz = t.z - ch * dist;
    const ty = height + t.y * 0.35;
    const lx = t.x + sh * this.lookAhead;
    const lz = t.z + ch * this.lookAhead;
    const ly = 1.2 + t.y * 0.3;
    if (!this.initialised) {
      this.pos.set(tx, ty, tz);
      this.look.set(lx, ly, lz);
      this.initialised = true;
    } else {
      // lateral follow is tight (the player must see their lane), height is soft
      const a = k(10);
      this.pos.x += (tx - this.pos.x) * a;
      this.pos.z += (tz - this.pos.z) * a;
      this.pos.y += (ty - this.pos.y) * k(5);
      this.look.x += (lx - this.look.x) * k(12);
      this.look.z += (lz - this.look.z) * k(12);
      this.look.y += (ly - this.look.y) * k(5);
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  reset(): void {
    this.initialised = false;
    this.pull = 0;
  }
}
