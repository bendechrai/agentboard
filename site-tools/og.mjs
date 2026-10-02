// usage: node og.mjs <siteUrl> <out.png> <t> [scheme] [width] [height] [mode]
// mode "og": the hero reshaped as a share card; mode "hero": the plain hero.
import puppeteer from 'puppeteer';
const [, , url, out, t = '21', scheme = 'light', w = '1200', h = '630', mode = 'og'] = process.argv;
const browser = await puppeteer.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 2 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
await page.goto(url + '?render&dpr=2', { waitUntil: 'load' });
if (mode === 'og') {
  await page.addStyleTag({ content: `
    .nav .link, .nav .btn, .tape, .lede, .install, .eyebrow { display: none !important; }
    .hero { min-height: ${h}px !important; height: ${h}px; }
    .hero-top { padding: 92px 56px 0 !important; }
    h1 { font-size: 60px !important; margin: 0 !important; }
    .nav .wrap { padding: 0 56px !important; height: 92px !important; }
    .brand { font-size: 24px !important; } .brand svg { width: 34px !important; height: 34px !important; }
    .pill { font-size: 14px !important; }
  ` });
}
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
await page.evaluate(async (t) => { await window.agentboardDiorama.ready; window.agentboardDiorama.resize(); window.agentboardDiorama.render(t); }, +t);
await new Promise((r) => setTimeout(r, 1500));
await page.evaluate((t) => window.agentboardDiorama.render(t), +t);
await page.screenshot({ path: out });
await browser.close();
console.log(out);
