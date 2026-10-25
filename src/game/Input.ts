/**
 * Raw input collection (keyboard + touch). Converted into a per-tick PlayerIntent by
 * PlayerController. Jump is edge-triggered and latched until the sim consumes it, so a
 * tap shorter than one sim tick is never lost.
 */
export class Input {
  left = false;
  right = false;
  dash = false;
  private jumpLatched = false;
  /** analogue steer from touch drag (-1..1), overrides keys while active */
  touchSteer: number | null = null;
  restartRequested = false;

  private readonly keyDown = (e: KeyboardEvent) => this.onKey(e, true);
  private readonly keyUp = (e: KeyboardEvent) => this.onKey(e, false);
  private readonly blur = () => this.clear();
  private touchId: number | null = null;
  private touchStartX = 0;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerup', this.onPointerUp);
    target.addEventListener('pointercancel', this.onPointerUp);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.blur);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target.removeEventListener('pointerup', this.onPointerUp);
    this.target.removeEventListener('pointercancel', this.onPointerUp);
  }

  /** returns and clears the latched jump */
  consumeJump(): boolean {
    const j = this.jumpLatched;
    this.jumpLatched = false;
    return j;
  }

  get steer(): number {
    if (this.touchSteer !== null) return this.touchSteer;
    return (this.right ? 1 : 0) - (this.left ? 1 : 0);
  }

  private clear(): void {
    this.left = this.right = this.dash = false;
    this.touchSteer = null;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    switch (e.code) {
      case 'KeyA':
      case 'ArrowLeft':
        this.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.right = down;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.dash = down;
        break;
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        if (down && !e.repeat) this.jumpLatched = true;
        break;
      case 'KeyR':
        if (down) this.restartRequested = true;
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // Minimal touch scheme (full mobile UI is Phase 1): left half drag = steer,
  // right half tap = jump, right half hold > 250 ms = dash.
  private dashTimer = 0;
  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    const w = this.target.clientWidth;
    if (e.clientX < w / 2) {
      this.touchId = e.pointerId;
      this.touchStartX = e.clientX;
      this.touchSteer = 0;
    } else {
      this.jumpLatched = true;
      window.clearTimeout(this.dashTimer);
      this.dashTimer = window.setTimeout(() => (this.dash = true), 250);
    }
  };
  private readonly onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== this.touchId) return;
    const dx = e.clientX - this.touchStartX;
    this.touchSteer = Math.max(-1, Math.min(1, dx / 60));
  };
  private readonly onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === this.touchId) {
      this.touchId = null;
      this.touchSteer = null;
    } else if (e.pointerType !== 'mouse') {
      window.clearTimeout(this.dashTimer);
      this.dash = false;
    }
  };
}
