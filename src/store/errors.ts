/**
 * The error type of the store layer, carrying the process exit code class a
 * CLI or MCP surface maps it to (board-cli: "Exit codes").
 */

/**
 * Exit code classes (board-cli: "Exit codes"):
 * - 0: success (never carried by a `BoardError`).
 * - 1: usage error or missing actor (for example an empty actor, or a
 *   proposed event that fails `validateEvent`).
 * - 2: board not found or unreadable.
 * - 3: conflict during sync that needs a human.
 * - 4: action rejected by board state (invalid transition, already assigned,
 *   not assignee, unknown ticket, and every other fold rejection reason).
 * - 5: event log integrity problem where the command needed the data.
 */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Every failure the store layer reports deliberately is a `BoardError`.
 *
 * - `exitCode`: the class above; never 0.
 * - `reason`: a stable machine-readable token where one exists, otherwise
 *   null. For exit 4 it is the fold rejection reason (`invalid-transition`,
 *   `already-assigned`, `not-assignee`, `unknown-ticket`, `duplicate-create`,
 *   `checklist-index`, `needs-task-link`) or the reason chosen by the
 *   operation that refused; for exit 2 it is `board-not-found`; for exit 1
 *   from the transaction it is `missing-actor` or `malformed-event`.
 * - `message`: human-readable, plain ASCII.
 *
 * Unexpected failures (IO errors, SQLite errors other than the documented
 * cases) are not wrapped and propagate as they are.
 */
export class BoardError extends Error {
  readonly exitCode: Exclude<ExitCode, 0>;
  readonly reason: string | null;

  constructor(exitCode: Exclude<ExitCode, 0>, reason: string | null, message: string) {
    super(message);
    this.name = 'BoardError';
    this.exitCode = exitCode;
    this.reason = reason;
  }
}
