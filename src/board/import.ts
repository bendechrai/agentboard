/**
 * `import-change`: one ticket per importable unit of a planning source,
 * paired with the existing tickets by identity and reconciled with them
 * (board-openspec-integration: "Import a change", "Task sources are
 * adapters", "Pair tickets to groups by identity", "Reconcile on
 * re-import"; board-concurrency: "Re-import is idempotent"; board-events:
 * "Fold semantics": "A ticket SHALL always be created in `todo`; an import
 * that needs another status writes the permitted moves").
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Ticket } from '../events/fold.js';
import {
  TASK_SOURCE_PATTERN,
  type Status,
  type TaskRef,
  type TicketChecklistAddItem,
  type TicketCreateBody,
  type TicketReconcileBody,
  type TicketReconcileUpdate,
} from '../events/schema.js';
import { newUlid } from '../events/ulid.js';
import type { Board } from '../store/board.js';
import { stmt } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { readState, readTicket } from '../store/cache.js';
import {
  runCommand,
  type CommandResult,
  type ProposedEvent,
  type TxContext,
} from '../store/transaction.js';
import { requireActor, ticketOf } from './lookup.js';
import { OPENSPEC_SOURCE } from './openspec.js';
import { refuseSecretLike } from './secrets.js';
import { SOURCE_ADAPTERS, sourceAdapter, type TaskUnit } from './sources.js';
import { asciiText } from './text.js';
import type { WriteOptions } from './types.js';

/** What `import-change` imports: a source and a ref within it. */
export interface ImportTarget {
  /** Task source; must have an adapter (`sourceAdapter`). */
  source: string;
  /** The ref within the source (for OpenSpec, the change directory name). */
  ref: string;
}

/**
 * Parses the `import-change` argument. Pure.
 *
 * - Without `:`, the whole text is an OpenSpec change name:
 *   `{ source: 'openspec', ref: text }`.
 * - With `:`, the text before the first `:` is the source and the rest is
 *   the ref (`speckit:001-photo-albums`), the same `<source>:<ref>` form
 *   `list --task` accepts. The source must match `TASK_SOURCE_PATTERN`,
 *   otherwise `BoardError(1, 'malformed-task-ref')`, exactly `the task
 *   source given to import-change must match /^[a-z][a-z0-9-]*$/`. A `#`
 *   in the text (checked first) is `BoardError(1, 'malformed-task-ref')`,
 *   exactly `the change given to import-change names an item (it contains
 *   #); import-change takes a whole change or <source>:<ref>` (an import
 *   names a whole ref, never one item).
 * - An empty text is `BoardError(1, 'usage')` (`import-change needs a
 *   change name or <source>:<ref>`) and an empty ref is
 *   `BoardError(1, 'usage')`, exactly `the change given to import-change
 *   names no ref after its source`.
 * No message repeats the text given (board-cli "Refusals never repeat the
 * refused input").
 *
 * Whether the source has an adapter is not checked here (`importChange`
 * does).
 */
export function parseImportTarget(text: string): ImportTarget {
  if (text === '') {
    throw new BoardError(1, 'usage', 'import-change needs a change name or <source>:<ref>');
  }
  if (text.includes('#')) {
    throw new BoardError(
      1,
      'malformed-task-ref',
      'the change given to import-change names an item (it contains #); import-change takes a whole change or <source>:<ref>',
    );
  }
  const colon = text.indexOf(':');
  if (colon < 0) {
    return { source: OPENSPEC_SOURCE, ref: text };
  }
  const source = text.slice(0, colon);
  const ref = text.slice(colon + 1);
  if (!TASK_SOURCE_PATTERN.test(source)) {
    throw new BoardError(
      1,
      'malformed-task-ref',
      `the task source given to import-change must match ${String(TASK_SOURCE_PATTERN)}`,
    );
  }
  if (ref === '') {
    throw new BoardError(
      1,
      'usage',
      'the change given to import-change names no ref after its source',
    );
  }
  return { source, ref };
}

/**
 * Jaccard similarity a ticket and a group need, at least, to be paired by
 * content (pass 2 of `pairTickets`).
 */
export const PAIR_THRESHOLD = 0.5;

/**
 * How much lower than a content pair's score every other candidate of
 * either side must score (pass 2), and the score from which another
 * candidate prevents a pairing by number (pass 3).
 */
export const PAIR_MARGIN = 0.2;

/**
 * The normalised form of a title for pairing (board-openspec-integration:
 * "Pair tickets to groups by identity"). Pure. In order:
 * 1. lowercase (`String.prototype.toLowerCase`);
 * 2. remove a leading number: a match of `^\s*[0-9]+(\.[0-9]+)*\.?\s+`
 *    (`5. Docs` and `5 Docs` become `docs`; `5.Docs` keeps its number);
 * 3. replace every run of characters other than `a-z` and `0-9` with one
 *    space;
 * 4. trim spaces at both ends.
 * Examples: `Re-import reconciliation (\`openspec/reconcile-import\`)` is
 * `re import reconciliation openspec reconcile import`; `## 5.` style
 * headings never reach it (the parser strips them), but a hand-written
 * ticket title `3. CLI core` is `cli core`.
 */
export function normaliseTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(LEADING_NUMBER, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A leading group or task number and the whitespace after it. */
const LEADING_NUMBER = /^\s*[0-9]+(\.[0-9]+)*\.?\s+/;

/** A leading markdown checkbox. */
const CHECKBOX = /^- \[[ xX]\] /;

/** A leading task number (`taskNumber`). */
const TASK_NUMBER = /^([0-9]+(\.[0-9]+)+)\.?(?=\s|$)/;

/**
 * The normalised form of a task line for pairing: the line with a leading
 * checkbox (`- [ ] `, `- [x] ` or `- [X] `, if any) removed, then exactly
 * `normaliseTitle` (which removes the leading task number, so
 * `- [x] 1.2 Add B, with retries` and `3.4 add b with retries` are both
 * `add b with retries`). Pure.
 */
export function normaliseTaskLine(text: string): string {
  return normaliseTitle(text.replace(CHECKBOX, ''));
}

/**
 * The task number of a checklist or task line: the leading
 * `<n>.<m>[.<k>...]`, a match of `^([0-9]+(\.[0-9]+)+)\.?(?=\s|$)` (group
 * 1), or null when the line has none (`1.2 Add B` is `1.2`, `1.2. Add B`
 * is `1.2`, `1.2.3 Sub` is `1.2.3`, `12 Add` and `Add 1.2` are null).
 * Pure.
 */
export function taskNumber(text: string): string | null {
  return TASK_NUMBER.exec(text)?.[1] ?? null;
}

/**
 * The text of a line without its task number: the text after the number
 * (`TASK_NUMBER`) and the whitespace that follows it, or the whole text
 * when it has no number.
 */
function withoutNumber(text: string): string {
  const match = TASK_NUMBER.exec(text);
  return match === null ? text : text.slice(match[0].length).trimStart();
}

/**
 * A Jaccard score as the exact rational `shared / union` (`0 / 1` for two
 * empty sets), so that scores compare without rounding errors.
 */
interface Score {
  shared: number;
  union: number;
}

function score(a: readonly string[], b: readonly string[]): Score {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const line of left) {
    if (right.has(line)) {
      shared += 1;
    }
  }
  const union = left.size + right.size - shared;
  return union === 0 ? { shared: 0, union: 1 } : { shared, union };
}

/**
 * `PAIR_THRESHOLD` and `PAIR_MARGIN` as exact fractions (1/2 and 1/5),
 * for comparing `Score`s.
 */
const THRESHOLD = { num: 1, den: 2 };
const MARGIN = { num: 1, den: 5 };

/** True when `s >= num / den`. */
function atLeast(s: Score, fraction: { num: number; den: number }): boolean {
  return s.shared * fraction.den >= fraction.num * s.union;
}

/** True when `other <= best - MARGIN`. */
function marginMet(best: Score, other: Score): boolean {
  // other.shared / other.union <= best.shared / best.union - num / den,
  // multiplied out by the (positive) denominators.
  return (
    other.shared * best.union * MARGIN.den <=
    (best.shared * MARGIN.den - MARGIN.num * best.union) * other.union
  );
}

/**
 * Jaccard similarity of two collections of normalised lines, taken as
 * sets (duplicates count once): `|A and B| / |A or B|`, in 0..1. Two empty
 * sets score 0 (no evidence of identity). Pure.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const s = score(a, b);
  return s.shared / s.union;
}

/** The part of a ticket that pairing reads. */
export type PairingTicket = Pick<Ticket, 'id' | 'title' | 'task' | 'checklist'>;

/** Which pass of `pairTickets` paired a ticket with a group. */
export type PairPass = 'title' | 'content' | 'number';

/** A ticket paired with a group. */
export interface Pair {
  /** Ticket id. */
  ticket: string;
  /** The group's `item` (its current number). */
  item: string;
  pass: PairPass;
  /**
   * `jaccard` of the ticket's normalised active checklist lines (lines
   * without `removed`, through `normaliseTaskLine`) and the group's
   * normalised task lines, whatever the pass.
   */
  score: number;
}

/** A still-unpaired ticket and group that could be the same (see `PairingReport.ambiguous`). */
export interface AmbiguousCandidate {
  ticket: string;
  item: string;
  /** As `Pair.score`. */
  score: number;
  /** True when their normalised titles are equal. */
  sameTitle: boolean;
}

/** Result of `pairTickets`. */
export interface PairingReport {
  /** One per paired group, in the order of `units`. */
  pairs: Pair[];
  /** The `item` of every group left unpaired (it gets a new ticket), in the order of `units`. */
  newGroups: string[];
  /** The id of every ticket left unpaired (it is superseded), in the order of `tickets`. */
  unpaired: string[];
  /**
   * Empty when the pairing is decided. Otherwise (the import refuses with
   * `reconcile-ambiguous`): every still-unpaired ticket and group with a
   * score of at least `PAIR_MARGIN` or equal normalised titles, ordered
   * by the ticket's position in `tickets`, then the group's in `units`.
   */
  ambiguous: AmbiguousCandidate[];
}

/**
 * Pairs a change's tickets with its current task groups by identity, never
 * by number alone (board-openspec-integration: "Pair tickets to groups by
 * identity"). Pure; reads no board.
 *
 * `tickets` are the change's tickets that are not superseded, open or
 * closed, in any order the caller chooses (the import passes them by
 * ascending id); `units` are the groups in tasks file order. A ticket's
 * lines are its active checklist lines (without `removed`), normalised
 * with `normaliseTaskLine`; a group's lines are its task line texts,
 * normalised the same way; titles are normalised with `normaliseTitle`.
 * Scores are `jaccard` of those line sets. Scores are compared exactly,
 * as the rationals they are (shared over union), never with a rounding
 * error: a best score of 0.7 against another of 0.5 meets the 0.2 margin.
 *
 * Three passes, each over the tickets and groups still unpaired when it
 * starts, each deciding all of its pairs at once:
 * 1. title: a ticket and a group with equal normalised titles, when no
 *    other unpaired ticket and no other unpaired group has that
 *    normalised title;
 * 2. content: a ticket `t` and a group `g` with score `s >= PAIR_THRESHOLD`
 *    such that every other unpaired group scores at most `s - PAIR_MARGIN`
 *    against `t` and every other unpaired ticket scores at most
 *    `s - PAIR_MARGIN` against `g`;
 * 3. number: a ticket whose `task.item` equals a group's `item`, when no
 *    other unpaired ticket has that item, no other unpaired group scores
 *    `PAIR_MARGIN` or more against the ticket, and no other unpaired
 *    ticket scores `PAIR_MARGIN` or more against the group.
 *
 * The pairing is ambiguous when, after the three passes, a still-unpaired
 * ticket and a still-unpaired group score at least `PAIR_THRESHOLD` or
 * have equal normalised titles (a best match whose margin was not met, or
 * a tie); `ambiguous` then lists the candidates as documented on
 * `PairingReport`, and `pairs`, `newGroups` and `unpaired` still describe
 * the passes' outcome.
 */
export function pairTickets(
  tickets: readonly PairingTicket[],
  units: readonly TaskUnit[],
): PairingReport {
  const ticketTitles = tickets.map((t) => normaliseTitle(t.title));
  const unitTitles = units.map((u) => normaliseTitle(u.title));
  const ticketLines = tickets.map((t) =>
    t.checklist.filter((line) => line.removed !== true).map((line) => normaliseTaskLine(line.text)),
  );
  const scores = units.map((u) => {
    const lines = u.lines.map((line) => normaliseTaskLine(line.text));
    return ticketLines.map((t) => score(t, lines));
  });
  /** `scores[unit][ticket]`; always present for in-range indices. */
  const at = (t: number, u: number): Score => scores[u]?.[t] ?? { shared: 0, union: 1 };
  /** The unit paired with each ticket, by index. */
  const unitOf = new Map<number, { unit: number; pass: PairPass }>();
  const pairedUnits = new Set<number>();
  const openTickets = (): number[] => tickets.map((_, i) => i).filter((i) => !unitOf.has(i));
  const openUnits = (): number[] => units.map((_, i) => i).filter((i) => !pairedUnits.has(i));
  const decide = (pass: PairPass, found: [number, number][]): void => {
    for (const [t, u] of found) {
      unitOf.set(t, { unit: u, pass });
      pairedUnits.add(u);
    }
  };

  // Pass 1: equal normalised titles, unique on both sides.
  {
    const ts = openTickets();
    const us = openUnits();
    const found: [number, number][] = [];
    for (const t of ts) {
      const title = ticketTitles[t];
      const sameTickets = ts.filter((o) => ticketTitles[o] === title);
      const sameUnits = us.filter((u) => unitTitles[u] === title);
      const [u] = sameUnits;
      if (u !== undefined && sameTickets.length === 1 && sameUnits.length === 1) {
        found.push([t, u]);
      }
    }
    decide('title', found);
  }

  // Pass 2: content, at least the threshold and every rival a margin lower.
  {
    const ts = openTickets();
    const us = openUnits();
    const found: [number, number][] = [];
    for (const t of ts) {
      for (const u of us) {
        const s = at(t, u);
        if (
          atLeast(s, THRESHOLD) &&
          us.every((o) => o === u || marginMet(s, at(t, o))) &&
          ts.every((o) => o === t || marginMet(s, at(o, u)))
        ) {
          found.push([t, u]);
        }
      }
    }
    decide('content', found);
  }

  // Pass 3: number, when no other candidate of either side scores the margin.
  {
    const ts = openTickets();
    const us = openUnits();
    const found: [number, number][] = [];
    for (const t of ts) {
      const item = tickets[t]?.task?.item;
      const sameItem = us.filter((u) => units[u]?.item === item);
      const [u] = sameItem;
      if (
        item === undefined ||
        u === undefined ||
        sameItem.length !== 1 ||
        ts.some((o) => o !== t && tickets[o]?.task?.item === item)
      ) {
        continue;
      }
      if (
        us.every((o) => o === u || !atLeast(at(t, o), MARGIN)) &&
        ts.every((o) => o === t || !atLeast(at(o, u), MARGIN))
      ) {
        found.push([t, u]);
      }
    }
    decide('number', found);
  }

  const ts = openTickets();
  const us = openUnits();
  const ambiguous: AmbiguousCandidate[] = [];
  const undecided = ts.some((t) =>
    us.some((u) => atLeast(at(t, u), THRESHOLD) || ticketTitles[t] === unitTitles[u]),
  );
  if (undecided) {
    for (const t of ts) {
      for (const u of us) {
        const sameTitle = ticketTitles[t] === unitTitles[u];
        if (sameTitle || atLeast(at(t, u), MARGIN)) {
          ambiguous.push({
            ticket: tickets[t]?.id ?? '',
            item: units[u]?.item ?? '',
            score: jaccardOf(at(t, u)),
            sameTitle,
          });
        }
      }
    }
  }
  const pairs: Pair[] = [];
  units.forEach((unit, u) => {
    for (const [t, chosen] of unitOf) {
      if (chosen.unit === u) {
        pairs.push({
          ticket: tickets[t]?.id ?? '',
          item: unit.item,
          pass: chosen.pass,
          score: jaccardOf(at(t, u)),
        });
      }
    }
  });
  return {
    pairs,
    newGroups: us.map((u) => units[u]?.item ?? ''),
    unpaired: ts.map((t) => tickets[t]?.id ?? ''),
    ambiguous,
  };
}

function jaccardOf(s: Score): number {
  return s.shared / s.union;
}

/** One `ticket.renumber` the import writes. */
export interface RenumberStep {
  ticket: string;
  from: string;
  to: string;
}

/**
 * Orders two task items: two decimal numbers (`^[0-9]+$`) by numeric
 * value, a decimal number before anything else, and otherwise by string
 * order; -1, 0 or 1. Pure.
 */
export function compareItems(a: string, b: string): -1 | 0 | 1 {
  const decimal = /^[0-9]+$/;
  const aNumber = decimal.test(a);
  const bNumber = decimal.test(b);
  if (aNumber && bNumber) {
    return Math.sign(Number(a) - Number(b)) as -1 | 0 | 1;
  }
  if (aNumber !== bNumber) {
    return aNumber ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The renumbers of a pairing: one step per pair whose ticket's
 * `task.item` differs from the pair's `item` (`from` the ticket's item,
 * `to` the group's), in ascending order of `from` by `compareItems`, ties
 * by ticket id. Pairs whose ticket is not in `tickets` are ignored. Because
 * the fold does not require items to be unique, a swap (2 to 3 and 3 to 2)
 * needs no temporary number. Pure.
 */
export function renumberPlan(
  tickets: readonly PairingTicket[],
  pairs: readonly Pair[],
): RenumberStep[] {
  const steps: RenumberStep[] = [];
  for (const pair of pairs) {
    const from = tickets.find((t) => t.id === pair.ticket)?.task?.item;
    if (from !== undefined && from !== pair.item) {
      steps.push({ ticket: pair.ticket, from, to: pair.item });
    }
  }
  return steps.sort(
    (a, b) =>
      compareItems(a.from, b.from) || (a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0),
  );
}

/**
 * The difference between a paired ticket and its group: what one
 * `ticket.reconcile` carries, without `forced`, `holder` and `source`.
 */
export interface ReconcileDiff {
  /** The group's title when it differs from the ticket's (exact comparison), else null. */
  title: string | null;
  /** Changed lines, ascending by index. */
  updated: TicketReconcileUpdate[];
  /** Indices of lines to mark removed, ascending. */
  removed: number[];
  /** Lines to append, in tasks file order. */
  added: TicketChecklistAddItem[];
}

/**
 * The reconcile diff of a ticket against its group's current task lines
 * (board-openspec-integration: "Reconcile on re-import"), or null when
 * nothing differs. Pure.
 *
 * Only the ticket's active lines (without `removed`) take part; removed
 * lines are never matched, updated or removed again. Lines are matched in
 * two passes, each line matched at most once:
 * 1. by task number (`taskNumber`): an active ticket line and a task line
 *    with the same number; when several lines on either side share a
 *    number, the k-th such ticket line (in index order) matches the k-th
 *    such task line (in file order);
 * 2. for lines still unmatched, by text with the task number removed (the
 *    text after the number and the whitespace that follows it; the whole
 *    text when there is no number), compared exactly, the k-th with the
 *    k-th as above.
 * Then:
 * - a matched line whose text is unchanged: nothing (it keeps its done
 *   flag, even when the tasks file's checkbox differs);
 * - a matched line whose text differs only in its task number (its text
 *   without the number is equal): in `updated` with the new text and the
 *   ticket's done flag;
 * - any other matched line whose text differs: in `updated` with the new
 *   text and the done flag of its tasks file checkbox;
 * - an active ticket line left unmatched: in `removed`;
 * - a task line left unmatched: in `added`, with its checkbox as `done`,
 *   in file order.
 * `title` as documented on `ReconcileDiff`. Null when `title` is null and
 * the three lists are empty.
 */
export function reconcileDiff(
  ticket: Pick<Ticket, 'title' | 'checklist'>,
  unit: TaskUnit,
): ReconcileDiff | null {
  const active: number[] = [];
  ticket.checklist.forEach((line, index) => {
    if (line.removed !== true) {
      active.push(index);
    }
  });
  const textOf = (index: number): string => ticket.checklist[index]?.text ?? '';
  /** Task line index (in `unit.lines`) matched with each ticket line index. */
  const matched = new Map<number, number>();
  const taken = new Set<number>();
  const matchBy = (key: (text: string) => string | null): void => {
    const open = new Map<string, number[]>();
    unit.lines.forEach((line, j) => {
      const k = taken.has(j) ? null : key(line.text);
      if (k !== null) {
        open.set(k, [...(open.get(k) ?? []), j]);
      }
    });
    for (const index of active) {
      const k = matched.has(index) ? null : key(textOf(index));
      const j = k === null ? undefined : open.get(k)?.shift();
      if (j !== undefined) {
        matched.set(index, j);
        taken.add(j);
      }
    }
  };
  matchBy(taskNumber);
  matchBy(withoutNumber);

  const updated: TicketReconcileUpdate[] = [];
  const removed: number[] = [];
  for (const index of active) {
    const j = matched.get(index);
    const line = unit.lines[j ?? -1];
    const current = ticket.checklist[index];
    if (line === undefined || current === undefined) {
      removed.push(index);
    } else if (line.text !== current.text) {
      const renumbered = withoutNumber(line.text) === withoutNumber(current.text);
      updated.push({ index, text: line.text, done: renumbered ? current.done : line.done });
    }
  }
  const added = unit.lines
    .filter((_, j) => !taken.has(j))
    .map((line) => ({ text: line.text, done: line.done }));
  const title = unit.title === ticket.title ? null : unit.title;
  if (title === null && updated.length === 0 && removed.length === 0 && added.length === 0) {
    return null;
  }
  return { title, updated, removed, added };
}

/**
 * Why a reconcile is blocked on one line: `done`, the line is done on the
 * ticket; `held`, the ticket is assigned and in `tests`, `implementing` or
 * `review`.
 */
export type BlockReason = 'done' | 'held';

/** A line whose change blocks a reconcile. */
export interface BlockedLine {
  /** The checklist index. */
  index: number;
  /** The line's current text on the ticket. */
  text: string;
  /** What the reconcile would do to it. */
  change: 'updated' | 'removed';
  /** `done` when the line is done, else `held`. */
  reason: BlockReason;
}

/**
 * The lines that block `diff` on `ticket` (board-openspec-integration:
 * "Reconcile on re-import"), ascending by index; empty when the reconcile
 * may be written without `--force`. Pure.
 *
 * Considered: every `removed` line, and every `updated` line whose text
 * changes other than only in its task number (a renumbered line is not a
 * rewording and never blocks). Such a line blocks with reason `done` when
 * it is done on the ticket, else with reason `held` when the ticket's
 * assignee is not null and its status is `tests`, `implementing` or
 * `review`. A title change and added lines never block.
 */
export function reconcileGuard(
  ticket: Pick<Ticket, 'status' | 'assignee' | 'checklist'>,
  diff: ReconcileDiff,
): BlockedLine[] {
  const held = ticket.assignee !== null && HELD_STATUSES.includes(ticket.status);
  const changes: { index: number; change: 'updated' | 'removed' }[] = [
    ...diff.updated
      .filter(
        (line) =>
          withoutNumber(line.text) !== withoutNumber(ticket.checklist[line.index]?.text ?? ''),
      )
      .map((line) => ({ index: line.index, change: 'updated' as const })),
    ...diff.removed.map((index) => ({ index, change: 'removed' as const })),
  ];
  const blocked: BlockedLine[] = [];
  for (const { index, change } of changes) {
    const line = ticket.checklist[index];
    if (line === undefined) {
      continue;
    }
    if (line.done) {
      blocked.push({ index, text: line.text, change, reason: 'done' });
    } else if (held) {
      blocked.push({ index, text: line.text, change, reason: 'held' });
    }
  }
  return blocked.sort((a, b) => a.index - b.index);
}

/** The statuses in which an assigned ticket's lines are not rewritten without `--force`. */
const HELD_STATUSES: readonly Status[] = ['tests', 'implementing', 'review'];

/**
 * The `source` of a `ticket.reconcile`: `<tasksFile>@sha256:<hex>`, where
 * `<hex>` is the lowercase hex SHA-256 of `bytes`, the tasks file exactly
 * as this import read it. Pure.
 */
export function reconcileSource(tasksFile: string, bytes: Uint8Array): string {
  return `${tasksFile}@sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Options of `importChange`. */
export interface ImportOptions extends WriteOptions {
  /** `--dry-run`: compute and report everything, write nothing. */
  dryRun?: boolean | undefined;
  /** `--force`: write blocked reconciles too, with `forced` true. */
  force?: boolean | undefined;
}

/**
 * What an import did (or, in a dry run, would do) to one group's ticket or
 * to one unpaired ticket:
 * - `created`: the group had no ticket, so one was created;
 * - `updated`: a paired ticket got a renumber, a reconcile, or both;
 * - `unchanged`: a paired ticket, nothing written (a closed ticket whose
 *   lines differ is `unchanged` too, with its `diff`);
 * - `blocked`: a paired ticket whose reconcile the guard blocked and
 *   `--force` was not given (a renumber may still have been written);
 * - `superseded`: a ticket paired with no group got a `ticket.supersede`.
 */
export type ImportAction = 'created' | 'updated' | 'unchanged' | 'blocked' | 'superseded';

/** One entry of an import: a group and its ticket, or an unpaired ticket. */
export interface ImportedTicket {
  /** The group's `item` (its current number); null for a `superseded` entry. */
  item: string | null;
  /** The group's title; for a `superseded` entry, the ticket's title. */
  title: string;
  /** The ticket's id; null only for a `created` entry of a dry run. */
  id: string | null;
  action: ImportAction;
  /** How the ticket was paired with the group; null for `created` and `superseded`. */
  pairing: { pass: PairPass; score: number } | null;
  /** The renumber written (or due in a dry run), else null. */
  renumber: { from: string; to: string } | null;
  /**
   * `reconcileDiff` of the paired ticket (after its renumber) against the
   * group, null when nothing differs, and null for `created` and
   * `superseded`. Also set for a closed ticket, which is never reconciled.
   */
  diff: ReconcileDiff | null;
  /** `reconcileGuard` of `diff`; empty when not blocked (and for a closed ticket). */
  blocked: BlockedLine[];
  /** True when the reconcile was (or in a dry run would be) written with `forced` true. */
  forced: boolean;
  /** The reason of the supersede written (or due), else null. */
  supersede: string | null;
  /** Hashes of the events written for this entry, in the order written; empty in a dry run. */
  events: string[];
  /**
   * The ticket after the import, as `readTicket` returns it; in a dry run
   * the ticket as it is; null only for a `created` entry of a dry run.
   */
  ticket: Ticket | null;
}

/** Result of `importChange`; also the `import-change --json` document (dry run included). */
export interface ImportResult {
  source: string;
  ref: string;
  /** Root-relative POSIX path of the tasks file read (`SourceAdapter.tasksPath`). */
  tasksFile: string;
  /** True for `--dry-run`. */
  dryRun: boolean;
  /**
   * One entry per group, in tasks file order, then one per `superseded`
   * ticket, by ascending item (`compareItems`) and then id.
   */
  tickets: ImportedTicket[];
  /** `PairingReport.ambiguous`: empty unless the pairing is ambiguous. */
  ambiguous: AmbiguousCandidate[];
  /** Total number of events written by this import (always 0 in a dry run). */
  events: number;
}

/**
 * An import refused after it computed its result: `reconcile-ambiguous`
 * (nothing written) or `reconcile-blocked` (every other group written).
 * Exit 4; `result` is the import's result (for `reconcile-ambiguous`, the
 * dry-run result, with `ambiguous` listing the candidates).
 */
export class ImportRefusedError extends BoardError {
  readonly result: ImportResult;

  constructor(
    reason: 'reconcile-ambiguous' | 'reconcile-blocked',
    message: string,
    result: ImportResult,
  ) {
    super(4, reason, message);
    this.name = 'ImportRefusedError';
    this.result = result;
  }
}

/**
 * `import-change`: makes the change's tickets follow its current tasks file
 * (board-openspec-integration: "Import a change", "Pair tickets to groups
 * by identity", "Reconcile on re-import"; board-concurrency: "Re-import is
 * idempotent"; board-events: "Fold semantics": "A ticket SHALL always be
 * created in `todo`; an import that needs another status writes the
 * permitted moves").
 *
 * Checks, in order, before anything is written:
 * 1. `actor` empty: `BoardError(1, 'missing-actor')`.
 * 2. No adapter for `target.source` (`sourceAdapter`):
 *    `BoardError(1, 'unsupported-source')`, exactly `the task source given
 *    has no adapter in this version; only openspec can be imported` (the
 *    adapters of `SOURCE_ADAPTERS` joined by `, `), which does not repeat
 *    the source.
 * 3. The units, `adapter.listUnits(dirname(board.dir), target.ref)`:
 *    `usage`, `tasks-not-found` (naming the tasks file path) or
 *    `malformed-tasks` from the adapter propagate unchanged.
 * 4. `refuseSecretLike(texts, false, false)` over every unit title and
 *    every task line text (exit 1 `secret-like`, naming the pattern only).
 *    There is no bypass flag, so the message does not mention
 *    `--allow-secret-like`. A refused import writes nothing at all.
 *
 * The change's tickets are every ticket, open or closed, whose task
 * reference has the `source` and `ref` of `target` (any item) and which is
 * not superseded; superseded tickets take no further part. The import
 * pairs them with the units (`pairTickets`, tickets by ascending id, on
 * the caught-up state) and then writes, in this order:
 * 1. the renumbers of `renumberPlan`, one `ticket.renumber {from, to}`
 *    each, in its order;
 * 2. for each unit in file order:
 *    - an unpaired unit: a new ticket, exactly as a first import creates
 *      one: one `ticket.create` with `title` the unit title, `labels`
 *      `adapter.labels(ref, unit)`, `task` `{ source, ref, item }` and
 *      `checklist` the task line texts (omitted when there are none), no
 *      description; then one `ticket.checklist` tick per ticked line in
 *      index order; then, when the unit has at least one task line and
 *      all are ticked, the moves `tests`, `implementing`, `review`,
 *      `merged`, so the ticket ends in `merged`;
 *    - a paired closed ticket: nothing (its `diff` is still reported);
 *    - a paired open ticket: `reconcileDiff` of the ticket (after its
 *      renumber) against the unit; nothing when it is null; when
 *      `reconcileGuard` returns lines and `force` is not set, nothing
 *      (the entry is `blocked`); otherwise one `ticket.reconcile` whose
 *      `title` (only when not null), `updated`, `removed` and `added` are
 *      the diff's, `forced` is true exactly when the guard returned lines
 *      (so only `force` makes it true), `holder` is the ticket's assignee
 *      when `forced` is true and the ticket is assigned (absent
 *      otherwise), and `source` is `reconcileSource(tasksFile, <the tasks
 *      file bytes this import read>)`;
 * 3. for each unpaired ticket, by ascending item (`compareItems`) then
 *    id, one `ticket.supersede` with reason
 *    `group removed from <tasksFile>`.
 * So a ticket gets at most one renumber, one reconcile and one supersede,
 * and a tasks file that matches the board writes nothing. An import never
 * changes a ticket's status or assignee, and its labels only through a
 * renumber; the moves of a newly created, fully ticked group are the only
 * status changes it writes.
 *
 * Each event is written in its own command transaction (`runCommand`, with
 * `options`), whose operation re-checks the event against the caught-up
 * state, so a concurrent import of the same change never makes this one
 * write a stale or duplicate event: a renumber whose ticket's item differs
 * from `from`, a reconcile whose diff recomputed on the caught-up ticket
 * is null (one that is not null is written as recomputed), a supersede of
 * a ticket already superseded, and the create of a unit for which a
 * concurrent import has created a ticket (a ticket of the change, not
 * superseded, with the unit's item and the unit's normalised title) are
 * refused `stale-import` inside their transaction, which commits its
 * catch-up and writes nothing, and are not reported. A crash part way
 * leaves the events written so far, and a re-import pairs again and writes
 * what is left, with one exception: a kill between a new ticket's create
 * and its ticks or moves leaves that ticket in `todo` with unticked lines,
 * which the next import reports `unchanged` (it pairs by title and its
 * lines match, and a reconcile never changes done flags of unchanged lines
 * or the status).
 *
 * Refusals after pairing (`ImportRefusedError`, exit 4):
 * - `reconcile-ambiguous` when the pairing is ambiguous: nothing at all
 *   is written; the message is the line
 *   `pairing tickets with the groups of <tasksFile> is ambiguous; nothing was written`
 *   followed, for each `AmbiguousCandidate`, by a line
 *   `  <ticket id> group <item> score <score with two decimals>`, with
 *   ` (same title)` appended when `sameTitle`; `result` is the dry-run
 *   result (`dryRun` true, `ambiguous` set).
 * - `reconcile-blocked` after every unit and unpaired ticket has been
 *   processed, when at least one entry is `blocked`; the message is the
 *   line
 *   `reconcile blocked for <n> ticket(s); every other group was imported`
 *   followed, per blocked entry in result order, by
 *   `  <id> group <item> <title>` and, per blocked line,
 *   `    blocked <index> <text> (done)` or
 *   `    blocked <index> <text> (held by <assignee> in <status>)`; `result`
 *   is the import's result.
 *
 * With `dryRun`: the same result is computed against the current state
 * and returned with `dryRun` true, `events` 0, every entry's `events`
 * empty and, for a `created` entry, `id` and `ticket` null; no event file
 * or temporary file is created, and neither refusal above is thrown (the
 * ambiguous candidates are in `ambiguous`, blocked entries are `blocked`
 * unless `force`).
 */
export function importChange(
  board: Board,
  actor: string,
  target: ImportTarget,
  options?: ImportOptions,
): ImportResult {
  requireActor(actor);
  const adapter = sourceAdapter(target.source);
  if (adapter === undefined) {
    throw new BoardError(
      1,
      'unsupported-source',
      `the task source given has no adapter in this version; only ` +
        `${SOURCE_ADAPTERS.map((a) => a.source).join(', ')} can be imported`,
    );
  }
  const hostRoot = dirname(board.dir);
  const units = adapter.listUnits(hostRoot, target.ref);
  refuseSecretLike(
    units.flatMap((unit) => [unit.title, ...unit.lines.map((line) => line.text)]),
    false,
    false,
  );
  const tasksFile = adapter.tasksPath(target.ref);
  const plan = planImport(board, target, units, tasksFile, options?.force === true);
  const base = {
    source: target.source,
    ref: target.ref,
    tasksFile,
    ambiguous: plan.ambiguous,
  };
  if (options?.dryRun === true || plan.ambiguous.length > 0) {
    const result: ImportResult = {
      ...base,
      dryRun: true,
      tickets: plan.entries.map((p) => p.entry),
      events: 0,
    };
    if (options?.dryRun === true) {
      return result;
    }
    throw new ImportRefusedError('reconcile-ambiguous', ambiguousMessage(result), result);
  }
  const bytes = readFileSync(join(hostRoot, ...tasksFile.split('/')));
  const writer: Writer = {
    board,
    actor,
    target,
    labels: (unit) => adapter.labels(target.ref, unit),
    source: reconcileSource(tasksFile, bytes),
    force: options?.force === true,
    options,
  };
  writeImport(writer, plan);
  const tickets = plan.entries.map((p) => p.entry);
  const result: ImportResult = {
    ...base,
    dryRun: false,
    tickets,
    events: tickets.reduce((sum, t) => sum + t.events.length, 0),
  };
  const blocked = tickets.filter((t) => t.action === 'blocked');
  if (blocked.length > 0) {
    throw new ImportRefusedError('reconcile-blocked', blockedMessage(blocked), result);
  }
  return result;
}

/** One entry of the plan: the reported entry plus what the writer needs. */
interface Planned {
  entry: ImportedTicket;
  /** The group of a `created` or paired entry; null for a `superseded` one. */
  unit: TaskUnit | null;
}

/** What `planImport` computes, before anything is written. */
interface Plan {
  /** In result order: one per unit in file order, then the superseded tickets. */
  entries: Planned[];
  /** `renumberPlan` of the pairing. */
  renumbers: RenumberStep[];
  ambiguous: AmbiguousCandidate[];
}

/**
 * Pairs the change's tickets with `units` on the board's current state and
 * computes every entry as a dry run reports it.
 */
function planImport(
  board: Board,
  target: ImportTarget,
  units: readonly TaskUnit[],
  tasksFile: string,
  force: boolean,
): Plan {
  const tickets = Object.values(readState(board.db).tickets)
    .filter(
      (t) => t.superseded === null && t.task?.source === target.source && t.task.ref === target.ref,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const report = pairTickets(tickets, units);
  const renumbers = renumberPlan(tickets, report.pairs);
  const entries: Planned[] = units.map((unit) => {
    const pair = report.pairs.find((p) => p.item === unit.item);
    const ticket = pair === undefined ? undefined : byId.get(pair.ticket);
    if (pair === undefined || ticket === undefined) {
      return { entry: createdEntry(unit, null, [], null), unit };
    }
    const step = renumbers.find((r) => r.ticket === ticket.id);
    const renumber = step === undefined ? null : { from: step.from, to: step.to };
    const diff = reconcileDiff(ticket, unit);
    const blocked = ticket.closed || diff === null ? [] : reconcileGuard(ticket, diff);
    const writesReconcile = !ticket.closed && diff !== null && (blocked.length === 0 || force);
    let action: ImportAction = 'unchanged';
    if (!ticket.closed && blocked.length > 0 && !force) {
      action = 'blocked';
    } else if (renumber !== null || writesReconcile) {
      action = 'updated';
    }
    const entry: ImportedTicket = {
      item: unit.item,
      title: unit.title,
      id: ticket.id,
      action,
      pairing: { pass: pair.pass, score: pair.score },
      renumber,
      diff,
      blocked,
      forced: writesReconcile && blocked.length > 0,
      supersede: null,
      events: [],
      ticket,
    };
    return { entry, unit };
  });
  const reason = `group removed from ${tasksFile}`;
  const unpaired = report.unpaired
    .map((id) => byId.get(id))
    .filter((t): t is Ticket => t !== undefined)
    .sort((a, b) => compareItems(a.task?.item ?? '', b.task?.item ?? '') || (a.id < b.id ? -1 : 1));
  for (const ticket of unpaired) {
    entries.push({
      entry: {
        item: null,
        title: ticket.title,
        id: ticket.id,
        action: 'superseded',
        pairing: null,
        renumber: null,
        diff: null,
        blocked: [],
        forced: false,
        supersede: reason,
        events: [],
        ticket,
      },
      unit: null,
    });
  }
  return { entries, renumbers, ambiguous: report.ambiguous };
}

/** A `created` entry; `id` and `ticket` are null in a dry run. */
function createdEntry(
  unit: TaskUnit,
  id: string | null,
  events: string[],
  ticket: Ticket | null,
): ImportedTicket {
  return {
    item: unit.item,
    title: unit.title,
    id,
    action: 'created',
    pairing: null,
    renumber: null,
    diff: null,
    blocked: [],
    forced: false,
    supersede: null,
    events,
    ticket,
  };
}

/** What the writer of an import needs besides the plan. */
interface Writer {
  board: Board;
  actor: string;
  target: ImportTarget;
  labels: (unit: TaskUnit) => string[];
  /** The `source` of every reconcile this import writes. */
  source: string;
  force: boolean;
  options: ImportOptions | undefined;
}

/**
 * Thrown by a `propose` of `writeOne` when the event it would write is
 * stale or redundant on the caught-up state. Never escapes this module.
 */
class Skip extends Error {
  constructor() {
    super('nothing left to write');
  }
}

/**
 * Writes one event in its own command transaction; `propose` re-checks it
 * against the caught-up state and returns it, or throws `Skip`. A skip is
 * a refusal with reason `stale-import`, so the transaction commits its
 * catch-up and writes no event of its own; a write the fold itself rejects
 * `stale-import` is skipped the same way. Returns the command's result, or
 * null when skipped.
 */
function writeOne(w: Writer, propose: (ctx: TxContext) => ProposedEvent): CommandResult | null {
  try {
    return runCommand(
      w.board,
      w.actor,
      (ctx) => {
        try {
          return { ok: true, event: propose(ctx) };
        } catch (error) {
          if (error instanceof Skip) {
            return {
              ok: false,
              exitCode: 4,
              reason: 'stale-import',
              message: 'a concurrent import already made this change',
            };
          }
          throw error;
        }
      },
      w.options,
    );
  } catch (error) {
    if (error instanceof BoardError && error.reason === 'stale-import') {
      return null;
    }
    throw error;
  }
}

/**
 * Writes the plan, in order: the renumbers, then each group in file order
 * (a create or a reconcile), then the supersedes. Updates each entry with
 * the events written and the ticket after the import.
 */
function writeImport(w: Writer, plan: Plan): void {
  const byId = new Map(
    plan.entries
      .filter((p) => p.entry.id !== null)
      .map((p) => [p.entry.id ?? '', p.entry] as const),
  );
  for (const step of plan.renumbers) {
    const result = writeOne(w, (ctx) => {
      const ticket = ctx.ticket(step.ticket);
      if (ticket?.superseded !== null || ticket.task?.item !== step.from) {
        throw new Skip();
      }
      return {
        kind: 'ticket.renumber',
        ticket: step.ticket,
        body: { from: step.from, to: step.to },
      };
    });
    if (result !== null) {
      byId.get(step.ticket)?.events.push(result.hash);
    }
  }
  for (const planned of plan.entries) {
    const { entry, unit } = planned;
    if (unit === null) {
      continue;
    }
    if (entry.action === 'created') {
      planned.entry = createTicket(w, unit);
    } else if (entry.id !== null && entry.ticket?.closed === false) {
      reconcileTicket(w, entry, unit);
    }
  }
  for (const { entry } of plan.entries) {
    if (entry.action !== 'superseded' || entry.id === null || entry.supersede === null) {
      continue;
    }
    const id = entry.id;
    const reason = entry.supersede;
    const result = writeOne(w, (ctx) => {
      if (ctx.ticket(id)?.superseded !== null) {
        throw new Skip();
      }
      return { kind: 'ticket.supersede', ticket: id, body: { reason } };
    });
    if (result !== null) {
      entry.events.push(result.hash);
    }
  }
  for (const { entry } of plan.entries) {
    if (entry.id !== null) {
      entry.ticket = readTicket(w.board.db, entry.id);
    }
    if (entry.action === 'updated' && entry.events.length === 0) {
      entry.action = 'unchanged';
    }
  }
}

/**
 * Writes the reconcile of a paired open ticket, recomputing its diff and
 * guard on the caught-up ticket, and updates `entry` with what was written
 * (or with the block that stopped it).
 */
function reconcileTicket(w: Writer, entry: ImportedTicket, unit: TaskUnit): void {
  const id = entry.id ?? '';
  let diff = entry.diff;
  let blocked = entry.blocked;
  const result = writeOne(w, (ctx) => {
    const ticket = ctx.ticket(id);
    if (ticket === null || ticket.closed || ticket.superseded !== null) {
      throw new Skip();
    }
    diff = reconcileDiff(ticket, unit);
    blocked = diff === null ? [] : reconcileGuard(ticket, diff);
    if (diff === null || (blocked.length > 0 && !w.force)) {
      throw new Skip();
    }
    const forced = blocked.length > 0;
    const body: TicketReconcileBody = {
      updated: diff.updated,
      removed: diff.removed,
      added: diff.added,
      forced,
      source: w.source,
    };
    if (diff.title !== null) {
      body.title = diff.title;
    }
    if (forced && ticket.assignee !== null) {
      body.holder = ticket.assignee;
    }
    return { kind: 'ticket.reconcile', ticket: id, body };
  });
  entry.diff = diff;
  entry.blocked = blocked;
  if (result !== null) {
    entry.events.push(result.hash);
    entry.forced = blocked.length > 0;
    entry.action = 'updated';
  } else {
    entry.forced = false;
    entry.action = blocked.length > 0 && !w.force ? 'blocked' : entry.action;
  }
}

/**
 * Creates the ticket of an unpaired unit, exactly as a first import does,
 * unless a concurrent import has meanwhile created one (a ticket of the
 * change, not superseded, with the unit's item and normalised title): then
 * nothing is written and that ticket is reported `unchanged`.
 */
function createTicket(w: Writer, unit: TaskUnit): ImportedTicket {
  const task: TaskRef = { source: w.target.source, ref: w.target.ref, item: unit.item };
  const found: { id: string | null } = { id: null };
  const first = writeOne(w, () => {
    found.id = concurrentTicket(w.board, task, unit.title);
    if (found.id !== null) {
      throw new Skip();
    }
    const body: TicketCreateBody = { title: unit.title, task };
    const labels = w.labels(unit);
    if (labels.length > 0) {
      body.labels = [...labels];
    }
    if (unit.lines.length > 0) {
      body.checklist = unit.lines.map((line) => line.text);
    }
    return { kind: 'ticket.create', ticket: newUlid(), body };
  });
  if (first === null) {
    const id = found.id ?? '';
    const entry = createdEntry(unit, id, [], readTicket(w.board.db, id));
    entry.action = 'unchanged';
    return entry;
  }
  const id = ticketOf(first.ticket).id;
  const events = [first.hash];
  const follow: ProposedEvent[] = [];
  unit.lines.forEach((line, index) => {
    if (line.done) {
      follow.push({ kind: 'ticket.checklist', ticket: id, body: { index, done: true } });
    }
  });
  if (unit.lines.length > 0 && unit.lines.every((line) => line.done)) {
    for (const to of MERGED_PATH) {
      follow.push({ kind: 'ticket.move', ticket: id, body: { to } });
    }
  }
  for (const event of follow) {
    events.push(runCommand(w.board, w.actor, () => ({ ok: true, event }), w.options).hash);
  }
  return createdEntry(unit, id, events, null);
}

/** The id of a ticket of the change, not superseded, with `task.item` and the normalised `title`, or null. */
function concurrentTicket(board: Board, task: TaskRef, title: string): string | null {
  const rows = stmt(
    board.db,
    'SELECT id, title FROM tickets WHERE task_source = ? AND task_ref = ? AND task_item = ? ' +
      'AND superseded IS NULL ORDER BY id',
  ).all(task.source, task.ref, task.item);
  const wanted = normaliseTitle(title);
  const found = rows.find((row) => normaliseTitle(String(row.title)) === wanted);
  return found === undefined ? null : String(found.id);
}

/** The permitted moves from `todo` to `merged`, in order. */
const MERGED_PATH: readonly Status[] = ['tests', 'implementing', 'review', 'merged'];

/** A score with two decimals, as the reports print it. */
function twoDecimals(score: number): string {
  return score.toFixed(2);
}

/** The message of `reconcile-ambiguous`. */
function ambiguousMessage(result: ImportResult): string {
  const lines = [
    `pairing tickets with the groups of ${asciiText(result.tasksFile)} is ambiguous; nothing was written`,
  ];
  for (const c of result.ambiguous) {
    lines.push(
      `  ${c.ticket} group ${asciiText(c.item)} score ${twoDecimals(c.score)}` +
        (c.sameTitle ? ' (same title)' : ''),
    );
  }
  return lines.join('\n');
}

/** The text of a blocked line, as the refusal and `renderImport` print it. */
function blockedLineText(line: BlockedLine, ticket: Ticket | null): string {
  const why =
    line.reason === 'done'
      ? 'done'
      : `held by ${asciiText(ticket?.assignee ?? '-')} in ${ticket?.status ?? 'todo'}`;
  return `blocked ${String(line.index)} ${asciiText(line.text)} (${why})`;
}

/** The message of `reconcile-blocked`. */
function blockedMessage(blocked: readonly ImportedTicket[]): string {
  const lines = [
    `reconcile blocked for ${String(blocked.length)} ticket(s); every other group was imported`,
  ];
  for (const entry of blocked) {
    lines.push(
      `  ${entry.id ?? '-'} group ${asciiText(entry.item ?? '-')} ${asciiText(entry.title)}`,
    );
    for (const line of entry.blocked) {
      lines.push(`    ${blockedLineText(line, entry.ticket)}`);
    }
  }
  return lines.join('\n');
}
