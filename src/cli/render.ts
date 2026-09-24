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
  const markers = (ticket.adhoc === null ? '' : '[adhoc] ') + (ticket.closed ? '[closed] ' : '');
  return [
    ticket.id,
    ticket.status,
    ticket.assignee === null ? '-' : asciiText(ticket.assignee),
    `${markers}${asciiText(ticket.title)}`,
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
