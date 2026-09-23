/**
 * The tasks-file reminder printed by `checklist tick`
 * (board-openspec-integration: "Completion truth stays in tasks", "Task
 * sources are adapters").
 *
 * Only the path and line computation for the `openspec` source lives here;
 * task 7.2 moves it behind the source adapter interface without changing
 * this function's results.
 */

import type { Ticket } from '../events/fold.js';
import { notImplemented } from './stub.js';

/**
 * What `checklist tick` tells the actor about the planning tool's own
 * tasks file.
 *
 * - `source`: the ticket's task source, or null for a ticket without a task
 *   reference (ad hoc).
 * - `path`: for the `openspec` source, `openspec/changes/<ref>/tasks.md`
 *   (POSIX separators, relative to the host project root); null for any
 *   other source and for ad hoc tickets.
 * - `line`: the 1-based line number in that file of the task line that
 *   corresponds to the ticked checklist index, or null when the file cannot
 *   be read or the line cannot be found.
 * - `message`: one ASCII line. For `openspec` it contains the path (followed
 *   by `:<line>` when the line is known) and says the task line must be
 *   ticked in `tasks.md` in the implementing PR, because the board never
 *   marks a task complete. For another source it says that no tasks-file
 *   reminder is available for source `<source>`. For an ad hoc ticket it
 *   says the ticket has no task reference, so there is no tasks file.
 */
export interface TaskReminder {
  source: string | null;
  path: string | null;
  line: number | null;
  message: string;
}

/**
 * Computes the reminder for ticking checklist line `index` (0-based) of
 * `ticket`, whose host project root is `hostRoot` (the parent directory of
 * the board directory).
 *
 * For `openspec`, the line is found in `<hostRoot>/<path>` as follows: the
 * group heading is the first line matching `^## <item>\. ` (for example
 * `## 3. CLI core commands` for item `3`); the group ends at the next line
 * starting with `## ` or at the end of the file; within it, task lines are
 * the lines matching `^- \[[ xX]\] `, and the reminder names the
 * `index`-th of them (0-based), the same order `import-change` uses to
 * build a ticket's checklist. Reads the file only; never writes.
 */
export function taskReminder(hostRoot: string, ticket: Ticket, index: number): TaskReminder {
  throw notImplemented(hostRoot, ticket, index);
}
