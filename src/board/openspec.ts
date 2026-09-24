/**
 * The `openspec` task source adapter (board-openspec-integration: "Task
 * sources are adapters", "Import a change"; board-events: "Task
 * reference": for `openspec`, `ref` is the change directory name and `item`
 * the task group number in decimal).
 *
 * The only module under `src` that knows OpenSpec's layout
 * (`openspec/changes/<name>/tasks.md`) and its tasks file format.
 */

import type { SourceAdapter, TaskUnit } from './sources.js';

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
  void text;
  void path;
  throw new Error('not implemented');
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
    void hostRoot;
    throw new Error('not implemented');
  },
  tasksPath(ref: string): string {
    void ref;
    throw new Error('not implemented');
  },
  listUnits(hostRoot: string, ref: string): TaskUnit[] {
    void hostRoot;
    void ref;
    throw new Error('not implemented');
  },
  locate(hostRoot: string, ref: string, item: string, index: number) {
    void hostRoot;
    void ref;
    void item;
    void index;
    throw new Error('not implemented');
  },
  labels(ref: string, unit: TaskUnit): string[] {
    void ref;
    void unit;
    throw new Error('not implemented');
  },
};
