/**
 * `close-merged`: closes the `merged` tickets whose pull request has been
 * merged (board-openspec-integration: "Close merged", "Decisions are
 * promoted, not buried"). The GitHub CLI `gh` is required; there is no
 * `gh`-less fallback.
 *
 * The PR merge state comes from the GitHub CLI through a `GhRunner`, which
 * is injectable so that tests never run the real `gh`: library tests pass
 * a fake runner, and CLI tests put a fake `gh` script first on the `PATH`
 * of the environment they pass (the default runner looks `gh` up on
 * `env.PATH`, never on the test process's own `PATH`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CloseDisposition, Ticket, TicketLink } from '../events/fold.js';
import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { closeTicket } from './actions.js';
import { requireActor } from './lookup.js';
import { listTickets } from './tickets.js';
import { asciiText, type Env } from './text.js';
import type { WriteOptions, WriteOutcome } from './types.js';

/** What running `gh` produced. */
export type GhResult =
  /** No `gh` executable was found (the spawn failed with ENOENT). */
  | { status: 'missing' }
  /** `gh` ran and exited (`code` is its exit status; a signal counts as 1). */
  | { status: 'exited'; code: number; stdout: string; stderr: string };

/** Runs `gh <args>` in `cwd` with `env`. Must not throw for a missing `gh`. */
export type GhRunner = (args: readonly string[], where: { cwd: string; env: Env }) => GhResult;

/**
 * The default `GhRunner`: spawns `gh` synchronously (no shell) with `args`,
 * in `cwd`, with exactly `env` as its environment, so the executable is
 * looked up on `env.PATH`. Captures stdout and stderr as UTF-8 and a
 * timeout of 30 seconds (a timeout counts as `exited` with code 1).
 * Returns `{ status: 'missing' }` when the executable is not found; any
 * other spawn error propagates.
 */
export function runGh(args: readonly string[], where: { cwd: string; env: Env }): GhResult {
  const result = spawnSync('gh', args, {
    cwd: where.cwd,
    env: { ...where.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_TIMEOUT_MS,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === 'ENOENT') {
    return { status: 'missing' };
  }
  if (error !== undefined && error.code !== 'ETIMEDOUT') {
    throw error;
  }
  const stderr = error === undefined ? result.stderr : `gh timed out after 30 seconds\n`;
  return {
    status: 'exited',
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr,
  };
}

/** How long `runGh` lets `gh` run. */
const GH_TIMEOUT_MS = 30_000;

/** The arguments `closeMerged` passes to `gh` for PR `pr`: `pr view <pr> --json state`. */
export function ghPrViewArgs(pr: string | number): string[] {
  return ['pr', 'view', String(pr), '--json', 'state'];
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

/**
 * Why a candidate with a merged (or unknown) PR was left open: `gh-error`,
 * `decision-path-missing`, or the `reason` of the `BoardError` (exit 1 or
 * 4) that closing the ticket threw, such as `unpromoted-decision`,
 * `path-outside-tree` or `invalid-transition` (the ticket was closed by
 * someone else between listing and closing). Open-ended by design, so a new
 * refusal of `closeTicket` is listed rather than aborting the run.
 */
export type SkipReason = string;

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
   * output was not the expected JSON; for any other reason, the message of
   * the `BoardError` closing threw.
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
 * `closeTicket`) with `actor` and `options`, run against the state at that
 * moment, which may differ from the listing (another process may have
 * closed the ticket or commented on it since).
 *
 * Any `BoardError` with exit code 1 or 4 thrown while closing one ticket
 * (for example `unpromoted-decision`, `path-outside-tree` for a decision
 * path that now resolves outside the working tree, or `invalid-transition`
 * for a ticket closed concurrently) leaves that ticket open and lists it in
 * `skipped` with the error's reason and message and the ticket as listed;
 * the remaining candidates are still processed and the command succeeds.
 * A `BoardError` with exit code 2 or 5 (board or integrity problems, a
 * busy cache) and any other error propagate and end the run; closes
 * already written stay written.
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
  requireActor(actor);
  const cwd = input?.cwd ?? process.cwd();
  const env = input?.env ?? process.env;
  const gh = input?.gh ?? runGh;
  const result: CloseMergedResult = { closed: [], unmerged: [], skipped: [] };
  const candidates = listTickets(board, { status: 'merged' }).flatMap((ticket) => {
    const pr = lastLink(ticket, 'pr');
    return pr === undefined ? [] : [{ ticket, pr: pr.pr }];
  });
  let root: string | null = null;
  for (const { ticket, pr } of candidates) {
    const answer = gh(ghPrViewArgs(pr), { cwd, env });
    if (answer.status === 'missing') {
      throw new BoardError(
        1,
        'gh-missing',
        'close-merged requires the GitHub CLI gh, which was not found on PATH',
      );
    }
    const state = prState(answer);
    if (typeof state !== 'string') {
      result.skipped.push({ id: ticket.id, pr, reason: 'gh-error', message: state.error, ticket });
      continue;
    }
    if (state !== 'MERGED') {
      result.unmerged.push({ id: ticket.id, pr, state, ticket });
      continue;
    }
    const decision = lastLink(ticket, 'decision');
    try {
      let outcome: WriteOutcome;
      if (decision === undefined) {
        outcome = closeTicket(board, actor, { id: ticket.id, noDecision: true }, options);
      } else {
        root ??= treeRoot(cwd, env);
        const absolute = join(root, ...decision.path.split('/'));
        if (!existsSync(absolute)) {
          result.skipped.push({
            id: ticket.id,
            pr,
            reason: 'decision-path-missing',
            message: `the decision record ${asciiText(decision.path)} does not exist`,
            ticket,
          });
          continue;
        }
        outcome = closeTicket(
          board,
          actor,
          { id: ticket.id, decisionRecordedIn: absolute, cwd: root, env },
          options,
        );
      }
      const closed = outcome.ticket;
      result.closed.push({
        id: ticket.id,
        pr,
        disposition: closed.disposition ?? { noDecision: true },
        hash: outcome.hash ?? '',
        ticket: closed,
      });
    } catch (error) {
      // A refusal of this one ticket (exit 1 or 4) is listed and the run
      // continues; board, integrity and unexpected errors end it.
      if (!(error instanceof BoardError) || (error.exitCode !== 1 && error.exitCode !== 4)) {
        throw error;
      }
      result.skipped.push({
        id: ticket.id,
        pr,
        reason: error.reason ?? 'close-refused',
        message: error.message,
        ticket,
      });
    }
  }
  return result;
}

/** The last link of `type` on `ticket` in fold order, or undefined. */
function lastLink<T extends TicketLink['type']>(
  ticket: Ticket,
  type: T,
): Extract<TicketLink, { type: T }> | undefined {
  return ticket.links.filter((l): l is Extract<TicketLink, { type: T }> => l.type === type).at(-1);
}

/** The PR state `gh` reported, or an error message for a `gh-error` skip. */
function prState(answer: Extract<GhResult, { status: 'exited' }>): string | { error: string } {
  if (answer.code !== 0) {
    const first = answer.stderr.split('\n')[0]?.trim() ?? '';
    return {
      error: `gh exited with code ${String(answer.code)}${
        first === '' ? '' : `: ${asciiText(first)}`
      }`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.stdout);
  } catch {
    parsed = null;
  }
  const state =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).state
      : undefined;
  return typeof state === 'string'
    ? state
    : { error: 'gh output was not the expected JSON object with a string state' };
}

/** The working tree root of `cwd` (`git rev-parse --show-toplevel`), or `cwd` when there is none. */
function treeRoot(cwd: string, env: Env): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      env: { ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/, '');
    return out === '' ? cwd : out;
  } catch {
    return cwd;
  }
}
