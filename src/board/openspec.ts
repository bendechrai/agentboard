/**
 * The `openspec` task source adapter (board-openspec-integration: "Task
 * sources are adapters", "Import a change"; board-events: "Task
 * reference": for `openspec`, `ref` is the change directory name and `item`
 * the task group number in decimal).
 *
 * The only module under `src` that knows OpenSpec's layout
 * (`openspec/changes/<name>/tasks.md`) and its tasks file format.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BoardError } from '../store/errors.js';
import type { SourceAdapter, TaskLocation, TaskUnit } from './sources.js';
import { asciiText } from './text.js';

/** The task reference `source` of OpenSpec. */
export const OPENSPEC_SOURCE = 'openspec';

/**
 * Parses an OpenSpec `tasks.md` into its task groups. Pure.
 *
 * The text is split into lines on `\n`; a trailing `\r` on a line is
 * ignored (CRLF files parse like LF files). Line numbers are 1-based.
 *
 * - Group heading: a line matching `^## ([0-9]+)\. (.*)$` whose title part
 *   is not blank. `item` is the number as written (`"3"`); `title` is the
 *   rest of the heading with surrounding whitespace removed
 *   (`## 3. CLI core commands` has title `CLI core commands`). A group
 *   runs until the next line starting with `## ` (numbered or not) or the
 *   end of the file.
 * - Task line: inside a group, a line matching `^- \[([ xX])\] (.*)$`,
 *   starting at column 0. `done` is true for `x` and `X`. `text` is the
 *   rest of the line with trailing whitespace removed (the task number is
 *   kept: `- [x] 1.1 Implement canonical` has text
 *   `1.1 Implement canonical`). These are exactly the lines `taskReminder`
 *   counted before the adapter existed, in the same order.
 * - Everything else is ignored: the document title and prose, blank lines,
 *   `###` sub-headings, indented lines (continuations and nested lists),
 *   lines before the first group, and the contents of a `## ` section that
 *   is not a numbered group (such a heading also ends the group before
 *   it). A continuation line does not become part of the task's text.
 * - A group with no task lines is returned with `lines: []`.
 *
 * @throws BoardError exit 1 `malformed-tasks` when a group number appears
 *   on two headings (naming the number and the 1-based line of the second
 *   heading), or when a task line has no text after its checkbox, i.e. it
 *   is blank after trailing whitespace is removed (naming its line).
 *   `path`, when given, is included in the message (the adapter passes the
 *   root-relative tasks file path).
 */
export function parseOpenSpecTasks(text: string, path?: string): TaskUnit[] {
  const where = path === undefined ? '' : `${asciiText(path)}: `;
  const units: TaskUnit[] = [];
  const seen = new Map<string, number>();
  let current: TaskUnit | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const number = i + 1;
    if (line.startsWith('## ')) {
      current = groupHeading(line, number, seen, where);
      if (current !== null) {
        units.push(current);
      }
      continue;
    }
    const task = TASK_LINE.exec(line);
    if (current === null || task === null) {
      continue;
    }
    const taskText = (task[2] ?? '').trimEnd();
    if (taskText === '') {
      throw new BoardError(
        1,
        'malformed-tasks',
        `${where}line ${String(number)}: the task line has no text after its checkbox`,
      );
    }
    current.lines.push({ text: taskText, done: task[1] !== ' ', line: number });
  }
  return units;
}

/**
 * The unit a `## ` line starts, or null when it is not a numbered group
 * heading with a title. Records the group number in `seen` and refuses one
 * used twice.
 */
function groupHeading(
  line: string,
  number: number,
  seen: Map<string, number>,
  where: string,
): TaskUnit | null {
  const heading = GROUP_HEADING.exec(line);
  const item = heading?.[1];
  const title = heading?.[2]?.trim() ?? '';
  if (item === undefined || title === '') {
    return null;
  }
  const first = seen.get(item);
  if (first !== undefined) {
    throw new BoardError(
      1,
      'malformed-tasks',
      `${where}line ${String(number)}: task group ${item} is already defined on line ${String(first)}`,
    );
  }
  seen.set(item, number);
  return { item, title, line: number, lines: [] };
}

/** A numbered group heading: number and title part. */
const GROUP_HEADING = /^## ([0-9]+)\. (.*)$/;

/** A task line at column 0: checkbox mark and the rest of the line. */
const TASK_LINE = /^- \[([ xX])\] (.*)$/;

/** `ref` as a single safe path segment, or `BoardError(1, 'usage')`. */
function checkRef(ref: string): string {
  if (ref === '' || ref === '.' || ref === '..' || /[/\\]/.test(ref) || ref.includes('\0')) {
    throw new BoardError(
      1,
      'usage',
      `the OpenSpec change name ${JSON.stringify(asciiText(ref))} is not a single directory name`,
    );
  }
  return ref;
}

/** The root-relative tasks file path of change `ref`. */
function changeTasksPath(ref: string): string {
  return `openspec/changes/${checkRef(ref)}/tasks.md`;
}

function listChangeUnits(hostRoot: string, ref: string): TaskUnit[] {
  const path = changeTasksPath(ref);
  let text: string;
  try {
    text = readFileSync(join(hostRoot, ...path.split('/')), 'utf8');
  } catch {
    throw new BoardError(
      1,
      'tasks-not-found',
      `cannot read the tasks file ${asciiText(path)} (is ${asciiText(ref)} an OpenSpec change?)`,
    );
  }
  return parseOpenSpecTasks(text, path);
}

/**
 * The `openspec` adapter.
 *
 * - `root(hostRoot)`: `<hostRoot>/openspec`.
 * - `tasksPath(ref)`: `openspec/changes/<ref>/tasks.md`, after the `ref`
 *   checks documented on `SourceAdapter.tasksPath`.
 * - `listUnits(hostRoot, ref)`: reads `<hostRoot>/<tasksPath(ref)>` as
 *   UTF-8 and returns `parseOpenSpecTasks(text, tasksPath(ref))`. A missing
 *   or unreadable file (including a missing change directory) is
 *   `BoardError(1, 'tasks-not-found')` whose message names
 *   `openspec/changes/<ref>/tasks.md`.
 * - `locate(hostRoot, ref, item, index)`: the path, and the `line` of the
 *   `index`-th entry of the unit `item` from `listUnits`, or null when that
 *   throws (missing or malformed file) or has no such unit or entry
 *   (including a negative index). Gives the same results as
 *   `taskReminder` did before task 7.2.
 * - `labels(ref, unit)`: `['change:<ref>', 'group:<unit.item>']`.
 */
export const openspecAdapter: SourceAdapter = {
  source: OPENSPEC_SOURCE,
  root(hostRoot: string): string {
    return join(hostRoot, 'openspec');
  },
  tasksPath(ref: string): string {
    return changeTasksPath(ref);
  },
  listUnits(hostRoot: string, ref: string): TaskUnit[] {
    return listChangeUnits(hostRoot, ref);
  },
  locate(hostRoot: string, ref: string, item: string, index: number): TaskLocation {
    const path = changeTasksPath(ref);
    let units: TaskUnit[];
    try {
      units = listChangeUnits(hostRoot, ref);
    } catch {
      return { path, line: null };
    }
    const unit = units.find((u) => u.item === item);
    const entry = index >= 0 ? unit?.lines[index] : undefined;
    return { path, line: entry?.line ?? null };
  },
  labels(ref: string, unit: TaskUnit): string[] {
    return [`change:${ref}`, `group:${unit.item}`];
  },
};
