import * as THREE from 'three';
import type { Course } from '../data/Course';
import { Rng, deriveSeed, fmix32 } from '../data/Seed';
import { FIELD, HORSE, SIM } from '../game/Config';
import { HorseState, type HorseSimulation } from '../game/HorseSimulation';
import { BODY_PIVOT_Y, buildHorseFar, buildHorseMid, buildHorseNear, buildShadowGeometry, triangleCount } from './HorseGeometry';
import { COLOR_TEX_WIDTH, TEXELS_PER_HORSE, createHorseMaterial, createShadowMaterial } from './HorseMaterial';

/**
 * Render-side LOD for 10,000 horses. Independent of the simulation LOD layers:
 * render tiers are chosen by camera distance + frustum, sim layers by distance to the
 * player. Each tier is one instanced draw call (+1 for blob shadows on near/mid).
 */
export interface RenderLodSettings {
  nearDist: number;
  midDist: number;
  farDist: number;
  nearCap: number;
  midCap: number;
  /** max far-tier instances (closest kept) */
  farCap: number;
  /** fraction of far-tier horses drawn beyond midDist (stable per-id thinning) */
  farKeep: number;
  shadows: boolean;
}

export const DEFAULT_LOD: RenderLodSettings = {
  nearDist: 38,
  midDist: 140,
  farDist: 1250,
  nearCap: 160,
  midCap: 1400,
  farCap: 10000,
  farKeep: 1,
  shadows: true,
};

class Tier {
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly mesh: THREE.Mesh;
  readonly pose0: Float32Array;
  readonly pose1: Float32Array;
  readonly ids: Float32Array;
  readonly attr0: THREE.InstancedBufferAttribute;
  readonly attr1: THREE.InstancedBufferAttribute;
  readonly attrId: THREE.InstancedBufferAttribute;
  readonly shadow: THREE.Mesh | null;
  readonly trisPerInstance: number;
  count = 0;

  constructor(
    readonly capacity: number,
    base: THREE.BufferGeometry,
    material: THREE.Material,
    withShadow: boolean,
  ) {
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = base.index;
    for (const name of Object.keys(base.attributes)) this.geometry.setAttribute(name, base.getAttribute(name));
    this.pose0 = new Float32Array(capacity * 4);
    this.pose1 = new Float32Array(capacity * 4);
    this.ids = new Float32Array(capacity);
    this.attr0 = new THREE.InstancedBufferAttribute(this.pose0, 4).setUsage(THREE.DynamicDrawUsage);
    this.attr1 = new THREE.InstancedBufferAttribute(this.pose1, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrId = new THREE.InstancedBufferAttribute(this.ids, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iPose0', this.attr0);
    this.geometry.setAttribute('iPose1', this.attr1);
    this.geometry.setAttribute('iId', this.attrId);
    this.geometry.instanceCount = 0;
    this.trisPerInstance = triangleCount(base);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false; // culled per instance on the CPU
    if (withShadow) {
      const sg = new THREE.InstancedBufferGeometry();
      const circle = buildShadowGeometry();
      sg.index = circle.index;
      sg.setAttribute('position', circle.getAttribute('position'));
      sg.setAttribute('iPose0', this.attr0);
      sg.instanceCount = 0;
      this.shadow = new THREE.Mesh(sg, createShadowMaterial());
      this.shadow.frustumCulled = false;
      this.shadow.renderOrder = -1;
    } else {
      this.shadow = null;
    }
  }

  commit(): void {
    const n = this.count;
    this.geometry.instanceCount = n;
    for (const a of [this.attr0, this.attr1, this.attrId]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n * a.itemSize));
      a.needsUpdate = true;
    }
    if (this.shadow) (this.shadow.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
  }
}

export interface HorseRenderStats {
  near: number;
  mid: number;
  far: number;
  culled: number;
  triangles: number;
  /** instances uploaded this frame (near + mid + far) */
  instances: number;
}

const SILKS = [
  0xff4d6d, 0xffb703, 0x3a86ff, 0x8338ec, 0x06d6a0, 0xff7b00, 0xef476f, 0x118ab2, 0xffd60a, 0x2ec4b6, 0xe63946,
  0x9b5de5, 0x00bbf9, 0xf15bb5, 0x80ed99, 0xfee440, 0x4361ee, 0xff006e, 0xfb5607, 0x00f5d4,
];
const COATS = [0x8b4a24, 0x6b3a1e, 0xa0522d, 0x3b2a22, 0xd9cfc4, 0xc89b5a, 0x5a4636, 0xefe6dc];
export const PLAYER_COLORS = { coat: 0xfaf6f0, silkA: 0xff2d95, silkB: 0xffe600 };

export class HorseRenderer {
  readonly group = new THREE.Group();
  readonly colorTexture: THREE.DataTexture;
  private readonly near: Tier;
  private readonly mid: Tier;
  private readonly far: Tier;
  readonly settings: RenderLodSettings = { ...DEFAULT_LOD };
  readonly stats: HorseRenderStats = { near: 0, mid: 0, far: 0, culled: 0, triangles: 0, instances: 0 };

  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly planes = new Float32Array(24);
  private readonly tmp = new Float32Array(3);
  // per-frame scratch (visible horses)
  private readonly visIdx: Int32Array;
  private readonly visX: Float32Array;
  private readonly visZ: Float32Array;
  private readonly visH: Float32Array;
  private readonly visD: Float32Array;
  /** 1 m distance bins for the tier budgets */
  private readonly hist = new Int32Array(1301);
  /** stable per-horse key in [0,1) for far-tier thinning */
  private readonly thinKey: Float32Array;
  effectiveNear = 0;
  effectiveMid = 0;
  effectiveFar = 0;
  /** interpolated world pose of the player (for camera follow) */
  readonly playerPose = { x: 0, y: 0, z: 0, heading: 0, yaw: 0, speed: 0 };

  constructor(
    private sim: HorseSimulation,
    private readonly course: Course,
  ) {
    this.colorTexture = buildColorTexture(sim.n, sim.seed);
    const n = sim.n;
    this.visIdx = new Int32Array(n);
    this.visX = new Float32Array(n);
    this.visZ = new Float32Array(n);
    this.visH = new Float32Array(n);
    this.visD = new Float32Array(n);
    this.thinKey = new Float32Array(n);
    for (let i = 0; i < n; i++) this.thinKey[i] = fmix32(i + 1) / 4294967296;
    this.near = new Tier(Math.min(n, 512), buildHorseNear(), createHorseMaterial({ colors: this.colorTexture, animated: true }), true);
    this.mid = new Tier(Math.min(n, 4096), buildHorseMid(), createHorseMaterial({ colors: this.colorTexture, animated: true }), true);
    this.far = new Tier(n, buildHorseFar(), createHorseMaterial({ colors: this.colorTexture, animated: false, scale: 1.12 }), false);
    for (const t of [this.far, this.mid, this.near]) {
      if (t.shadow) this.group.add(t.shadow);
      this.group.add(t.mesh);
    }
  }

  rebind(sim: HorseSimulation): void {
    if (sim.seed !== this.sim.seed || sim.n !== this.sim.n) throw new Error('rebind requires the same seed and field size');
    this.sim = sim;
  }

  dispose(): void {
    for (const t of [this.far, this.mid, this.near]) {
      t.geometry.dispose();
      (t.mesh.material as THREE.Material).dispose();
      if (t.shadow) {
        t.shadow.geometry.dispose();
        (t.shadow.material as THREE.Material).dispose();
      }
    }
    this.colorTexture.dispose();
  }

  /** Compute the interpolated player pose only (call before camera update). */
  updatePlayerPose(alpha: number): void {
    const sim = this.sim;
    const i = FIELD.PLAYER;
    const x = sim.prevX[i] + (sim.x[i] - sim.prevX[i]) * alpha;
    const p = sim.prevProgress[i] + (sim.progress[i] - sim.prevProgress[i]) * alpha;
    const y = sim.prevY[i] + (sim.y[i] - sim.prevY[i]) * alpha;
    this.course.toWorld(x, p, this.tmp);
    const pp = this.playerPose;
    pp.x = this.tmp[0];
    pp.z = this.tmp[1];
    pp.y = y;
    pp.heading = this.tmp[2];
    pp.yaw = this.tmp[2] - Math.max(-0.45, Math.min(0.45, sim.vx[i] / Math.max(sim.speed[i], 10)));
    pp.speed = sim.speed[i];
  }

  /** Fill instance buffers for all visible horses. `camera` must already be positioned. */
  update(alpha: number, camera: THREE.PerspectiveCamera): void {
    const sim = this.sim;
    const course = this.course;
    const set = this.settings;

    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const pl = this.planes;
    for (let k = 0; k < 6; k++) {
      const plane = this.frustum.planes[k];
      pl[k * 4] = plane.normal.x;
      pl[k * 4 + 1] = plane.normal.y;
      pl[k * 4 + 2] = plane.normal.z;
      pl[k * 4 + 3] = plane.constant;
    }
    const camX = camera.position.x;
    const camZ = camera.position.z;
    const far2 = set.farDist * set.farDist;

    const near = this.near;
    const mid = this.mid;
    const far = this.far;
    near.count = mid.count = far.count = 0;
    let culled = 0;
    const tmp = this.tmp;
    const R = 2.2; // bounding sphere radius (tumbling horses included)
    const dtAlpha = alpha * SIM.DT;

    const { prevX, x: xs, prevProgress, progress, prevY, y: ys, vx, speed, state, stateTime, stateDuration, fallSide, gaitPhase } =
      sim;

    // ---- pass 1: interpolate, project to world, frustum/distance cull, distance histogram ----
    const vis = this.visIdx;
    const vwx = this.visX;
    const vwz = this.visZ;
    const vh = this.visH;
    const vd = this.visD;
    const hist = this.hist;
    hist.fill(0);
    const binMax = hist.length - 1;
    const thinKey = this.thinKey;
    const keep = set.farKeep;
    const midSetting = set.midDist;
    // camera -> player segment (for hiding occluders)
    const pp = this.playerPose;
    let segX = pp.x - camX;
    let segZ = pp.z - camZ;
    const segLen = Math.hypot(segX, segZ) || 1;
    segX /= segLen;
    segZ /= segLen;
    let nVis = 0;
    for (let i = 0; i < sim.n; i++) {
      const x = prevX[i] + (xs[i] - prevX[i]) * alpha;
      const p = prevProgress[i] + (progress[i] - prevProgress[i]) * alpha;
      course.toWorld(x, p, tmp);
      const wx = tmp[0];
      const wz = tmp[1];
      const dx = wx - camX;
      const dz = wz - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > far2) {
        culled++;
        continue;
      }
      // sphere vs frustum (centre at mid-body height)
      let inside = true;
      for (let k = 0; k < 24; k += 4) {
        if (pl[k] * wx + pl[k + 1] * 1.1 + pl[k + 2] * wz + pl[k + 3] < -R) {
          inside = false;
          break;
        }
      }
      if (!inside) {
        culled++;
        continue;
      }
      const d = Math.sqrt(d2);
      if (i !== FIELD.PLAYER) {
        // stable thinning of the far field on low quality levels
        if (d > midSetting && thinKey[i] >= keep) {
          culled++;
          continue;
        }
        // horses brushing past the lens, or standing between the camera and the player,
        // would hide the gaps the player is steering for: hide them
        if (d < 3.5) {
          culled++;
          continue;
        }
        const t = dx * segX + dz * segZ; // along camera->player, in metres
        if (t > 0 && t < segLen - 2.6) {
          const perp = Math.abs(dx * segZ - dz * segX);
          if (perp < 1.5) {
            culled++;
            continue;
          }
        }
      }
      vis[nVis] = i;
      vwx[nVis] = wx;
      vwz[nVis] = wz;
      vh[nVis] = tmp[2];
      vd[nVis] = d;
      nVis++;
      const bin = d < binMax ? d | 0 : binMax;
      hist[bin]++;
    }

    // ---- budgets: shrink tier radii so the CLOSEST horses get the detailed meshes, and the
    //      far tier never exceeds its instance cap (the farthest are dropped) ----
    let nearR = set.nearDist;
    let midR = set.midDist;
    let farR = set.farDist;
    {
      let cum = 0;
      let nearDone = false;
      let midDone = false;
      const total = set.nearCap + set.midCap + set.farCap;
      for (let b = 0; b <= binMax; b++) {
        const next = cum + hist[b];
        if (!nearDone && (b >= set.nearDist || next > set.nearCap - 1)) {
          nearR = Math.min(set.nearDist, b);
          nearDone = true;
        }
        if (!midDone && (b >= set.midDist || next > set.nearCap + set.midCap - 1)) {
          midR = Math.min(set.midDist, b);
          midDone = true;
        }
        if (next > total) {
          farR = b;
          break;
        }
        cum = next;
      }
    }
    this.effectiveNear = nearR;
    this.effectiveMid = midR;
    this.effectiveFar = farR;

    // ---- pass 2: tier assignment + pose ----
    for (let v = 0; v < nVis; v++) {
      const i = vis[v];
      const wx = vwx[v];
      const wz = vwz[v];
      const d = vd[v];
      let tier: Tier;
      if (i === FIELD.PLAYER || d < nearR) tier = near;
      else if (d < midR) tier = mid;
      else if (d < farR) tier = far;
      else {
        culled++;
        continue;
      }
      if (tier.count >= tier.capacity) tier = tier === near ? mid : far;
      if (tier.count >= tier.capacity) tier = far;
      if (tier.count >= tier.capacity) continue;

      // ---- pose from state (pure presentation; deterministic from sim data) ----
      const heading = vh[v];
      const sp = speed[i];
      let y = prevY[i] + (ys[i] - prevY[i]) * alpha;
      let steerYaw = vx[i] / (sp > 10 ? sp : 10);
      if (steerYaw > 0.45) steerYaw = 0.45;
      else if (steerYaw < -0.45) steerYaw = -0.45;
      let yaw = heading - steerYaw;
      let pitch = 0;
      let roll = 0;
      const phase = gaitPhase[i] + sp * 0.8 * dtAlpha;
      let amp = sp > 0.5 ? Math.min(1, sp / 14) * 0.8 : 0.08;
      const st = state[i];
      const t = stateTime[i] + dtAlpha;
      if (st === HorseState.FALL) {
        const side = fallSide[i] || 1;
        const u = Math.min(1, t / 0.75);
        const e = 1 - (1 - u) * (1 - u) * (1 - u);
        roll = side * e * (Math.PI * 2.5); // 1¼ comedic rolls, ends on its side
        pitch = 0.35 * Math.sin(u * Math.PI);
        y += lyingDrop(roll);
        amp = 1.25; // legs flail
        yaw += side * 0.5 * e;
      } else if (st === HorseState.RECOVER) {
        const side = fallSide[i] || 1;
        const u = Math.min(1, t / (stateDuration[i] || HORSE.RECOVER_TIME));
        const e = u * u * (3 - 2 * u);
        roll = side * (Math.PI * 0.5) * (1 - e);
        y += lyingDrop(roll) + Math.sin(u * Math.PI) * 0.35;
        yaw += side * 0.5 * (1 - e);
        amp = 0.6;
      } else if (st === HorseState.STUMBLE) {
        const k = Math.max(0, 1 - t / (stateDuration[i] || HORSE.STUMBLE_TIME));
        pitch = 0.3 * Math.sin(t * 16) * k + 0.12 * k;
        roll = 0.2 * Math.sin(t * 23) * k;
      } else {
        // galloping body rock + bob, lean into lateral motion
        pitch = Math.sin(phase * 2) * 0.05;
        roll = -vx[i] * 0.035;
        y += Math.abs(Math.sin(phase)) * 0.12 * amp;
      }

      const c = tier.count++;
      const o = c * 4;
      tier.pose0[o] = wx;
      tier.pose0[o + 1] = y;
      tier.pose0[o + 2] = wz;
      tier.pose0[o + 3] = yaw;
      tier.pose1[o] = pitch;
      tier.pose1[o + 1] = roll;
      tier.pose1[o + 2] = phase;
      tier.pose1[o + 3] = amp;
      tier.ids[c] = i;
    }

    near.commit();
    mid.commit();
    far.commit();
    const shadows = set.shadows;
    if (near.shadow) near.shadow.visible = shadows;
    if (mid.shadow) mid.shadow.visible = shadows;

    const s = this.stats;
    s.near = near.count;
    s.mid = mid.count;
    s.far = far.count;
    s.culled = culled;
    s.instances = near.count + mid.count + far.count;
    s.triangles =
      near.count * near.trisPerInstance + mid.count * mid.trisPerInstance + far.count * far.trisPerInstance;
  }
}

/** Lower the body while rolled so a horse lying on its side / back rests on the turf. */
function lyingDrop(roll: number): number {
  const s = Math.abs(Math.sin(roll));
  const c = Math.cos(roll);
  return -(BODY_PIVOT_Y - 0.42) * s - 0.55 * (1 - c) * 0.5 * (1 - s);
}

/** 4 texels per horse: coat, silk primary, silk secondary, spare. sRGB bytes. */
function buildColorTexture(n: number, seed: number): THREE.DataTexture {
  const texels = n * TEXELS_PER_HORSE;
  const h = Math.ceil(texels / COLOR_TEX_WIDTH);
  const data = new Uint8Array(COLOR_TEX_WIDTH * h * 4);
  const rng = new Rng(deriveSeed(seed, 'colors'));
  const put = (i: number, k: number, hex: number) => {
    const o = (i * TEXELS_PER_HORSE + k) * 4;
    data[o] = (hex >> 16) & 255;
    data[o + 1] = (hex >> 8) & 255;
    data[o + 2] = hex & 255;
    data[o + 3] = 255;
  };
  for (let i = 0; i < n; i++) {
    if (i === FIELD.PLAYER) {
      put(i, 0, PLAYER_COLORS.coat);
      put(i, 1, PLAYER_COLORS.silkA);
      put(i, 2, PLAYER_COLORS.silkB);
      continue;
    }
    const a = rng.int(0, SILKS.length - 1);
    let b = rng.int(0, SILKS.length - 2);
    if (b >= a) b++;
    put(i, 0, COATS[rng.int(0, COATS.length - 1)]);
    put(i, 1, SILKS[a]);
    put(i, 2, rng.chance(0.3) ? 0xffffff : SILKS[b]);
  }
  const tex = new THREE.DataTexture(data, COLOR_TEX_WIDTH, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
