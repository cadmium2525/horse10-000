/**
 * iOS Safari ignores `user-scalable=no`: block pinch (gesture* events, multi-touch moves) and
 * double-tap zoom (a second touchend within 300 ms) so the game never zooms mid-race.
 * Listeners are non-passive so preventDefault takes effect.
 */
export function installNoZoom(target: Document = document): void {
  const block = (e: Event) => e.preventDefault();
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    target.addEventListener(type, block, { passive: false });
  }
  target.addEventListener(
    'touchmove',
    (e) => {
      if ((e as TouchEvent).touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
  let lastEnd = 0;
  target.addEventListener(
    'touchend',
    (e) => {
      const now = performance.now();
      if (now - lastEnd < 300) e.preventDefault();
      lastEnd = now;
    },
    { passive: false },
  );
  // ctrl+wheel / trackpad pinch on desktop browsers
  target.addEventListener(
    'wheel',
    (e) => {
      if ((e as WheelEvent).ctrlKey) e.preventDefault();
    },
    { passive: false },
  );
}
