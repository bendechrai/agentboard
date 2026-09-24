/**
 * The health report (board-insights: "Health report", "Durations";
 * add-board-insights task 1.1). Pure and browser-safe; see `types.ts`.
 *
 * One definition of every health check, shared by the web health panel
 * (evaluated in the browser), the `health` CLI command and the MCP tool
 * `board_health`. Every age is `now` minus an event wall, clamped at 0 when
 * the wall is in the future (clock skew between machines).
 */

import { openDecisions } from '../events/decisions.js';
import type { Ticket, TicketComment } from '../events/fold.js';
import type { Hlc } from '../events/hlc.js';
import { isKnownEvent, type Status } from '../events/schema.js';
import { ticketCard, type Card } from './columns.js';
import { compareStrings } from './order.js';
import type { BoardModel, EventView } from './types.js';

/** Thresholds of the health checks, in milliseconds. */
export interface HealthThresholds {
  /**
   * An assignee idle for at least this long makes their claim stale
   * (`staleClaims`).
   */
  staleAfter: number;
  /**
   * A ticket whose entry into `blocked` is at least this old is stuck
   * (`stuckBlocked`).
   */
  blockedAfter: number;
}

/**
 * Default thresholds: `staleAfter` 2 hours (7200000 ms), `blockedAfter`
 * 24 hours (86400000 ms). Frozen.
 */
export const DEFAULT_THRESHOLDS: Readonly<HealthThresholds> = Object.freeze({
  staleAfter: 2 * 60 * 60 * 1000,
  blockedAfter: 24 * 60 * 60 * 1000,
});

/**
 * Parses a threshold duration (board-insights: "Durations"): `<n>m`,
 * `<n>h` or `<n>d` (minutes, hours, days; lowercase unit), where `<n>` is
 * a positive decimal integer of at most 5 digits (ASCII `0`-`9` only), so
 * `1m` to `99999d`. The whole text must match: no sign, no whitespace, no
 * fraction, no exponent, no other unit, no unit spelled out.
 *
 * Returns the duration in milliseconds (a minute is 60000, an hour
 * 3600000, a day 86400000), or null for any other text (for example `0h`,
 * `100000m`, `2hours`, `h`, `-1h`, `1.5h`, `2H`, ` 2h`, `2s`, `2` or the
 * empty string). The CLI turns null into exit 1 with reason `usage`; the
 * web panel shows the input as invalid and keeps the report unchanged.
 */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text);
  if (match === null) {
    return null;
  }
  const [, digits = '', unit = ''] = match;
  const n = Number(digits);
  const scale = UNIT_MS[unit];
  return n > 0 && scale !== undefined ? n * scale : null;
}

/** The whole text of a duration: 1 to 5 ASCII digits and a lowercase unit. */
const DURATION = /^([0-9]{1,5})([mhd])$/;

/** Milliseconds per duration unit. */
const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A reference to the event a finding measured its age from. */
export interface HealthEventRef {
  hash: string;
  kind: string;
  actor: string;
  /** The event's `ts`; the age is `now - ts.wall`, clamped at 0. */
  ts: Hlc;
}

/** One stale claim. */
export interface StaleClaim {
  /** `ticketCard(ticket, now)` of the ticket. */
  ticket: Card;
  /** The ticket's assignee. */
  assignee: string;
  /**
   * The event idle time is measured from: the later, in fold order, of the
   * assignee's own latest applied event on the ticket (any kind) and the
   * latest applied `ticket.claim`, `ticket.handoff` or `ticket.assign` on
   * the ticket (the event that made them the assignee).
   */
  since: HealthEventRef;
  /** `max(0, now - since.ts.wall)`. */
  idleMs: number;
}

/** One ticket stuck in `blocked`. */
export interface StuckBlocked {
  /** `ticketCard(ticket, now)` of the ticket. */
  ticket: Card;
  /** The status it was blocked from (`Ticket.blockedFrom`). */
  blockedFrom: Status;
  /**
   * The applied event that moved the ticket into `blocked` most recently:
   * a `ticket.move` to `blocked`, or a `ticket.handoff` with status
   * `blocked` applied while the ticket was not already blocked. A
   * `ticket.handoff` with status `blocked` on a ticket that is already
   * blocked is a reassignment, not an entry into `blocked`, and does not
   * restart the clock; nor does any comment.
   */
  since: HealthEventRef;
  /** `max(0, now - since.ts.wall)`. */
  blockedMs: number;
  /**
   * The ticket's latest comment (the last of `Ticket.comments`, a handoff
   * note included), which by convention says why; null when it has none.
   */
  latestComment: TicketComment | null;
}

/** One open ticket with open decisions and no `decision` link. */
export interface UnpromotedDecision {
  /** `ticketCard(ticket, now)` of the ticket. */
  ticket: Card;
  /** `openDecisions(ticket.comments)`, in comment order. */
  decisions: { actor: string; text: string }[];
}

/** One open ticket in `merged`, as `close-merged` would see it. */
export interface CloseMergedCandidate {
  /** `ticketCard(ticket, now)` of the ticket. */
  ticket: Card;
  /** The `pr` values of the ticket's `pr` links, in link order (duplicates kept). */
  prs: (string | number)[];
  /** `openDecisions(ticket.comments)`, in comment order. */
  decisions: { actor: string; text: string }[];
  /** True when the ticket has at least one `decision` link. */
  decisionLinked: boolean;
}

/** The `close-merged` candidates, split three ways. */
export interface CloseMergedReport {
  /**
   * At least one `pr` link, and no open decision or at least one
   * `decision` link: `close-merged` closes it once `gh` reports the PR
   * merged. The report never claims a PR is merged.
   */
  ready: CloseMergedCandidate[];
  /**
   * At least one `pr` link, at least one open decision and no `decision`
   * link: `close-merged` would skip it with the decision rule.
   */
  heldByDecision: CloseMergedCandidate[];
  /**
   * No `pr` link (whatever its decisions): `close-merged` never considers
   * it; it needs `link --pr` or a manual `close`.
   */
  missingPr: CloseMergedCandidate[];
}

/**
 * One event a running server's feed reported as late, or as removed in a
 * resync, since the server started (board-insights: "Health in the web
 * app"). Only a server can observe these.
 */
export interface LateArrival {
  hash: string;
  kind: string;
  /** The event's ticket, or null (`board.meta`). */
  ticket: string | null;
  /** Whether the feed reported it as `late` or `removed`. */
  type: 'late' | 'removed';
  /** When the server observed it, in milliseconds since the Unix epoch. */
  observedAt: number;
}

/** The summary of the last cache check (`rebuild --check`, the store's `checkCache`). */
export interface HealthCheck {
  /** When the check ran, in milliseconds since the Unix epoch. */
  ranAt: number;
  /** True when the cache matches the event log (`CheckResult.ok`). */
  matches: boolean;
  /** The number of differing rows (`CheckResult.differences.length`). */
  differingRows: number;
}

/** Input of `healthReport`. */
export interface HealthInput {
  /**
   * The board: its tickets and its events with their outcomes, in fold
   * order (as `BoardModel`). Events of closed tickets may be left out.
   */
  model: Pick<BoardModel, 'tickets' | 'events'>;
  /** The current time, in milliseconds since the Unix epoch. */
  now: number;
  thresholds: HealthThresholds;
  /** The server's observed late arrivals; absent or null outside a server. */
  late?: LateArrival[] | null;
  /** The last cache check; absent or null when none ran. */
  check?: HealthCheck | null;
}

/** The health report (board-insights: "Health report"). */
export interface HealthReport {
  /** `input.now`. */
  now: number;
  /** A copy of `input.thresholds`. */
  thresholds: HealthThresholds;
  /**
   * Every open (not closed) ticket not in `merged` with an assignee whose
   * `idleMs` is at least `thresholds.staleAfter`. Ordered by `idleMs`
   * descending, then ticket id ascending.
   */
  staleClaims: StaleClaim[];
  /**
   * Every open ticket in `blocked` whose `blockedMs` is at least
   * `thresholds.blockedAfter`. Ordered by `blockedMs` descending, then
   * ticket id ascending.
   */
  stuckBlocked: StuckBlocked[];
  /**
   * Every open ticket (any status) with at least one open decision
   * (`openDecisions`, the function `close` uses) and no `decision` link.
   * Ordered by ticket id ascending.
   */
  unpromotedDecisions: UnpromotedDecision[];
  /** The open tickets in `merged`; each list ordered by ticket id ascending. */
  closeMerged: CloseMergedReport;
  /** A copy of `input.late` in the order given, or null when not supplied. */
  late: LateArrival[] | null;
  /** A copy of `input.check`, or null when not supplied. */
  check: HealthCheck | null;
}

/**
 * Computes the health report of a board (board-insights: "Health
 * report"). Pure: reads no clock (`now` is given) and does not modify its
 * input. Closed tickets appear in no section. Only applied events count;
 * rejected and unknown-kind events are ignored. See `HealthReport` and the
 * finding types for each check's exact definition.
 */
export function healthReport(input: HealthInput): HealthReport {
  const { model, now, thresholds } = input;
  const applied = appliedByTicket(model.events);
  const open = Object.values(model.tickets)
    .filter((ticket) => !ticket.closed)
    .sort((a, b) => compareStrings(a.id, b.id));

  const staleClaims: StaleClaim[] = [];
  const stuckBlocked: StuckBlocked[] = [];
  const unpromotedDecisions: UnpromotedDecision[] = [];
  const closeMerged: CloseMergedReport = { ready: [], heldByDecision: [], missingPr: [] };

  for (const ticket of open) {
    const events = applied.get(ticket.id) ?? [];
    const stale = staleClaim(ticket, events, now);
    if (stale !== null && stale.idleMs >= thresholds.staleAfter) {
      staleClaims.push(stale);
    }
    const stuck = stuckInBlocked(ticket, events, now);
    if (stuck !== null && stuck.blockedMs >= thresholds.blockedAfter) {
      stuckBlocked.push(stuck);
    }
    const decisions = openDecisions(ticket.comments);
    const decisionLinked = ticket.links.some((link) => link.type === 'decision');
    if (decisions.length > 0 && !decisionLinked) {
      unpromotedDecisions.push({ ticket: ticketCard(ticket, now), decisions });
    }
    if (ticket.status === 'merged') {
      const candidate: CloseMergedCandidate = {
        ticket: ticketCard(ticket, now),
        prs: ticket.links.flatMap((link) => (link.type === 'pr' ? [link.pr] : [])),
        decisions: openDecisions(ticket.comments),
        decisionLinked,
      };
      if (candidate.prs.length === 0) {
        closeMerged.missingPr.push(candidate);
      } else if (decisions.length > 0 && !decisionLinked) {
        closeMerged.heldByDecision.push(candidate);
      } else {
        closeMerged.ready.push(candidate);
      }
    }
  }

  // `open` is in ascending id order and the sorts are stable, so equal ages
  // stay in ascending id order.
  staleClaims.sort((a, b) => b.idleMs - a.idleMs);
  stuckBlocked.sort((a, b) => b.blockedMs - a.blockedMs);

  return {
    now,
    thresholds: { staleAfter: thresholds.staleAfter, blockedAfter: thresholds.blockedAfter },
    staleClaims,
    stuckBlocked,
    unpromotedDecisions,
    closeMerged,
    late: input.late == null ? null : input.late.map((arrival) => ({ ...arrival })),
    check: input.check == null ? null : { ...input.check },
  };
}

/** The applied events of each ticket, in fold order, keyed by ticket id. */
function appliedByTicket(events: readonly EventView[]): Map<string, EventView[]> {
  const byTicket = new Map<string, EventView[]>();
  for (const view of events) {
    if (view.outcome === 'applied' && view.ticket !== null) {
      const list = byTicket.get(view.ticket) ?? [];
      list.push(view);
      byTicket.set(view.ticket, list);
    }
  }
  return byTicket;
}

/** Kinds whose applied event sets the assignee (a release clears it). */
const ASSIGNING_KINDS: ReadonlySet<string> = new Set([
  'ticket.claim',
  'ticket.handoff',
  'ticket.assign',
]);

/**
 * The stale-claim finding of an open ticket not in `merged` with an
 * assignee, whatever its idle time; null otherwise, or when no applied event
 * of the ticket bears on the assignee. `events` are the ticket's applied
 * events in fold order.
 */
function staleClaim(ticket: Ticket, events: readonly EventView[], now: number): StaleClaim | null {
  const assignee = ticket.assignee;
  if (assignee === null || ticket.status === 'merged') {
    return null;
  }
  // The later in fold order of the assignee's own latest event and the
  // latest assigning event is simply the last event matching either.
  let since: EventView | null = null;
  for (const view of events) {
    if (view.actor === assignee || ASSIGNING_KINDS.has(view.kind)) {
      since = view;
    }
  }
  if (since === null) {
    return null;
  }
  return {
    ticket: ticketCard(ticket, now),
    assignee,
    since: eventRef(since),
    idleMs: age(now, since.ts),
  };
}

/**
 * The stuck-in-blocked finding of an open ticket in `blocked`, whatever its
 * age; null otherwise, or when its entry into `blocked` is not among
 * `events` (the ticket's applied events in fold order).
 */
function stuckInBlocked(
  ticket: Ticket,
  events: readonly EventView[],
  now: number,
): StuckBlocked | null {
  if (ticket.status !== 'blocked' || ticket.blockedFrom === null) {
    return null;
  }
  let status: Status = 'todo';
  let entry: EventView | null = null;
  for (const view of events) {
    const { event } = view;
    if (!isKnownEvent(event)) {
      continue;
    }
    let next: Status = status;
    if (event.kind === 'ticket.move') {
      next = event.body.to;
    } else if (event.kind === 'ticket.handoff') {
      next = event.body.status;
    }
    if (next === 'blocked' && status !== 'blocked') {
      entry = view;
    }
    status = next;
  }
  if (entry === null) {
    return null;
  }
  const latest = ticket.comments.at(-1);
  return {
    ticket: ticketCard(ticket, now),
    blockedFrom: ticket.blockedFrom,
    since: eventRef(entry),
    blockedMs: age(now, entry.ts),
    latestComment:
      latest === undefined
        ? null
        : { actor: latest.actor, ts: { ...latest.ts }, text: latest.text, hash: latest.hash },
  };
}

function eventRef(view: EventView): HealthEventRef {
  return { hash: view.hash, kind: view.kind, actor: view.actor, ts: { ...view.ts } };
}

/** `now - ts.wall`, or 0 when the wall is in the future. */
function age(now: number, ts: Hlc): number {
  return Math.max(0, now - ts.wall);
}
