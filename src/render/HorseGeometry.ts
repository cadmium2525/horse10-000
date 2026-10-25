import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural toy-style low-poly horse + jockey.
 *
 * Model space: facing +Z, standing on y = 0, body centre at (0, BODY_PIVOT_Y, 0).
 * Extra vertex attributes consumed by HorseMaterial:
 *   aMask (vec3): weights for (coat colour, silk primary, silk secondary)
 *   aLeg  (vec4): (isLeg, gait phase offset, hip pivot y, hip pivot z)
 */
export const BODY_PIVOT_Y = 1.1;

const HIP_Y = 0.86;

type MaskKind = 'coat' | 'silkA' | 'silkB' | 'fixed';

interface PartOpts {
  /** sRGB hex; multiplied with the mask colour (use 0xffffff for pure mask colour) */
  color?: number;
  mask?: MaskKind;
  /** leg index 0..3 => animated around the hip */
  leg?: number;
}

// gallop leg phase offsets (front-left, front-right, hind-left, hind-right)
const LEG_PHASE = [0.0, 0.7, Math.PI, Math.PI + 0.7];
const LEG_Z = [0.42, 0.42, -0.42, -0.42];
const LEG_X = [-0.19, 0.19, -0.19, 0.19];

const tmpColor = new THREE.Color();

function tag(geo: THREE.BufferGeometry, opts: PartOpts): THREE.BufferGeometry {
  const g = geo;
  g.deleteAttribute('uv');
  const count = g.getAttribute('position').count;
  const color = new Float32Array(count * 3);
  const mask = new Float32Array(count * 3);
  const leg = new Float32Array(count * 4);
  tmpColor.setHex(opts.color ?? 0xffffff); // converts sRGB -> linear working space
  const m = opts.mask ?? 'fixed';
  const mk = m === 'coat' ? [1, 0, 0] : m === 'silkA' ? [0, 1, 0] : m === 'silkB' ? [0, 0, 1] : [0, 0, 0];
  for (let v = 0; v < count; v++) {
    color[v * 3] = tmpColor.r;
    color[v * 3 + 1] = tmpColor.g;
    color[v * 3 + 2] = tmpColor.b;
    mask[v * 3] = mk[0];
    mask[v * 3 + 1] = mk[1];
    mask[v * 3 + 2] = mk[2];
    if (opts.leg !== undefined) {
      leg[v * 4] = 1;
      leg[v * 4 + 1] = LEG_PHASE[opts.leg];
      leg[v * 4 + 2] = HIP_Y;
      leg[v * 4 + 3] = LEG_Z[opts.leg];
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('aMask', new THREE.BufferAttribute(mask, 3));
  g.setAttribute('aLeg', new THREE.BufferAttribute(leg, 4));
  return g;
}

function capsuleZ(r: number, len: number, capSeg: number, radial: number): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, len, capSeg, radial);
  g.rotateX(Math.PI / 2);
  return g;
}

function place(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('mergeGeometries failed');
  merged.computeBoundingSphere();
  return merged;
}

const MANE = 0x3a2a20;
const HOOF = 0x2b2522;
const SKIN = 0xf1c7a0;
const WHITE = 0xffffff;
const CLOTH = 0xf7f4ee;

/** Near LOD: rounded, ~900 triangles. */
export function buildHorseNear(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // body (slightly squashed capsule)
  const body = capsuleZ(0.4, 0.95, 3, 8);
  body.scale(0.92, 1, 1);
  parts.push(tag(place(body, 0, BODY_PIVOT_Y, 0), { mask: 'coat' }));
  // neck
  parts.push(tag(place(new THREE.CapsuleGeometry(0.2, 0.5, 2, 6), 0, 1.55, 0.72, 0.62), { mask: 'coat' }));
  // head + muzzle
  parts.push(tag(place(capsuleZ(0.19, 0.34, 2, 7), 0, 1.86, 1.0, 0.55), { mask: 'coat' }));
  parts.push(tag(place(new THREE.SphereGeometry(0.15, 6, 4), 0, 1.72, 1.2), { mask: 'coat', color: 0xd8c8b8 }));
  // eyes
  for (const s of [-1, 1]) {
    parts.push(tag(place(new THREE.SphereGeometry(0.045, 4, 3), s * 0.15, 1.93, 1.03), { color: 0x1a1a1a }));
    // ears
    parts.push(tag(place(new THREE.ConeGeometry(0.06, 0.18, 4), s * 0.09, 2.1, 0.88, -0.2), { mask: 'coat' }));
  }
  // mane & tail
  parts.push(tag(place(new THREE.BoxGeometry(0.09, 0.55, 0.16), 0, 1.72, 0.6, 0.62), { color: MANE }));
  parts.push(tag(place(new THREE.CapsuleGeometry(0.09, 0.42, 1, 5), 0, 1.05, -0.82, -0.7), { color: MANE }));
  // legs + hooves (animated)
  for (let l = 0; l < 4; l++) {
    parts.push(tag(place(new THREE.CapsuleGeometry(0.1, 0.6, 1, 6), LEG_X[l], 0.46, LEG_Z[l]), { mask: 'coat', leg: l }));
    parts.push(tag(place(new THREE.CylinderGeometry(0.11, 0.12, 0.12, 6), LEG_X[l], 0.07, LEG_Z[l]), { color: HOOF, leg: l }));
  }
  // saddle cloth
  parts.push(tag(place(new THREE.BoxGeometry(0.86, 0.08, 0.62), 0, 1.47, 0.0), { color: CLOTH }));
  parts.push(tag(place(new THREE.BoxGeometry(0.88, 0.05, 0.64), 0, 1.44, 0.0), { mask: 'silkB' }));
  // jockey: torso, arms, legs, head, helmet
  parts.push(tag(place(new THREE.CapsuleGeometry(0.18, 0.26, 2, 7), 0, 1.86, 0.12, 0.75), { mask: 'silkA' }));
  for (const s of [-1, 1]) {
    parts.push(tag(place(new THREE.CapsuleGeometry(0.065, 0.3, 1, 5), s * 0.2, 1.86, 0.36, 1.2), { mask: 'silkA' }));
    parts.push(tag(place(new THREE.CapsuleGeometry(0.08, 0.3, 1, 5), s * 0.27, 1.62, 0.1, 0.9), { color: WHITE }));
  }
  parts.push(tag(place(new THREE.SphereGeometry(0.13, 6, 4), 0, 2.09, 0.38), { color: SKIN }));
  const helmet = new THREE.SphereGeometry(0.155, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.55);
  parts.push(tag(place(helmet, 0, 2.13, 0.36, -0.25), { mask: 'silkB' }));
  parts.push(tag(place(new THREE.BoxGeometry(0.2, 0.03, 0.12), 0, 2.15, 0.52, -0.25), { mask: 'silkB' }));
  return merge(parts);
}

/** Mid LOD: same silhouette, ~220 triangles, legs still animated. */
export function buildHorseMid(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = capsuleZ(0.4, 0.95, 2, 6);
  body.scale(0.92, 1, 1);
  parts.push(tag(place(body, 0, BODY_PIVOT_Y, 0), { mask: 'coat' }));
  parts.push(tag(place(new THREE.CapsuleGeometry(0.2, 0.5, 1, 5), 0, 1.55, 0.72, 0.62), { mask: 'coat' }));
  parts.push(tag(place(capsuleZ(0.19, 0.36, 1, 5), 0, 1.84, 1.04, 0.55), { mask: 'coat' }));
  parts.push(tag(place(new THREE.BoxGeometry(0.09, 0.5, 0.14), 0, 1.72, 0.6, 0.62), { color: MANE }));
  parts.push(tag(place(new THREE.BoxGeometry(0.12, 0.42, 0.12), 0, 1.05, -0.82, -0.7), { color: MANE }));
  for (let l = 0; l < 4; l++) {
    parts.push(tag(place(new THREE.BoxGeometry(0.17, 0.8, 0.17), LEG_X[l], 0.44, LEG_Z[l]), { mask: 'coat', leg: l }));
  }
  parts.push(tag(place(new THREE.BoxGeometry(0.86, 0.1, 0.62), 0, 1.46, 0.0), { mask: 'silkB' }));
  parts.push(tag(place(new THREE.CapsuleGeometry(0.19, 0.24, 1, 5), 0, 1.86, 0.14, 0.75), { mask: 'silkA' }));
  parts.push(tag(place(new THREE.SphereGeometry(0.16, 6, 4), 0, 2.11, 0.37), { mask: 'silkB' }));
  return merge(parts);
}

/** Far LOD: boxes only (~60 triangles). Reads as a colourful dot of horse + jockey. */
export function buildHorseFar(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tag(place(new THREE.BoxGeometry(0.72, 0.72, 1.7), 0, BODY_PIVOT_Y, 0), { mask: 'coat' }));
  parts.push(tag(place(new THREE.BoxGeometry(0.34, 0.75, 0.38), 0, 1.65, 0.9, 0.6), { mask: 'coat' }));
  parts.push(tag(place(new THREE.BoxGeometry(0.6, 0.78, 0.2), 0, 0.42, 0.42), { mask: 'coat', color: 0xcccccc }));
  parts.push(tag(place(new THREE.BoxGeometry(0.6, 0.78, 0.2), 0, 0.42, -0.42), { mask: 'coat', color: 0xcccccc }));
  parts.push(tag(place(new THREE.BoxGeometry(0.42, 0.55, 0.42), 0, 1.86, 0.12, 0.5), { mask: 'silkA' }));
  parts.push(tag(place(new THREE.BoxGeometry(0.3, 0.26, 0.3), 0, 2.16, 0.32), { mask: 'silkB' }));
  return merge(parts);
}

/** Soft round blob shadow (unit radius, on the XZ plane). */
export function buildShadowGeometry(): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(1, 12);
  g.rotateX(-Math.PI / 2);
  g.deleteAttribute('normal');
  return g;
}

export function triangleCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
