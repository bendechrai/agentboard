// usage: AB=<agentboard bin> TASKS=add-search-tasks.md node record.mjs <scratch projectDir> <out.mp4>
// Builds a fresh board in <projectDir>, opens `agentboard serve` in a
// headless browser and records a scripted session driven by the real CLI.
import puppeteer from 'puppeteer';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, out] = process.argv;
const AB = process.env.AB;
const SCHEME = process.env.SCHEME || 'light';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ab = (...args) => execFileSync(AB, args, { cwd: dir, encoding: 'utf8' });
const tryAb = (...args) => { try { return ab(...args); } catch (e) { return String(e.stdout) + String(e.stderr); } };

rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'openspec/changes/add-search'), { recursive: true });
cpSync(process.env.TASKS, join(dir, 'openspec/changes/add-search/tasks.md'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
ab('init');
ab('import-change', 'add-search', '--as', 'orchestrator');
const ids = JSON.parse(ab('list', '--json')).map((t) => t.id);
const [T1, T2, T3, T4, T5] = ids;

const srv = spawn(AB, ['serve', '--json', '--no-open'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
const [chunk] = await once(srv.stdout, 'data');
const { url } = JSON.parse(String(chunk).split('\n')[0]);

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 2640, height: 1640, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: SCHEME }]);
await page.goto(url, { waitUntil: 'domcontentloaded' });
// Show a tidy board path in the header instead of the scratch directory.
await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
await page.evaluate(() => {
  const fix = () => {
    for (const el of document.querySelectorAll('header *')) {
      if (el.children.length === 0 && el.textContent.endsWith('/.board') && el.textContent !== '~/code/recipes/.board') el.textContent = '~/code/recipes/.board';
    }
  };
  fix();
  new MutationObserver(fix).observe(document.body, { subtree: true, childList: true, characterData: true });
});
await sleep(1200);
const go = (h) => page.evaluate((h) => { location.hash = h; }, h);

const cdp = await page.createCDPSession();
const frames = [];
cdp.on('Page.screencastFrame', async (f) => {
  frames.push({ data: f.data, t: f.metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: 2640, maxHeight: 1640 });
// Repaint continuously so frames arrive even when nothing changes.
await page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none'; document.body.appendChild(d); let i = 0; setInterval(() => { d.style.background = i++ % 2 ? '#000' : '#fff'; }, 50); });
const rec = { stop: async () => {
  await cdp.send('Page.stopScreencast');
  const fdir = out + '.frames'; rmSync(fdir, { recursive: true, force: true }); mkdirSync(fdir);
  let list = '';
  frames.forEach((f, i) => {
    const name = `${String(i).padStart(5, '0')}.jpg`;
    writeFileSync(join(fdir, name), Buffer.from(f.data, 'base64'));
    const next = frames[i + 1] ? frames[i + 1].t : f.t + 0.1;
    list += `file '${name}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}\n`;
  });
  writeFileSync(join(fdir, 'list.txt'), list);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(fdir, 'list.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', out]);
  console.log('frames', frames.length);
} };
await sleep(1500);
const beat = async (ms, ...args) => { tryAb(...args); await sleep(ms); };

await beat(1300, 'claim', T1, '--as', 'test-author-1');
await beat(1300, 'move', T1, 'tests', '--as', 'test-author-1');
await beat(1000, 'claim', T2, '--as', 'test-author-2');
await beat(1300, 'move', T2, 'tests', '--as', 'test-author-2');
await beat(1300, 'handoff', T1, '--to', 'impl-1', '--status', 'implementing', '--note', 'Red tests for tokenising and rebuild-on-change are in; stubs in src/search/index.ts.', '--as', 'test-author-1');
await beat(1300, 'claim', T3, '--as', 'test-author-1');
await beat(1300, 'comment', T2, 'DECISION: tag: filters are case-insensitive', '--as', 'test-author-2');
await beat(1300, 'move', T1, 'blocked', '--as', 'impl-1');
await beat(1300, 'comment', T1, 'Blocked: the index schema needs a recipe version column first.', '--as', 'impl-1');
await beat(1300, 'release', T1, '--as', 'impl-1');
await beat(1300, 'claim', T1, '--as', 'impl-2');
await beat(1300, 'move', T1, '--as', 'impl-2');
await beat(1300, 'handoff', T2, '--to', 'impl-1', '--status', 'implementing', '--note', 'Parser tests are red; see the decision about tag: filters.', '--as', 'test-author-2');
await beat(1300, 'handoff', T1, '--to', 'reviewer-1', '--status', 'review', '--note', 'Green; index rebuilds on recipe change.', '--as', 'impl-2');
// The ticket detail: conversation and events.
await go(`#/ticket/${T1}`);
await sleep(1800);
await beat(2200, 'comment', T1, 'Looks good. Merging once CI is green.', '--as', 'reviewer-1');
await beat(2000, 'move', T1, 'merged', '--as', 'reviewer-1');
// The feed, then the lanes.
await go('#/feed');
await sleep(1200);
await beat(1600, 'move', T3, 'tests', '--as', 'test-author-1');
await beat(2000, 'claim', T4, '--as', 'test-author-2');
await go('#/lanes');
await sleep(3000);
await go('#/board?closed=1');
await sleep(2500);

await rec.stop();
await browser.close();
srv.kill('SIGTERM');
writeFileSync(out + '.ids.json', JSON.stringify(ids));
console.log('done', out);
