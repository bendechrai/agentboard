/**
 * Secret-looking text refusal (board-cli: "No secrets on the board";
 * design.md: "Secret refusal"). A guard rail, not a scanner.
 */

import { BoardError } from '../store/errors.js';

/**
 * Names of the secret patterns, in the order they are checked and
 * reported:
 *
 * - `pem-private-key`: a PEM private key header, `-----BEGIN ` then any
 *   run of upper-case letters, digits and spaces ending in `PRIVATE KEY`,
 *   then `-----` (for example `-----BEGIN PRIVATE KEY-----`,
 *   `-----BEGIN RSA PRIVATE KEY-----`, `-----BEGIN OPENSSH PRIVATE
 *   KEY-----`).
 * - `aws-access-key-id`: `AKIA` or `ASIA` followed by exactly 16
 *   characters of `[0-9A-Z]`, not preceded or followed by another
 *   `[0-9A-Za-z]` character.
 * - `github-token`: a classic token `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_`
 *   followed by at least 36 characters of `[A-Za-z0-9]`, or a fine-grained
 *   token `github_pat_` followed by at least 22 characters of
 *   `[A-Za-z0-9_]`.
 * - `generic-secret-assignment`: one of the words `token`, `secret`,
 *   `password` or `key` (case-insensitive, possibly the end of a longer
 *   identifier such as `api_key` or `GITHUB_TOKEN`), then optional spaces, a
 *   separator `:` or `=`, optional spaces, an optional `"` or `'`, then 32 or
 *   more consecutive base64 or base64url characters (`[A-Za-z0-9+/_-]`,
 *   optionally followed by `=` padding).
 */
export const SECRET_PATTERN_NAMES = [
  'pem-private-key',
  'aws-access-key-id',
  'github-token',
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

/** The expression of each pattern, as documented on `SECRET_PATTERN_NAMES`. */
const PATTERNS: Record<SecretPatternName, RegExp> = {
  'pem-private-key': /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  'aws-access-key-id': /(?<![0-9A-Za-z])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])/,
  'github-token': /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22}/,
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
  void bypassFlag;
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
    `refused: the text matches the secret pattern(s) ${names}; the board is not a secret ` +
      'store (pass --allow-secret-like if this is not a secret)',
  );
}
