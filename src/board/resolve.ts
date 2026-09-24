/**
 * Ticket id prefix resolution and task reference arguments (board-cli:
 * "Command surface"; design.md: Risks, "Prefix ids collide").
 */

import type { BoardState } from '../events/fold.js';
import { TASK_SOURCE_PATTERN, parseTaskRef, type TaskRef } from '../events/schema.js';
import { asciiText } from './text.js';
import { BoardError } from '../store/errors.js';

/** Shortest accepted id prefix. */
export const MIN_PREFIX_LENGTH = 6;

/**
 * Resolves a full ticket id or a unique prefix against `state.tickets`
 * (closed tickets included). Pure.
 *
 * The text is upper-cased first (ULIDs are Crockford base32, which is
 * case-insensitive). Then, in order:
 * - an exact id match is returned as is;
 * - shorter than `MIN_PREFIX_LENGTH`: `BoardError(1, 'id-too-short')`
 *   naming the minimum length;
 * - exactly one id starts with it: that id;
 * - none: `BoardError(4, 'unknown-ticket')` naming the text;
 * - several: `BoardError(1, 'ambiguous-id')` whose message lists every
 *   matching full id, in ascending order.
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
 *   `BoardError(1, 'malformed-task-ref')` whose message quotes the text and
 *   shows the form `TASK_REF_FORM` with an example
 *   (`openspec:add-board-core#3`).
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
 * non-empty. Anything else is `BoardError(1, 'malformed-task-ref')` showing
 * `<source>:<ref>[#<item>]`. Pure.
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
