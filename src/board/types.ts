/**
 * Shared result and option types of the board operations (design.md:
 * "Library first, CLI second"). Every operation in `src/board/` takes a
 * `Board` handle (see `openBoard`) and returns a plain result object; the
 * CLI and, later, the MCP server only parse arguments and render results.
 *
 * Failures are always thrown as `BoardError` (see `src/store/errors.ts`),
 * with the exit code class and reason token documented on each operation.
 */

import type { Ticket } from '../events/fold.js';
import type { CommandOptions } from '../store/transaction.js';

/**
 * Options every writing operation passes through to `runCommand` (clock,
 * crash-injection hooks, environment for `AGENTBOARD_TEST_PAUSE`).
 */
export type WriteOptions = CommandOptions;

/**
 * Result of a writing operation, and the `--json` document of every
 * writing command (board-cli: "Output conventions": "for writing commands
 * an object containing the event hash and the resulting ticket").
 *
 * - `hash`: the hash (file name without `.json`) of the event written, or
 *   `null` when the operation succeeded without writing an event (the only
 *   such case in this group is a `claim` retried by the actor that already
 *   holds the ticket).
 * - `ticket`: the ticket after the operation, exactly as `readTicket`
 *   returns it (the folded `Ticket`, timestamps as `Hlc` objects).
 */
export interface WriteOutcome {
  hash: string | null;
  ticket: Ticket;
}
