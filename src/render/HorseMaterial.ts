import * as THREE from 'three';
import { BODY_PIVOT_Y } from './HorseGeometry';

/**
 * Lambert material extended for GPU-posed instanced horses.
 *
 * Per-instance attributes (InstancedBufferAttribute):
 *   iPose0 vec4: world x, world y, world z, yaw
 *   iPose1 vec4: pitch, roll, gait phase, gait amplitude
 *   iId    float: horse id -> colour lookup in uColors (4 texels per horse)
 *
 * Only 9 floats per horse are uploaded per frame (vs 16 for an instance matrix),
 * the leg swing is done in the vertex shader, and colours live in a static texture.
 */
export interface HorseMaterialOptions {
  colors: THREE.DataTexture;
  animated: boolean;
  scale?: number;
}

export const COLOR_TEX_WIDTH = 256;
export const TEXELS_PER_HORSE = 4;

export function createHorseMaterial(opts: HorseMaterialOptions): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const uniforms = {
    uColors: { value: opts.colors },
    uScale: { value: opts.scale ?? 1 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec3 aMask;
attribute vec4 aLeg;
attribute vec4 iPose0;
attribute vec4 iPose1;
attribute float iId;
uniform highp sampler2D uColors;
uniform float uScale;
mat3 hRotX(float a){ float c=cos(a), s=sin(a); return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c); }
mat3 hRotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }
mat3 hRotZ(float a){ float c=cos(a), s=sin(a); return mat3(c,s,0.0, -s,c,0.0, 0.0,0.0,1.0); }
vec3 hColor(int k){
  int idx = int(iId + 0.5) * ${TEXELS_PER_HORSE} + k;
  return texelFetch(uColors, ivec2(idx % ${COLOR_TEX_WIDTH}, idx / ${COLOR_TEX_WIDTH}), 0).rgb;
}`,
      )
      .replace(
        '#include <color_vertex>',
        /* glsl */ `#include <color_vertex>
{
  vec3 coat = hColor(0);
  vec3 silkA = hColor(1);
  vec3 silkB = hColor(2);
  vec3 tint = mix(mix(mix(vec3(1.0), coat, aMask.x), silkA, aMask.y), silkB, aMask.z);
  vColor.rgb *= tint;
}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
${opts.animated ? 'float hLegA = aLeg.x * sin(iPose1.z + aLeg.y) * iPose1.w;' : 'float hLegA = 0.0;'}
mat3 hLegR = hRotX(hLegA);
mat3 hBodyR = hRotY(iPose0.w) * hRotZ(iPose1.y) * hRotX(iPose1.x);
vec3 objectNormal = hBodyR * (hLegR * normal);
#ifdef USE_TANGENT
vec3 objectTangent = vec3( tangent.xyz );
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
vec3 hLocal = position;
${opts.animated ? 'if (aLeg.x > 0.5) { vec3 hPiv = vec3(0.0, aLeg.z, aLeg.w); hLocal = hLegR * (hLocal - hPiv) + hPiv; }' : ''}
vec3 hPivot = vec3(0.0, ${BODY_PIVOT_Y.toFixed(3)}, 0.0);
vec3 transformed = hBodyR * ((hLocal - hPivot) * uScale) + hPivot * uScale + iPose0.xyz;`,
      );
  };
  // distinct program per variant
  mat.customProgramCacheKey = () => `horse-${opts.animated ? 'anim' : 'static'}`;
  return mat;
}

/** Blob shadows: reuse the tier's iPose0 buffer, flatten onto the ground. */
export function createShadowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: 0.32 } },
    vertexShader: /* glsl */ `
attribute vec4 iPose0;
varying vec2 vUv;
varying float vFade;
void main(){
  vUv = position.xz;
  float c = cos(iPose0.w), s = sin(iPose0.w);
  vec3 p = vec3(position.x * 0.62, 0.0, position.z * 1.25);
  p = vec3(c * p.x + s * p.z, 0.0, -s * p.x + c * p.z);
  float h = max(iPose0.y, 0.0);
  float k = 1.0 / (1.0 + h * 0.35);
  vec3 w = vec3(iPose0.x + p.x * (2.0 - k), 0.03, iPose0.z + p.z * (2.0 - k));
  vFade = k;
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;
varying float vFade;
void main(){
  float d = length(vUv);
  float a = smoothstep(1.0, 0.35, d) * uOpacity * vFade;
  gl_FragColor = vec4(0.05, 0.12, 0.02, a);
}`,
  });
}
