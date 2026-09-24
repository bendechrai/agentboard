/**
 * Task source adapters (board-openspec-integration: "Task sources are
 * adapters"; design.md: "Task reference is source-neutral").
 *
 * The board core depends on a planning tool only through the adapter keyed
 * by a task reference's `source`. Everything source-specific (where the
 * planning tool lives in the host project, how its tasks file is named and
 * parsed, which line a checklist index corresponds to) lives behind this
 * interface. `import-change` and the `checklist tick` reminder
 * (`taskReminder`) are the only consumers; every other operation treats a
 * task reference as three opaque strings, so a ticket whose source has no
 * adapter is fully usable.
 *
 * This version ships exactly one adapter, `openspec` (`openspecAdapter` in
 * `openspec.ts`).
 *
 * Host root: every adapter method takes `hostRoot`, the host project root
 * as the board locates it, which is the parent directory of the board
 * directory (`dirname(board.dir)`). This is what "locating the OpenSpec
 * root the same way the board is located" means: the planning tool's root
 * is found from the same discovery (`AGENTBOARD_DIR`, then the git common
 * dir, then `./.board`), so every linked worktree reads the main
 * checkout's tasks files, exactly as it writes the main checkout's board.
 */

import { openspecAdapter } from './openspec.js';

/** One task line of a unit, in file order. */
export interface TaskLine {
  /**
   * The checklist text: the line after its checkbox marker, with trailing
   * whitespace removed, verbatim otherwise (for OpenSpec it keeps the task
   * number, e.g. `1.1 Implement ...`). Never empty.
   */
  text: string;
  /** Whether the checkbox is ticked in the tasks file. */
  done: boolean;
  /** 1-based line number of the task line in the tasks file. */
  line: number;
}

/**
 * One importable unit of a `ref` (for OpenSpec, a top-level numbered task
 * group), which becomes one ticket.
 */
export interface TaskUnit {
  /** The task reference `item` (for OpenSpec, the group number in decimal as written). */
  item: string;
  /** The ticket title (for OpenSpec, the group heading text after `<n>. `). Never empty. */
  title: string;
  /** 1-based line number of the unit's heading. */
  line: number;
  /** The unit's task lines in file order; may be empty. */
  lines: TaskLine[];
}

/** Where a checklist line of a ticket lives in the planning tool's tasks file. */
export interface TaskLocation {
  /** POSIX path of the tasks file, relative to the host root (e.g. `openspec/changes/x/tasks.md`). */
  path: string;
  /**
   * 1-based line of the task line, or null when the file cannot be read,
   * the item is not in it, or the item has no task line at that index.
   */
  line: number | null;
}

/** A planning tool adapter. Every method reads only; none writes. */
export interface SourceAdapter {
  /** The task reference `source` this adapter serves (`^[a-z][a-z0-9-]*$`). */
  readonly source: string;
  /**
   * Absolute path of the planning tool's root in the host project (for
   * OpenSpec, `<hostRoot>/openspec`). Does not check that it exists.
   */
  root(hostRoot: string): string;
  /**
   * POSIX path, relative to the host root, of the tasks file of `ref` (for
   * OpenSpec, `openspec/changes/<ref>/tasks.md`). Does not check existence.
   *
   * @throws BoardError exit 1 `usage` when `ref` is not a single safe path
   *   segment: empty, `.` or `..`, or containing `/`, `\` or a NUL
   *   character (so a ref can never name a file outside the root).
   */
  tasksPath(ref: string): string;
  /**
   * The importable units of `ref`, in file order, read from the tasks file.
   *
   * @throws BoardError exit 1 `usage` for a bad `ref` (as `tasksPath`).
   * @throws BoardError exit 1 `tasks-not-found` when the tasks file cannot
   *   be read; the message names the root-relative path (`tasksPath(ref)`).
   * @throws BoardError exit 1 `malformed-tasks` when the file cannot be
   *   turned into units (see the adapter's parser); the message names the
   *   path and the 1-based line.
   */
  listUnits(hostRoot: string, ref: string): TaskUnit[];
  /**
   * Where checklist line `index` (0-based) of a ticket with task reference
   * `ref`/`item` lives: the tasks file path (always given) and the line of
   * the `index`-th task line of that unit, counted in the same order
   * `listUnits` lists them, so the reminder and the imported checklist
   * agree. Never throws for a missing or malformed file: `line` is then
   * null. A bad `ref` throws as `tasksPath`.
   */
  locate(hostRoot: string, ref: string, item: string, index: number): TaskLocation;
  /**
   * The labels of the ticket imported for `unit` of `ref`, in order (for
   * OpenSpec, `change:<ref>` then `group:<item>`).
   */
  labels(ref: string, unit: TaskUnit): string[];
}

/** Every adapter of this version, in order. Exactly `[openspecAdapter]`. */
export const SOURCE_ADAPTERS: readonly SourceAdapter[] = [openspecAdapter];

/**
 * The adapter for `source`, or undefined when this version has none (for
 * example `speckit`). Exact, case-sensitive match on `SourceAdapter.source`.
 */
export function sourceAdapter(source: string): SourceAdapter | undefined {
  return SOURCE_ADAPTERS.find((adapter) => adapter.source === source);
}
