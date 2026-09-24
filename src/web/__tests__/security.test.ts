/**
 * The per-request security checks as pure functions (board-web: "Access
 * token", "Host header check", "No cross-origin access and security
 * headers", "Read-only server"; add-board-web task 3.1). The same
 * scenarios over real HTTP are in server.test.ts.
 */

import type * as NodeCrypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { BoardError } from '../../store/errors.js';
import {
  ALLOWED_METHOD,
  CONTENT_SECURITY_POLICY,
  TOKEN_BYTES,
  TOKEN_LENGTH,
  checkRequest,
  cookieName,
  hostAllowed,
  isApiPath,
  newToken,
  presentedTokens,
  securityHeaders,
  sessionCookie,
  tokensEqual,
  type Guard,
  type RequestHead,
} from '../security.js';
import { CSP } from './web-helpers.js';

// Every call of crypto.timingSafeEqual, whichever way the module imports it.
const timing = vi.hoisted(() => ({ calls: [] as [number, number][] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
    timing.calls.push([a.byteLength, b.byteLength]);
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

/** A two-byte UTF-8 character. */
const E_ACUTE = String.fromCharCode(0xe9);
const TOKEN = 'A'.repeat(21) + '-_' + 'z'.repeat(20);
const PORT = 4477;
const GUARD: Guard = { port: PORT, token: TOKEN };
const HOST = `127.0.0.1:${String(PORT)}`;

/** `TOKEN` with the character at `i` changed. */
function differsAt(i: number): string {
  const other = TOKEN[i] === 'B' ? 'C' : 'B';
  return TOKEN.slice(0, i) + other + TOKEN.slice(i + 1);
}

function head(method: string, url: string, headers: Record<string, string> = {}): RequestHead {
  const lower: Record<string, string> = { host: HOST };
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return { method, url, headers: lower };
}

function withoutHost(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): RequestHead {
  return { method, url, headers: { ...headers } };
}

const BEARER = { authorization: `Bearer ${TOKEN}` };
const COOKIE = { cookie: `agentboard-${String(PORT)}=${TOKEN}` };

describe('newToken', () => {
  it('draws 32 random bytes as 43 base64url characters', () => {
    expect(TOKEN_BYTES).toBe(32);
    expect(TOKEN_LENGTH).toBe(43);
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bytes = Buffer.from(token, 'base64url');
    expect(bytes).toHaveLength(32);
    expect(bytes.toString('base64url')).toBe(token);
  });

  it('draws a new token at every call', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newToken()));
    expect(tokens.size).toBe(50);
  });
});

describe('tokensEqual', () => {
  it('is true for the token and false for anything else', () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual(`${TOKEN}`, TOKEN)).toBe(true);
    for (const i of [0, 21, 42]) {
      expect(tokensEqual(differsAt(i), TOKEN), String(i)).toBe(false);
    }
    expect(tokensEqual(TOKEN.slice(0, 42), TOKEN)).toBe(false);
    expect(tokensEqual(`${TOKEN}A`, TOKEN)).toBe(false);
    expect(tokensEqual('', TOKEN)).toBe(false);
    expect(tokensEqual(TOKEN.toLowerCase(), TOKEN)).toBe(false);
  });

  it('never throws, including on a different byte length with the same character count', () => {
    const accented = `${TOKEN.slice(0, 42)}${E_ACUTE}`;
    expect(accented).toHaveLength(43);
    expect(() => tokensEqual(accented, TOKEN)).not.toThrow();
    expect(tokensEqual(accented, TOKEN)).toBe(false);
  });

  it('compares equal lengths with crypto.timingSafeEqual, and never calls it on unequal lengths', () => {
    timing.calls.length = 0;
    tokensEqual(TOKEN, TOKEN);
    tokensEqual(differsAt(5), TOKEN);
    expect(timing.calls).toEqual([
      [43, 43],
      [43, 43],
    ]);
    timing.calls.length = 0;
    tokensEqual('short', TOKEN);
    tokensEqual(`${TOKEN.slice(0, 42)}${E_ACUTE}`, TOKEN);
    expect(timing.calls).toEqual([]);
  });
});

describe('the cookie', () => {
  it('is named after the port', () => {
    expect(cookieName(4477)).toBe('agentboard-4477');
    expect(cookieName(65535)).toBe('agentboard-65535');
  });

  it('scenario: the entry cookie is HttpOnly, SameSite=Strict, Path=/ and a session cookie', () => {
    const value = sessionCookie(PORT, TOKEN);
    expect(value).toBe(`agentboard-4477=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    expect(value).not.toMatch(/max-age|expires|domain|secure/i);
  });
});

describe('hostAllowed', () => {
  it.each([
    ['127.0.0.1:4477', true],
    ['localhost:4477', true],
    ['attacker.example:4477', false],
    ['attacker.example', false],
    ['127.0.0.1', false],
    ['localhost', false],
    ['127.0.0.1:4478', false],
    ['localhost:447', false],
    ['[::1]:4477', false],
    ['127.0.0.2:4477', false],
    ['0.0.0.0:4477', false],
    ['localhost.:4477', false],
    [' 127.0.0.1:4477', false],
    ['127.0.0.1:4477 ', false],
    ['LOCALHOST:4477', false],
    ['127.0.0.1:04477', false],
    ['', false],
  ])('%j is %s', (host, allowed) => {
    expect(hostAllowed(host, PORT)).toBe(allowed);
  });

  it('refuses a missing or repeated header', () => {
    expect(hostAllowed(undefined, PORT)).toBe(false);
    expect(hostAllowed([HOST, HOST], PORT)).toBe(false);
  });
});

describe('isApiPath', () => {
  it.each([
    ['/api', true],
    ['/api/', true],
    ['/api/board', true],
    ['/api/stream', true],
    ['/api/tickets/01J9K3', true],
    ['/', false],
    ['/app.js', false],
    ['/apix', false],
    ['/api.js', false],
    ['/API/board', false],
  ])('%s is %s', (path, api) => {
    expect(isApiPath(path)).toBe(api);
  });
});

describe('securityHeaders', () => {
  it('uses the Content-Security-Policy of board-web, exactly', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(CSP);
    expect(ALLOWED_METHOD).toBe('GET');
  });

  it('scenario: the headers of every response, and no-store on API responses', () => {
    const page = {
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    };
    expect(securityHeaders(false)).toEqual(page);
    expect(securityHeaders(true)).toEqual({ ...page, 'Cache-Control': 'no-store' });
    for (const headers of [securityHeaders(false), securityHeaders(true)]) {
      expect(Object.keys(headers).filter((k) => /^access-control-/i.test(k))).toEqual([]);
    }
  });

  it('returns a new object at every call', () => {
    const a = securityHeaders(true);
    a['X-Frame-Options'] = 'SAMEORIGIN';
    expect(securityHeaders(true)['X-Frame-Options']).toBe('DENY');
  });
});

describe('presentedTokens', () => {
  it('accepts the query token on GET / only', () => {
    expect(presentedTokens(head('GET', `/?token=${TOKEN}`), GUARD)).toEqual(['query']);
    expect(presentedTokens(head('GET', `/?x=1&token=${TOKEN}`), GUARD)).toEqual(['query']);
    expect(presentedTokens(head('GET', `/api/board?token=${TOKEN}`), GUARD)).toEqual([]);
    expect(presentedTokens(head('GET', `/api/stream?token=${TOKEN}`), GUARD)).toEqual([]);
    expect(presentedTokens(head('GET', `/app.js?token=${TOKEN}`), GUARD)).toEqual([]);
    expect(presentedTokens(head('GET', `/index.html?token=${TOKEN}`), GUARD)).toEqual([]);
    expect(presentedTokens(head('POST', `/?token=${TOKEN}`), GUARD)).toEqual([]);
    expect(presentedTokens(head('GET', `/?token=${differsAt(3)}`), GUARD)).toEqual([]);
  });

  it('finds the cookie of this port among others, and ignores another port', () => {
    expect(presentedTokens(head('GET', '/api/board', COOKIE), GUARD)).toEqual(['cookie']);
    expect(
      presentedTokens(
        head('GET', '/api/board', {
          cookie: `a=b; agentboard-4478=${TOKEN};agentboard-${String(PORT)}=${TOKEN}; c=d`,
        }),
        GUARD,
      ),
    ).toEqual(['cookie']);
    expect(
      presentedTokens(head('GET', '/api/board', { cookie: `agentboard-4478=${TOKEN}` }), GUARD),
    ).toEqual([]);
    expect(
      presentedTokens(
        head('GET', '/api/board', { cookie: `agentboard-${String(PORT)}=${differsAt(0)}` }),
        GUARD,
      ),
    ).toEqual([]);
    expect(presentedTokens(head('GET', '/api/board', { cookie: `token=${TOKEN}` }), GUARD)).toEqual(
      [],
    );
  });

  it('accepts Authorization: Bearer with the token only', () => {
    expect(presentedTokens(head('GET', '/api/board', BEARER), GUARD)).toEqual(['bearer']);
    expect(
      presentedTokens(
        head('GET', '/api/board', { authorization: `Bearer ${differsAt(42)}` }),
        GUARD,
      ),
    ).toEqual([]);
    expect(
      presentedTokens(head('GET', '/api/board', { authorization: `Basic ${TOKEN}` }), GUARD),
    ).toEqual([]);
    expect(presentedTokens(head('GET', '/api/board', { authorization: TOKEN }), GUARD)).toEqual([]);
  });

  it('lists every form that carries the token, in the order query, cookie, bearer', () => {
    expect(
      presentedTokens(head('GET', `/?token=${TOKEN}`, { ...COOKIE, ...BEARER }), GUARD),
    ).toEqual(['query', 'cookie', 'bearer']);
    expect(presentedTokens(head('GET', `/?token=${differsAt(1)}`, { ...COOKIE }), GUARD)).toEqual([
      'cookie',
    ]);
  });
});

/** Asserts a refusal and returns its error. */
function refused(
  verdict: ReturnType<typeof checkRequest>,
  status: number,
  reason: string,
  api: boolean,
): BoardError {
  expect(verdict.kind).toBe('refuse');
  if (verdict.kind !== 'refuse') {
    throw new Error('not a refusal');
  }
  expect(verdict.status).toBe(status);
  expect(verdict.error).toBeInstanceOf(BoardError);
  expect({ exitCode: verdict.error.exitCode, reason: verdict.error.reason }).toEqual({
    exitCode: 1,
    reason,
  });
  expect(verdict.api).toBe(api);
  return verdict.error;
}

describe('checkRequest', () => {
  it('scenario: DNS rebinding is refused 403 forbidden-host, before the token is looked at', () => {
    for (const host of ['attacker.example:4477', '127.0.0.1', 'localhost:1']) {
      refused(
        checkRequest(head('GET', '/api/board', { ...COOKIE, host }), GUARD),
        403,
        'forbidden-host',
        true,
      );
      refused(
        checkRequest(head('GET', '/', { ...BEARER, host }), GUARD),
        403,
        'forbidden-host',
        false,
      );
      // Without a token too: the Host check comes first.
      refused(
        checkRequest(head('POST', '/api/board', { host }), GUARD),
        403,
        'forbidden-host',
        true,
      );
    }
    refused(
      checkRequest(withoutHost('GET', '/api/board', COOKIE), GUARD),
      403,
      'forbidden-host',
      true,
    );
  });

  it('refuses a request without a valid token with 401 unauthorized, whatever its method', () => {
    refused(checkRequest(head('GET', '/api/board'), GUARD), 401, 'unauthorized', true);
    refused(checkRequest(head('GET', '/'), GUARD), 401, 'unauthorized', false);
    refused(checkRequest(head('GET', '/app.js'), GUARD), 401, 'unauthorized', false);
    refused(checkRequest(head('POST', '/api/board'), GUARD), 401, 'unauthorized', true);
    refused(
      checkRequest(head('OPTIONS', '/api/board', { origin: 'https://evil.example' }), GUARD),
      401,
      'unauthorized',
      true,
    );
  });

  it('scenario: the query token is not accepted on the API', () => {
    refused(
      checkRequest(head('GET', `/api/board?token=${TOKEN}`), GUARD),
      401,
      'unauthorized',
      true,
    );
  });

  it('scenario: a token differing in one character is 401', () => {
    refused(
      checkRequest(head('GET', '/api/board', { authorization: `Bearer ${differsAt(10)}` }), GUARD),
      401,
      'unauthorized',
      true,
    );
  });

  it('never puts a token in the unauthorized message', () => {
    const wrong = differsAt(7);
    const error = refused(
      checkRequest(head('GET', `/?token=${wrong}`, { authorization: `Bearer ${wrong}` }), GUARD),
      401,
      'unauthorized',
      false,
    );
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(wrong);
    expect(error.message).toMatch(/URL/);
  });

  it('scenario: every method but GET is 405 method-not-allowed once authenticated', () => {
    for (const method of [
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'HEAD',
      'OPTIONS',
      'CONNECT',
      'TRACE',
    ]) {
      refused(
        checkRequest(head(method, '/api/board', BEARER), GUARD),
        405,
        'method-not-allowed',
        true,
      );
      refused(checkRequest(head(method, '/', COOKIE), GUARD), 405, 'method-not-allowed', false);
    }
  });

  it('scenario: the entry URL with the token enters with the session cookie', () => {
    for (const url of [`/?token=${TOKEN}`, `/?token=${TOKEN}&x=1`]) {
      const verdict = checkRequest(head('GET', url), GUARD);
      expect(verdict).toEqual({ kind: 'enter', setCookie: sessionCookie(PORT, TOKEN) });
    }
    // Even when a cookie is present as well.
    expect(checkRequest(head('GET', `/?token=${TOKEN}`, COOKIE), GUARD).kind).toBe('enter');
  });

  it('routes an authenticated GET with its path and query', () => {
    const verdict = checkRequest(head('GET', '/api/events?after=abc&limit=5', BEARER), GUARD);
    expect(verdict.kind).toBe('route');
    if (verdict.kind === 'route') {
      expect(verdict.path).toBe('/api/events');
      expect(verdict.query.get('after')).toBe('abc');
      expect(verdict.query.get('limit')).toBe('5');
      expect(verdict.api).toBe(true);
    }
    const page = checkRequest(head('GET', '/', COOKIE), GUARD);
    expect(page).toMatchObject({ kind: 'route', path: '/', api: false });
    const asset = checkRequest(
      head('GET', '/app.js', { host: `localhost:${String(PORT)}`, ...COOKIE }),
      GUARD,
    );
    expect(asset).toMatchObject({ kind: 'route', path: '/app.js', api: false });
  });

  it('routes GET / with a wrong query token when a valid cookie authenticates it', () => {
    expect(checkRequest(head('GET', `/?token=${differsAt(2)}`, COOKIE), GUARD)).toMatchObject({
      kind: 'route',
      path: '/',
    });
  });
});
