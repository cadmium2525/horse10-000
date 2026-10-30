// Regenerates public/apple-touch-icon.png (180×180, full-bleed square: iOS rounds the corners itself)
// from public/favicon.svg.   node scripts/gen-icon.mjs   (dev tool; the PNG is committed)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8').replace(/ rx="14"/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 180, height: 180 } });
await page.setContent(`<body style="margin:0"><div style="width:180px;height:180px">${svg.replace('<svg ', '<svg width="180" height="180" ')}</div></body>`);
writeFileSync(new URL('../public/apple-touch-icon.png', import.meta.url), await page.screenshot({ type: 'png' }));
await browser.close();
console.log('wrote public/apple-touch-icon.png');
