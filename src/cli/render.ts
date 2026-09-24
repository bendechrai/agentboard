/**
 * Human output (board-cli: "Output conventions"): plain ASCII, one line
 * per ticket in `list`, a full record in `show`.
 */

import type { Ticket } from '../events/fold.js';
import { formatTaskRef } from '../events/schema.js';
import { asciiText } from '../board/text.js';
import type { InboxEntry } from '../board/inbox.js';
import type { ShowResult } from '../board/tickets.js';

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
