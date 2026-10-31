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
 * The actor tables of actor-secret-check (design.md "Testing approach"),
 * at the end of this module, reuse these fixtures as actor names: refused
 * by a secret pattern, refused for the actor form only, and accepted. Of
 * the fixtures above, `CROCKFORD_26`, `CROCKFORD_26_SEVEN` and `TOTP_SEED`
 * have the actor form and match no pattern, so they are accepted actor
 * names (design.md "Residual risk").
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

// ---------------------------------------------------------------------------
// Actor names (actor-secret-check design.md "Testing approach"; board-cli
// "Actor names are checked"). The three tables every task group of that
// change tests with, and that each reviewer recomputes with a throwaway
// program: names refused by a secret pattern (whatever their form), names
// that match no pattern and are refused for the form only, and names that
// are accepted. The form is `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$`, tested
// on ASCII only; the patterns are those of `src/board/secrets.ts`, tested
// first.

/** One refused actor name, with the message part it must get. */
export interface RefusedActor extends SecretFixture {
  /**
   * The secret pattern names the refusal must name, in
   * `SECRET_PATTERN_NAMES` order, joined with `, `; null when the name
   * matches no pattern and must get the form message.
   */
  readonly patterns: string | null;
}

/** A JWT-shaped value (header, payload, signature, base64url, dot-separated). */
export const JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  '.',
  'eyJzdWIiOiJhZ2VudCIsImlhdCI6MTcwMDAwMDAwMH0',
  '.',
  'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0',
].join('');

/** A Slack-style bot token (about 55 characters of the actor alphabet). */
export const SLACK_TOKEN = ['xoxb', '-2048163390-5182934756103-', 'Qm7vT2kLx9WcR4pZ8nYb3HdJ'].join(
  '',
);

/** An OpenAI-style project key, longer than 32 characters. */
export const OPENAI_KEY = ['sk', '-proj-', 'T3BlbkFJx7Qm2vK9pL4wR8nZ5cY1hD6j'].join('');

/** A GitHub fine-grained token: `github_pat_` and 22 more characters (33 in all). */
export const GITHUB_PAT = ['github', '_pat_', '11ABCDEFG0123456789xyz'].join('');

/** A `generic-secret-assignment`: `api_key=` and 32 base64 characters. */
export const KEY_ASSIGNMENT = ['api_key', '=', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY'].join('');

/** A PEM private key header (alone: the shortest text the pattern matches). */
export const PEM_HEADER = ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join('');

/** Plain lowercase hex, 33 characters: one over the length bound. */
export const HEX_33 = ['9f3c1a7e5b2d8c4f', '6a0e1b3d5f7a9c2e4'].join('');

/** Plain lowercase hex, 32 characters: within the form (design.md "Residual risk"). */
export const HEX_32 = ['9f3c1a7e5b2d8c4f', '6a0e1b3d5f7a9c2e'].join('');

// Names outside the form by one non-ASCII character, built with
// String.fromCharCode so the source stays ASCII.
/** `impl-ete` with two e acute (U+00E9). */
export const NON_ASCII = `impl-${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}`;
/** `impl` and a long s (U+017F), which Unicode case folding turns into s. */
export const LONG_S = `impl${String.fromCharCode(0x17f)}`;
/** A fullwidth i (U+FF49), which NFKC normalises to i, then `mpl-1`. */
export const FULLWIDTH = `${String.fromCharCode(0xff49)}mpl-1`;
/** A Kelvin sign (U+212A), which Unicode case folding turns into k, then `ai`. */
export const KELVIN = `${String.fromCharCode(0x212a)}ai`;

/**
 * Names refused by a secret pattern. Every one is tested against the
 * patterns before the form, so the AWS-style key id (20 characters of the
 * form) and the 40-character GitHub token (outside the form) both get the
 * pattern message, never the form message.
 */
export const ACTORS_REFUSED_BY_PATTERN: readonly RefusedActor[] = [
  { name: 'github-token', value: GITHUB_TOKEN, secret: GITHUB_TOKEN, patterns: 'github-token' },
  { name: 'github-pat', value: GITHUB_PAT, secret: GITHUB_PAT, patterns: 'github-token' },
  { name: 'aws-key-id', value: AWS_KEY_ID, secret: AWS_KEY_ID, patterns: 'aws-access-key-id' },
  {
    name: 'url-with-credentials',
    value: URL_WITH_CREDENTIALS,
    secret: `agent:${URL_TOKEN}`,
    patterns: 'github-token',
  },
  {
    name: 'key-assignment',
    value: KEY_ASSIGNMENT,
    secret: KEY_ASSIGNMENT,
    patterns: 'generic-secret-assignment',
  },
  { name: 'pem-header', value: PEM_HEADER, secret: PEM_HEADER, patterns: 'pem-private-key' },
  {
    name: 'aws-and-github',
    value: `${AWS_KEY_ID} ${GITHUB_TOKEN}`,
    secret: `${AWS_KEY_ID} ${GITHUB_TOKEN}`,
    patterns: 'aws-access-key-id, github-token',
  },
];

/**
 * Names that match no secret pattern and are refused for the form only:
 * token shapes the patterns do not name (longer than 32 characters, or
 * holding a character outside the form) and names outside the form
 * (board-cli scenario "Names outside the actor form").
 */
export const ACTORS_REFUSED_BY_FORM: readonly RefusedActor[] = [
  // Token shapes no pattern names.
  { name: 'hex-40', value: HEX_40, secret: HEX_40, patterns: null },
  { name: 'hex-64', value: HEX_64, secret: HEX_64, patterns: null },
  { name: 'hex-33', value: HEX_33, secret: HEX_33, patterns: null },
  { name: 'long-word', value: LONG_WORD, secret: LONG_WORD, patterns: null },
  { name: 'jwt', value: JWT, secret: JWT, patterns: null },
  { name: 'slack-token', value: SLACK_TOKEN, secret: SLACK_TOKEN, patterns: null },
  { name: 'openai-key', value: OPENAI_KEY, secret: OPENAI_KEY, patterns: null },
  // Names outside the form.
  {
    name: '33-characters',
    value: `a${'b'.repeat(32)}`,
    secret: `a${'b'.repeat(32)}`,
    patterns: null,
  },
  { name: 'space', value: 'impl 1', secret: 'impl 1', patterns: null },
  { name: 'slash', value: 'claude/opus', secret: 'claude/opus', patterns: null },
  { name: 'leading-hyphen', value: '-impl', secret: '-impl', patterns: null },
  { name: 'leading-dot', value: '.impl', secret: '.impl', patterns: null },
  { name: 'leading-underscore', value: '_impl', secret: '_impl', patterns: null },
  { name: 'leading-at', value: '@impl', secret: '@impl', patterns: null },
  { name: 'non-ascii-letter', value: NON_ASCII, secret: NON_ASCII, patterns: null },
  // A long s folds to s under Unicode case-insensitive matching.
  { name: 'long-s', value: LONG_S, secret: LONG_S, patterns: null },
  // A fullwidth i normalises (NFKC) to i.
  { name: 'fullwidth-letter', value: FULLWIDTH, secret: FULLWIDTH, patterns: null },
  // A Kelvin sign folds to k.
  { name: 'kelvin-sign', value: KELVIN, secret: KELVIN, patterns: null },
  { name: 'esc', value: 'impl\u001b[31m', secret: 'impl\u001b[31m', patterns: null },
  { name: 'trailing-newline', value: 'orch-7\n', secret: 'orch-7\n', patterns: null },
  { name: 'tab', value: 'impl\t1', secret: 'impl\t1', patterns: null },
  { name: 'colon', value: 'ben:secret', secret: 'ben:secret', patterns: null },
  { name: 'equals', value: 'actor=impl', secret: 'actor=impl', patterns: null },
  { name: 'plus', value: 'ben+impl', secret: 'ben+impl', patterns: null },
  { name: 'quote', value: "o'brien", secret: "o'brien", patterns: null },
  { name: 'shell', value: '$(id)', secret: '$(id)', patterns: null },
];

/** Every refused name, the pattern table first. */
export const ACTORS_REFUSED: readonly RefusedActor[] = [
  ...ACTORS_REFUSED_BY_PATTERN,
  ...ACTORS_REFUSED_BY_FORM,
];

/**
 * Every distinct actor name on this repository's own board (every event's
 * `actor`, every hand-off's `to`), collected from its event files on
 * 2026-10-31: all lowercase letters, digits and `-`, the longest 15
 * characters (`implementer-dm2`).
 */
export const BOARD_ACTORS: readonly string[] = [
  'flake-fixer',
  'implementer-1',
  'implementer-2',
  'implementer-3',
  'implementer-4',
  'implementer-5',
  'implementer-6',
  'implementer-8',
  'implementer-a1',
  'implementer-a2',
  'implementer-a3',
  'implementer-a4',
  'implementer-a5',
  'implementer-a6',
  'implementer-dm',
  'implementer-dm2',
  'implementer-gst',
  'implementer-kc',
  'implementer-ne1',
  'implementer-ne2',
  'orchestrator',
  'proposer',
  'reviewer-1',
  'reviewer-2',
  'reviewer-3',
  'reviewer-3-1',
  'reviewer-3-2',
  'reviewer-3b',
  'reviewer-4',
  'reviewer-4-1',
  'reviewer-4-2',
  'reviewer-5',
  'reviewer-5-1',
  'reviewer-5-2',
  'reviewer-5b',
  'reviewer-6',
  'reviewer-7',
  'reviewer-a1',
  'reviewer-a1b',
  'reviewer-a2',
  'reviewer-a3',
  'reviewer-a4',
  'reviewer-a5',
  'reviewer-a6',
  'reviewer-dm-1',
  'reviewer-dm-2',
  'reviewer-dm2',
  'reviewer-gst-1',
  'reviewer-gst-2',
  'reviewer-kc-1',
  'reviewer-kc-2',
  'reviewer-ne1-1',
  'reviewer-ne1-2',
  'reviewer-ne2-1',
  'reviewer-ne2-2',
  'site-writer',
  'test-author-1',
  'test-author-2',
  'test-author-3',
  'test-author-4',
  'test-author-5',
  'test-author-6',
  'test-author-8',
  'test-author-a1',
  'test-author-a2',
  'test-author-a3',
  'test-author-a4',
  'test-author-a5',
  'test-author-a6',
  'test-author-dm',
  'test-author-dm2',
  'test-author-gst',
  'test-author-kc',
  'test-author-ne1',
  'test-author-ne2',
  'writer-7',
  'writer-gst',
];

/** Every actor example of the docs, the guide, the help and README (design.md). */
export const DOC_ACTORS: readonly string[] = [
  'orch',
  'orchestrator',
  'impl',
  'impl-1',
  'impl-2',
  'reviewer',
  'reviewer-1',
  'reviewer-3-2',
  'merger-1',
  'merger-2',
  'merger-3',
  'merger-4',
  'releaser-1',
  'test-1',
  'ben',
  'a',
  'x',
];

/**
 * Accepted names beyond the board and the docs: other styles of the form
 * (board-cli scenario "Existing actor styles are accepted"), its bounds,
 * and the residual risk of design.md (secret-shaped strings of at most 32
 * characters of the form that match no pattern are accepted: the 26- and
 * 16-character base32 fixtures and 32 hex characters). `agentboard` passes
 * the check (and is then refused as the reserved actor, reason `usage`).
 */
export const ACTORS_ACCEPTED_OTHER: readonly string[] = [
  'test-author-ac1',
  'test-author-ne2',
  'implementer-dm2',
  '0',
  'Ben',
  'ben.dechrai',
  'test_author',
  'ben@laptop',
  'ben@example.com',
  'A_B@c.d-e',
  'impl-',
  'impl.',
  `a${'b'.repeat(31)}`,
  `0${'z'.repeat(31)}`,
  CROCKFORD_26,
  CROCKFORD_26_SEVEN,
  TOTP_SEED,
  HEX_32,
  'agentboard',
];

/** Every accepted name: the board's, the docs' and the others, without duplicates. */
export const ACTORS_ACCEPTED: readonly string[] = [
  ...new Set([...BOARD_ACTORS, ...DOC_ACTORS, ...ACTORS_ACCEPTED_OTHER]),
];

/** The exact message of an actor refused by the patterns `names`, from `source`. */
export function actorPatternMessage(source: string, names: string): string {
  return `refused: the actor name given with ${source} matches the secret pattern(s) ${names}; an actor name is recorded on every event and shared with the board, so choose another name (--allow-secret-like does not apply to actor names)`;
}

/** The exact message of an actor refused for the form, from `source`. */
export function actorFormMessage(source: string): string {
  return `refused: the actor name given with ${source} is not of the actor form: 1 to 32 ASCII letters, digits, dots, underscores, hyphens or @ signs, the first a letter or digit, such as impl-1`;
}

/** The exact refusal message `refused` must get from `source`. */
export function actorMessage(source: string, refused: RefusedActor): string {
  return refused.patterns === null
    ? actorFormMessage(source)
    : actorPatternMessage(source, refused.patterns);
}
