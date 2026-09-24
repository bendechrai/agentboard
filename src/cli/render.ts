/**
 * Human output (board-cli: "Output conventions"): plain ASCII, one line
 * per ticket in `list`, a full record in `show`.
 */

import type { Ticket } from '../events/fold.js';
import { formatTaskRef } from '../events/schema.js';
import { asciiText } from '../board/text.js';
import type { InboxEntry } from '../board/inbox.js';
import type { ShowResult } from '../board/tickets.js';
import { CACHE_SCHEMA_VERSION } from '../store/cache.js';
import type { CheckResult, RebuildReport } from '../store/rebuild.js';
import type { Card } from '../view/columns.js';
import type { HealthReport } from '../view/health.js';
import { relativeTime } from '../view/time.js';

/** Re-exported from `src/board/text.ts` (defined there for layering). */
export { asciiText };

/**
 * The `list` line of a ticket, without a newline:
 * `<full 26-character id>  <status>  <assignee or ->  <markers><title>`,
 * fields separated by two spaces, where `<markers>` is `[adhoc] ` for a
 * ticket with an ad hoc reason and `[closed] ` for a closed ticket (in
 * that order when both apply), and assignee and title pass through
 * `asciiText`. Example:
 * `01ARYZ6S41TSV4RRFFQ69G5FAV  todo  -  [adhoc] Fix thing`. The id is never
 * shortened, so every id printed by `list` can be pasted back into any
 * command. Pure.
 */
export function renderListLine(ticket: Ticket): string {
  return listLine({ ...ticket, adhoc: ticket.adhoc !== null });
}

/** The fields of a `list` line. */
type ListFields = Pick<Card, 'id' | 'status' | 'assignee' | 'adhoc' | 'closed' | 'title'>;

/** The `list` line of `fields` (see `renderListLine`). */
function listLine(fields: ListFields): string {
  const markers = (fields.adhoc ? '[adhoc] ' : '') + (fields.closed ? '[closed] ' : '');
  return [
    fields.id,
    fields.status,
    fields.assignee === null ? '-' : asciiText(fields.assignee),
    `${markers}${asciiText(fields.title)}`,
  ].join('  ');
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
  const t = show.ticket;
  const orDash = (text: string | null): string => (text === null ? '-' : asciiText(text));
  const lines = [
    `id: ${t.id}`,
    `title: ${asciiText(t.title)}`,
    `status: ${t.status}${t.blockedFrom === null ? '' : ` (from ${t.blockedFrom})`}`,
    `assignee: ${orDash(t.assignee)}`,
  ];
  if (t.task !== null) {
    lines.push(`task: ${asciiText(formatTaskRef(t.task))}`);
  } else if (t.adhoc !== null) {
    lines.push(`adhoc: ${asciiText(t.adhoc)}`);
  } else {
    lines.push('task: -');
  }
  lines.push(
    `labels: ${t.labels.length === 0 ? '-' : t.labels.map(asciiText).join(', ')}`,
    `description: ${orDash(t.description)}`,
    'checklist:',
    ...t.checklist.map(
      (item, i) => `  [${item.done ? 'x' : ' '}] ${String(i)} ${asciiText(item.text)}`,
    ),
    'links:',
    ...t.links.map((l) =>
      l.type === 'pr' ? `  pr ${asciiText(String(l.pr))}` : `  decision ${asciiText(l.path)}`,
    ),
    'comments:',
    ...t.comments.map((c) => `  ${asciiText(c.actor)}: ${asciiText(c.text)}`),
    `closed: ${closedText(t)}`,
    `events: ${String(show.events)}`,
    ...show.unknown.map((u) => `unknown: ${asciiText(u.kind)} ${u.hash}`),
  );
  return `${lines.join('\n')}\n`;
}

function closedText(t: Ticket): string {
  if (!t.closed || t.disposition === null) {
    return 'no';
  }
  return 'decision' in t.disposition
    ? `yes (decision: ${asciiText(t.disposition.decision)})`
    : 'yes (no decision)';
}

/**
 * The human line of one inbox entry (`inbox` and `watch`), without a
 * newline: fields separated by two spaces,
 * `<ticket id or ->  <kind>  <from>`, then `to <to>`, `status <status>` and
 * `note <note>`, each only when the entry's field is not null, in that
 * order; `from`, `to` and `note` pass through `asciiText`. Example:
 * `01ARYZ6S41TSV4RRFFQ69G5FAV  ticket.handoff  impl  to reviewer  status review  note done`.
 * Pure.
 */
export function renderInboxLine(entry: InboxEntry): string {
  const fields = [entry.ticket ?? '-', entry.kind, asciiText(entry.from)];
  if (entry.to !== null) {
    fields.push(`to ${asciiText(entry.to)}`);
  }
  if (entry.status !== null) {
    fields.push(`status ${entry.status}`);
  }
  if (entry.note !== null) {
    fields.push(`note ${asciiText(entry.note)}`);
  }
  return fields.join('  ');
}

/**
 * The counts of a rebuild report, as used by `renderRebuild` and
 * `renderCheck`, without a newline:
 * `<folded> folded, <rejected> rejected, <malformed> malformed, <corrupt> corrupt, <unknown> unknown`.
 * Example: `3 folded, 1 rejected, 0 malformed, 0 corrupt, 0 unknown`. Pure.
 */
export function renderCounts(report: RebuildReport): string {
  return [
    `${String(report.folded)} folded`,
    `${String(report.rejected)} rejected`,
    `${String(report.malformed)} malformed`,
    `${String(report.corrupt)} corrupt`,
    `${String(report.unknown)} unknown`,
  ].join(', ');
}

/**
 * Human output of `agentboard rebuild`: the line
 * `rebuilt: <renderCounts(report)>`, then one line per corrupt file
 * (`  corrupt <name>`, in `report.corruptFiles` order) and one per malformed
 * file (`  malformed <hash>.json`, in `report.malformedFiles` order), each
 * ending with a newline. `rebuild` opens the board without catch-up, so the
 * open reports nothing and these files are reported here. Example:
 *
 * ```
 * rebuilt: 3 folded, 1 rejected, 1 malformed, 0 corrupt, 0 unknown
 *   malformed 5f0c...e1.json
 * ```
 *
 * Names pass through `asciiText`. Pure.
 */
export function renderRebuild(report: RebuildReport): string {
  const lines = [`rebuilt: ${renderCounts(report)}`];
  for (const file of report.corruptFiles) {
    lines.push(`  corrupt ${asciiText(file.name)}`);
  }
  for (const file of report.malformedFiles) {
    lines.push(`  malformed ${asciiText(file.hash)}.json`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The `--json` document of `agentboard rebuild --check` (board-cache:
 * "Rebuild").
 *
 * - The cache is a cache of the running schema version: the store's
 *   `CheckResult` plus `noCache: false` and `schemaMismatch: false`.
 * - No cache file exists (`<board>/cache.sqlite` is absent): `{ ok: false,
 *   noCache: true, schemaMismatch: false, differences: [], report: null }`.
 *   Nothing is created and no event file is read.
 * - The cache file exists but is not a cache of `CACHE_SCHEMA_VERSION`
 *   (another `meta.schema_version`, an empty file, not a SQLite database,
 *   no `meta` table): `{ ok: false, noCache: false, schemaMismatch: true,
 *   differences: [], report: null }`. The file is left byte for byte
 *   unchanged, cursor rows included.
 */
export type CheckDocument =
  | (CheckResult & { noCache: false; schemaMismatch: false })
  | { ok: false; noCache: true; schemaMismatch: false; differences: []; report: null }
  | { ok: false; noCache: false; schemaMismatch: true; differences: []; report: null };

/**
 * Human output of `agentboard rebuild --check`, ending with a newline.
 *
 * - No cache file (`doc.noCache`): one line, `no-cache: there is no cache file`.
 * - Not a cache of this version (`doc.schemaMismatch`): one line,
 *   `schema-mismatch: the cache file is not a cache of schema version <CACHE_SCHEMA_VERSION>`.
 * - No divergence (`doc.ok`): one line,
 *   `no divergence: <renderCounts(doc.report)>`.
 * - Divergence: a first line `divergence: <n> differing row(s)` (`<n>` the
 *   number of differences), then one line per difference, in the order of
 *   `doc.differences`: two spaces, the table, the key and the state,
 *   separated by single spaces, where the state is `changed` (the row is on
 *   both sides and differs), `only-in-cache` (`rebuilt` is null) or
 *   `only-in-rebuild` (`live` is null). The key of a `tickets` row is the
 *   ticket id and that of a `comments` or `links` row is `<ticket>#<seq>`,
 *   so every differing ticket is named. Example:
 *
 * ```
 * divergence: 1 differing row(s)
 *   tickets 01ARYZ6S41TSV4RRFFQ69G5FAV changed
 * ```
 *
 * Keys pass through `asciiText`. Row contents are never printed (the
 * `--json` document carries them). Pure.
 */
export function renderCheck(doc: CheckDocument): string {
  if (doc.noCache) {
    return 'no-cache: there is no cache file\n';
  }
  if (doc.schemaMismatch) {
    return `schema-mismatch: the cache file is not a cache of schema version ${String(CACHE_SCHEMA_VERSION)}\n`;
  }
  if (doc.ok) {
    return `no divergence: ${renderCounts(doc.report)}\n`;
  }
  const lines = [`divergence: ${String(doc.differences.length)} differing row(s)`];
  for (const difference of doc.differences) {
    const state =
      difference.rebuilt === null
        ? 'only-in-cache'
        : difference.live === null
          ? 'only-in-rebuild'
          : 'changed';
    lines.push(`  ${difference.table} ${asciiText(difference.key)} ${state}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Human output of `agentboard health` (board-insights: "Health command":
 * each section with its count, then one line per ticket in the `list`
 * format followed by the finding). Every line ends with a newline; user
 * text (titles, assignees, actors, comment text, pr values) passes through
 * `asciiText`. Lines, in this order:
 *
 * ```
 * thresholds: stale after <S>, blocked after <B>
 * stale claims: <n>
 * <card>  last active <age> (<kind> by <actor>)
 * stuck in blocked: <n>
 * <card>  blocked <age> from <status>; latest comment by <actor>: <text>
 * unpromoted decisions: <n>
 * <card>  <k> open decision(s), no decision link
 * close-merged ready: <n>
 * <card>  pr <prs>
 * close-merged held by decision: <n>
 * <card>  pr <prs>; <k> open decision(s), no decision link
 * close-merged missing pr: <n>
 * <card>  no pr link
 * cache check: <check>
 * ```
 *
 * where:
 * - `<S>` and `<B>` are `report.thresholds.staleAfter` and `blockedAfter`
 *   written with the largest unit that divides them exactly: `<n>d` for a
 *   whole number of days, else `<n>h` for whole hours, else `<n>m` for
 *   whole minutes, else `<n>ms` (so 7200000 is `2h`, 86400000 is `1d`,
 *   5400000 is `90m`).
 * - `<n>` is the number of entries of the section, and the section's
 *   ticket lines follow its heading, in the report's order; a section with
 *   no entry is just its heading with `0`.
 * - `<card>` is the `list` line of the finding's `ticket` card, exactly as
 *   `renderListLine` writes a ticket with the same id, status, assignee,
 *   ad hoc marker, closed marker and title:
 *   `<id>  <status>  <assignee or ->  <markers><title>`.
 * - `<age>` is `relativeTime` (`src/view/time.ts`) of `idleMs` or
 *   `blockedMs`, for example `3h ago`.
 * - stale claim: `<kind>` and `<actor>` are `since.kind` and `since.actor`.
 * - stuck in blocked: `<status>` is `blockedFrom`; when `latestComment` is
 *   null the text after `; ` is `no comment` instead.
 * - `<k> open decision(s)` is `1 open decision` or `<k> open decisions`
 *   (`<k>` the length of `decisions`).
 * - `<prs>` is the candidate's `prs`, each through `String` and
 *   `asciiText`, joined with `, `.
 * - `<check>` is `not run` when `report.check` is null, `matches (0
 *   differing rows)` when it matches, and `differs (<d> differing rows)`
 *   otherwise (`<d>` is `differingRows`; the word stays `rows` for 1).
 *
 * `report.late` is not printed (it is null for the CLI). Pure.
 *
 * Example:
 *
 * ```
 * thresholds: stale after 2h, blocked after 1d
 * stale claims: 1
 * 01ARYZ6S41TSV4RRFFQ69G5FAV  implementing  impl  Parser  last active 3h ago (ticket.claim by impl)
 * stuck in blocked: 0
 * unpromoted decisions: 0
 * close-merged ready: 0
 * close-merged held by decision: 0
 * close-merged missing pr: 0
 * cache check: not run
 * ```
 */
export function renderHealth(report: HealthReport): string {
  const { thresholds, staleClaims, stuckBlocked, unpromotedDecisions, closeMerged } = report;
  const lines = [
    `thresholds: stale after ${durationText(thresholds.staleAfter)}, blocked after ${durationText(thresholds.blockedAfter)}`,
  ];
  const section = <T extends { ticket: Card }>(
    heading: string,
    entries: readonly T[],
    finding: (entry: T) => string,
  ): void => {
    lines.push(`${heading}: ${String(entries.length)}`);
    for (const entry of entries) {
      lines.push(`${listLine(entry.ticket)}  ${finding(entry)}`);
    }
  };
  section(
    'stale claims',
    staleClaims,
    (s) =>
      `last active ${relativeTime(s.idleMs)} (${asciiText(s.since.kind)} by ${asciiText(s.since.actor)})`,
  );
  section('stuck in blocked', stuckBlocked, (s) => {
    const comment =
      s.latestComment === null
        ? 'no comment'
        : `latest comment by ${asciiText(s.latestComment.actor)}: ${asciiText(s.latestComment.text)}`;
    return `blocked ${relativeTime(s.blockedMs)} from ${s.blockedFrom}; ${comment}`;
  });
  section('unpromoted decisions', unpromotedDecisions, (u) => decisionsText(u.decisions.length));
  section('close-merged ready', closeMerged.ready, (c) => prsText(c.prs));
  section(
    'close-merged held by decision',
    closeMerged.heldByDecision,
    (c) => `${prsText(c.prs)}; ${decisionsText(c.decisions.length)}`,
  );
  section('close-merged missing pr', closeMerged.missingPr, () => 'no pr link');
  const check = report.check;
  lines.push(
    `cache check: ${
      check === null
        ? 'not run'
        : `${check.matches ? 'matches' : 'differs'} (${String(check.differingRows)} differing rows)`
    }`,
  );
  return `${lines.join('\n')}\n`;
}

/** A threshold in the largest unit that divides it exactly: d, h, m, else ms. */
function durationText(ms: number): string {
  for (const [unit, scale] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
  ] as const) {
    if (ms % scale === 0) {
      return `${String(ms / scale)}${unit}`;
    }
  }
  return `${String(ms)}ms`;
}

/** `1 open decision` or `<k> open decisions`, then `, no decision link`. */
function decisionsText(k: number): string {
  return `${String(k)} open decision${k === 1 ? '' : 's'}, no decision link`;
}

/** `pr <p1>, <p2>, ...`. */
function prsText(prs: readonly (string | number)[]): string {
  return `pr ${prs.map((pr) => asciiText(String(pr))).join(', ')}`;
}
