/**
 * End-to-end smoke test of `agentboard serve` on the built package
 * (add-board-web task 5.1; design.md "Testing strategy", smoke; board-web:
 * "Serve command" scenario "Start and stop", "Access token", "Live event
 * stream" scenario "CLI write reaches the browser", "Self-contained front
 * end").
 *
 * The built CLI (`dist/cli.js`) serves a temporary board with
 * `serve --port 0 --json`. A `happy-dom` browser page opens the start-up
 * URL printed on the `--json` line (the token in the fragment), so the
 * page, `app.css` and the built bundle `app.js` are loaded from the live
 * server by happy-dom's own `fetch`, and the bundle runs in the page:
 * every API request and the stream (read with `fetch` and an SSE parser)
 * reach the live server over real HTTP. The test then checks the token
 * hand-over (moved from the fragment to `sessionStorage`, removed from the
 * address bar, sent only as a bearer header, never in a URL, no cookie),
 * creates a ticket with the CLI and waits at most 3 seconds for its card,
 * and stops the server with SIGINT (exit 0).
 *
 * No browser is downloaded: happy-dom is a dev dependency, so this runs in
 * `make check`, `make check-in-docker` and `make check-floor` alike. Run
 * `npm run build` first when running vitest directly (the harness says so
 * when `dist/cli.js` is missing). Only 127.0.0.1 is used, on port 0.
 */

import { Browser, type BrowserPage, type BrowserWindow, type Element } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { until } from '../web/__tests__/web-helpers.js';
import {
  boardProject,
  oneDocument,
  runCliAsync,
  startCli,
  type CliProcess,
} from './harness/processes.js';

const TASK = ['--task', 'openspec:add-board-web#5'];

/** The `--json` start-up line of `serve` (board-web: "Serve command"). */
interface Startup {
  url: string;
  port: number;
  token: string;
  writable: boolean;
}

/** One request the page made, as happy-dom's fetch sent it. */
interface SentRequest {
  /**
   * The URL without its fragment: what goes on the wire (happy-dom hands
   * the URL to `node:http`, which sends only the path and query, as a
   * browser does).
   */
  url: string;
  authorization: string | null;
  cookie: string | null;
}

const browsers: Browser[] = [];

afterEach(async () => {
  for (const browser of browsers.splice(0)) {
    await browser.close().catch(() => undefined);
  }
});

/** Creates a ticket through the built CLI and returns its id. */
async function newTicket(root: string, title: string): Promise<string> {
  const out = await runCliAsync(['new', title, ...TASK, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: { id: string } }).ticket.id;
}

/** Waits for the one `--json` line of a `serve` child and parses it. */
async function startup(proc: CliProcess): Promise<Startup> {
  await until(
    () => proc.stdout().includes('\n'),
    15_000,
    `the start-up line (stderr: ${proc.stderr()})`,
  );
  return JSON.parse(proc.stdout().split('\n')[0] ?? '') as Startup;
}

/**
 * A happy-dom browser with JavaScript evaluation on (the bundle must run),
 * recording every request its pages send. Closed after the test.
 */
function browser(sent: SentRequest[]): Browser {
  const created = new Browser({
    settings: {
      enableJavaScriptEvaluation: true,
      // The page runs only the bundle this repository just built.
      suppressInsecureJavaScriptEnvironmentWarning: true,
      fetch: {
        interceptor: {
          beforeAsyncRequest: ({ request }) => {
            sent.push({
              url: request.url.split('#')[0] ?? '',
              authorization: request.headers.get('authorization'),
              cookie: request.headers.get('cookie'),
            });
            return Promise.resolve();
          },
        },
      },
    },
  });
  browsers.push(created);
  return created;
}

/** The card of ticket `id` on the board view, or null. */
function card(window: BrowserWindow, id: string): Element | null {
  return window.document.querySelector(`.columns article.card[data-ticket="${id}"]`);
}

/** Polls `check` every 10 ms; resolves with the milliseconds it took, or rejects after `ms`. */
async function within(check: () => boolean, ms: number, what: string): Promise<number> {
  const started = Date.now();
  await until(check, ms, what);
  return Date.now() - started;
}

describe('smoke: the built package in a happy-dom page', () => {
  it(
    'loads the page from the start-up URL, hands the token over, shows a CLI write within 3 seconds and stops on SIGINT',
    { timeout: 60_000 },
    async () => {
      const { root } = boardProject();
      const first = await newTicket(root, 'Smoke first');

      const proc = startCli({ argv: ['serve', '--port', '0', '--json'] }, root);
      const line = await startup(proc);
      expect(line.url).toBe(`http://127.0.0.1:${String(line.port)}/#token=${line.token}`);
      expect(line.writable).toBe(false);

      const sent: SentRequest[] = [];
      const page: BrowserPage = browser(sent).newPage();
      await page.goto(line.url);
      const window = page.mainFrame.window;

      // The bundle ran and rendered the board from the live server.
      await within(() => card(window, first) !== null, 10_000, 'the first card');
      expect(card(window, first)?.textContent).toContain('Smoke first');

      // The token moved from the fragment to sessionStorage, and the
      // fragment is gone from the address bar.
      expect(window.sessionStorage.getItem('agentboard-token')).toBe(line.token);
      expect(window.location.href).toBe(`http://127.0.0.1:${String(line.port)}/`);
      expect(window.location.hash).toBe('');
      expect(window.location.href).not.toContain(line.token);

      // No cookie: none visible to the page, none stored by the browser.
      expect(window.document.cookie).toBe('');
      expect(page.context.cookieContainer.getCookies(null, false)).toEqual([]);

      // Wait for the live stream to be open before writing, so the card
      // can only arrive through it.
      const streamUrl = `http://127.0.0.1:${String(line.port)}/api/stream`;
      await within(
        () => sent.some((r) => r.url.startsWith(streamUrl)),
        10_000,
        'the stream request',
      );
      await within(
        () => window.document.querySelector('.live.on') !== null,
        10_000,
        'the live indicator',
      );

      const second = await newTicket(root, 'Smoke second');
      const took = await within(() => card(window, second) !== null, 3000, 'the new card');
      expect(took).toBeLessThanOrEqual(3000);
      expect(card(window, second)?.textContent).toContain('Smoke second');
      expect(card(window, second)?.closest('[data-status]')?.getAttribute('data-status')).toBe(
        'todo',
      );

      // What was sent: the page and its assets without a token, every API
      // and stream request with exactly the bearer header, no token in any
      // URL, no cookie on any request.
      const origin = `http://127.0.0.1:${String(line.port)}/`;
      const paths = sent.map((r) => r.url.slice(origin.length - 1).split('?')[0]);
      expect(paths).toEqual(expect.arrayContaining(['/', '/app.js', '/app.css', '/api/board']));
      for (const request of sent) {
        expect(request.url.startsWith(origin), request.url).toBe(true);
        expect(request.url, 'a URL carrying the token').not.toContain(line.token);
        expect(request.cookie, request.url).toBeNull();
        const path = request.url.slice(origin.length - 1);
        if (path === '/api' || path.startsWith('/api/') || path.startsWith('/api?')) {
          expect(request.authorization, request.url).toBe(`Bearer ${line.token}`);
        } else {
          expect(request.authorization, request.url).toBeNull();
        }
      }
      expect(page.context.cookieContainer.getCookies(null, false)).toEqual([]);

      process.kill(proc.pid, 'SIGINT');
      const result = await proc.exited;
      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(result.stdout.split('\n')).toEqual([JSON.stringify(line), '']);
    },
  );
});
