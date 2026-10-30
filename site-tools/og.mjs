// usage: node og.mjs <siteUrl> <out.png|out.jpg> <t> [scheme] [width] [height] [mode] [dpr]
// mode "og": the hero reshaped as a share card; mode "hero": the plain hero.
// A `.jpg` output is written as JPEG; `dpr` sets the device pixel ratio.
import puppeteer from 'puppeteer';
const [, , url, out, t = '21', scheme = 'light', w = '1200', h = '630', mode = 'og', dpr = '2'] = process.argv;
const jpeg = /\.jpe?g$/i.test(out);
const browser = await puppeteer.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: +dpr });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
await page.goto(url + `?render&dpr=${dpr}`, { waitUntil: 'load' });
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
await page.screenshot({ path: out, ...(jpeg ? { type: 'jpeg', quality: 86 } : {}) });
await browser.close();
console.log(out);
