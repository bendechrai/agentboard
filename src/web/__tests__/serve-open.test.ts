/**
 * Whether `agentboard serve` opens the browser (board-web: "Serve command", its
 * scenarios "Opens the browser from an interactive terminal", "No browser for a
 * script", "No browser without a display on Linux", "Explicit open and
 * no-open", "Conflicting open flags" and "Opener failure is a warning";
 * add-serve-auto-open design.md: "Deciding whether to open", "Order and
 * output").
 *
 * `openMode` and `shouldAutoOpen` are pure and tested on their own, for
 * every condition on darwin, win32 and linux. `serveCommand` is then run
 * in process with its seams (`open`, `platform`, `stdoutIsTTY`) and the
 * environment of its `RunContext`, so no test needs a real terminal and
 * no test ever runs a real opener. A test that expects no opener call
 * stops the server and awaits `serveCommand` before asserting: the open
 * decision is taken before `serveCommand` waits for the stop signal, so
 * once it has returned any call would already have been made (no fixed
 * sleeps). The built CLI with a piped stdout is covered in
 * src/__tests__/serve-processes.test.ts.
 */

import { createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LazyBoard, runCliAsync, runContext, type AsyncCliIo } from '../../cli/main.js';
import type { ArgValues, Env, StreamIo } from '../../cli/types.js';
import { cliEnv } from '../../cli/__tests__/cli-helpers.js';
import { BoardError } from '../../store/errors.js';
import { findBoard } from '../../store/locate.js';
import { openMode, serveCommand, shouldAutoOpen, type AutoOpenInput } from '../serve.js';
import { freePort, project, request, scratch, until } from './web-helpers.js';

// ---------------------------------------------------------------------------
// openMode

describe('openMode', () => {
  it('is auto when neither --open nor --no-open is given', () => {
    expect(openMode({})).toBe('auto');
    expect(openMode({ port: 0, as: 'ben' })).toBe('auto');
  });

  it('is always for --open and never for --no-open', () => {
    expect(openMode({ open: true })).toBe('always');
    expect(openMode({ 'no-open': true })).toBe('never');
    expect(openMode({ open: true, port: 4477 })).toBe('always');
    expect(openMode({ 'no-open': true, as: 'ben' })).toBe('never');
  });

  it('treats a false value as not given', () => {
    expect(openMode({ open: false })).toBe('auto');
    expect(openMode({ 'no-open': false })).toBe('auto');
    expect(openMode({ open: false, 'no-open': false })).toBe('auto');
    expect(openMode({ open: true, 'no-open': false })).toBe('always');
    expect(openMode({ open: false, 'no-open': true })).toBe('never');
  });

  it('refuses --open with --no-open as a usage error naming both flags', () => {
    let thrown: unknown;
    try {
      openMode({ open: true, 'no-open': true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BoardError);
    const error = thrown as BoardError;
    expect(error.exitCode).toBe(1);
    expect(error.reason).toBe('usage');
    expect(error.message).toContain('--open');
    expect(error.message).toContain('--no-open');
  });
});

// ---------------------------------------------------------------------------
// shouldAutoOpen

/** The three platforms the spec names. */
const PLATFORMS = ['darwin', 'win32', 'linux'] as const;
type Platform = (typeof PLATFORMS)[number];

/** The smallest environment in which the display check passes on each platform. */
const GRAPHICAL: Record<Platform, Env> = {
  darwin: {},
  win32: {},
  linux: { DISPLAY: ':0' },
};

/** An interactive input on `platform` where every condition holds, then `env` and `over` on top. */
function input(
  platform: NodeJS.Platform,
  env: Env = {},
  over: Partial<Omit<AutoOpenInput, 'platform' | 'env'>> = {},
): AutoOpenInput {
  const base = platform in GRAPHICAL ? GRAPHICAL[platform as Platform] : {};
  return { platform, env: { ...base, ...env }, stdoutIsTTY: true, json: false, ...over };
}

const SSH_VARIABLES = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'] as const;

/** Plausible values of the SSH variables. */
const SSH_VALUES: Record<(typeof SSH_VARIABLES)[number], string> = {
  SSH_CONNECTION: '10.0.0.1 51234 10.0.0.2 22',
  SSH_CLIENT: '10.0.0.1 51234 22',
  SSH_TTY: '/dev/pts/3',
};

describe('shouldAutoOpen', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(PLATFORMS)('is true on %s when every condition holds', (platform) => {
    expect(shouldAutoOpen(input(platform))).toBe(true);
  });

  describe('condition 1: stdout is a terminal', () => {
    it.each(PLATFORMS)('is false on %s when stdout is not a terminal', (platform) => {
      expect(shouldAutoOpen(input(platform, {}, { stdoutIsTTY: false }))).toBe(false);
    });
  });

  describe('condition 2: no --json', () => {
    it.each(PLATFORMS)('is false on %s with --json', (platform) => {
      expect(shouldAutoOpen(input(platform, {}, { json: true }))).toBe(false);
    });

    it.each(PLATFORMS)('is false on %s with --json and no terminal', (platform) => {
      expect(shouldAutoOpen(input(platform, {}, { json: true, stdoutIsTTY: false }))).toBe(false);
    });
  });

  describe('condition 3: CI unset or empty', () => {
    const cases = PLATFORMS.flatMap((platform) =>
      ['1', 'true', '0', 'false', 'yes', ' '].map((value) => [platform, value] as const),
    );

    it.each(cases)('is false on %s with CI=%j (set, whatever the value)', (platform, value) => {
      expect(shouldAutoOpen(input(platform, { CI: value }))).toBe(false);
    });

    it.each(PLATFORMS)('is true on %s with CI empty', (platform) => {
      expect(shouldAutoOpen(input(platform, { CI: '' }))).toBe(true);
    });

    it.each(PLATFORMS)('is true on %s with CI present but undefined (unset)', (platform) => {
      expect(shouldAutoOpen(input(platform, { CI: undefined }))).toBe(true);
    });
  });

  describe('condition 4: not an SSH session', () => {
    const cases = PLATFORMS.flatMap((platform) =>
      SSH_VARIABLES.map((name) => [platform, name] as const),
    );

    it.each(cases)('is false on %s with %s set', (platform, name) => {
      expect(shouldAutoOpen(input(platform, { [name]: SSH_VALUES[name] }))).toBe(false);
    });

    it.each(cases)('is true on %s with %s empty', (platform, name) => {
      expect(shouldAutoOpen(input(platform, { [name]: '' }))).toBe(true);
    });

    it.each(cases)('is true on %s with %s present but undefined', (platform, name) => {
      expect(shouldAutoOpen(input(platform, { [name]: undefined }))).toBe(true);
    });

    it.each(PLATFORMS)('is true on %s with all three SSH variables empty', (platform) => {
      expect(
        shouldAutoOpen(input(platform, { SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '' })),
      ).toBe(true);
    });

    it.each(cases)('is false on %s with %s set while the other two are empty', (platform, name) => {
      const env: Env = {
        SSH_CONNECTION: '',
        SSH_CLIENT: '',
        SSH_TTY: '',
        [name]: SSH_VALUES[name],
      };
      expect(shouldAutoOpen(input(platform, env))).toBe(false);
    });
  });

  describe('condition 5: a display on platforms other than macOS and Windows', () => {
    it.each([
      [{}, false],
      [{ DISPLAY: '' }, false],
      [{ WAYLAND_DISPLAY: '' }, false],
      [{ DISPLAY: '', WAYLAND_DISPLAY: '' }, false],
      [{ DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, false],
      [{ DISPLAY: ':0' }, true],
      [{ WAYLAND_DISPLAY: 'wayland-0' }, true],
      [{ DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' }, true],
      [{ DISPLAY: ':1', WAYLAND_DISPLAY: '' }, true],
      [{ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, true],
    ] as [Env, boolean][])('on linux with %j is %s', (env, expected) => {
      const linux: AutoOpenInput = { platform: 'linux', env, stdoutIsTTY: true, json: false };
      expect(shouldAutoOpen(linux)).toBe(expected);
    });

    it.each(['freebsd', 'openbsd', 'sunos', 'aix', 'android'] as NodeJS.Platform[])(
      'applies on %s too',
      (platform) => {
        const bare: AutoOpenInput = { platform, env: {}, stdoutIsTTY: true, json: false };
        expect(shouldAutoOpen(bare)).toBe(false);
        expect(shouldAutoOpen({ ...bare, env: { DISPLAY: ':0' } })).toBe(true);
        expect(shouldAutoOpen({ ...bare, env: { WAYLAND_DISPLAY: 'wayland-0' } })).toBe(true);
        expect(shouldAutoOpen({ ...bare, env: { DISPLAY: '', WAYLAND_DISPLAY: '' } })).toBe(false);
      },
    );

    const ignored = (['darwin', 'win32'] as const).flatMap((platform) =>
      (
        [
          {},
          { DISPLAY: '' },
          { WAYLAND_DISPLAY: '' },
          { DISPLAY: '', WAYLAND_DISPLAY: '' },
          { DISPLAY: ':0' },
          { WAYLAND_DISPLAY: 'wayland-0' },
        ] as Env[]
      ).map((env) => [platform, env] as const),
    );

    it.each(ignored)('is ignored on %s (env %j opens)', (platform, env) => {
      expect(shouldAutoOpen({ platform, env, stdoutIsTTY: true, json: false })).toBe(true);
    });

    it('does not rescue a failing condition on linux', () => {
      const env: Env = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' };
      expect(shouldAutoOpen(input('linux', env, { stdoutIsTTY: false }))).toBe(false);
      expect(shouldAutoOpen(input('linux', env, { json: true }))).toBe(false);
      expect(shouldAutoOpen(input('linux', { ...env, CI: '1' }))).toBe(false);
      expect(shouldAutoOpen(input('linux', { ...env, SSH_TTY: '/dev/pts/0' }))).toBe(false);
    });
  });

  it.each(PLATFORMS)('is pure on %s: reads its input, not the process environment', (platform) => {
    vi.stubEnv('CI', '1');
    vi.stubEnv('SSH_CONNECTION', SSH_VALUES.SSH_CONNECTION);
    vi.stubEnv('SSH_CLIENT', SSH_VALUES.SSH_CLIENT);
    vi.stubEnv('SSH_TTY', SSH_VALUES.SSH_TTY);
    vi.stubEnv('DISPLAY', '');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    expect(shouldAutoOpen(input(platform))).toBe(true);
    vi.unstubAllEnvs();
    vi.stubEnv('DISPLAY', ':0');
    vi.stubEnv('CI', '');
    expect(shouldAutoOpen(input(platform, { CI: '1' }))).toBe(false);
    expect(shouldAutoOpen({ platform: 'linux', env: {}, stdoutIsTTY: true, json: false })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// serveCommand

/**
 * The CLI test environment without any variable the auto check reads, so
 * the developer's own shell (an SSH session, CI, a display) never changes
 * the outcome; `extra` goes on top.
 */
function quietEnv(extra: Env = {}): Env {
  return cliEnv({
    CI: undefined,
    SSH_CONNECTION: undefined,
    SSH_CLIENT: undefined,
    SSH_TTY: undefined,
    DISPLAY: undefined,
    WAYLAND_DISPLAY: undefined,
    ...extra,
  });
}

/** One call of the injected opener. */
interface OpenCall {
  readonly url: string;
  /** Everything written to stdout when the opener was called. */
  readonly stdoutSoFar: string;
}

/** How `launch` runs `serveCommand`. */
interface LaunchOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly env?: Env;
  readonly platform?: NodeJS.Platform;
  /** Omitted: `serveCommand`'s default (`process.stdout.isTTY`). */
  readonly stdoutIsTTY?: boolean;
  /** The opener's outcome; defaults to resolving. */
  readonly open?: (url: string) => Promise<void>;
}

/** A running in-process `serveCommand`. */
interface Launched {
  stdout(): string;
  stderr(): string;
  readonly calls: OpenCall[];
  stop(): void;
  readonly done: Promise<void>;
}

/** Runs `serveCommand` directly with `values`, recording every call of the (injected) opener. */
function launch(values: ArgValues, options: LaunchOptions = {}): Launched {
  const cwd = options.cwd ?? project().root;
  const env = options.env ?? quietEnv();
  const lazy = new LazyBoard(
    () => findBoard({ cwd, env }).dir,
    () => undefined,
  );
  let stdout = '';
  let stderr = '';
  const calls: OpenCall[] = [];
  const controller = new AbortController();
  const io: StreamIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    json: options.json ?? false,
    signal: controller.signal,
  };
  const outcome = options.open ?? (() => Promise.resolve());
  const done = serveCommand(runContext(cwd, env, null, lazy), values, io, {
    open: (url) => {
      calls.push({ url, stdoutSoFar: stdout });
      return outcome(url);
    },
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.stdoutIsTTY === undefined ? {} : { stdoutIsTTY: options.stdoutIsTTY }),
  }).finally(() => {
    lazy.close();
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    calls,
    stop: () => {
      controller.abort();
    },
    done,
  };
}

/** An interactive macOS terminal with none of the variables the auto check reads. */
const INTERACTIVE_MAC = { platform: 'darwin', stdoutIsTTY: true, json: false } as const;

/** Waits for the start-up line; returns it without its newline, and its URL. */
async function startup(running: Launched): Promise<{ line: string; url: string }> {
  await until(() => running.stdout().includes('\n'), 5000, 'the start-up line');
  const line = running.stdout().split('\n')[0] ?? '';
  const url = /(http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43})/.exec(line)?.[1] ?? '';
  expect(url, line).not.toBe('');
  return { line, url };
}

/** The port and token of a start-up URL. */
function endpoint(url: string): { port: number; token: string } {
  const match = /:(\d+)\/#token=(.+)$/.exec(url);
  return { port: Number(match?.[1]), token: match?.[2] ?? '' };
}

/** Expects exactly one opener call, with the start-up URL, made after the start-up line. */
async function expectOpenedOnce(running: Launched): Promise<void> {
  const { line, url } = await startup(running);
  await until(() => running.calls.length > 0, 3000, 'the opener');
  running.stop();
  await running.done;
  expect(running.calls).toEqual([{ url, stdoutSoFar: `${line}\n` }]);
  expect(running.stdout()).toBe(`${line}\n`);
  expect(running.stderr()).toBe('');
}

/** Expects no opener call: stops the server and awaits `serveCommand` first. */
async function expectNotOpened(running: Launched): Promise<void> {
  const { line } = await startup(running);
  running.stop();
  await running.done;
  expect(running.calls).toEqual([]);
  expect(running.stdout()).toBe(`${line}\n`);
  expect(running.stderr()).toBe('');
}

describe('scenario: Opens the browser from an interactive terminal', () => {
  it('on macOS, prints the start-up line and then opens <url> once', async () => {
    await expectOpenedOnce(launch({}, INTERACTIVE_MAC));
  });

  it('with --json absent the start-up line is the plain one, and the URL opened is its URL', async () => {
    const running = launch({}, INTERACTIVE_MAC);
    const { line, url } = await startup(running);
    expect(line).toMatch(/^serving .+ read-only at http:\/\/127\.0\.0\.1:\d+\/#token=/);
    await until(() => running.calls.length > 0, 3000, 'the opener');
    expect(running.calls[0]?.url).toBe(url);
    running.stop();
    await running.done;
  });

  it.each([
    ['darwin', {}],
    ['win32', {}],
    ['win32', { DISPLAY: '', WAYLAND_DISPLAY: '' }],
    ['linux', { DISPLAY: ':0' }],
    ['linux', { WAYLAND_DISPLAY: 'wayland-0' }],
    ['freebsd', { DISPLAY: ':0' }],
  ] as [NodeJS.Platform, Env][])('on %s with %j opens once', async (platform, extra) => {
    await expectOpenedOnce(
      launch({}, { platform, stdoutIsTTY: true, json: false, env: quietEnv(extra) }),
    );
  });

  it('also in write mode (--as ben)', async () => {
    await expectOpenedOnce(launch({ as: 'ben' }, INTERACTIVE_MAC));
  });

  it('treats CI and the SSH variables set to the empty string as unset', async () => {
    await expectOpenedOnce(
      launch(
        {},
        {
          ...INTERACTIVE_MAC,
          env: quietEnv({ CI: '', SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '' }),
        },
      ),
    );
  });

  it('reads the environment from the RunContext, not from process.env', async () => {
    vi.stubEnv('CI', '1');
    vi.stubEnv('SSH_CONNECTION', SSH_VALUES.SSH_CONNECTION);
    try {
      await expectOpenedOnce(launch({}, INTERACTIVE_MAC));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('scenario: No browser for a script', () => {
  it.each([
    ['stdout a pipe', {}, { stdoutIsTTY: false }],
    ['--json', {}, { json: true }],
    ['--json and stdout a pipe', {}, { json: true, stdoutIsTTY: false }],
    ['CI=1', { CI: '1' }, {}],
    ['CI=true', { CI: 'true' }, {}],
    ['CI=0', { CI: '0' }, {}],
    ['SSH_CONNECTION set', { SSH_CONNECTION: SSH_VALUES.SSH_CONNECTION }, {}],
    ['SSH_CLIENT set', { SSH_CLIENT: SSH_VALUES.SSH_CLIENT }, {}],
    ['SSH_TTY set', { SSH_TTY: SSH_VALUES.SSH_TTY }, {}],
  ] as [string, Env, Partial<LaunchOptions>][])(
    'does not open with %s and neither flag',
    async (_name, extra, over) => {
      await expectNotOpened(launch({}, { ...INTERACTIVE_MAC, env: quietEnv(extra), ...over }));
    },
  );

  it.each(PLATFORMS)('does not open on %s with stdout a pipe', async (platform) => {
    await expectNotOpened(
      launch({}, { platform, stdoutIsTTY: false, json: false, env: quietEnv(GRAPHICAL[platform]) }),
    );
  });
});

describe('scenario: No browser without a display on Linux', () => {
  it.each([
    ['neither variable', {}],
    ['DISPLAY empty', { DISPLAY: '' }],
    ['WAYLAND_DISPLAY empty', { WAYLAND_DISPLAY: '' }],
    ['both empty', { DISPLAY: '', WAYLAND_DISPLAY: '' }],
  ] as [string, Env][])('does not open from a terminal with %s', async (_name, extra) => {
    await expectNotOpened(
      launch({}, { platform: 'linux', stdoutIsTTY: true, json: false, env: quietEnv(extra) }),
    );
  });
});

describe('scenario: Explicit open and no-open', () => {
  it('--open --json with stdout a pipe opens <url> once', async () => {
    const running = launch({ open: true }, { platform: 'darwin', stdoutIsTTY: false, json: true });
    await until(() => running.stdout().includes('\n'), 5000, 'the start-up line');
    const doc = JSON.parse(running.stdout()) as { url: string };
    await until(() => running.calls.length > 0, 3000, 'the opener');
    running.stop();
    await running.done;
    expect(running.calls).toEqual([{ url: doc.url, stdoutSoFar: running.stdout() }]);
    expect(running.stdout().split('\n')).toHaveLength(2);
  });

  it('--open opens whatever the environment: CI, SSH, and linux without a display', async () => {
    await expectOpenedOnce(
      launch(
        { open: true },
        {
          platform: 'linux',
          stdoutIsTTY: false,
          json: false,
          env: quietEnv({
            CI: '1',
            SSH_CONNECTION: SSH_VALUES.SSH_CONNECTION,
            SSH_TTY: '/dev/pts/1',
          }),
        },
      ),
    );
  });

  it('--no-open from an interactive terminal on macOS does not open', async () => {
    await expectNotOpened(launch({ 'no-open': true }, INTERACTIVE_MAC));
  });

  it.each(PLATFORMS)('--no-open never opens on %s where auto would', async (platform) => {
    await expectNotOpened(
      launch(
        { 'no-open': true },
        { platform, stdoutIsTTY: true, json: false, env: quietEnv(GRAPHICAL[platform]) },
      ),
    );
  });

  it('--no-open with --as ben does not open', async () => {
    await expectNotOpened(launch({ 'no-open': true, as: 'ben' }, INTERACTIVE_MAC));
  });
});

/** Does something listen on 127.0.0.1:`port`? */
async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

/** Runs `agentboard <argv>` in process through `runCliAsync` until it returns (or is stopped). */
function cli(
  argv: readonly string[],
  cwd: string,
): { stdout(): string; stop(): void; done: Promise<number> } {
  let stdout = '';
  const controller = new AbortController();
  const io: AsyncCliIo = {
    argv,
    cwd,
    // CI set: were the flags accepted, this in-process server would never open a browser.
    env: quietEnv({ CI: '1' }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => undefined,
    stopSignal: () => controller.signal,
  };
  return {
    stdout: () => stdout,
    stop: () => {
      controller.abort();
    },
    done: runCliAsync(io).then((code) => Number(code)),
  };
}

/** The exit code of `running` when it returns within `ms`, else `still running` (and stops it). */
async function exitWithin(
  running: { stop(): void; done: Promise<number> },
  ms: number,
): Promise<number | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve('still running');
    }, ms);
  });
  const outcome = await Promise.race([running.done, late]);
  clearTimeout(timer);
  if (outcome === 'still running') {
    running.stop();
    await running.done;
  }
  return outcome;
}

describe('scenario: Conflicting open flags', () => {
  it.each([[['--open', '--no-open']], [['--no-open', '--open']]])(
    'agentboard serve %j exits 1 usage, binds no port, with a board and without one',
    { timeout: 20_000 },
    async (flags) => {
      for (const cwd of [project().root, scratch()]) {
        const port = await freePort();
        const running = cli(['serve', '--port', String(port), '--json', ...flags], cwd);
        expect(await exitWithin(running, 3000)).toBe(1);
        const doc = JSON.parse(running.stdout()) as {
          error: { exitCode: number; reason: string; message: string };
        };
        expect(doc.error).toMatchObject({ exitCode: 1, reason: 'usage' });
        expect(doc.error.message).toContain('--open');
        expect(doc.error.message).toContain('--no-open');
        expect(running.stdout().trim().split('\n')).toHaveLength(1);
        expect(await portIsFree(port)).toBe(true);
      }
    },
  );

  it('serveCommand refuses both before the board lookup and before listening, and never opens', async () => {
    for (const cwd of [project().root, scratch()]) {
      const port = await freePort();
      const running = launch({ open: true, 'no-open': true, port }, { ...INTERACTIVE_MAC, cwd });
      const error: unknown = await running.done.then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BoardError);
      expect(error).toMatchObject({ exitCode: 1, reason: 'usage' });
      expect(running.stdout()).toBe('');
      expect(running.calls).toEqual([]);
      expect(await portIsFree(port)).toBe(true);
    }
  });
});

describe('scenario: Opener failure is a warning', () => {
  it('in auto mode prints one warning line on stderr and keeps serving', async () => {
    const running = launch(
      {},
      { ...INTERACTIVE_MAC, open: () => Promise.reject(new Error('spawn open ENOENT')) },
    );
    const { line, url } = await startup(running);
    await until(() => running.stderr().includes('\n'), 5000, 'the warning');
    expect(running.stderr()).toBe('agentboard: could not open a browser: spawn open ENOENT\n');
    const { port, token } = endpoint(url);
    expect(running.stderr()).not.toContain(token);
    const session = await request(port, '/api/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(session.status).toBe(200);
    const again = await request(port, '/api/board', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(again.status).toBe(200);
    running.stop();
    await running.done;
    expect(running.calls).toHaveLength(1);
    expect(running.stdout()).toBe(`${line}\n`);
    expect(running.stderr()).toBe('agentboard: could not open a browser: spawn open ENOENT\n');
  });

  it('in auto mode masks the token when the opener echoes the URL', async () => {
    const running = launch(
      {},
      {
        platform: 'linux',
        stdoutIsTTY: true,
        json: false,
        env: quietEnv({ DISPLAY: ':0' }),
        open: (url) => Promise.reject(new Error(`xdg-open ${url} exited with code 3`)),
      },
    );
    const { url } = await startup(running);
    await until(() => running.stderr().includes('\n'), 5000, 'the warning');
    const { port, token } = endpoint(url);
    const masked = `http://127.0.0.1:${String(port)}/#token=<token>`;
    expect(running.stderr()).toBe(
      `agentboard: could not open a browser: xdg-open ${masked} exited with code 3\n`,
    );
    expect(running.stderr()).not.toContain(token);
    running.stop();
    await running.done;
  });
});

describe('the defaults of the seams', () => {
  /** Replaces `process.stdout.isTTY` for the duration of `body`. */
  async function withStdoutTTY(value: boolean, body: () => Promise<void>): Promise<void> {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true, writable: true });
    try {
      await body();
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      } else {
        Object.defineProperty(process.stdout, 'isTTY', descriptor);
      }
    }
  }

  it('stdoutIsTTY defaults to process.stdout.isTTY', async () => {
    await withStdoutTTY(false, async () => {
      await expectNotOpened(launch({}, { platform: 'darwin', json: false }));
    });
    await withStdoutTTY(true, async () => {
      await expectOpenedOnce(launch({}, { platform: 'darwin', json: false }));
    });
  });

  it('platform defaults to process.platform', async () => {
    // No display variable: only darwin and win32 open.
    const running = launch({}, { stdoutIsTTY: true, json: false });
    if (process.platform === 'darwin' || process.platform === 'win32') {
      await expectOpenedOnce(running);
    } else {
      await expectNotOpened(running);
    }
  });
});
