/**
 * Fixtures of the `init --remote` no-echo tests (no-echo-refusals group 2;
 * board-cli "Board in a separate repository"): the token-shaped values as
 * `--remote` values, an environment that keeps git off every proxy, an
 * HTTP server on 127.0.0.1 that refuses every request with 401 (an auth
 * failure without leaving the machine), and a `GIT_SSH_COMMAND` shim that
 * prints a chosen line on stderr and connects nowhere. Nothing here
 * contacts a host other than 127.0.0.1 and ::1.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { secretFixture, SECRET_FIXTURES, URL_TOKEN as URL_FIXTURE_TOKEN } from '../../__tests__/harness/secret-fixtures.js';
import { git, tempDir } from './helpers.js';
import { realGit } from './sharing-helpers.js';
import { syncEnv, type Env } from './sync-helpers.js';

/**
 * The token of the URL fixture (`https://agent:<token>@git.example.com/x.git`):
 * the token alone, not the fixture's `secret` (`agent:<token>`, whose user
 * name the leak check also counts), so the URLs built here carry it as
 * the password of `agent`.
 */
export const URL_TOKEN = URL_FIXTURE_TOKEN;

/** The GitHub-style token fixture. */
export const GH_TOKEN = secretFixture('github-token').value;

/** The fixtures that are a bare token (every one but the URL), for a token given as the whole value. */
export const BARE_TOKENS = SECRET_FIXTURES.filter((f) => f.name !== 'url-with-credentials');

/** A port on 127.0.0.1 where nothing listens (connection refused at once). */
export const CLOSED_PORT = 1;

/**
 * `syncEnv(extra)` without any proxy variable and with `NO_PROXY=*`, so git
 * (libcurl) connects to 127.0.0.1 directly whatever the machine sets, and
 * without `GIT_ASKPASS` and `SSH_ASKPASS`, so a remote asking for a
 * password fails at once (git's terminal prompt is already off).
 */
export function localEnv(extra: Env = {}): Env {
  return syncEnv({
    http_proxy: undefined,
    https_proxy: undefined,
    all_proxy: undefined,
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    ALL_PROXY: undefined,
    no_proxy: '*',
    NO_PROXY: '*',
    GIT_ASKPASS: undefined,
    SSH_ASKPASS: undefined,
    ...extra,
  });
}

/**
 * The URL with credentials of each form git accepts, against a closed port
 * on 127.0.0.1 (or ::1), keyed by a short name; each holds `URL_TOKEN` or
 * `GH_TOKEN` as its credential.
 */
export function credentialUrls(port: number = CLOSED_PORT): Record<string, string> {
  return {
    'https user:password': `https://agent:${URL_TOKEN}@127.0.0.1:${port}/me/missing.git`,
    'https token as user': `https://${GH_TOKEN}@127.0.0.1:${port}/me/missing.git`,
    'http user:password percent-encoded': `http://agent:${URL_TOKEN}%21@127.0.0.1:${port}/x.git`,
    'https IPv6 host': `https://agent:${URL_TOKEN}@[::1]:${port}/x.git`,
  };
}

/** A child HTTP server on 127.0.0.1 answering every request 401 with a Basic challenge. */
export interface AuthServer {
  readonly port: number;
  stop(): void;
}

/** Starts `AuthServer` as a child process (git runs synchronously, so it cannot be served in process). */
export async function startAuthServer(): Promise<AuthServer> {
  const source = [
    "const http = require('node:http');",
    'const server = http.createServer((req, res) => {',
    "  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"agentboard-test\"' });",
    '  res.end();',
    '});',
    "server.listen(0, '127.0.0.1', () => { process.stdout.write(server.address().port + '\\n'); });",
  ].join('\n');
  return startChildServer(source);
}

/** Runs `source` with node as a child process and resolves with the port it prints on its first stdout line. */
async function startChildServer(source: string): Promise<AuthServer> {
  const child: ChildProcess = spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const line = out.split('\n')[0];
      if (out.includes('\n') && line !== undefined) {
        resolve(Number(line));
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      reject(new Error(`server exited with ${String(code)}`));
    });
  });
  return {
    port,
    stop: () => {
      child.kill();
    },
  };
}

/**
 * A `GIT_SSH_COMMAND` shim that prints `line` on stderr and exits 255
 * without connecting anywhere: git passes ssh's stderr through, so `line`
 * stands for a git or ssh error line that quotes what it was given.
 */
export function printingSshShim(line: string): string {
  const dir = tempDir();
  const script = join(dir, 'ssh-print-shim');
  const quoted = line.replace(/'/g, "'\\''");
  writeFileSync(script, ['#!/bin/sh', `printf '%s\\n' '${quoted}' >&2`, 'exit 255', ''].join('\n'));
  chmodSync(script, 0o755);
  return script;
}

/**
 * Starts, as a child process, an HTTP proxy on 127.0.0.1 that answers every
 * request, and every `CONNECT`, with 407 and a Basic `Proxy-Authenticate`
 * challenge, so git asks for the proxy password (and, with the prompt
 * off, quotes the proxy URL in `could not read Password for '<proxy>'`).
 * It forwards nothing.
 */
export async function startProxyServer(): Promise<AuthServer> {
  const source = [
    "const http = require('node:http');",
    "const challenge = { 'Proxy-Authenticate': 'Basic realm=\"agentboard-test-proxy\"' };",
    'const server = http.createServer((req, res) => {',
    '  res.writeHead(407, challenge);',
    '  res.end();',
    '});',
    "server.on('connect', (req, socket) => {",
    "  socket.end('HTTP/1.1 407 Proxy Authentication Required\\r\\nProxy-Authenticate: Basic realm=\"agentboard-test-proxy\"\\r\\nContent-Length: 0\\r\\n\\r\\n');",
    '});',
    "server.listen(0, '127.0.0.1', () => { process.stdout.write(server.address().port + '\\n'); });",
  ].join('\n');
  return startChildServer(source);
}

/** `text` with curl's elapsed time (`after 12 ms`) made constant, for comparing the output of two git runs. */
export function withoutTiming(text: string): string {
  return text.replace(/after \d+ ms/g, 'after N ms');
}

/**
 * A URL holding both fixtures, a credential in its user information and a
 * token in its path, on a closed port of 127.0.0.1: it never answers, so
 * a test makes git use a local bare repository for it with
 * `rewriteToLocal`. `name` keeps several such URLs apart.
 */
export function credentialedUrl(name = 'x'): string {
  return `http://agent:${URL_TOKEN}@127.0.0.1:${CLOSED_PORT}/${name}/${GH_TOKEN}.git`;
}

/**
 * Makes git use the local repository `path` for `url`: a
 * `url.<path>.insteadOf <url>` entry in the global configuration file of
 * `env` (`GIT_CONFIG_GLOBAL`, as `syncEnv` sets it), so every repository
 * and every command run with `env` resolves it, `init --remote` included.
 */
export function rewriteToLocal(env: Env, url: string, path: string): void {
  const file = env.GIT_CONFIG_GLOBAL;
  if (file === undefined) {
    throw new Error('rewriteToLocal needs an env with GIT_CONFIG_GLOBAL');
  }
  git(tempDir(), 'config', '--file', file, '--add', `url.${path}.insteadOf`, url);
}

/**
 * `env` with a `git` shim first on its PATH that fails, with `line` on
 * stderr and exit status 128, every invocation whose arguments include
 * every word of `triggers`, and runs the real git for any other. It
 * stands for a remote that answers `ls-remote` but fails a later step
 * (fetch, pull, push, clone, checkout) with a line quoting a URL.
 */
export function withFailingGit(env: Env, triggers: readonly string[], line: string): Env {
  const dir = join(tempDir(), 'failing-git-bin');
  mkdirSync(dir);
  const quote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
  const checks = triggers.map(
    (word) =>
      `found=0; for a in "$@"; do [ "$a" = ${quote(word)} ] && found=1; done; [ "$found" = 1 ] || exec ${quote(realGit())} "$@"`,
  );
  writeFileSync(
    join(dir, 'git'),
    ['#!/bin/sh', ...checks, `printf '%s\\n' ${quote(line)} >&2`, 'exit 128', ''].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  return { ...env, PATH: `${dir}:${env.PATH ?? process.env.PATH ?? ''}` };
}
