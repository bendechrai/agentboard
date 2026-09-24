/**
 * The tasks-file reminder printed by `checklist tick`
 * (board-openspec-integration: "Completion truth stays in tasks", "Task
 * sources are adapters").
 *
 * Task 7.2: the path and line come from the ticket's source adapter
 * (`sourceAdapter(task.source)`, `SourceAdapter.locate`), never from
 * source-specific code in this module; the results are unchanged from
 * group 3 for `openspec`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { asciiText } from './text.js';
import type { Ticket } from '../events/fold.js';

/**
 * What `checklist tick` tells the actor about the planning tool's own
 * tasks file.
 *
 * - `source`: the ticket's task source, or null for a ticket without a task
 *   reference (ad hoc).
 * - `path`: for a source with an adapter, the adapter's tasks file path
 *   (for `openspec`, `openspec/changes/<ref>/tasks.md`; POSIX separators,
 *   relative to the host project root); null for a source without an
 *   adapter and for ad hoc tickets.
 * - `line`: the 1-based line number in that file of the task line that
 *   corresponds to the ticked checklist index, or null when the file cannot
 *   be read or the line cannot be found.
 * - `message`: one ASCII line. For a source with an adapter it contains
 *   the path (followed by `:<line>` when the line is known) and says the
 *   task line must be ticked in the tasks file in the implementing PR,
 *   because the board never marks a task complete. For a source without an
 *   adapter it says that no tasks-file reminder is available for source
 *   `<source>`. For an ad hoc ticket it
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
 * For a source with an adapter, `path` and `line` are
 * `adapter.locate(hostRoot, task.ref, task.item, index)` (for `openspec`,
 * see `parseOpenSpecTasks`: the `index`-th task line of the group, the
 * same order `import-change` uses to build a ticket's checklist). Reads
 * the file only; never writes.
 */
export function taskReminder(hostRoot: string, ticket: Ticket, index: number): TaskReminder {
  const task = ticket.task;
  if (task === null) {
    return {
      source: null,
      path: null,
      line: null,
      message: 'this ticket has no task reference (ad hoc), so there is no tasks file to update',
    };
  }
  if (task.source !== 'openspec') {
    return {
      source: task.source,
      path: null,
      line: null,
      message: `no tasks-file reminder is available for source ${asciiText(task.source)}`,
    };
  }
  const path = `openspec/changes/${task.ref}/tasks.md`;
  const line = findTaskLine(join(hostRoot, ...path.split('/')), task.item, index);
  const where = line === null ? asciiText(path) : `${asciiText(path)}:${String(line)}`;
  return {
    source: task.source,
    path,
    line,
    message:
      `reminder: tick the task line in ${where} in the implementing PR ` +
      '(the board never marks a task complete; tasks.md is the record)',
  };
}

/**
 * The 1-based line of the `index`-th task line of group `item` in the tasks
 * file at `file`, or null when the file cannot be read or there is no such
 * line.
 */
function findTaskLine(file: string, item: string, index: number): number | null {
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
  const heading = `## ${item}. `;
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0 || index < 0) {
    return null;
  }
  let seen = 0;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ')) {
      break;
    }
    if (/^- \[[ xX]\] /.test(line)) {
      if (seen === index) {
        return i + 1;
      }
      seen += 1;
    }
  }
  return null;
}
