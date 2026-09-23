/**
 * Secret-looking text refusal (board-cli: "No secrets on the board";
 * design.md: "Secret refusal"). A guard rail, not a scanner.
 */

import { notImplemented } from './stub.js';

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
  throw notImplemented(text);
}

/**
 * Refuses secret-looking free text before an event is written.
 *
 * Checks every string of `texts` with `secretPatternsIn`. When
 * `allowSecretLike` is true, or nothing matches, returns normally.
 * Otherwise throws `BoardError(1, 'secret-like', message)`, where the
 * message names every matching pattern name, says the board is not a
 * secret store, and names `--allow-secret-like` as the bypass. The message
 * never contains any part of the matched text (nor of the text checked).
 *
 * Used by `newTicket` (title, description, labels, checklist lines and ad
 * hoc reason), `commentTicket` (text) and `handoffTicket` (note).
 */
export function refuseSecretLike(texts: readonly string[], allowSecretLike: boolean): void {
  throw notImplemented(texts, allowSecretLike);
}
