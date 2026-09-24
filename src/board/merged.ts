/**
 * `close-merged`: closes the `merged` tickets whose pull request has been
 * merged (board-openspec-integration: "Close merged", "Decisions are
 * promoted, not buried"; design.md Open Questions: `gh` is required, a
 * `gh`-less fallback is deferred).
 *
 * The PR merge state comes from the GitHub CLI through a `GhRunner`, which
 * is injectable so that tests never run the real `gh`: library tests pass
 * a fake runner, and CLI tests put a fake `gh` script first on the `PATH`
 * of the environment they pass (the default runner looks `gh` up on
 * `env.PATH`, never on the test process's own `PATH`).
 */

import type { CloseDisposition, Ticket } from '../events/fold.js';
import type { Board } from '../store/board.js';
import type { Env } from './text.js';
import type { WriteOptions } from './types.js';

/** What running `gh` produced. */
export type GhResult =
  /** No `gh` executable was found (the spawn failed with ENOENT). */
  | { status: 'missing' }
  /** `gh` ran and exited (`code` is its exit status; a signal counts as 1). */
  | { status: 'exited'; code: number; stdout: string; stderr: string };

/** Runs `gh <args>` in `cwd` with `env`. Must not throw for a missing `gh`. */
export type GhRunner = (
  args: readonly string[],
  where: { cwd: string; env: Env },
) => GhResult;

/**
 * The default `GhRunner`: spawns `gh` synchronously (no shell) with `args`,
 * in `cwd`, with exactly `env` as its environment, so the executable is
 * looked up on `env.PATH`. Captures stdout and stderr as UTF-8 and a
 * timeout of 30 seconds (a timeout counts as `exited` with code 1).
 * Returns `{ status: 'missing' }` when the executable is not found; any
 * other spawn error propagates.
 */
export function runGh(args: readonly string[], where: { cwd: string; env: Env }): GhResult {
  void args;
  void where;
  throw new Error('not implemented');
}

/** The arguments `closeMerged` passes to `gh` for PR `pr`: `pr view <pr> --json state`. */
export function ghPrViewArgs(pr: string | number): string[] {
  void pr;
  throw new Error('not implemented');
}

/** Input of `closeMerged`. */
export interface CloseMergedInput {
  /**
   * Directory the command runs in: `gh` runs there (so a bare PR number
   * resolves against the repository checked out there), and a decision
   * link path is checked for existence against its working tree root (the
   * root `treePath` uses). Defaults to `process.cwd()`.
   */
  cwd?: string | undefined;
  /** Environment for `gh` and `git`. Defaults to `process.env`. */
  env?: Env | undefined;
  /** Runs `gh`. Defaults to `runGh`. */
  gh?: GhRunner | undefined;
}

/** A ticket `close-merged` closed. */
export interface ClosedByMerge {
  id: string;
  /** The PR link that was queried. */
  pr: string | number;
  /** The disposition written: the decision link's path, or no-decision. */
  disposition: CloseDisposition;
  /** Hash of the `ticket.close` event. */
  hash: string;
  /** The ticket after the close. */
  ticket: Ticket;
}

/** A candidate whose PR is not merged; left untouched. */
export interface NotMerged {
  id: string;
  pr: string | number;
  /** The PR state `gh` reported, as given (e.g. `OPEN`, `CLOSED`). */
  state: string;
  ticket: Ticket;
}

/** Why a candidate with a merged (or unknown) PR was left open. */
export type SkipReason = 'unpromoted-decision' | 'decision-path-missing' | 'gh-error';

/** A candidate left open for a reason other than an unmerged PR. */
export interface SkippedByMerge {
  id: string;
  pr: string | number;
  reason: SkipReason;
  /**
   * One ASCII line or more. For `unpromoted-decision`, the message
   * `closeTicket` gives (quoting each open `DECISION:` comment and the
   * rule); for `decision-path-missing`, naming the path; for `gh-error`,
   * the `gh` exit code and the first line of its stderr, or that its
   * output was not the expected JSON.
   */
  message: string;
  ticket: Ticket;
}

/** Result of `closeMerged`; also the `close-merged --json` document. */
export interface CloseMergedResult {
  /** Each list is in ascending ticket id order. */
  closed: ClosedByMerge[];
  unmerged: NotMerged[];
  skipped: SkippedByMerge[];
}

/**
 * `close-merged`.
 *
 * Candidates: every ticket that is not closed, is in status `merged`, and
 * has at least one `pr` link. Tickets in any other status (including
 * `blocked`) and tickets with no `pr` link are not looked at. When a
 * ticket has several `pr` links, the last one in fold order is the PR.
 *
 * With no candidates, returns three empty lists without running `gh` (so
 * a machine without `gh` can run it harmlessly).
 *
 * For each candidate, in ascending id order, runs
 * `gh(ghPrViewArgs(pr), { cwd, env })`:
 * - `missing` (on the first candidate, before anything is written):
 *   `BoardError(1, 'gh-missing')` saying the GitHub CLI `gh` is required
 *   by close-merged and was not found on PATH. Nothing is written.
 * - `exited` with a non-zero code, or stdout that is not a JSON object
 *   with a string `state`: skipped with reason `gh-error`; the remaining
 *   candidates are still processed and the command still succeeds.
 * - `state` other than `MERGED`: listed in `unmerged` with that state,
 *   nothing written.
 * - `MERGED`, and the ticket has a `decision` link: closed through
 *   `closeTicket` with the last decision link's path, which is recorded
 *   root-relative already, so the close records that same path. The file
 *   must exist relative to the working tree root of `cwd`; when it does
 *   not, skipped with reason `decision-path-missing`. The `DECISION:`
 *   guard does not apply to a close that names a decision record.
 * - `MERGED` and no `decision` link: closed with no-decision, unless the
 *   ticket has open `DECISION:` comments (`openDecisions`), in which case
 *   it is skipped with reason `unpromoted-decision` and the guard's
 *   message, and left open.
 * Each close is its own command transaction (`runCommand` through
 * `closeTicket`) with `actor` and `options`.
 *
 * @throws BoardError exit 1 `missing-actor` when `actor` is empty.
 * @throws BoardError exit 1 `gh-missing` as above.
 */
export function closeMerged(
  board: Board,
  actor: string,
  input?: CloseMergedInput,
  options?: WriteOptions,
): CloseMergedResult {
  void board;
  void actor;
  void input;
  void options;
  throw new Error('not implemented');
}
