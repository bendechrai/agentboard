/**
 * The per-request security checks as pure functions (board-web: "Access
 * token", "Host header check", "No cross-origin access and security
 * headers", "Read-only server"). The same
 * scenarios over real HTTP are in server.test.ts.
 */

import type * as NodeCrypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { BoardError } from '../../store/errors.js';
import {
  ACTIONS_PREFIX,
  ALLOWED_METHOD,
  CONTENT_SECURITY_POLICY,
  TOKEN_BYTES,
  TOKEN_LENGTH,
  checkRequest,
  hostAllowed,
  isActionPath,
  isApiPath,
  newToken,
  presentedTokens,
  securityHeaders,
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

/**
 * A request head as `node:http` gives it: `headers` with the first value
 * of each header, `headersDistinct` with every value. `hosts` are the Host
 * header values in order (default one, `HOST`); `headers.host` takes an
 * explicit override from `headers`.
 */
function head(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  hosts: readonly string[] = [headers.host ?? HOST],
): RequestHead {
  const lower: Record<string, string> = {};
  const distinct: Record<string, string[]> = {};
  if (hosts.length > 0) {
    lower.host = hosts[0] ?? '';
    distinct.host = [...hosts];
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'host') {
      lower[k.toLowerCase()] = v;
      distinct[k.toLowerCase()] = [v];
    }
  }
  return { method, url, headers: lower, headersDistinct: distinct };
}

function withoutHost(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): RequestHead {
  return head(method, url, headers, []);
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

  it('accepts every value node:http kept only when there is exactly one allowed value', () => {
    expect(hostAllowed([HOST], PORT)).toBe(true);
    expect(hostAllowed([`localhost:${String(PORT)}`], PORT)).toBe(true);
    expect(hostAllowed(undefined, PORT)).toBe(false);
    expect(hostAllowed([], PORT)).toBe(false);
    expect(hostAllowed([HOST, HOST], PORT)).toBe(false);
    expect(hostAllowed([HOST, 'attacker.example'], PORT)).toBe(false);
    expect(hostAllowed(['attacker.example', HOST], PORT)).toBe(false);
    expect(hostAllowed(['attacker.example:4477'], PORT)).toBe(false);
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
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
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
  it('accepts Authorization: Bearer with the token only', () => {
    expect(presentedTokens(head('GET', '/api/board', BEARER), GUARD)).toEqual(['bearer']);
    expect(presentedTokens(head('POST', '/', BEARER), GUARD)).toEqual(['bearer']);
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

  it('ignores a token query parameter on every path, GET / included', () => {
    for (const url of [`/?token=${TOKEN}`, `/api/board?token=${TOKEN}`, `/app.js?token=${TOKEN}`]) {
      expect(presentedTokens(head('GET', url), GUARD), url).toEqual([]);
    }
  });

  it('ignores every cookie, the old agentboard-<port> cookie included', () => {
    for (const cookie of [
      `agentboard-${String(PORT)}=${TOKEN}`,
      `a=b; agentboard-${String(PORT)}=${TOKEN}; c=d`,
      `token=${TOKEN}`,
    ]) {
      expect(presentedTokens(head('GET', '/api/board', { cookie }), GUARD), cookie).toEqual([]);
      expect(presentedTokens(head('GET', `/?token=${TOKEN}`, { cookie }), GUARD), cookie).toEqual(
        [],
      );
    }
    expect(presentedTokens(head('GET', '/api/board', { ...COOKIE, ...BEARER }), GUARD)).toEqual([
      'bearer',
    ]);
  });

  it('refuses more than one Authorization header, even when the first is valid', () => {
    const valid = `Bearer ${TOKEN}`;
    for (const values of [
      [valid, valid],
      [valid, `Bearer ${differsAt(0)}`],
      [valid, 'Basic eDp5'],
      [`Bearer ${differsAt(0)}`, valid],
      [valid, valid, valid],
    ]) {
      const base = head('GET', '/api/board');
      // node:http keeps only the first Authorization value in `headers`
      // and every value in `headersDistinct`.
      const repeated: RequestHead = {
        ...base,
        headers: { ...base.headers, authorization: values[0] },
        headersDistinct: { ...base.headersDistinct, authorization: values },
      };
      expect(presentedTokens(repeated, GUARD), values.join(' | ')).toEqual([]);
      refused(checkRequest(repeated, GUARD), 401, 'unauthorized', true);
    }
  });

  it('accepts one Authorization header given in headersDistinct as a one-value array', () => {
    const base = head('GET', '/api/board', BEARER);
    expect(base.headersDistinct?.authorization).toEqual([`Bearer ${TOKEN}`]);
    expect(presentedTokens(base, GUARD)).toEqual(['bearer']);
    expect(checkRequest(base, GUARD).kind).toBe('route');
  });

  it('refuses a request whose headersDistinct is absent but headers has a valid bearer token', () => {
    // headersDistinct is how the count is known; without it the request
    // cannot prove it carried exactly one Authorization header.
    const { headersDistinct: _dropped, ...rest } = head('GET', '/api/board', BEARER);
    void _dropped;
    expect(presentedTokens(rest, GUARD)).toEqual([]);
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
        checkRequest(head('GET', '/api/board', { ...BEARER, host }), GUARD),
        403,
        'forbidden-host',
        true,
      );
      // Rebinding the page: the page needs no token but the Host check still applies.
      refused(checkRequest(head('GET', '/', { host }), GUARD), 403, 'forbidden-host', false);
      refused(checkRequest(head('GET', '/app.js', { host }), GUARD), 403, 'forbidden-host', false);
      // Without a token too: the Host check comes first.
      refused(
        checkRequest(head('POST', '/api/board', { host }), GUARD),
        403,
        'forbidden-host',
        true,
      );
    }
    refused(
      checkRequest(withoutHost('GET', '/api/board', BEARER), GUARD),
      403,
      'forbidden-host',
      true,
    );
    refused(checkRequest(withoutHost('GET', '/'), GUARD), 403, 'forbidden-host', false);
  });

  it('scenario: a duplicate Host header is 403 forbidden-host, whichever value comes first', () => {
    for (const hosts of [
      [HOST, 'attacker.example'],
      ['attacker.example', HOST],
      [HOST, HOST],
    ]) {
      refused(
        checkRequest(head('GET', '/api/board', BEARER, hosts), GUARD),
        403,
        'forbidden-host',
        true,
      );
      refused(checkRequest(head('GET', '/', {}, hosts), GUARD), 403, 'forbidden-host', false);
    }
  });

  it('checks the Host with headersDistinct, not with the first value in headers', () => {
    const smuggled: RequestHead = {
      method: 'GET',
      url: '/api/board',
      headers: { host: HOST, ...BEARER },
      headersDistinct: { host: [HOST, 'attacker.example'], authorization: [BEARER.authorization] },
    };
    refused(checkRequest(smuggled, GUARD), 403, 'forbidden-host', true);
    // No headersDistinct at all counts as no Host header.
    refused(
      checkRequest({ method: 'GET', url: '/', headers: { host: HOST } }, GUARD),
      403,
      'forbidden-host',
      false,
    );
  });

  it('scenario: the API requires the bearer header, whatever the method', () => {
    for (const path of ['/api/board', '/api/stream', '/api', '/api/nope']) {
      refused(checkRequest(head('GET', path), GUARD), 401, 'unauthorized', true);
    }
    refused(checkRequest(head('POST', '/api/board'), GUARD), 401, 'unauthorized', true);
    refused(
      checkRequest(head('OPTIONS', '/api/board', { origin: 'https://evil.example' }), GUARD),
      401,
      'unauthorized',
      true,
    );
  });

  it('scenario: a query token and a cookie are ignored on the API', () => {
    refused(
      checkRequest(head('GET', `/api/board?token=${TOKEN}`, COOKIE), GUARD),
      401,
      'unauthorized',
      true,
    );
    refused(
      checkRequest(head('GET', `/api/stream?token=${TOKEN}`, COOKIE), GUARD),
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
      checkRequest(
        head('GET', `/api/board?token=${wrong}`, { authorization: `Bearer ${wrong}` }),
        GUARD,
      ),
      401,
      'unauthorized',
      true,
    );
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(wrong);
    expect(error.message).toMatch(/URL/);
  });

  it('scenario: the page and the assets are routed without a token', () => {
    for (const url of ['/', '/app.js', '/app.css', '/index.html', '/nope']) {
      const verdict = checkRequest(head('GET', url), GUARD);
      expect(verdict, url).toMatchObject({ kind: 'route', path: url, api: false });
    }
  });

  it('routes GET /?token=<token> as the page: no entry URL, no cookie', () => {
    for (const headers of [{}, COOKIE, BEARER]) {
      const verdict = checkRequest(head('GET', `/?token=${TOKEN}`, headers), GUARD);
      expect(verdict.kind).toBe('route');
      if (verdict.kind === 'route') {
        expect(verdict.path).toBe('/');
        expect(verdict.api).toBe(false);
      }
      expect(JSON.stringify(verdict)).not.toContain('Set-Cookie');
    }
  });

  it('scenario: every method but GET is 405 once past the token check', () => {
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
      // The page needs no token, so a non-GET there is 405 without one.
      refused(checkRequest(head(method, '/'), GUARD), 405, 'method-not-allowed', false);
      refused(checkRequest(head(method, '/app.js'), GUARD), 405, 'method-not-allowed', false);
    }
  });

  it('routes an authenticated API GET with its path and query', () => {
    const verdict = checkRequest(head('GET', '/api/events?after=abc&limit=5', BEARER), GUARD);
    expect(verdict.kind).toBe('route');
    if (verdict.kind === 'route') {
      expect(verdict.path).toBe('/api/events');
      expect(verdict.query.get('after')).toBe('abc');
      expect(verdict.query.get('limit')).toBe('5');
      expect(verdict.api).toBe(true);
    }
    const local = checkRequest(
      head('GET', '/api/session', { host: `localhost:${String(PORT)}`, ...BEARER }),
      GUARD,
    );
    expect(local).toMatchObject({ kind: 'route', path: '/api/session', api: true });
  });
});

// board-web: "Read-only server": GET only, except POST to
// /api/actions/<action>.

describe('isActionPath', () => {
  it('is true for every path under /api/actions/', () => {
    expect(ACTIONS_PREFIX).toBe('/api/actions/');
    for (const path of ['/api/actions/comment', '/api/actions/', '/api/actions/a/b']) {
      expect(isActionPath(path), path).toBe(true);
    }
  });

  it('is false for everything else', () => {
    for (const path of ['/api/actions', '/api/actionsx', '/api/board', '/actions/comment', '/']) {
      expect(isActionPath(path), path).toBe(false);
    }
  });
});

describe('checkRequest and the action paths', () => {
  it('routes an authenticated POST of an action path with method POST', () => {
    const verdict = checkRequest(head('POST', '/api/actions/comment?x=1', BEARER), GUARD);
    expect(verdict).toMatchObject({
      kind: 'route',
      method: 'POST',
      path: '/api/actions/comment',
      api: true,
    });
    const local = checkRequest(
      head('POST', '/api/actions/claim', { host: `localhost:${String(PORT)}`, ...BEARER }),
      GUARD,
    );
    expect(local).toMatchObject({ kind: 'route', method: 'POST', path: '/api/actions/claim' });
  });

  it('routes a GET with method GET', () => {
    expect(checkRequest(head('GET', '/api/board', BEARER), GUARD)).toMatchObject({
      kind: 'route',
      method: 'GET',
    });
    expect(checkRequest(head('GET', '/'), GUARD)).toMatchObject({ kind: 'route', method: 'GET' });
  });

  it('checks the Host, then the token, before the method of an action', () => {
    refused(
      checkRequest(
        head('POST', '/api/actions/comment', { ...BEARER, host: 'attacker.example:4477' }),
        GUARD,
      ),
      403,
      'forbidden-host',
      true,
    );
    refused(checkRequest(head('POST', '/api/actions/comment'), GUARD), 401, 'unauthorized', true);
    refused(
      checkRequest(head('POST', '/api/actions/comment', COOKIE), GUARD),
      401,
      'unauthorized',
      true,
    );
    refused(
      checkRequest(head('POST', `/api/actions/comment?token=${TOKEN}`), GUARD),
      401,
      'unauthorized',
      true,
    );
    refused(
      checkRequest(
        head('OPTIONS', '/api/actions/comment', { origin: 'https://attacker.example' }),
        GUARD,
      ),
      401,
      'unauthorized',
      true,
    );
  });

  it('answers every other method of an action path with 405 and allow POST', () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const verdict = checkRequest(head(method, '/api/actions/comment', BEARER), GUARD);
      refused(verdict, 405, 'method-not-allowed', true);
      expect(verdict).toMatchObject({ allow: 'POST' });
    }
  });

  it('answers a POST anywhere else with 405 and allow GET', () => {
    for (const url of ['/api/board', '/api/actions', '/api/actionsx/comment', '/api/session']) {
      const verdict = checkRequest(head('POST', url, BEARER), GUARD);
      refused(verdict, 405, 'method-not-allowed', true);
      expect(verdict, url).toMatchObject({ allow: 'GET' });
    }
    for (const url of ['/', '/app.js', '/actions/comment']) {
      const verdict = checkRequest(head('POST', url), GUARD);
      refused(verdict, 405, 'method-not-allowed', false);
      expect(verdict, url).toMatchObject({ allow: 'GET' });
    }
  });

  it('carries allow on a 405 only', () => {
    expect(checkRequest(head('POST', '/api/actions/comment'), GUARD)).not.toHaveProperty('allow');
    expect(
      checkRequest(head('GET', '/api/board', { host: 'attacker.example:4477' }), GUARD),
    ).not.toHaveProperty('allow');
  });
});
