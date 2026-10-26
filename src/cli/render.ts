/**
 * Human output (board-cli: "Output conventions"): plain ASCII, one line
 * per ticket in `list`, a full record in `show`.
 */

import type { Ticket } from '../events/fold.js';
import { formatTaskRef } from '../events/schema.js';
import { asciiText } from '../board/text.js';
import type { ConfigResult } from '../board/config.js';
import type { ImportAction, ImportResult, ImportedTicket } from '../board/import.js';
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
 * `<full 26-character id>  <status>  <assignee>  <markers><title>`,
 * fields separated by two spaces, where `<assignee>` is
 * `assigneeToken(ticket, now)` (`src/board/leases.ts`: the actor or `-`,
 * with the lease and queue suffixes, for example `merger-1*+2m^3`) when
 * `now` is given, as `list` gives it (its clock reading, the same one its
 * `--json` lease states are computed at), and the assignee or `-` alone
 * when `now` is omitted (the result line of a writing command), and
 * `<markers>` is `[unplanned] ` for
 * a ticket with an unplanned disposition (`unplanned` not null), else
 * `[adhoc] ` for a ticket with an ad hoc reason and no unplanned
 * disposition, then `[closed] ` for a closed ticket, then `[superseded] `
 * for a superseded one (in that order when several apply; a ticket with a
 * task reference shows neither of the first two: board-openspec-integration
 * "Ad hoc markers in list"), and assignee and title pass through
 * `asciiText`. Examples:
 * `01ARYZ6S41TSV4RRFFQ69G5FAV  todo  -  [adhoc] Fix thing`,
 * `01ARYZ6S41TSV4RRFFQ69G5FAV  merged  -  [unplanned] Fix thing`,
 * `01ARYZ6S41TSV4RRFFQ69G5FAV  blocked  -  [unplanned] [closed] Fix thing`,
 * `01ARYZ6S41TSV4RRFFQ69G5FAV  merged  -  [closed] [superseded] Old group`.
 * The id is never shortened, so every id printed by `list` can be pasted
 * back into any command. Pure.
 */
export function renderListLine(ticket: Ticket, now?: number): string {
  void now;
  return listLine({
    ...ticket,
    adhoc: ticket.adhoc !== null,
    unplanned: ticket.unplanned !== null,
    superseded: typeof ticket.superseded === 'string',
  });
}

/**
 * The fields of a `list` line; `superseded` is absent where the source (a
 * health card) does not carry it, and then no marker is printed.
 */
type ListFields = Pick<Card, 'id' | 'status' | 'assignee' | 'adhoc' | 'closed' | 'title'> & {
  /** The unplanned marker: true when the ticket has an unplanned disposition. */
  unplanned: boolean;
  superseded?: boolean;
};

/** The `list` line of `fields` (see `renderListLine`). */
function listLine(fields: ListFields): string {
  const scope = fields.unplanned ? '[unplanned] ' : fields.adhoc ? '[adhoc] ' : '';
  const markers =
    scope +
    (fields.closed ? '[closed] ' : '') +
    (fields.superseded === true ? '[superseded] ' : '');
  return [
    fields.id,
    fields.status,
    fields.assignee === null ? '-' : asciiText(fields.assignee),
    `${markers}${asciiText(fields.title)}`,
  ].join('  ');
}

/**
 * The `show` record, one `<label>: <value>` per line, ending with a
 * newline, user text (actors, reasons, titles) through `asciiText`, times
 * as `isoTime` (`src/board/leases.ts`). A ticket without a lease, waiters,
 * grant, takeover or forced release prints exactly what it printed before
 * leases existed. Example of a held ticket with waiters:
 *
 * ```
 * assignee: merger-1
 * lease: live, ttl 30m, expires 2026-10-26T12:28:20.000Z, claimable from 2026-10-26T12:29:20.000Z
 * next grant: merger-2 at 2026-10-26T12:29:20.001Z, accept by 2026-10-26T12:31:20.001Z
 * queue:
 *   1 merger-2 (joined 2026-10-26T11:58:30.000Z, ttl 30m)
 * ```
 *
 * The record:
 *
 * ```
 * id: <full id>
 * title: <title>
 * status: <status>                  (blocked: `blocked (from <origin>)`)
 * assignee: <assignee or ->
 * lease: <state>[ (grace)], ttl <ttl>, expires <iso>, claimable from <iso>
 *                                   (only with a lease: its `state`, ` (grace)`
 *                                    while not confirmed, `formatDuration(ttl)`,
 *                                    `isoTime(expiresAt)`, `isoTime(claimableAt)`)
 * granted: <to> at <iso>, accept by <iso>
 *                                   (only with `show.grant`: `to`, `at`, `acceptBy`)
 * next grant: <to> at <iso>, accept by <iso>
 *                                   (only with `show.nextGrant`)
 * queue:                            (only with waiters; then per waiter, in order,
 *                                    `  <position> <actor> (joined <iso>, ttl <ttl>)`,
 *                                    position from 1, `isoTime(joined.wall)`,
 *                                    `formatDuration(ttl)`)
 * takeover: <actor> at <iso> from <holder> (lease expired <iso>)
 *                                   (only with `show.takeover`: `at`, then
 *                                    `expiresAt` of the lease it replaced)
 * forced release: <actor> at <iso> from <holder>: <reason>
 *                                   (only with `show.forcedRelease`)
 * task: <source>:<ref>#<item>       (or `adhoc: <reason>`, or `task: -`)
 * unplanned: <reason> (by <actor>)  (only when the ticket has an unplanned
 *                                    disposition: its reason and actor,
 *                                    right after the task or adhoc line)
 * labels: <comma+space separated, or ->
 * description: <text or ->
 * checklist:                        (then per line `  [x] <index> <text>` or `  [ ] ...`;
 *                                    a removed line ends with ` (removed)`)
 * links:                            (then per link `  pr <n or url>` or `  decision <path>`)
 * comments:                         (then per comment, in order, `  <actor>: <text>`)
 * closed: no                        (or `yes (decision: <path>)` or `yes (no decision)`)
 * superseded: <reason>              (only when the ticket is superseded)
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
  if (t.unplanned !== null) {
    lines.push(`unplanned: ${asciiText(t.unplanned.reason)} (by ${asciiText(t.unplanned.actor)})`);
  }
  lines.push(
    `labels: ${t.labels.length === 0 ? '-' : t.labels.map(asciiText).join(', ')}`,
    `description: ${orDash(t.description)}`,
    'checklist:',
    ...t.checklist.map(
      (item, i) =>
        `  [${item.done ? 'x' : ' '}] ${String(i)} ${asciiText(item.text)}` +
        (item.removed === true ? ' (removed)' : ''),
    ),
    'links:',
    ...t.links.map((l) =>
      l.type === 'pr' ? `  pr ${asciiText(String(l.pr))}` : `  decision ${asciiText(l.path)}`,
    ),
    'comments:',
    ...t.comments.map((c) => `  ${asciiText(c.actor)}: ${asciiText(c.text)}`),
    `closed: ${closedText(t)}`,
    ...(t.superseded === null ? [] : [`superseded: ${asciiText(t.superseded)}`]),
    `events: ${String(show.events)}`,
    ...show.unknown.map((u) => `unknown: ${asciiText(u.kind)} ${u.hash}`),
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Human output of `import-change` (with or without `--dry-run`), ending
 * with a newline. User text (titles, line texts, actors, reasons) passes
 * through `asciiText`. Pure.
 *
 * For each entry of `result.tickets`, in order, a head line:
 * - `<action> <renderListLine(ticket)>` when the entry has a ticket;
 * - `created group <item>: <title>` for a `created` entry of a dry run.
 * Then, each starting with two spaces and only when it applies, in this
 * order:
 * - dry run only, when `pairing` is not null:
 *   `  paired by <pass> (score <score with two decimals>)`;
 * - `renumber`: `  renumbered from group <from> to <to>`;
 * - `supersede`: `  superseded: <reason>`;
 * - when `diff` is not null: `  title: <new title>` (when its `title` is
 *   not null); per `updated` line `  updated [x] <index> <text>` (or
 *   `[ ]`, the line's new done flag, and its new text); per removed index
 *   `  removed [x] <index> <text>` (or `[ ]`, the line's current done flag
 *   and text on the ticket); per added line `  added [x] <text>` (or
 *   `[ ]`); then, when the entry's ticket is closed,
 *   `  not reconciled: closed`;
 * - per `blocked` line `  blocked <index> <text> (done)` or
 *   `  blocked <index> <text> (held by <assignee> in <status>)`;
 * - when `forced`: `  forced`.
 * Then, in a dry run with candidates, one line per `ambiguous` candidate:
 * `ambiguous <ticket id> group <item> (score <two decimals>)`, with
 * ` same title` before the closing parenthesis when `sameTitle`
 * (`... (score 0.00 same title)`).
 * Then the summary line, where the blocked and superseded counts appear
 * only when not zero:
 * - `imported <source>:<ref>: <c> created, <u> updated, <n> unchanged[, <b> blocked][, <s> superseded], <e> events`;
 * - dry run: `dry run <source>:<ref>: <c> created, <u> updated, <n> unchanged[, <b> blocked][, <s> superseded][, ambiguous], nothing written`,
 *   with `, ambiguous` when `ambiguous` is not empty.
 * Example (a dry run renumbering one ticket and creating one):
 *
 * ```
 * created group 5: Leases
 * updated 01ARYZ6S41TSV4RRFFQ69G5FAV  todo  -  Docs
 *   paired by title (score 1.00)
 *   renumbered from group 5 to 6
 * dry run openspec:add-x: 1 created, 1 updated, 0 unchanged, nothing written
 * ```
 */
export function renderImport(result: ImportResult): string {
  const lines: string[] = [];
  for (const entry of result.tickets) {
    lines.push(...importEntryLines(entry, result.dryRun));
  }
  if (result.dryRun) {
    for (const c of result.ambiguous) {
      lines.push(
        `ambiguous ${c.ticket} group ${asciiText(c.item)} ` +
          `(score ${c.score.toFixed(2)}${c.sameTitle ? ' same title' : ''})`,
      );
    }
  }
  const count = (action: ImportAction): number =>
    result.tickets.filter((t) => t.action === action).length;
  const optional = (action: ImportAction): string =>
    count(action) === 0 ? '' : `, ${String(count(action))} ${action}`;
  const counts =
    `${String(count('created'))} created, ${String(count('updated'))} updated, ` +
    `${String(count('unchanged'))} unchanged${optional('blocked')}${optional('superseded')}`;
  const target = `${asciiText(result.source)}:${asciiText(result.ref)}`;
  lines.push(
    result.dryRun
      ? `dry run ${target}: ${counts}${result.ambiguous.length > 0 ? ', ambiguous' : ''}, nothing written`
      : `imported ${target}: ${counts}, ${String(result.events)} events`,
  );
  return `${lines.join('\n')}\n`;
}

/** The lines of one `import-change` entry (see `renderImport`). */
function importEntryLines(entry: ImportedTicket, dryRun: boolean): string[] {
  const { ticket, diff } = entry;
  const box = (done: boolean): string => (done ? '[x]' : '[ ]');
  const lines = [
    ticket === null
      ? `${entry.action} group ${asciiText(entry.item ?? '-')}: ${asciiText(entry.title)}`
      : `${entry.action} ${renderListLine(ticket)}`,
  ];
  if (dryRun && entry.pairing !== null) {
    lines.push(`  paired by ${entry.pairing.pass} (score ${entry.pairing.score.toFixed(2)})`);
  }
  if (entry.renumber !== null) {
    lines.push(
      `  renumbered from group ${asciiText(entry.renumber.from)} to ${asciiText(entry.renumber.to)}`,
    );
  }
  if (entry.supersede !== null) {
    lines.push(`  superseded: ${asciiText(entry.supersede)}`);
  }
  if (diff !== null) {
    if (diff.title !== null) {
      lines.push(`  title: ${asciiText(diff.title)}`);
    }
    for (const line of diff.updated) {
      lines.push(`  updated ${box(line.done)} ${String(line.index)} ${asciiText(line.text)}`);
    }
    for (const index of diff.removed) {
      const line = ticket?.checklist[index];
      lines.push(
        `  removed ${box(line?.done ?? false)} ${String(index)} ${asciiText(line?.text ?? '')}`,
      );
    }
    for (const line of diff.added) {
      lines.push(`  added ${box(line.done)} ${asciiText(line.text)}`);
    }
    if (ticket?.closed === true) {
      lines.push('  not reconciled: closed');
    }
  }
  for (const line of entry.blocked) {
    const why =
      line.reason === 'done'
        ? 'done'
        : `held by ${ticket?.assignee === null || ticket === null ? '-' : asciiText(ticket.assignee)} in ${ticket?.status ?? '-'}`;
    lines.push(`  blocked ${String(line.index)} ${asciiText(line.text)} (${why})`);
  }
  if (entry.forced) {
    lines.push('  forced');
  }
  return lines;
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
 *
 * `reader` is the actor reading the inbox (`inbox` and `watch` pass their
 * actor). The line begins with `GRANTED: ` when the entry is a
 * `ticket.grant` whose `to` equals `reader`, and with `LOST: ` when its
 * `affects` equals `reader` (board-cli: "Lease and queue events in the
 * inbox"); with `reader` omitted there is no prefix. Examples:
 * `GRANTED: 01ARYZ6S41TSV4RRFFQ69G5FAV  ticket.grant  agentboard  to merger-2`,
 * `LOST: 01ARYZ6S41TSV4RRFFQ69G5FAV  ticket.release.force  orchestrator  note stalled`.
 * Pure.
 */
export function renderInboxLine(entry: InboxEntry, reader?: string): string {
  void reader;
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
 * Human output of `config get`, ending with a newline: for `config get
 * <key>` (`keyed` true) the one line `<formatDuration(value)>`, followed by
 * ` (default)` when the default is in effect (`5m`, `2m (default)`); for
 * `config get` (`keyed` false) one line per setting,
 * `<key> <formatDuration(value)>` with the same suffix, in the order of
 * `result.settings` (`lease.grace 2m (default)`, `queue.window 5m`). Pure.
 */
export function renderConfig(result: ConfigResult, keyed: boolean): string {
  void result;
  void keyed;
  throw new Error('not implemented');
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
 * unplanned scope: <w> in the last <U> (<t> in all)
 * <card>  <outcome> <age>, unplanned: <reason>
 * <card>  closed <age>, no reason recorded (ad hoc: <adhoc>)
 * cache check: <check>
 * ```
 *
 * The unplanned scope section (board-insights: "Health command", "Unplanned
 * merges in text output"; add-adhoc-ticket-lifecycle design.md section 7)
 * comes after the close-merged sections and before the cache check:
 * - `<w>` is `unplannedScope.tickets.length` (the entries within the
 *   window), `<U>` is `report.thresholds.unplannedWithin` written as `<S>`
 *   and `<B>` are, and `<t>` is `unplannedScope.total`; the heading is
 *   followed by one line per entry of `tickets`, in the report's order;
 * - `<outcome>` is the entry's `outcome` (`merged` or `closed`), `<age>` is
 *   `relativeTime(ageMs)`, and the line ends with `unplanned: <reason>`
 *   (the entry's `reason` through `asciiText`) when `reason` is not null,
 *   else `no reason recorded (ad hoc: <adhoc>)` with the entry's `adhoc`
 *   through `asciiText` (an entry with a null `reason` always has an ad
 *   hoc reason);
 * - the `<card>` of an entry carries `[unplanned]` (and no `[adhoc]`) when
 *   the card's `unplanned` is not null, as `renderListLine` does, so an
 *   undisclosed close shows `[adhoc] [closed]`.
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
 *   ad hoc marker, unplanned marker (`Card.unplanned`), closed marker and
 *   title: `<id>  <status>  <assignee or ->  <markers><title>`.
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
  const {
    thresholds,
    staleClaims,
    stuckBlocked,
    unpromotedDecisions,
    closeMerged,
    unplannedScope,
  } = report;
  const lines = [
    `thresholds: stale after ${durationText(thresholds.staleAfter)}, blocked after ${durationText(thresholds.blockedAfter)}`,
  ];
  // A heading line, then one list line per entry with its finding.
  const listed = <T extends { ticket: Card }>(
    heading: string,
    entries: readonly T[],
    finding: (entry: T) => string,
  ): void => {
    lines.push(heading);
    for (const entry of entries) {
      const card = entry.ticket;
      lines.push(`${listLine({ ...card, unplanned: card.unplanned !== null })}  ${finding(entry)}`);
    }
  };
  // A section headed with its count.
  const section = <T extends { ticket: Card }>(
    heading: string,
    entries: readonly T[],
    finding: (entry: T) => string,
  ): void => {
    listed(`${heading}: ${String(entries.length)}`, entries, finding);
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
  listed(
    `unplanned scope: ${String(unplannedScope.tickets.length)} in the last ${durationText(thresholds.unplannedWithin)} (${String(unplannedScope.total)} in all)`,
    unplannedScope.tickets,
    (u) =>
      `${u.outcome} ${relativeTime(u.ageMs)}, ${
        u.reason === null
          ? `no reason recorded (ad hoc: ${asciiText(u.adhoc ?? '')})`
          : `unplanned: ${asciiText(u.reason)}`
      }`,
  );
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
