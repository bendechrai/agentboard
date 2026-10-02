import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
const [, , svgPath, outDir] = process.argv;
const svg = readFileSync(svgPath, 'utf8');
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
for (const [name, size, pad, bg] of [['favicon-32.png', 32, 0, 'transparent'], ['apple-touch-icon.png', 180, 22, '#f4ece0']]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size - pad * 2}" height="${size - pad * 2}" `)}</body></html>`);
  await page.screenshot({ path: `${outDir}/${name}`, omitBackground: bg === 'transparent' });
}
await browser.close();
