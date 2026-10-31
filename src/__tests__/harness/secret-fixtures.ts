/**
 * Token-shaped values for the no-echo tests (no-echo-refusals design.md,
 * "Testing approach"; board-cli "Refusals never repeat the refused
 * input"), and the assertion that none of them leaked into an output.
 *
 * Shared by both task groups of no-echo-refusals: every refusal test
 * passes a fixture as the refused input and then checks every channel the
 * refusal reaches (stdout, stderr, the `--json` document, the MCP tool
 * result and the MCP server's stderr, the web action body and the
 * server's output) with `expectNoLeak`. Group 2 (sharing: `init
 * --remote`, `sync`, git lines quoted from remote commands) builds its
 * URLs from the same fixtures through `src/board/__tests__/no-echo-remote-helpers.ts`
 * and calls `expectNoLeak` with one output; `secretFixture` and
 * `MIN_LEAK` are its names for `fixture` and `LEAK_WINDOW`.
 *
 * The literals are built with `join` (as `src/board/__tests__/helpers.ts`
 * builds its secret samples) so that no complete token-shaped string is in
 * the source, where a secret scanner or a host's push protection would
 * flag it. None of them is a real credential.
 *
 * None of the fixtures has the ticket id shape (1 to 26 Crockford base32
 * characters, ASCII case-insensitive, the first of them 0): each
 * contains `_`, `-`, `:`, `I`, is longer than 26 characters, or (the
 * base32 fixtures of review rounds 1 and 2) is all Crockford base32 but
 * starts with a letter or with 7. So the id exception of board-cli "Ticket ids in
 * refusals" never applies to them, and every refusal must keep them out
 * of every output.
 */

import { expect } from 'vitest';

/** One token-shaped value. */
export interface SecretFixture {
  /** A short name, reported when the fixture leaks. */
  readonly name: string;
  /** The value passed as the refused input. */
  readonly value: string;
  /**
   * The secret part of `value`, whose every substring of
   * `LEAK_WINDOW` or more characters counts as a leak. Equal to `value`
   * except for the URL with credentials, whose secret is its user
   * information: its scheme and host are not secret and may appear in an
   * output that names another URL.
   */
  readonly secret: string;
}

/** A GitHub-style classic token: `ghp_` and 36 alphanumerics. */
export const GITHUB_TOKEN = ['ghp', '_', 'Q8wErT5yUi9oPa3sDf7gHj1kLz6xCv4bNm2M'].join('');

/** An AWS-style access key id: `AKIA` and 16 upper-case alphanumerics. */
export const AWS_KEY_ID = ['AKIA', 'Q4X7EXAMPLE2W9ZK'].join('');

/** A 40-character lowercase hex string (the length of a SHA-1). */
export const HEX_40 = ['9f3c1a7e5b2d', '8c4f6a0e1b3d', '5f7a9c2e4b6d8f0a'].join('');

/**
 * A 64-character lowercase hex string (the length of a SHA-256), the only
 * shape that passes the `inbox --since` form check and so reaches the
 * `unknown-cursor` refusal.
 */
export const HEX_64 = ['c0ffee5ec2e7d4a1b8f3e6c9a2d5b8e1', 'f4a7c0d3b6e9f2a5c8b1e4d7a0c3f6b9'].join(
  '',
);

/** The token inside `URL_WITH_CREDENTIALS`. */
export const URL_TOKEN = ['ghp', '_', 'Z3xCv7bNm1QwE5rTy9UiO2pAs6DfG4hJk8L0'].join('');

/** A URL with credentials: `https://agent:<token>@git.example.com/x.git`. */
export const URL_WITH_CREDENTIALS = ['https://agent:', URL_TOKEN, '@git.example.com/x.git'].join(
  '',
);

/**
 * A token of only `[a-z0-9-]` (a word-like shape) longer than 26
 * characters.
 */
export const LONG_WORD = ['x9k2-q7vz-m3p8', '-w4rt-j6hn-b5cd-f1gs'].join('');

/**
 * A 26-character token of Crockford base32 that starts with a letter (8
 * to Z): the length of a ULID, but not one, since every ULID starts with
 * 0 to 7 (review round 1, F2).
 */
export const CROCKFORD_26 = ['KZQ4XK9M2PVB8', 'RT3NH6WD5YCFJ'].join('');

/**
 * A 26-character token of Crockford base32 that starts with 7: the shape
 * of a ULID from the far future, which the id exception no longer repeats
 * since it requires a first character of 0 (review round 2).
 */
export const CROCKFORD_26_SEVEN = ['7MZ4QK9X2PVB8', 'GW3NH6TD5YCAE'].join('');

/**
 * A 16-character TOTP-style seed (RFC 4648 base32, A to Z and 2 to 7)
 * with no I, L, O or U, so every character is Crockford base32 (review
 * round 1, F2).
 */
export const TOTP_SEED = ['JBSWY3DP', 'EHPK3PXP'].join('');

/**
 * Every fixture of design.md "Testing approach", plus `HEX_64`,
 * `CROCKFORD_26`, `CROCKFORD_26_SEVEN` and `TOTP_SEED`.
 */
export const SECRET_FIXTURES: readonly SecretFixture[] = [
  { name: 'github-token', value: GITHUB_TOKEN, secret: GITHUB_TOKEN },
  { name: 'aws-key-id', value: AWS_KEY_ID, secret: AWS_KEY_ID },
  { name: 'hex-40', value: HEX_40, secret: HEX_40 },
  { name: 'hex-64', value: HEX_64, secret: HEX_64 },
  { name: 'url-with-credentials', value: URL_WITH_CREDENTIALS, secret: `agent:${URL_TOKEN}` },
  { name: 'long-word', value: LONG_WORD, secret: LONG_WORD },
  { name: 'crockford-26', value: CROCKFORD_26, secret: CROCKFORD_26 },
  { name: 'totp-seed', value: TOTP_SEED, secret: TOTP_SEED },
  { name: 'crockford-26-seven', value: CROCKFORD_26_SEVEN, secret: CROCKFORD_26_SEVEN },
];

/** The fixtures a positional or flag value is tested with (all but the URL). */
export const TOKEN_FIXTURES: readonly SecretFixture[] = SECRET_FIXTURES.filter(
  (f) => f.name !== 'url-with-credentials',
);

/** The fixture of the given name. */
export function fixture(name: string): SecretFixture {
  const found = SECRET_FIXTURES.find((f) => f.name === name);
  if (found === undefined) {
    throw new Error(`no secret fixture named ${name}`);
  }
  return found;
}

/** `fixture`, under the name the group 2 (sharing) tests import. */
export const secretFixture = fixture;

/** A substring of a fixture's secret this long or longer counts as a leak. */
export const LEAK_WINDOW = 8;

/** `LEAK_WINDOW`, under the name the group 2 (sharing) tests import. */
export const MIN_LEAK = LEAK_WINDOW;

/** Any value as text: strings as they are, everything else as JSON. */
function textOf(output: unknown): string {
  return typeof output === 'string' ? output : (JSON.stringify(output) ?? '');
}

/**
 * The names of the fixtures that leaked into `output` (a string, or any
 * value, which is checked as its JSON text): a fixture leaked when its
 * `value`, or any substring of `LEAK_WINDOW` characters of its `secret`,
 * appears in the output, compared without regard to case (an upper-cased
 * echo is still an echo). Pure.
 */
export function leaksIn(
  output: unknown,
  fixtures: readonly SecretFixture[] = SECRET_FIXTURES,
): string[] {
  const text = textOf(output).toLowerCase();
  return fixtures
    .filter((f) => {
      if (text.includes(f.value.toLowerCase())) {
        return true;
      }
      const secret = f.secret.toLowerCase();
      for (let i = 0; i + LEAK_WINDOW <= secret.length; i += 1) {
        if (text.includes(secret.slice(i, i + LEAK_WINDOW))) {
          return true;
        }
      }
      return false;
    })
    .map((f) => f.name);
}

/** Whether `value` is a `SecretFixture` (the optional last argument of `expectNoLeak`). */
function isFixtureList(value: readonly unknown[]): value is readonly SecretFixture[] {
  return value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'name' in item &&
      'value' in item &&
      'secret' in item,
  );
}

/**
 * Asserts that no fixture leaked (see `leaksIn`). Two call shapes, one
 * per task group of no-echo-refusals, so that neither group's tests
 * changed when the two copies of this file were merged:
 * - `expectNoLeak(what, outputs, fixtures?)` (group 1): every value of
 *   `outputs` is checked; `what` names the call in the failure message,
 *   which never prints the output itself beyond what vitest prints for
 *   the comparison.
 * - `expectNoLeak(output, fixtures?)` (group 2): one output, a string.
 * The shapes are told apart by the second argument: absent or a list of
 * fixtures means the second shape; any other list means the first.
 */
export function expectNoLeak(output: string, fixtures?: readonly SecretFixture[]): void;
export function expectNoLeak(
  what: string,
  outputs: readonly unknown[],
  fixtures?: readonly SecretFixture[],
): void;
export function expectNoLeak(
  first: string,
  second?: readonly unknown[],
  third: readonly SecretFixture[] = SECRET_FIXTURES,
): void {
  if (second === undefined || (second.length > 0 && isFixtureList(second))) {
    expect(leaksIn(first, second ?? SECRET_FIXTURES), 'no fixture in the output').toEqual([]);
    return;
  }
  second.forEach((output, index) => {
    expect(leaksIn(output, third), `${first}: output ${String(index)}`).toEqual([]);
  });
}
