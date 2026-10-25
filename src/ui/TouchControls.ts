import type { Input } from '../game/Input';
import { h, show } from './dom';

/**
 * Landscape touch controls (design §4): virtual stick on the left (drag anywhere in the
 * left half; the stick appears under the thumb), a big JUMP button and a smaller DASH
 * button on the right. Jump and dash are separate buttons so dashing never jumps.
 */
export class TouchControls {
  readonly el: HTMLDivElement;
  private readonly stickBase: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;
  private readonly jumpBtn: HTMLDivElement;
  private readonly dashBtn: HTMLDivElement;
  private stickId: number | null = null;
  private stickX = 0;
  private stickY = 0;
  private dashId: number | null = null;
  private static readonly RADIUS = 56;

  constructor(parent: HTMLElement, private readonly input: Input) {
    this.stickKnob = h('div', { class: 'stick-knob' });
    this.stickBase = h('div', { class: 'stick-base' }, [this.stickKnob]);
    this.jumpBtn = h('div', { class: 'tbtn tbtn-jump' }, [h('span', { text: 'ジャンプ' })]);
    this.dashBtn = h('div', { class: 'tbtn tbtn-dash' }, [h('span', { text: 'ダッシュ' })]);
    const stickZone = h('div', { class: 'stick-zone' }, [this.stickBase]);
    this.el = h('div', { class: 'touch-controls hidden' }, [stickZone, this.dashBtn, this.jumpBtn]);
    parent.appendChild(this.el);

    stickZone.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      stickZone.setPointerCapture(e.pointerId);
      const r = stickZone.getBoundingClientRect();
      this.stickX = e.clientX - r.left;
      this.stickY = e.clientY - r.top;
      this.stickBase.style.left = `${this.stickX}px`;
      this.stickBase.style.top = `${this.stickY}px`;
      this.stickBase.classList.add('active');
      this.setKnob(0, 0);
      this.input.touchSteer = 0;
      e.preventDefault();
    });
    stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      const r = stickZone.getBoundingClientRect();
      const dx = e.clientX - r.left - this.stickX;
      const R = TouchControls.RADIUS;
      const cl = Math.max(-R, Math.min(R, dx));
      this.setKnob(cl, 0);
      // small dead zone, full deflection at ~70 % of the radius
      const v = Math.abs(cl) < 6 ? 0 : cl / (R * 0.7);
      this.input.touchSteer = Math.max(-1, Math.min(1, v));
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.input.touchSteer = null;
      this.stickBase.classList.remove('active');
      this.setKnob(0, 0);
    };
    stickZone.addEventListener('pointerup', endStick);
    stickZone.addEventListener('pointercancel', endStick);

    this.jumpBtn.addEventListener('pointerdown', (e) => {
      this.input.pressJump();
      this.jumpBtn.classList.add('pressed');
      e.preventDefault();
    });
    const jumpUp = () => this.jumpBtn.classList.remove('pressed');
    this.jumpBtn.addEventListener('pointerup', jumpUp);
    this.jumpBtn.addEventListener('pointercancel', jumpUp);
    this.jumpBtn.addEventListener('pointerleave', jumpUp);

    this.dashBtn.addEventListener('pointerdown', (e) => {
      this.dashId = e.pointerId;
      this.dashBtn.setPointerCapture(e.pointerId);
      this.input.touchDash = true;
      this.dashBtn.classList.add('pressed');
      e.preventDefault();
    });
    const dashUp = (e: PointerEvent) => {
      if (e.pointerId !== this.dashId) return;
      this.dashId = null;
      this.input.touchDash = false;
      this.dashBtn.classList.remove('pressed');
    };
    this.dashBtn.addEventListener('pointerup', dashUp);
    this.dashBtn.addEventListener('pointercancel', dashUp);
  }

  private setKnob(x: number, y: number): void {
    this.stickKnob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  show(on: boolean): void {
    show(this.el, on);
    if (!on) {
      this.input.touchSteer = null;
      this.input.touchDash = false;
    }
  }

  setDashState(gauge: number, dashing: boolean): void {
    this.dashBtn.style.setProperty('--gauge', String(Math.max(0, Math.min(1, gauge))));
    this.dashBtn.classList.toggle('active', dashing);
  }
}
