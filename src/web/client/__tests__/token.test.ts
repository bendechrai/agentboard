/**
 * Taking the access token from the URL fragment (`token.ts`; board-web: "Access
 * token"): stored in `sessionStorage`, removed from the address bar, validated,
 * and read back on a reload.
 */

import { describe, expect, it } from 'vitest';

import { TOKEN_KEY, TOKEN_PATTERN, discardToken, takeToken, type TokenEnv } from '../token.js';
import { TOKEN } from './client-helpers.js';

interface FakeEnv extends TokenEnv {
  readonly stored: Map<string, string>;
  readonly replaced: string[];
}

function env(hash: string, stored: Record<string, string> = {}, storageFails = false): FakeEnv {
  const map = new Map(Object.entries(stored));
  const replaced: string[] = [];
  return {
    stored: map,
    replaced,
    location: { hash, pathname: '/', search: '' },
    storage: () => {
      if (storageFails) {
        throw new Error('SecurityError: storage is disabled');
      }
      return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          map.set(key, value);
        },
        removeItem: (key: string) => {
          map.delete(key);
        },
      };
    },
    history: {
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        replaced.push(String(url));
      },
    },
  };
}

describe('takeToken', () => {
  it('takes the token from the fragment, stores it and clears the address bar', () => {
    const e = env(`#token=${TOKEN}`);
    expect(takeToken(e)).toBe(TOKEN);
    expect(e.stored.get(TOKEN_KEY)).toBe(TOKEN);
    expect(e.replaced).toEqual(['/']);
    expect(TOKEN_KEY).toBe('agentboard-token');
  });

  it('keeps the path and query when clearing the fragment', () => {
    const e: FakeEnv = {
      ...env(`#token=${TOKEN}`),
      location: { hash: `#token=${TOKEN}`, pathname: '/', search: '?x=1' },
    };
    expect(takeToken(e)).toBe(TOKEN);
    expect(e.replaced).toEqual(['/?x=1']);
  });

  it('replaces a stored token with the one in the fragment', () => {
    const old = 'o'.repeat(43);
    const e = env(`#token=${TOKEN}`, { [TOKEN_KEY]: old });
    expect(takeToken(e)).toBe(TOKEN);
    expect(e.stored.get(TOKEN_KEY)).toBe(TOKEN);
  });

  it('reads the stored token when the fragment has none, leaving the address bar alone', () => {
    for (const hash of ['', '#', '#/feed?actor=a', '#/board']) {
      const e = env(hash, { [TOKEN_KEY]: TOKEN });
      expect(takeToken(e)).toBe(TOKEN);
      expect(e.replaced).toEqual([]);
    }
  });

  it('is null with no token anywhere', () => {
    const e = env('');
    expect(takeToken(e)).toBeNull();
    expect(e.replaced).toEqual([]);
  });

  it('refuses a malformed fragment token, clearing it and discarding any stored token', () => {
    for (const bad of [
      '',
      'short',
      `${TOKEN}x`,
      `${TOKEN.slice(0, 42)}!`,
      `${TOKEN.slice(0, 42)}=`,
    ]) {
      const e = env(`#token=${bad}`, { [TOKEN_KEY]: TOKEN });
      expect(takeToken(e), bad).toBeNull();
      expect(e.replaced, bad).toEqual(['/']);
      expect(e.stored.has(TOKEN_KEY), bad).toBe(false);
    }
  });

  it('discards a malformed stored value', () => {
    const e = env('', { [TOKEN_KEY]: 'garbage' });
    expect(takeToken(e)).toBeNull();
    expect(e.stored.has(TOKEN_KEY)).toBe(false);
  });

  it('discardToken removes the stored token and survives missing storage', () => {
    const e = env('', { [TOKEN_KEY]: TOKEN, other: 'kept' });
    discardToken(e);
    expect(e.stored.has(TOKEN_KEY)).toBe(false);
    expect(e.stored.get('other')).toBe('kept');
    expect(() => {
      discardToken(env('', {}, true));
    }).not.toThrow();
    expect(takeToken(e)).toBeNull();
  });

  it('works without storage: uses the fragment, else has nothing', () => {
    const e = env(`#token=${TOKEN}`, {}, true);
    expect(takeToken(e)).toBe(TOKEN);
    expect(e.replaced).toEqual(['/']);
    expect(takeToken(env('', {}, true))).toBeNull();
  });

  it('validates 43 base64url characters', () => {
    expect(TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(TOKEN_PATTERN.test('A'.repeat(43))).toBe(true);
    expect(TOKEN_PATTERN.test('A'.repeat(42))).toBe(false);
    expect(TOKEN_PATTERN.test('A'.repeat(44))).toBe(false);
    expect(TOKEN_PATTERN.test(`${'A'.repeat(42)}+`)).toBe(false);
    expect(TOKEN_PATTERN.test(`${'A'.repeat(42)}/`)).toBe(false);
  });
});
