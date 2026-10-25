/**
 * Raw input collection (keyboard; touch via ui/TouchControls). Converted into a per-tick
 * PlayerIntent by PlayerController. Jump is edge-triggered and latched until the sim
 * consumes it, so a tap shorter than one sim tick is never lost.
 */
export class Input {
  left = false;
  right = false;
  keyDash = false;
  touchDash = false;
  private jumpLatched = false;
  /** analogue steer from the touch stick (-1..1), overrides keys while active */
  touchSteer: number | null = null;
  restartRequested = false;
  pauseRequested = false;
  /** any key / tap (unlocks audio, starts from the title) */
  onAnyInput: (() => void) | null = null;
  /** Enter / Space on menus */
  confirmRequested = false;

  private readonly keyDown = (e: KeyboardEvent) => this.onKey(e, true);
  private readonly keyUp = (e: KeyboardEvent) => this.onKey(e, false);
  private readonly blur = () => this.clear();
  private readonly pointer = () => this.onAnyInput?.();

  constructor() {
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
    window.addEventListener('pointerdown', this.pointer, { capture: true });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.blur);
    window.removeEventListener('pointerdown', this.pointer, { capture: true });
  }

  get dash(): boolean {
    return this.keyDash || this.touchDash;
  }

  pressJump(): void {
    this.jumpLatched = true;
  }

  /** returns and clears the latched jump */
  consumeJump(): boolean {
    const j = this.jumpLatched;
    this.jumpLatched = false;
    return j;
  }

  /** drop latched presses (e.g. when a race starts) */
  reset(): void {
    this.jumpLatched = false;
    this.restartRequested = false;
    this.pauseRequested = false;
    this.confirmRequested = false;
  }

  get steer(): number {
    if (this.touchSteer !== null) return this.touchSteer;
    return (this.right ? 1 : 0) - (this.left ? 1 : 0);
  }

  private clear(): void {
    this.left = this.right = this.keyDash = this.touchDash = false;
    this.touchSteer = null;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down) this.onAnyInput?.();
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
        this.keyDash = down;
        break;
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        if (down && !e.repeat) {
          this.jumpLatched = true;
          this.confirmRequested = true;
        }
        break;
      case 'Enter':
        if (down && !e.repeat) this.confirmRequested = true;
        break;
      case 'Escape':
      case 'KeyP':
        if (down && !e.repeat) this.pauseRequested = true;
        break;
      case 'KeyR':
        if (down) this.restartRequested = true;
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
