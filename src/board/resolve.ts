/**
 * Ticket id prefix resolution and task reference arguments (board-cli:
 * "Command surface"; add-board-core design.md: Risks, "Prefix ids collide").
 */

import type { BoardState } from '../events/fold.js';
import { TASK_SOURCE_PATTERN, parseTaskRef, type TaskRef } from '../events/schema.js';
import { asciiText } from './text.js';
import { BoardError } from '../store/errors.js';

/** Shortest accepted id prefix. */
export const MIN_PREFIX_LENGTH = 6;

/**
 * True when `text` has the shape of a ticket id or id prefix (board-cli
 * "Ticket ids in refusals"): after upper-casing, it matches
 * `^[0-9A-HJKMNP-TV-Z]{1,26}$`, that is 1 to 26 characters of Crockford
 * base32 (the digits and the letters other than I, L, O and U). So
 * `01j9k3` and `01J9K3ZZZZ` are id-shaped, and the empty string, `01NOPE`
 * (an `O`), a 27-character run, and anything with `_`, `-`, `:` or `/`
 * are not.
 *
 * Only an id-shaped text given as a ticket id may be repeated in a
 * refusal or a hint; `resolveTicketId` and `renderHint`
 * (`src/guidance/hints.ts`) decide with this. Pure.
 */
export function isIdShaped(text: string): boolean {
  // Stub (no-echo-refusals group 1, test author); the implementer writes it.
  throw new Error(`isIdShaped is not implemented (${String(text.length)})`);
}

/**
 * The message of the `unknown-ticket` refusal for a ticket id that is not
 * id-shaped (`isIdShaped` false), which names the id form and not the
 * text given.
 */
export const NOT_AN_ID_MESSAGE =
  'no ticket matches the id given, which is not a ticket id: an id is 26 characters of ' +
  'Crockford base32 (digits and letters other than I, L, O and U), or a unique prefix of ' +
  'at least 6 of them';

/**
 * Resolves a full ticket id or a unique prefix against `state.tickets`
 * (closed tickets included). Pure.
 *
 * The text is upper-cased first (ULIDs are Crockford base32, which is
 * case-insensitive). Then, in order:
 * - an exact id match is returned as is;
 * - shorter than `MIN_PREFIX_LENGTH`: `BoardError(1, 'id-too-short')`
 *   naming the minimum length, exactly `ticket id prefix <text> is too
 *   short: give at least 6 characters` when `isIdShaped(text)`, else
 *   `the ticket id given is too short: give at least 6 characters`;
 * - exactly one id starts with it: that id;
 * - none: `BoardError(4, 'unknown-ticket')`, exactly `no ticket matches
 *   <text>` when `isIdShaped(text)`, else `NOT_AN_ID_MESSAGE`;
 * - several: `BoardError(1, 'ambiguous-id')` whose message names the
 *   prefix and lists every matching full id, in ascending order (a prefix
 *   that matches an id is always id-shaped).
 * `<text>` is the text as given (not upper-cased), through `asciiText`.
 * Text that is not id-shaped is never repeated (board-cli "Refusals never
 * repeat the refused input").
 */
export function resolveTicketId(state: BoardState, text: string): string {
  const wanted = text.toUpperCase();
  if (Object.hasOwn(state.tickets, wanted)) {
    return wanted;
  }
  if (wanted.length < MIN_PREFIX_LENGTH) {
    throw new BoardError(
      1,
      'id-too-short',
      `ticket id prefix ${asciiText(text)} is too short: give at least ${String(MIN_PREFIX_LENGTH)} characters`,
    );
  }
  const matches = Object.keys(state.tickets)
    .filter((id) => id.startsWith(wanted))
    .sort();
  const [only, ...more] = matches;
  if (only === undefined) {
    throw new BoardError(4, 'unknown-ticket', `no ticket matches ${asciiText(text)}`);
  }
  if (more.length > 0) {
    throw new BoardError(
      1,
      'ambiguous-id',
      `ticket id prefix ${asciiText(text)} is ambiguous; it matches ${matches.join(', ')}`,
    );
  }
  return only;
}

/** The text form of a task reference, shown in every task reference error. */
export const TASK_REF_FORM = '<source>:<ref>#<item>';

/**
 * The task arguments of `new` and `link` as given on the command line.
 * `change` and `group` are the OpenSpec shorthand.
 */
export interface TaskArgs {
  task?: string | undefined;
  change?: string | undefined;
  group?: string | undefined;
}

/**
 * Turns the task arguments into a task reference, or undefined when none
 * of the three is given. Pure.
 *
 * - `task` alone: `parseTaskRef(task)`; when that is null,
 *   `BoardError(1, 'malformed-task-ref')`, exactly `malformed task
 *   reference: --task expects <source>:<ref>#<item>, for example
 *   openspec:add-board-core#3`.
 * - `change` and `group` together: exactly `{ source: 'openspec', ref:
 *   change, item: group }`, the same reference as `--task
 *   openspec:<change>#<group>`. `group` must be a positive decimal integer
 *   without leading zeros (`^[1-9][0-9]*$`) and `change` non-empty and
 *   free of `#`; otherwise `BoardError(1, 'malformed-task-ref')`.
 * - `change` without `group`, or `group` without `change`:
 *   `BoardError(1, 'usage')` saying both are needed.
 * - `task` together with `change` or `group`: `BoardError(1, 'usage')`.
 */
export function taskRefFromArgs(args: TaskArgs): TaskRef | undefined {
  const { task, change, group } = args;
  if (task !== undefined) {
    if (change !== undefined || group !== undefined) {
      throw new BoardError(1, 'usage', 'give either --task or --change with --group, not both');
    }
    const ref = parseTaskRef(task);
    if (ref === null) {
      throw new BoardError(
        1,
        'malformed-task-ref',
        `malformed task reference ${asciiText(task)}: expected ${TASK_REF_FORM}, for example openspec:add-board-core#3`,
      );
    }
    return ref;
  }
  if (change === undefined && group === undefined) {
    return undefined;
  }
  if (change === undefined || group === undefined) {
    throw new BoardError(1, 'usage', '--change and --group must be given together');
  }
  if (change === '' || change.includes('#')) {
    throw new BoardError(
      1,
      'malformed-task-ref',
      `malformed change name ${asciiText(change)}: it must be non-empty and contain no #`,
    );
  }
  if (!/^[1-9][0-9]*$/.test(group)) {
    throw new BoardError(
      1,
      'malformed-task-ref',
      `malformed group ${asciiText(group)}: it must be a positive decimal number such as 3`,
    );
  }
  return { source: 'openspec', ref: change, item: group };
}

/**
 * A `list --task` filter: a task reference whose `item` may be omitted to
 * match every item of `source:ref`.
 */
export interface TaskFilter {
  source: string;
  ref: string;
  item?: string;
}

/**
 * Parses a `list --task` value: `<source>:<ref>#<item>` (exact match) or
 * `<source>:<ref>` (any item). The second form is recognised when the text
 * has no `#`; `source` must match `TASK_SOURCE_PATTERN` and `ref` be
 * non-empty. Anything else is `BoardError(1, 'malformed-task-ref')`,
 * exactly `malformed task filter: --task expects <source>:<ref>[#<item>]`,
 * which does not repeat the text. Pure.
 */
export function parseTaskFilter(text: string): TaskFilter {
  if (text.includes('#')) {
    const ref = parseTaskRef(text);
    if (ref !== null) {
      return ref;
    }
  } else {
    const colon = text.indexOf(':');
    const source = text.slice(0, colon);
    const ref = text.slice(colon + 1);
    if (colon >= 0 && TASK_SOURCE_PATTERN.test(source) && ref !== '') {
      return { source, ref };
    }
  }
  throw new BoardError(
    1,
    'malformed-task-ref',
    `malformed task filter ${asciiText(text)}: expected <source>:<ref>[#<item>]`,
  );
}
