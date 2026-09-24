/**
 * Human output (board-cli: "Output conventions"): plain ASCII, one line
 * per ticket in `list`, a full record in `show`.
 */

import type { Ticket } from '../events/fold.js';
import { formatTaskRef } from '../events/schema.js';
import type { ShowResult } from '../board/tickets.js';

/** Length of the id prefix shown by `list`. */
export const LIST_ID_PREFIX = 10;

/**
 * Makes user text safe for plain ASCII output: every character outside
 * printable ASCII (below 0x20, 0x7F and above) is written as `\uXXXX` with
 * four upper-case hex digits of its UTF-16 code unit (a character outside
 * the BMP becomes two escapes), and a backslash is written as `\\`, so the
 * output is unambiguous and one line. Pure.
 */
export function asciiText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) {
      out += '\\\\';
    } else if (code < 0x20 || code >= 0x7f) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else {
      out += text[i] ?? '';
    }
  }
  return out;
}

/**
 * The `list` line of a ticket, without a newline:
 * `<first LIST_ID_PREFIX characters of id>  <status>  <assignee or ->  <markers><title>`,
 * fields separated by two spaces, where `<markers>` is `[adhoc] ` for a
 * ticket with an ad hoc reason and `[closed] ` for a closed ticket (in
 * that order when both apply), and assignee and title pass through
 * `asciiText`. Example: `01ARYZ6S41  todo  -  [adhoc] Fix thing`. Pure.
 */
export function renderListLine(ticket: Ticket): string {
  const markers = (ticket.adhoc === null ? '' : '[adhoc] ') + (ticket.closed ? '[closed] ' : '');
  return [
    ticket.id.slice(0, LIST_ID_PREFIX),
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
