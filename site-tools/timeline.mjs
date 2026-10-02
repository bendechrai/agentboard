import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message)); page.on('console', (m) => { if (m.type() === 'warn' && m.text().startsWith('diorama')) console.log(m.text()); });
await page.goto(process.argv[2] + '?render', { waitUntil: 'load' });
const r = await page.evaluate(() => ({ loop: window.agentboardDiorama.LOOP, tape: window.agentboardDiorama.tape.map((e) => `${e.t.toFixed(1).padStart(5)}  ${e.actor.padEnd(14)} ${e.kind.padEnd(15)} ${e.ticket} ${e.note}`) }));
console.log('LOOP', r.loop); console.log(r.tape.join('\n'));
await browser.close();
