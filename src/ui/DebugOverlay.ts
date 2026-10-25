/**
 * `?debug=1` overlay: FPS, sim/render CPU time, LOD layer counts, quality state.
 * Updated at 4 Hz to keep DOM cost negligible.
 */
export interface DebugStats {
  fps: number;
  frameMs: number;
  simMsPerTick: number;
  simTicksPerFrame: number;
  prepMs: number;
  drawMs: number;
  layerA: number;
  layerB: number;
  layerC: number;
  radiusA: number;
  radiusB: number;
  renderNear: number;
  renderMid: number;
  renderFar: number;
  renderCulled: number;
  renderNearR: number;
  renderFarR: number;
  instances: number;
  impostors: number;
  phase: string;
  cpuMs: number;
  refreshMs: number;
  renderMidR: number;
  triangles: number;
  drawCalls: number;
  pixelRatio: number;
  qualityLevel: number;
  rank: number;
  overtakes: number;
  playerState: string;
  speed: number;
  dash: number;
  progress: number;
  remaining: number;
  raceTime: number;
  contacts: number;
  falls: number;
  down: number;
  seed: number;
}

export class DebugOverlay {
  private readonly el: HTMLDivElement;
  private acc = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'debug-overlay';
    parent.appendChild(this.el);
  }

  update(s: DebugStats, dt: number): void {
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    const f = (v: number, d = 1) => v.toFixed(d);
    this.el.textContent =
      `FPS ${f(s.fps, 0)}  frame ${f(s.frameMs)}ms  px ${f(s.pixelRatio, 2)}  Q${s.qualityLevel}\n` +
      `cpu ${f(s.cpuMs, 2)}ms/frame (budget ${f(Math.max(16.67, s.refreshMs))}ms, refresh ${f(s.refreshMs)}ms)\n` +
      `sim ${f(s.simMsPerTick, 2)}ms/tick x${f(s.simTicksPerFrame, 2)}  prep ${f(s.prepMs, 2)}ms  draw ${f(s.drawMs, 2)}ms\n` +
      `sim LOD  A ${s.layerA}  B ${s.layerB}  C ${s.layerC}  (rA ${f(s.radiusA)}m rB ${f(s.radiusB)}m)\n` +
      `render   near ${s.renderNear}  mid ${s.renderMid}  far ${s.renderFar}  culled ${s.renderCulled}  (${f(s.renderNearR, 0)}/${f(s.renderMidR, 0)}/${f(s.renderFarR, 0)}m)\n` +
      `tris ${(s.triangles / 1000).toFixed(0)}k  inst ${s.instances}  pts ${s.impostors}  calls ${s.drawCalls}  contacts ${s.contacts}  down ${s.down}  falls ${s.falls}\n` +
      `rank ${s.rank.toLocaleString()} / 10,000  passed ${s.overtakes}  ${s.playerState}  ${f(s.speed)}m/s  dash ${f(s.dash * 100, 0)}%\n` +
      `t ${f(s.raceTime)}s  progress ${f(s.progress, 0)}m  remain ${f(s.remaining, 0)}m  seed ${s.seed}  ${s.phase}`;
  }

  dispose(): void {
    this.el.remove();
  }
}
