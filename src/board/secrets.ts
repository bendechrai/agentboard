/**
 * Secret-looking text refusal (board-cli: "No secrets on the board";
 * add-board-core design.md: "Secret refusal"). A guard rail, not a scanner.
 */

import { BoardError } from '../store/errors.js';

/**
 * Names of the secret patterns, in the order they are checked and
 * reported (board-cli "No secrets on the board"; secret-prefix-patterns
 * design.md "The patterns"): the three original provider patterns, the
 * other provider patterns alphabetically, then the catch-all.
 *
 * - `pem-private-key`: `-----BEGIN ` then any run of upper-case ASCII
 *   letters, digits and spaces ending in `PRIVATE KEY`, optionally
 *   followed by ` BLOCK`, then `-----` (PEM private key headers such as
 *   `-----BEGIN PRIVATE KEY-----`, `-----BEGIN RSA PRIVATE KEY-----` and
 *   `-----BEGIN OPENSSH PRIVATE KEY-----`, and the PGP private key block
 *   header `-----BEGIN PGP PRIVATE KEY BLOCK-----`).
 * - `aws-access-key-id`: `AKIA` or `ASIA` followed by exactly 16
 *   characters of `[0-9A-Z]`, not preceded or followed by another
 *   ASCII letter or digit.
 * - `github-token`: a classic token `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_`
 *   followed by at least 36 characters of `[A-Za-z0-9]`, or a fine-grained
 *   token `github_pat_` followed by at least 22 characters of
 *   `[A-Za-z0-9_]`.
 * - `anthropic-api-key`: `sk-ant-` followed by at least 16 characters of
 *   `[A-Za-z0-9_-]`.
 * - `digitalocean-token`: `dop_v1_`, `doo_v1_` or `dor_v1_` followed by at
 *   least 16 characters of `[a-f0-9]`.
 * - `docker-token`: `dckr_pat_` or `dckr_oat_` followed by at least 16
 *   characters of `[A-Za-z0-9_-]`.
 * - `gitlab-token`: `glpat-` followed by at least 16 characters of
 *   `[A-Za-z0-9_-]`.
 * - `google-api-key`: `AIza` followed by at least 32 characters of
 *   `[A-Za-z0-9_-]`.
 * - `huggingface-token`: `hf_` followed by at least 32 characters of
 *   `[A-Za-z0-9]`.
 * - `jwt`: `eyJ` and at least 8 characters of `[A-Za-z0-9_-]`, a `.`,
 *   `eyJ` and at least 8 characters of `[A-Za-z0-9_-]`, a `.`, then at
 *   least 16 characters of `[A-Za-z0-9_-]`.
 * - `npm-token`: `npm_` followed by at least 32 characters of
 *   `[A-Za-z0-9]`.
 * - `openai-api-key`: `sk-proj-`, `sk-svcacct-` or `sk-admin-` followed by
 *   at least 16 characters of `[A-Za-z0-9_-]`, or `sk-` followed by at
 *   least 32 characters of `[A-Za-z0-9]` (so `sk-ant-` keys, and
 *   hyphenated words, never match it).
 * - `pypi-token`: `pypi-AgEIcHlwaS5vcmc` followed by at least 16
 *   characters of `[A-Za-z0-9_-]`.
 * - `sendgrid-api-key`: `SG.`, at least 16 characters of `[A-Za-z0-9_-]`,
 *   a `.`, then at least 16 characters of `[A-Za-z0-9_-]`.
 * - `shopify-token`: `shpat_`, `shpca_`, `shppa_` or `shpss_` followed by
 *   at least 16 characters of `[A-Fa-f0-9]`.
 * - `slack-token`: `xoxa-`, `xoxb-`, `xoxe-`, `xoxp-`, `xoxr-`, `xoxs-` or
 *   `xapp-`, one or more ASCII digits, a `-`, then at least 16 characters
 *   of `[A-Za-z0-9-]`.
 * - `stripe-secret-key`: `sk_live_`, `sk_test_`, `rk_live_` or `rk_test_`
 *   followed by at least 16 characters of `[A-Za-z0-9]`. Publishable keys
 *   (`pk_live_`, `pk_test_`) are public and match no pattern.
 * - `stripe-webhook-secret`: `whsec_` followed by at least 16 characters
 *   of `[A-Za-z0-9]`.
 * - `generic-secret-assignment`: one of the words `token`, `secret`,
 *   `password` or `key` (ASCII case-insensitive, possibly the end of a
 *   longer identifier such as `api_key` or `GITHUB_TOKEN`), then optional
 *   spaces, a separator `:` or `=`, optional spaces, an optional `"` or
 *   `'`, then 32 or more consecutive base64 or base64url characters
 *   (`[A-Za-z0-9+/_-]`, optionally followed by `=` padding).
 *
 * Every pattern from `anthropic-api-key` to `stripe-webhook-secret`
 * matches only where its first character is not preceded by an ASCII
 * letter or digit (a preceding `_`, `-`, `.`, `=`, `:`, quote, space or the
 * start of the text is allowed), and is case-sensitive. Each "at least" is
 * a minimum with no maximum: a longer run, or a run followed by other
 * text, still matches. Twilio account and API key SIDs and unprefixed
 * secrets match no provider pattern.
 */
export const SECRET_PATTERN_NAMES = [
  'pem-private-key',
  'aws-access-key-id',
  'github-token',
  'anthropic-api-key',
  'digitalocean-token',
  'docker-token',
  'gitlab-token',
  'google-api-key',
  'huggingface-token',
  'jwt',
  'npm-token',
  'openai-api-key',
  'pypi-token',
  'sendgrid-api-key',
  'shopify-token',
  'slack-token',
  'stripe-secret-key',
  'stripe-webhook-secret',
  'generic-secret-assignment',
] as const;

/** The name of one secret pattern. */
export type SecretPatternName = (typeof SECRET_PATTERN_NAMES)[number];

/**
 * The names of every pattern `text` matches, in `SECRET_PATTERN_NAMES`
 * order, each at most once; empty when none match. Never returns or logs
 * the matched text. Pure.
 */
export function secretPatternsIn(text: string): SecretPatternName[] {
  return SECRET_PATTERN_NAMES.filter((name) => PATTERNS[name].test(text));
}

/**
 * The actor form (board-cli "Actor names are checked"): 1 to 32 ASCII
 * letters, digits, `.`, `_`, `-` or `@`, the first a letter or digit. No
 * `i` or `u` flag and no `m` flag: ASCII only, no case folding, and `^`
 * and `$` are the ends of the whole string, so a trailing newline fails.
 */
export const ACTOR_FORM = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$/;

/**
 * The predicate of the actor check (`checkActorName`, `src/cli/parse.ts`,
 * which refuses with the messages; board-cli "Actor names are checked"):
 * true when `name` matches no secret pattern (`secretPatternsIn`) and has
 * the actor form (`ACTOR_FORM`). The empty string fails. Shared with
 * `agentboard hook`, which treats a name that fails as no actor instead
 * of refusing (board-harness-hooks "Hook actor resolution"). Pure.
 */
export function isActorName(name: string): boolean {
  return secretPatternsIn(name).length === 0 && ACTOR_FORM.test(name);
}

/**
 * Matches no text: the stub expression of each provider pattern added by
 * secret-prefix-patterns until task 1.1 replaces it with the expression
 * documented on `SECRET_PATTERN_NAMES`.
 */
const NOT_IMPLEMENTED = /(?!)/;

/** The expression of each pattern, as documented on `SECRET_PATTERN_NAMES`. */
const PATTERNS: Record<SecretPatternName, RegExp> = {
  'pem-private-key': /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  'aws-access-key-id': /(?<![0-9A-Za-z])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])/,
  'github-token': /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22}/,
  'anthropic-api-key': NOT_IMPLEMENTED,
  'digitalocean-token': NOT_IMPLEMENTED,
  'docker-token': NOT_IMPLEMENTED,
  'gitlab-token': NOT_IMPLEMENTED,
  'google-api-key': NOT_IMPLEMENTED,
  'huggingface-token': NOT_IMPLEMENTED,
  jwt: NOT_IMPLEMENTED,
  'npm-token': NOT_IMPLEMENTED,
  'openai-api-key': NOT_IMPLEMENTED,
  'pypi-token': NOT_IMPLEMENTED,
  'sendgrid-api-key': NOT_IMPLEMENTED,
  'shopify-token': NOT_IMPLEMENTED,
  'slack-token': NOT_IMPLEMENTED,
  'stripe-secret-key': NOT_IMPLEMENTED,
  'stripe-webhook-secret': NOT_IMPLEMENTED,
  'generic-secret-assignment': /(?:token|secret|password|key) *[:=] *["']?[A-Za-z0-9+/_-]{32}/i,
};

/**
 * Refuses secret-looking free text before an event is written.
 *
 * Checks every string of `texts` with `secretPatternsIn`. When
 * `allowSecretLike` is true, or nothing matches, returns normally.
 * Otherwise throws `BoardError(1, 'secret-like', message)`, where the
 * message names every matching pattern name and says the board is not a
 * secret store. When `bypassFlag` is true (the default: the calling
 * command has `--allow-secret-like`) the message is exactly
 * `refused: the text matches the secret pattern(s) <names>; the board is
 * not a secret store (pass --allow-secret-like if this is not a secret)`;
 * when false (the command has no such flag, e.g. `import-change`) it is the
 * same without the parenthesised hint:
 * `refused: the text matches the secret pattern(s) <names>; the board is
 * not a secret store`. `<names>` is the matching pattern names in
 * `SECRET_PATTERN_NAMES` order, joined with `, `. The message never
 * contains any part of the matched text (nor of the text checked).
 *
 * Used by `newTicket` (title, description, labels, checklist lines and ad
 * hoc reason), `commentTicket` (text) and `handoffTicket` (note), all with
 * a bypass flag, and by `importChange` (unit titles and task lines) with
 * `allowSecretLike` false and `bypassFlag` false.
 */
export function refuseSecretLike(
  texts: readonly string[],
  allowSecretLike: boolean,
  bypassFlag = true,
): void {
  if (allowSecretLike) {
    return;
  }
  const found = new Set<SecretPatternName>();
  for (const text of texts) {
    for (const name of secretPatternsIn(text)) {
      found.add(name);
    }
  }
  if (found.size === 0) {
    return;
  }
  const names = SECRET_PATTERN_NAMES.filter((name) => found.has(name)).join(', ');
  throw new BoardError(
    1,
    'secret-like',
    `refused: the text matches the secret pattern(s) ${names}; the board is not a secret store` +
      (bypassFlag ? ' (pass --allow-secret-like if this is not a secret)' : ''),
  );
}
