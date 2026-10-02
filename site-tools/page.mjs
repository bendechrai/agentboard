// usage: node page.mjs <url> <out.png> [width] [height] [scheme] [fullPage] [waitMs]
import puppeteer from 'puppeteer';
const [, , url, out, w = '1440', h = '900', scheme = 'light', full = '0', wait = '4000'] = process.argv;
const browser = await puppeteer.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log('console:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
await page.goto(url, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, +wait));
await page.screenshot({ path: out, fullPage: full === '1' });
await browser.close();
console.log(out);
