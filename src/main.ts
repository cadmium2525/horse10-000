import './styles.css';
import { Game } from './game/Game';
import { parseSeed, randomSeed } from './data/Seed';

/**
 * Entry point. URL parameters:
 *   ?seed=12345   reproducible race (numeric or any string)
 *   ?debug=1      FPS / sim / render timing + LOD counts overlay
 *   ?autoplay=1   bot drives the player (verification / attract mode)
 *   ?pr=1         fixed pixel ratio (disables auto quality)
 *   ?q=0..3       initial render LOD level
 *   ?ff=20        debug: fast-forward the simulation 20 s before rendering
 */
function boot(): void {
  const params = new URLSearchParams(location.search);
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');

  const seed = parseSeed(params.get('seed')) ?? randomSeed();
  const pr = params.get('pr');
  const q = params.get('q');
  const ff = Number(params.get('ff')) || 0;
  try {
    const game = new Game(app, {
      seed,
      debug: params.get('debug') === '1',
      autoplay: params.get('autoplay') === '1',
      pixelRatio: pr ? Math.max(0.25, Math.min(3, Number(pr) || 1)) : undefined,
      quality: q !== null ? Math.max(0, Math.min(3, Number(q) | 0)) : undefined,
      fastForward: ff > 0 ? Math.min(ff, 300) : undefined,
    });
    game.start();
    // exposed for automated verification (Playwright) and console tinkering
    (window as unknown as { __game: Game }).__game = game;
  } catch (err) {
    console.error(err);
    const div = document.createElement('div');
    div.className = 'boot-error';
    div.textContent = 'WebGL を初期化できませんでした。対応ブラウザでお試しください。';
    document.body.appendChild(div);
  }
}

boot();
