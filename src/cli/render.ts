/**
 * Human output (board-cli: "Output conventions"): plain ASCII, one line
 * per ticket in `list`, a full record in `show`.
 */

import type { Ticket } from '../events/fold.js';
import type { ShowResult } from '../board/tickets.js';
import { notImplemented } from '../board/stub.js';

/** Length of the id prefix shown by `list`. */
export const LIST_ID_PREFIX = 10;

/**
 * Makes user text safe for plain ASCII output: every character outside
 * printable ASCII (below 0x20, 0x7F and above) is written as `\uXXXX` with
 * four upper-case hex digits of its UTF-16 code unit (a character outside
 * the BMP becomes two escapes), and a backslash is written as `\\`, so the
 * output is unambiguous and one line. Pure.
 */
export function asciiText(text: string): string {
  throw notImplemented(text);
}

/**
 * The `list` line of a ticket, without a newline:
 * `<first LIST_ID_PREFIX characters of id>  <status>  <assignee or ->  <markers><title>`,
 * fields separated by two spaces, where `<markers>` is `[adhoc] ` for a
 * ticket with an ad hoc reason and `[closed] ` for a closed ticket (in
 * that order when both apply), and assignee and title pass through
 * `asciiText`. Example: `01ARYZ6S41  todo  -  [adhoc] Fix thing`. Pure.
 */
export function renderListLine(ticket: Ticket): string {
  throw notImplemented(ticket);
}

/**
 * The `show` record, one `<label>: <value>` per line, ending with a
 * newline, user text through `asciiText`:
 *
 * ```
 * id: <full id>
 * title: <title>
 * status: <status>                  (blocked: `blocked (from <origin>)`)
 * assignee: <assignee or ->
 * task: <source>:<ref>#<item>       (or `adhoc: <reason>`, or `task: -`)
 * labels: <comma+space separated, or ->
 * description: <text or ->
 * checklist:                        (then per line `  [x] <index> <text>` or `  [ ] ...`)
 * links:                            (then per link `  pr <n or url>` or `  decision <path>`)
 * comments:                         (then per comment, in order, `  <actor>: <text>`)
 * closed: no                        (or `yes (decision: <path>)` or `yes (no decision)`)
 * events: <n>
 * unknown: <kind> <hash>            (one line per unknown-kind event, when any)
 * ```
 *
 * Pure.
 */
export function renderShow(show: ShowResult): string {
  throw notImplemented(show);
}
