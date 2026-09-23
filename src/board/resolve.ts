/**
 * Ticket id prefix resolution and task reference arguments (board-cli:
 * "Command surface"; design.md: Risks, "Prefix ids collide").
 */

import type { BoardState } from '../events/fold.js';
import type { TaskRef } from '../events/schema.js';
import { notImplemented } from './stub.js';

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
  throw notImplemented(state, text);
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
  throw notImplemented(args);
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
  throw notImplemented(text);
}
