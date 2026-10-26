// Regenerates public/assets/ogp.png (1200×630) from the in-game card renderer.
//   npm run build && npx vite preview --port 4317 &   then   node scripts/gen-ogp.mjs
// Uses Playwright's Chromium (dev tool only; the PNG is committed).
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.argv[2] ?? 'http://localhost:4317/horse10-000/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(`${base}?ogp=1`);
await page.waitForFunction(() => !!window.__ogpDataUrl, null, { timeout: 30000 });
const dataUrl = await page.evaluate(() => window.__ogpDataUrl);
writeFileSync(new URL('../public/assets/ogp.png', import.meta.url), Buffer.from(dataUrl.split(',')[1], 'base64'));
await browser.close();
console.log('wrote public/assets/ogp.png');
