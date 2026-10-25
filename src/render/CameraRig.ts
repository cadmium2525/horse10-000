import * as THREE from 'three';

export interface FollowTarget {
  x: number;
  y: number;
  z: number;
  /** course heading at the target (rad, 0 = +Z) */
  heading: number;
  speed: number;
  /** course-space position of the target (lateral, progress) */
  cx: number;
  cs: number;
}

/** minimal view of the course the camera needs (oval following) */
export interface CameraCourse {
  toWorld(x: number, s: number, out: number[] | Float32Array): void;
  infieldCenter(out: number[] | Float32Array): void;
}

export type CameraMode = 'title' | 'intro' | 'chase' | 'finish';

/**
 * Camera director.
 *  - title:  slow high orbit over the pack (attract mode)
 *  - intro:  ultra-wide shot of the whole field easing down into the chase camera over
 *            the start sequence (design §3-2)
 *  - chase:  third-person follow; pulls back/up while airborne so the landing spot is
 *            visible (design §3)
 *  - finish: slow orbit around the player
 * Shake is additive and disabled when "reduce motion" is on.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private modeTime = 0;
  private introLength = 3;
  private heading = 0;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private initialised = false;
  private pull = 0;
  private shakeAmp = 0;
  private shakeT = 0;
  reduceMotion = false;
  course: CameraCourse | null = null;
  private readonly tmpA = [0, 0, 0];
  private readonly tmpB = [0, 0, 0];
  private readonly centre = [0, 0];

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

  setMode(mode: CameraMode, introLength = 3): void {
    this.mode = mode;
    this.modeTime = 0;
    this.introLength = introLength;
    if (mode === 'title' || mode === 'intro') this.initialised = false;
  }

  shake(amount: number): void {
    if (this.reduceMotion) return;
    this.shakeAmp = Math.min(0.6, Math.max(this.shakeAmp, amount));
  }

  update(t: FollowTarget, dt: number): void {
    this.modeTime += dt;
    const k = (rate: number) => 1 - Math.exp(-rate * dt);
    if (!this.initialised) this.heading = t.heading;
    else this.heading += (t.heading - this.heading) * k(4);
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    // right vector for heading h: (-cos h, 0, sin h)
    const rx = -ch;
    const rz = sh;

    let tx: number;
    let ty: number;
    let tz: number;
    let lx: number;
    let ly: number;
    let lz: number;
    let rate = 10;

    if (this.mode === 'title' && this.course) {
      // high slow orbit over the infield: the whole oval and the 10,000-strong band
      this.course.infieldCenter(this.centre);
      const a = this.modeTime * 0.04 + 2.2;
      const R = 620;
      tx = this.centre[0] + Math.cos(a) * R;
      tz = this.centre[1] + Math.sin(a) * R;
      ty = 210;
      lx = (t.x + this.centre[0]) * 0.5;
      lz = (t.z + this.centre[1]) * 0.5;
      ly = 0;
      rate = 2;
    } else if (this.mode === 'finish') {
      const a = this.modeTime * 0.35 + Math.PI;
      tx = t.x + Math.cos(a) * 9 * rx + Math.sin(a) * 9 * sh;
      tz = t.z + Math.cos(a) * 9 * rz + Math.sin(a) * 9 * ch;
      ty = 3.6;
      lx = t.x;
      lz = t.z;
      ly = 1.4;
      rate = 3;
    } else {
      const airborne = Math.min(1, Math.max(0, t.y / 1.2));
      this.pull += (airborne - this.pull) * k(airborne > this.pull ? 6 : 2.5);
      const dist = this.distance + this.pull * 2.5 + Math.max(0, t.speed - 18) * 0.25;
      const height = this.height + this.pull * 1.6;
      // follow the course: camera on the centreline-parallel curve behind the player,
      // looking at a point ahead on the course (so it sees round the turn)
      if (this.course) {
        this.course.toWorld(t.cx * 0.9, t.cs - dist, this.tmpA);
        this.course.toWorld(t.cx * 0.8, t.cs + this.lookAhead, this.tmpB);
        tx = this.tmpA[0];
        tz = this.tmpA[1];
        lx = this.tmpB[0];
        lz = this.tmpB[1];
      } else {
        tx = t.x - sh * dist;
        tz = t.z - ch * dist;
        lx = t.x + sh * this.lookAhead;
        lz = t.z + ch * this.lookAhead;
      }
      ty = height + t.y * 0.35;
      ly = 1.2 + t.y * 0.3;
      if (this.mode === 'intro' && this.course) {
        // establishing shot from above the infield (the oval and the whole field) easing
        // down into the chase camera over the start sequence
        const u = Math.min(1, this.modeTime / (this.introLength * 0.85));
        const e = u * u * (3 - 2 * u);
        this.course.infieldCenter(this.centre);
        this.course.toWorld(0, t.cs + 120, this.tmpB);
        const sx = this.centre[0] * 0.55 + this.tmpB[0] * 0.45;
        const sz = this.centre[1] * 0.55 + this.tmpB[1] * 0.45;
        tx = sx + (tx - sx) * e;
        tz = sz + (tz - sz) * e;
        ty = 230 + (ty - 230) * e;
        this.course.toWorld(0, t.cs + 140, this.tmpB);
        lx = this.tmpB[0] + (lx - this.tmpB[0]) * e;
        lz = this.tmpB[1] + (lz - this.tmpB[1]) * e;
        ly = ly * e;
        rate = 30;
      }
    }

    if (!this.initialised) {
      this.pos.set(tx, ty, tz);
      this.look.set(lx, ly, lz);
      this.initialised = true;
    } else {
      // lateral follow is tight (the player must see their lane), height is soft
      const a = k(rate);
      this.pos.x += (tx - this.pos.x) * a;
      this.pos.z += (tz - this.pos.z) * a;
      this.pos.y += (ty - this.pos.y) * k(Math.min(rate, 5));
      this.look.x += (lx - this.look.x) * k(rate + 2);
      this.look.z += (lz - this.look.z) * k(rate + 2);
      this.look.y += (ly - this.look.y) * k(5);
    }
    this.camera.position.copy(this.pos);
    if (this.shakeAmp > 0.001) {
      this.shakeT += dt;
      const s = this.shakeAmp;
      this.camera.position.x += Math.sin(this.shakeT * 53) * s;
      this.camera.position.y += Math.sin(this.shakeT * 61 + 1) * s * 0.6;
      this.shakeAmp *= Math.exp(-dt * 7);
    }
    this.camera.lookAt(this.look);
  }

  reset(): void {
    this.initialised = false;
    this.pull = 0;
    this.shakeAmp = 0;
  }
}
