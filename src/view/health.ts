/**
 * The health report (board-insights: "Health report", "Durations";
 * add-board-insights task 1.1). Pure and browser-safe; see `types.ts`.
 *
 * One definition of every health check, shared by the web health panel
 * (evaluated in the browser), the `health` CLI command and the MCP tool
 * `board_health`. Every age is `now` minus an event wall, clamped at 0 when
 * the wall is in the future (clock skew between machines).
 */

import type { TicketComment } from '../events/fold.js';
import type { Hlc } from '../events/hlc.js';
import type { Status } from '../events/schema.js';
import type { Card } from './columns.js';
import type { BoardModel } from './types.js';

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
  void text;
  throw new Error('not implemented');
}

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
  void input;
  throw new Error('not implemented');
}
