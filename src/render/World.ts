import * as THREE from 'three';
import type { Course } from '../data/Course';
import type { HorseSimulation } from '../game/HorseSimulation';
import { CameraRig } from './CameraRig';
import { Environment, SKY } from './Environment';
import { Hazards } from './Hazards';
import { HorseRenderer, PLAYER_COLORS } from './HorseLOD';
import { LOD_LEVELS, type QualityState } from './Quality';

/**
 * Three.js scene owner. Knows nothing about game rules: it reads the simulation
 * arrays (interpolated with `alpha`) and draws them.
 */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  horses: HorseRenderer;
  env: Environment;
  hazards: Hazards;
  course: Course;
  private readonly marker: THREE.Mesh;
  private markerTime = 0;
  private lodLevel = 2;
  reduceMotion = false;
  /** last measured CPU cost (ms) */
  prepMs = 0;
  drawMs = 0;

  constructor(
    readonly canvasParent: HTMLElement,
    sim: HorseSimulation,
    course: Course,
  ) {
    this.course = course;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(SKY.fog);
    this.renderer.domElement.id = 'game-canvas';
    canvasParent.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.Fog(SKY.fog, 160, 1350);
    this.scene.background = null;

    const hemi = new THREE.HemisphereLight(0xdcefff, 0x6f9a45, 1.6);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(-0.6, 1, 0.35);
    this.scene.add(hemi, sun);

    this.env = new Environment(course);
    this.scene.add(this.env.group);
    this.horses = new HorseRenderer(sim, course);
    this.scene.add(this.horses.group);
    this.hazards = new Hazards(sim, course);
    this.scene.add(this.hazards.group);

    // floating marker above the player so they can be found in the crowd
    const mGeo = new THREE.ConeGeometry(0.32, 0.6, 4);
    mGeo.rotateX(Math.PI);
    this.marker = new THREE.Mesh(mGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(PLAYER_COLORS.silkA), fog: false }));
    this.scene.add(this.marker);

    this.rig = new CameraRig(1);
    this.rig.course = course;
    this.resize();
  }

  /**
   * Point the world at a (new) race. Same seed/course: cheap rebind. Different seed: the
   * scenery and the per-horse colours are rebuilt.
   */
  setRace(sim: HorseSimulation, course: Course): void {
    if (course !== this.course || sim.seed !== this.horses.seed || sim.n !== this.horses.n) {
      if (course !== this.course) {
        this.scene.remove(this.env.group);
        disposeTree(this.env.group);
        this.env = new Environment(course);
        this.scene.add(this.env.group);
        this.course = course;
        this.rig.course = course;
      }
      this.scene.remove(this.horses.group);
      this.horses.dispose();
      this.horses = new HorseRenderer(sim, course);
      Object.assign(this.horses.settings, LOD_LEVELS[this.lodLevel]);
      this.scene.add(this.horses.group);
      this.scene.remove(this.hazards.group);
      this.hazards.dispose();
      this.hazards = new Hazards(sim, course);
      this.scene.add(this.hazards.group);
    } else {
      this.horses.rebind(sim);
      this.hazards.rebind(sim);
    }
    this.rig.reset();
  }

  resize(): void {
    const w = this.canvasParent.clientWidth || window.innerWidth;
    const h = this.canvasParent.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.rig.resize(w / h);
  }

  applyQuality(q: QualityState): void {
    this.renderer.setPixelRatio(q.pixelRatio);
    this.resize();
    this.lodLevel = Math.max(0, Math.min(LOD_LEVELS.length - 1, q.level));
    Object.assign(this.horses.settings, LOD_LEVELS[this.lodLevel]);
  }

  render(alpha: number, dt: number, showMarker = true): void {
    const t0 = performance.now();
    this.horses.updatePlayerPose(alpha);
    const pp = this.horses.playerPose;
    this.rig.reduceMotion = this.reduceMotion;
    this.rig.update(pp, dt);
    // the high establishing shot sees the whole oval: push the fog out with camera height
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      const hgt = Math.max(0, this.rig.camera.position.y - 60);
      fog.near = 160 + hgt * 1.2;
      fog.far = 1350 + hgt * 1.6;
    }
    this.env.follow(this.rig.camera);
    this.horses.update(alpha, this.rig.camera);
    this.hazards.update(dt, this.reduceMotion);

    this.markerTime += dt;
    this.marker.visible = showMarker;
    this.marker.position.set(pp.x, pp.y + 3.1 + Math.sin(this.markerTime * 4) * 0.12, pp.z);
    this.marker.rotation.y = this.markerTime * 2;
    const t1 = performance.now();
    this.renderer.render(this.scene, this.rig.camera);
    const t2 = performance.now();
    this.prepMs = t1 - t0;
    this.drawMs = t2 - t1;
  }

  /**
   * Share-card photo: the player's horse seen from the front-right with the field charging
   * behind it, drawn with the game's own models / materials / environment. The main renderer
   * is switched to the card size for one render, copied into a 2D canvas straight after the
   * draw (no preserveDrawingBuffer needed) and then restored. LOD is raised for the shot only.
   * `focus` = where the horse sits in the frame (0..1 of width / height).
   */
  captureCard(w: number, h: number, focus: { x: number; y: number }, dist: number): HTMLCanvasElement {
    const r = this.renderer;
    const prevPR = r.getPixelRatio();
    const prevSize = r.getSize(new THREE.Vector2());
    const prevLod = { ...this.horses.settings };
    const prevMarker = this.marker.visible;
    try {
      r.setPixelRatio(1);
      r.setSize(w, h, false);
      Object.assign(this.horses.settings, LOD_LEVELS[LOD_LEVELS.length - 1]);
      this.horses.updatePlayerPose(1);
      const pp = this.horses.playerPose;
      // the arrow over the player's horse picks it out of the field
      this.marker.visible = true;
      this.marker.position.set(pp.x, pp.y + 3.1, pp.z);
      // camera ahead of the horse, a little to its right (three-quarter front view)
      const fx = Math.sin(pp.heading);
      const fz = Math.cos(pp.heading);
      const rx = -fz;
      const rz = fx;
      const cam = this.cardCamera ?? (this.cardCamera = new THREE.PerspectiveCamera(36, 1, 0.3, 3200));
      cam.aspect = w / h;
      cam.fov = w / h < 1 ? 46 : 36;
      cam.position.set(pp.x + fx * dist + rx * dist * 0.42, pp.y + 1.5, pp.z + fz * dist + rz * dist * 0.42);
      cam.lookAt(pp.x, pp.y + 1.35, pp.z);
      cam.setViewOffset(w, h, w / 2 - focus.x * w, h / 2 - focus.y * h, w, h);
      cam.updateMatrixWorld();
      this.env.follow(cam);
      this.horses.update(1, cam);
      r.render(this.scene, cam);
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable');
      ctx.drawImage(r.domElement, 0, 0);
      return out;
    } finally {
      Object.assign(this.horses.settings, prevLod);
      this.marker.visible = prevMarker;
      r.setPixelRatio(prevPR);
      r.setSize(prevSize.x, prevSize.y, false);
    }
  }

  private cardCamera: THREE.PerspectiveCamera | null = null;

  dispose(): void {
    this.horses.dispose();
    this.hazards.dispose();
    disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  get info() {
    return this.renderer.info.render;
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const mm of mats) {
      for (const v of Object.values(mm)) if (v instanceof THREE.Texture) v.dispose();
      mm.dispose();
    }
  });
}
