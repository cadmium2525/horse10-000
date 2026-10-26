import * as THREE from 'three';
import type { Course } from '../data/Course';
import { FIELD, HORSE } from '../game/Config';
import { HorseState, type HorseSimulation } from '../game/HorseSimulation';

/**
 * Early warning for downed horses / horse piles (design §3, §4: "危険な転倒群は遠方から
 * 砂埃・色・地面マーカーで予告"):
 *  - a pulsing ground ring under every downed horse ahead of the player, coloured by
 *    pile height: yellow = low enough to jump, red = too tall (go round). Rings grow with
 *    distance so a pile is readable 150 m+ ahead (> 7 s at race speed).
 *  - dust puffs where a horse has just gone down (also visible from far away).
 */
export const JUMPABLE_TOP = HORSE.JUMPABLE_TOP;

const MAX_MARKERS = 700;
const MAX_DUST = 900;

export class Hazards {
  readonly group = new THREE.Group();
  private readonly markers: THREE.InstancedMesh;
  /** floating diamonds above downed horses ahead: readable over the heads of the crowd */
  private readonly beacons: THREE.InstancedMesh;
  private readonly dust: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly yellow = new THREE.Color(0xffd60a);
  private readonly red = new THREE.Color(0xff3045);
  private readonly tmp = new Float32Array(3);
  private time = 0;
  /** stats for debug / tests */
  visibleMarkers = 0;

  constructor(
    private sim: HorseSimulation,
    private readonly course: Course,
  ) {
    const ring = new THREE.RingGeometry(0.75, 1.25, 20);
    ring.rotateX(-Math.PI / 2);
    this.markers = new THREE.InstancedMesh(
      ring,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, fog: false }),
      MAX_MARKERS,
    );
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 1;
    this.markers.count = 0;
    this.markers.setColorAt(0, this.yellow);

    const diamond = new THREE.OctahedronGeometry(0.45, 0);
    diamond.scale(1, 1.5, 1);
    this.beacons = new THREE.InstancedMesh(diamond, new THREE.MeshBasicMaterial({ fog: false }), MAX_MARKERS);
    this.beacons.frustumCulled = false;
    this.beacons.count = 0;
    this.beacons.setColorAt(0, this.yellow);

    const puff = new THREE.IcosahedronGeometry(0.6, 0);
    this.dust = new THREE.InstancedMesh(
      puff,
      new THREE.MeshLambertMaterial({ color: 0xe0cfa8, transparent: true, opacity: 0.8, flatShading: true }),
      MAX_DUST,
    );
    this.dust.frustumCulled = false;
    this.dust.count = 0;
    this.group.add(this.markers, this.beacons, this.dust);
  }

  rebind(sim: HorseSimulation): void {
    this.sim = sim;
  }

  dispose(): void {
    this.markers.geometry.dispose();
    (this.markers.material as THREE.Material).dispose();
    this.dust.geometry.dispose();
    (this.dust.material as THREE.Material).dispose();
    this.beacons.geometry.dispose();
    (this.beacons.material as THREE.Material).dispose();
  }

  update(dt: number, reduceMotion: boolean): void {
    this.time += dt;
    const sim = this.sim;
    const p0 = FIELD.PLAYER;
    const pp = sim.progress[p0];
    const px = sim.x[p0];
    let nm = 0;
    let nd = 0;
    let nb = 0;
    const pulse = reduceMotion ? 1 : 1 + 0.12 * Math.sin(this.time * 9);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 1; i < sim.n; i++) {
      if (sim.state[i] !== HorseState.FALL) continue;
      const dp = sim.progress[i] - pp;
      if (dp < -15 || dp > 320) continue;
      const dx = sim.x[i] - px;
      if (Math.abs(dx) > 140) continue;
      this.course.toWorld(sim.x[i], sim.progress[i], this.tmp);
      const dist = Math.hypot(dp, dx);
      if (nm < MAX_MARKERS) {
        const top = sim.groundY[i] + HORSE.FALLEN_HEIGHT;
        const sc = (1.15 + Math.max(0, dist - 25) / 55) * pulse * (top > JUMPABLE_TOP ? 1.25 : 1);
        this.q.setFromAxisAngle(up, this.tmp[2]);
        this.v.set(this.tmp[0], 0.05 + nm * 0.00002, this.tmp[1]);
        this.s.set(sc, 1, sc * 1.4);
        this.m.compose(this.v, this.q, this.s);
        this.markers.setMatrixAt(nm, this.m);
        this.markers.setColorAt(nm, top > JUMPABLE_TOP ? this.red : this.yellow);
        nm++;
        // diamonds only for what is close enough to act on (rings carry the far warnings)
        if (dp > 8 && dp < 85) {
          const bs = 0.8 + dist / 70;
          this.q.setFromAxisAngle(up, this.time * 2 + i);
          this.v.set(this.tmp[0], 3.0 + top + bs * 0.6 + (reduceMotion ? 0 : Math.sin(this.time * 4 + i) * 0.2), this.tmp[1]);
          this.s.set(bs, bs, bs);
          this.m.compose(this.v, this.q, this.s);
          this.beacons.setMatrixAt(nb, this.m);
          this.beacons.setColorAt(nb, top > JUMPABLE_TOP ? this.red : this.yellow);
          nb++;
        }
      }
      // dust puffs for fresh tumbles
      const age = sim.stateTime[i];
      if (age < 1.0 && nd + 3 <= MAX_DUST) {
        const grow = age < 0.5 ? age / 0.5 : 1 - (age - 0.5) / 0.5;
        const far = 1 + Math.max(0, dist - 40) / 60;
        for (let k = 0; k < 3; k++) {
          const ang = k * 2.1 + i;
          const r = 0.6 + age * 1.6;
          const sc = Math.max(0.01, (0.5 + age * 1.3) * grow * far);
          this.v.set(this.tmp[0] + Math.cos(ang) * r, 0.3 + age * 0.9 + k * 0.15, this.tmp[1] + Math.sin(ang) * r);
          this.s.set(sc, sc * 0.8, sc);
          this.q.identity();
          this.m.compose(this.v, this.q, this.s);
          this.dust.setMatrixAt(nd++, this.m);
        }
      }
    }
    this.markers.count = nm;
    this.beacons.count = nb;
    this.dust.count = nd;
    this.beacons.instanceMatrix.needsUpdate = true;
    if (this.beacons.instanceColor) this.beacons.instanceColor.needsUpdate = true;
    this.visibleMarkers = nm;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    this.dust.instanceMatrix.needsUpdate = true;
  }
}
