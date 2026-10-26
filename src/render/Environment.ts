import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Course } from '../data/Course';
import { Rng, deriveSeed } from '../data/Seed';

/**
 * Static scenery: sky dome, ground, striped turf track following the course
 * centreline, white rails, start/finish lines, distance boards, trees, hills, clouds.
 * Everything is either one merged mesh or one InstancedMesh per kind (few draw calls).
 */
export const SKY = {
  zenith: 0x4f9fea,
  horizon: 0xd6ecff,
  fog: 0xcfe6f7,
};

const lin = (hex: number) => new THREE.Color().setHex(hex);

export class Environment {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  private readonly rng: Rng;

  constructor(private readonly course: Course) {
    this.rng = new Rng(deriveSeed(course.seed, 'scenery'));
    this.sky = this.buildSky();
    this.group.add(this.sky);
    this.group.add(this.buildGround());
    this.group.add(this.buildTrack());
    this.group.add(this.buildLines());
    for (const m of this.buildRails()) this.group.add(m);
    for (const m of this.buildTrees()) this.group.add(m);
    this.group.add(this.buildHills());
    this.group.add(this.buildInfieldAndStands());
    this.group.add(this.buildClouds());
    this.group.add(this.buildFinishArch());
    for (const m of this.buildDistanceBoards()) this.group.add(m);
  }

  /** keep the sky centred on the camera */
  follow(camera: THREE.Camera): void {
    this.sky.position.copy(camera.position);
  }

  private buildSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(2800, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: lin(SKY.zenith) },
        uHorizon: { value: lin(SKY.horizon) },
        uGround: { value: lin(SKY.fog) },
      },
      vertexShader: /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: /* glsl */ `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGround;
varying vec3 vDir;
void main(){
  float h = vDir.y;
  vec3 c = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h * 1.6, 0.0, 1.0), 0.7)) : uGround;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`,
    });
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = -10;
    m.frustumCulled = false;
    return m;
  }

  private buildGround(): THREE.Mesh {
    const c = this.course;
    const mid = [0, 0];
    c.infieldCenter(mid);
    const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x86c25a }));
    m.position.set(mid[0], -0.02, mid[1]);
    return m;
  }

  /** Mowed-stripe turf ribbon along the centreline (vertex colours, flat). */
  private buildTrack(): THREE.Mesh {
    const c = this.course;
    const step = 4;
    const stripe = 16;
    const half = c.width / 2 + 3;
    const segs = Math.ceil((c.sMax - c.sMin) / step);
    const pos = new Float32Array(segs * 4 * 3);
    const col = new Float32Array(segs * 4 * 3);
    const idx = new Uint32Array(segs * 6);
    const a = lin(0x5db347);
    const b = lin(0x6fc457);
    const L = [0, 0, 0];
    const R = [0, 0, 0];
    for (let k = 0; k < segs; k++) {
      const s0 = c.sMin + k * step;
      const s1 = s0 + step;
      const cc = Math.floor(s0 / stripe) & 1 ? a : b;
      let v = k * 4;
      for (const [s, side] of [
        [s0, -1],
        [s0, 1],
        [s1, -1],
        [s1, 1],
      ] as const) {
        c.toWorld(side * half, s, side < 0 ? L : R);
        const w = side < 0 ? L : R;
        pos[v * 3] = w[0];
        pos[v * 3 + 1] = 0;
        pos[v * 3 + 2] = w[1];
        col[v * 3] = cc.r;
        col[v * 3 + 1] = cc.g;
        col[v * 3 + 2] = cc.b;
        v++;
      }
      const o = k * 4;
      // counter-clockwise seen from above (+Y normal)
      idx.set([o, o + 1, o + 2, o + 1, o + 3, o + 2], k * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    return m;
  }

  /** Start line (white) and finish line (checkered) as thin ribbons. */
  private buildLines(): THREE.Group {
    const g = new THREE.Group();
    const c = this.course;
    const strip = (s: number, depth: number, mat: THREE.Material, repeat: number) => {
      const geo = new THREE.PlaneGeometry(c.width, depth);
      geo.rotateX(-Math.PI / 2);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let v = 0; v < uv.count; v++) uv.setX(v, uv.getX(v) * repeat);
      const m = new THREE.Mesh(geo, mat);
      const p = [0, 0, 0];
      c.toWorld(0, s, p);
      m.position.set(p[0], 0.02, p[1]);
      m.rotation.y = p[2];
      return m;
    };
    g.add(strip(0, 0.8, new THREE.MeshLambertMaterial({ color: 0xffffff }), 1));
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 16;
    const ctx = canvas.getContext('2d')!;
    for (let yy = 0; yy < 2; yy++)
      for (let xx = 0; xx < 8; xx++) {
        ctx.fillStyle = (xx + yy) & 1 ? '#111' : '#fff';
        ctx.fillRect(xx * 8, yy * 8, 8, 8);
      }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    g.add(strip(c.length, 3, new THREE.MeshLambertMaterial({ map: tex }), c.width / 12));
    return g;
  }

  /** White rails on both sides: instanced posts + instanced rail segments. */
  private buildRails(): THREE.Object3D[] {
    const c = this.course;
    const spacing = 3;
    const count = Math.floor((c.sMax - c.sMin) / spacing);
    const offs = [c.width / 2 + 0.6, -(c.width / 2 + 0.6)];
    const postGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.25, 6);
    postGeo.translate(0, 0.62, 0);
    const railGeo = new THREE.BoxGeometry(0.1, 0.12, spacing + 0.05);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const posts = new THREE.InstancedMesh(postGeo, mat, count * 2);
    const rails = new THREE.InstancedMesh(railGeo, mat, count * 4);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const p = [0, 0, 0];
    let ip = 0;
    let ir = 0;
    for (let k = 0; k < count; k++) {
      const s = c.sMin + k * spacing;
      for (const off of offs) {
        c.toWorld(off, s, p);
        m.makeTranslation(p[0], 0, p[1]);
        posts.setMatrixAt(ip++, m);
        c.toWorld(off, s + spacing / 2, p);
        q.setFromAxisAngle(up, p[2]);
        for (const h of [1.18, 0.7]) {
          v.set(p[0], h, p[1]);
          m.compose(v, q, one);
          rails.setMatrixAt(ir++, m);
        }
      }
    }
    posts.computeBoundingSphere();
    rails.computeBoundingSphere();
    return [posts, rails];
  }

  /** Toy trees (trunk + chunky crown) scattered outside the rails. */
  private buildTrees(): THREE.Object3D[] {
    const c = this.course;
    const rng = this.rng;
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3, 6);
    trunkGeo.translate(0, 1.5, 0);
    const crownGeo = new THREE.IcosahedronGeometry(2.6, 0);
    crownGeo.translate(0, 4.6, 0);
    const placements: { x: number; s: number; sc: number }[] = [];
    for (let s = c.sMin; s < c.sMax; s += 9) {
      for (const side of [-1, 1]) {
        if (rng.chance(0.65)) {
          const x = side * (c.width / 2 + rng.range(14, 70));
          placements.push({ x, s: s + rng.range(-4, 4), sc: rng.range(0.8, 1.6) });
        }
      }
    }
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x8a5a36 }), placements.length);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), placements.length);
    const greens = [0x3f9b3a, 0x4caf50, 0x2e8b57, 0x66bb44, 0x7cc243].map(lin);
    const m = new THREE.Matrix4();
    const p = [0, 0, 0];
    placements.forEach((t, i) => {
      c.toWorld(t.x, t.s, p);
      m.makeScale(t.sc, t.sc, t.sc).setPosition(p[0], 0, p[1]);
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, greens[rng.int(0, greens.length - 1)]);
    });
    trunks.computeBoundingSphere();
    crowns.computeBoundingSphere();
    return [trunks, crowns];
  }

  /** low-poly hills in a ring well outside the oval */
  private buildHills(): THREE.Mesh {
    const c = this.course;
    const rng = this.rng;
    const parts: THREE.BufferGeometry[] = [];
    const centre = [0, 0];
    c.infieldCenter(centre);
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * Math.PI * 2 + rng.range(-0.05, 0.05);
      const dist = rng.range(1150, 1600);
      const r = rng.range(140, 300);
      const g = new THREE.IcosahedronGeometry(r, 1);
      g.scale(1.7, rng.range(0.35, 0.7), 1);
      g.rotateY(-a);
      g.translate(centre[0] + Math.cos(a) * dist, -r * 0.1, centre[1] + Math.sin(a) * dist);
      parts.push(g);
    }
    const geo = mergeGeometries(parts)!;
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x77b26a, flatShading: true }));
  }

  /**
   * Toy-style infield landmarks: a pond with a little island, flower beds and a big screen
   * facing the home straight; a grandstand with a coloured crowd outside the home straight.
   */
  private buildInfieldAndStands(): THREE.Group {
    const c = this.course;
    const g = new THREE.Group();
    const centre = [0, 0];
    c.infieldCenter(centre);
    const rng = this.rng;
    // pond (flat ellipse) + island
    const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshLambertMaterial({ color: 0x5ab4e8 }));
    pond.rotation.x = -Math.PI / 2;
    pond.scale.set(150, 90, 1);
    pond.position.set(centre[0], 0.03, centre[1]);
    const island = new THREE.Mesh(new THREE.CylinderGeometry(22, 26, 3, 14), new THREE.MeshLambertMaterial({ color: 0x8fd16a }));
    island.position.set(centre[0] + 30, 0.5, centre[1]);
    g.add(pond, island);
    // flower beds (instanced, bright)
    const bed = new THREE.CylinderGeometry(6, 6, 0.6, 10);
    const flowers = new THREE.InstancedMesh(bed, new THREE.MeshLambertMaterial({ color: 0xffffff }), 36);
    const cols = [0xff5d8f, 0xffd60a, 0xff8a00, 0xb15dff, 0xffffff].map((h) => new THREE.Color(h));
    const m = new THREE.Matrix4();
    for (let k = 0; k < 36; k++) {
      const a = (k / 36) * Math.PI * 2;
      m.makeTranslation(centre[0] + Math.cos(a) * 200, 0.3, centre[1] + Math.sin(a) * 130);
      flowers.setMatrixAt(k, m);
      flowers.setColorAt(k, cols[k % cols.length]);
    }
    g.add(flowers);

    // big screen inside the home straight, facing it
    const p = [0, 0, 0];
    c.toWorld(-(c.width / 2 + 45), c.homeStart + 180, p);
    const screenGroup = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(70, 26, 3), new THREE.MeshLambertMaterial({ color: 0x23293a }));
    frame.position.y = 22;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(64, 21), new THREE.MeshBasicMaterial({ color: 0x3a86ff }));
    face.position.set(0, 22, 1.6);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(6, 10, 3), new THREE.MeshLambertMaterial({ color: 0x9aa3b5 }));
    legs.position.y = 5;
    screenGroup.add(frame, face, legs);
    screenGroup.position.set(p[0], 0, p[1]);
    // face the track (towards +x in course space = outward on the home straight)
    screenGroup.rotation.y = p[2] - Math.PI / 2;
    g.add(screenGroup);

    // grandstand outside the home straight with a dotted crowd
    const standLen = 380;
    const steps = 6;
    const standGeo: THREE.BufferGeometry[] = [];
    for (let k = 0; k < steps; k++) {
      const box = new THREE.BoxGeometry(standLen, 2.2, 6);
      box.translate(0, 1.1 + k * 2.2, k * 6);
      standGeo.push(box);
    }
    const stand = new THREE.Mesh(mergeGeometries(standGeo)!, new THREE.MeshLambertMaterial({ color: 0xe9edf5 }));
    const roof = new THREE.Mesh(new THREE.BoxGeometry(standLen + 20, 1.2, 46), new THREE.MeshLambertMaterial({ color: 0xff3b5c }));
    roof.position.set(0, steps * 2.2 + 9, 16);
    const crowdN = 900;
    const fan = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1.4, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), crowdN);
    for (let k = 0; k < crowdN; k++) {
      const row = rng.int(0, steps - 1);
      m.makeTranslation(rng.range(-standLen / 2 + 3, standLen / 2 - 3), 2.2 + row * 2.2 + 0.7, row * 6 + rng.range(-1.5, 1.5));
      fan.setMatrixAt(k, m);
      fan.setColorAt(k, cols[rng.int(0, cols.length - 1)]);
    }
    const standGroup = new THREE.Group();
    standGroup.add(stand, roof, fan);
    c.toWorld(c.width / 2 + 28, c.homeStart + 260, p);
    standGroup.position.set(p[0], 0, p[1]);
    // local +z points away from the track (outside), local x along the straight
    standGroup.rotation.y = p[2] - Math.PI / 2;
    g.add(standGroup);
    return g;
  }

  private buildClouds(): THREE.Mesh {
    const c = this.course;
    const rng = this.rng;
    const parts: THREE.BufferGeometry[] = [];
    const p = [0, 0, 0];
    // clouds ring the course but leave the air above the oval clear (the intro looks down
    // on it from high above the infield)
    const centre = [0, 0];
    c.infieldCenter(centre);
    for (let k = 0; k < 34; k++) {
      c.toWorld(rng.range(-1600, 1600), rng.range(c.sMin - 400, c.sMax + 1600), p);
      const dx = p[0] - centre[0];
      const dz = p[1] - centre[1];
      const d = Math.hypot(dx, dz);
      if (d < 1000) {
        p[0] = centre[0] + (dx / Math.max(1, d)) * (1000 + (d % 300));
        p[1] = centre[1] + (dz / Math.max(1, d)) * (1000 + (d % 300));
      }
      const y = rng.range(180, 320);
      const puffs = rng.int(3, 5);
      for (let j = 0; j < puffs; j++) {
        const r = rng.range(22, 40);
        const g = new THREE.IcosahedronGeometry(r, 1);
        g.scale(1.4, 0.75, 1);
        g.translate(p[0] + (j - puffs / 2) * r * 1.1, y + rng.range(-6, 10), p[1] + rng.range(-15, 15));
        parts.push(g);
      }
    }
    const geo = mergeGeometries(parts)!;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xb8c8d8, flatShading: true, fog: false });
    return new THREE.Mesh(geo, mat);
  }

  private buildFinishArch(): THREE.Group {
    const c = this.course;
    const g = new THREE.Group();
    const p = [0, 0, 0];
    c.toWorld(0, c.length, p);
    g.position.set(p[0], 0, p[1]);
    g.rotation.y = p[2];
    const half = c.width / 2 + 2;
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xff3b5c });
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 20, 10), poleMat);
      pole.position.set(side * half, 10, 0);
      g.add(pole);
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff3b5c';
    ctx.fillRect(0, 0, 1024, 64);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < 4; k++) ctx.fillText('★ GOAL ★', 128 + k * 256, 34);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(4, 1);
    tex.anisotropy = 4;
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(half * 2, 4.5, 0.6),
      new THREE.MeshLambertMaterial({ map: tex, emissive: 0x331018 }),
    );
    banner.position.set(0, 18, 0);
    g.add(banner);
    return g;
  }

  /** Remaining-distance boards on the right-hand rail every 200 m. */
  private buildDistanceBoards(): THREE.Object3D[] {
    const c = this.course;
    const out: THREE.Object3D[] = [];
    const p = [0, 0, 0];
    for (let rem = 200; rem < c.length; rem += 200) {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 128, 64);
      ctx.fillStyle = '#e63946';
      ctx.fillRect(0, 0, 128, 10);
      ctx.fillStyle = '#222';
      ctx.font = 'bold 38px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(rem), 64, 38);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const board = new THREE.Group();
      const face = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      face.position.y = 4;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4, 6), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      pole.position.y = 2;
      board.add(face, pole);
      for (const side of [-1, 1]) {
        const b = side < 0 ? board : board.clone();
        c.toWorld(side * (c.width / 2 + 3), c.length - rem, p);
        b.position.set(p[0], 0, p[1]);
        b.rotation.y = p[2] + Math.PI; // face the approaching field
        out.push(b);
      }
    }
    return out;
  }
}
