/**
 * `agentboard health` and the unplanned scope (add-adhoc-ticket-lifecycle
 * task 3.2; board-insights: "Health command" scenarios "Unplanned merges in
 * text output" and "Unplanned scope over MCP and JSON", "Unplanned scope in
 * the health report" scenario "Information, not a failure"; board-cli:
 * "Command surface" scenario "Health has help"): `--unplanned-within`, the
 * text section and the JSON keys, through the CLI driver.
 *
 * The goldens on the task 2.3 fixture board (`disposition-fixture.ts`) are
 * written by hand from the specs: the fixture's ids, actors and walls are
 * fixed, and the clock is faked (`Date` only), so every byte is determined.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHint } from '../../guidance/hints.js';
import { P, T1, T2, ev, putEvent, tempDir } from '../../store/__tests__/helpers.js';
import type { Card } from '../../view/columns.js';
import { DEFAULT_THRESHOLDS, type HealthReport } from '../../view/health.js';
import { renderHealth } from '../render.js';
import { oneJson, project, run, type Run } from './cli-helpers.js';
import {
  EVENTS,
  FOLDED,
  ID,
  START,
  UNPLANNED_CLOSED_EVENT,
  UNPLANNED_MERGED_EVENT,
  at,
  fixture,
} from './disposition-fixture.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** The faked clock of the scenario boards. */
const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function ok(out: Run): Run {
  expect(out.code, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  return out;
}

/** The `--json` error document of a failed run. */
function errorOf(out: Run): {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
} {
  return (
    oneJson(out) as {
      error: { exitCode: number; reason: string | null; message: string; hint: string | null };
    }
  ).error;
}

/** `P.create` for an ad hoc ticket, with the `undefined` fields stripped as the file is written. */
function adhocCreate(id: string, title: string, reason: string): ReturnType<typeof P.create> {
  const extra = { task: undefined, checklist: undefined, labels: undefined, adhoc: reason };
  return JSON.parse(JSON.stringify(P.create(id, title, extra))) as ReturnType<typeof P.create>;
}

/**
 * Scenario board: ad hoc ticket T1 (`Fix login redirect`, ad hoc `hotfix`)
 * moved to `merged` with `--unplanned "production hotfix"` 2 hours before
 * `NOW` (the disposition a second before the move, as the command writes
 * them).
 */
function mergedBoard(): { root: string } {
  const { root, boardDir } = project();
  const eventsDir = join(boardDir, 'events');
  putEvent(eventsDir, ev(adhocCreate(T1, 'Fix login redirect', 'hotfix'), 'orch', NOW - DAY));
  putEvent(eventsDir, ev(P.move(T1, 'tests'), 'impl', NOW - DAY + 1000));
  putEvent(eventsDir, ev(P.move(T1, 'implementing'), 'impl', NOW - DAY + 2000));
  putEvent(eventsDir, ev(P.move(T1, 'review'), 'impl', NOW - DAY + 3000));
  putEvent(eventsDir, ev(P.unplanned(T1, 'production hotfix'), 'orch', NOW - 2 * HOUR - 1000));
  putEvent(eventsDir, ev(P.move(T1, 'merged'), 'orch', NOW - 2 * HOUR));
  return { root };
}

/**
 * A board written before ADR 0013: ad hoc ticket T2 (`Try a new parser`,
 * ad hoc `spike`) closed from `blocked` 3 days before `NOW` with no link
 * and no disposition. Closed, so it is in no other section.
 */
function undisclosedBoard(): { root: string } {
  const { root, boardDir } = project();
  const eventsDir = join(boardDir, 'events');
  putEvent(eventsDir, ev(adhocCreate(T2, 'Try a new parser', 'spike'), 'orch', NOW - 5 * DAY));
  putEvent(eventsDir, ev(P.move(T2, 'blocked'), 'impl', NOW - 4 * DAY));
  putEvent(eventsDir, ev(P.close(T2), 'orch', NOW - 3 * DAY));
  return { root };
}

describe('scenario: Unplanned merges in text output', () => {
  it('prints the heading with the window count and the total, then the list line ending with the outcome, age and reason, and exits 0', () => {
    const { root } = mergedBoard();
    const out = ok(run(['health'], root));
    const lines = out.stdout.split('\n');
    const heading = lines.indexOf('unplanned scope: 1 in the last 7d (1 in all)');
    expect(heading, out.stdout).toBeGreaterThan(0);
    expect(lines[heading + 1]).toBe(
      `${T1}  merged  -  [unplanned] Fix login redirect  merged 2h ago, unplanned: production hotfix`,
    );
    // The section follows the close-merged sections and precedes the check.
    expect(lines[heading - 2]).toBe('close-merged missing pr: 1');
    expect(lines[heading - 1]).toBe(`${T1}  merged  -  [unplanned] Fix login redirect  no pr link`);
    expect(lines[heading + 2]).toBe('cache check: not run');
    expect(lines[heading + 3]).toBe('');
    expect(lines).toHaveLength(heading + 4);
  });

  it('writes the window given in the heading', () => {
    const { root } = mergedBoard();
    expect(ok(run(['health', '--unplanned-within', '30d'], root)).stdout).toContain(
      '\nunplanned scope: 1 in the last 30d (1 in all)\n',
    );
    expect(ok(run(['health', '--unplanned-within', '36h'], root)).stdout).toContain(
      '\nunplanned scope: 1 in the last 36h (1 in all)\n',
    );
    const narrow = ok(run(['health', '--unplanned-within', '90m'], root)).stdout;
    expect(narrow).toContain('\nunplanned scope: 0 in the last 90m (1 in all)\ncache check: not run\n');
    expect(narrow).not.toContain('unplanned: production hotfix');
  });

  it('writes a ticket closed before this change with no reason recorded and its ad hoc reason', () => {
    const { root } = undisclosedBoard();
    const out = ok(run(['health'], root));
    expect(out.stdout).toContain(
      '\nunplanned scope: 1 in the last 7d (1 in all)\n' +
        `${T2}  blocked  -  [adhoc] [closed] Try a new parser  closed 3d ago, no reason recorded (ad hoc: spike)\n` +
        'cache check: not run\n',
    );
  });
});

describe('scenario: Information, not a failure', () => {
  it('exits 0 with no stderr when unplanned scope is the only thing in the report', () => {
    const { root } = undisclosedBoard();
    const text = ok(run(['health'], root));
    expect(text.stdout).toMatch(/^stale claims: 0$/m);
    expect(text.stdout).toMatch(/^stuck in blocked: 0$/m);
    expect(text.stdout).toMatch(/^unpromoted decisions: 0$/m);
    expect(text.stdout).toMatch(/^close-merged missing pr: 0$/m);
    expect(text.stdout).toMatch(/^unplanned scope: 1 /m);
    const json = ok(run(['health', '--json'], root));
    const doc = oneJson(json) as HealthReport;
    expect(doc.unplannedScope.total).toBe(1);
    expect(doc.staleClaims).toEqual([]);
    expect(doc.stuckBlocked).toEqual([]);
    expect(doc.unpromotedDecisions).toEqual([]);
    expect(doc.closeMerged).toEqual({ ready: [], heldByDecision: [], missingPr: [] });
    // The health entry declares no exit code for findings: only 0, usage, no board, integrity.
    expect(ok(run(['health', '--unplanned-within', '1m'], root)).stdout).toContain(
      'unplanned scope: 0 in the last 1m (1 in all)',
    );
  });
});

describe('scenario: Unplanned scope over MCP and JSON (the JSON side)', () => {
  it('prints thresholds.unplannedWithin and unplannedScope with --unplanned-within 30d', () => {
    const { root } = mergedBoard();
    const doc = oneJson(ok(run(['health', '--unplanned-within', '30d', '--json'], root))) as HealthReport;
    expect(doc.thresholds).toEqual({
      staleAfter: DEFAULT_THRESHOLDS.staleAfter,
      blockedAfter: DEFAULT_THRESHOLDS.blockedAfter,
      unplannedWithin: 2_592_000_000,
    });
    expect(doc.unplannedScope.total).toBe(1);
    expect(doc.unplannedScope.tickets).toHaveLength(1);
    expect(doc.unplannedScope.tickets[0]).toMatchObject({
      ticket: { id: T1, status: 'merged', adhoc: true, unplanned: { reason: 'production hotfix' } },
      adhoc: 'hotfix',
      reason: 'production hotfix',
      outcome: 'merged',
      since: { kind: 'ticket.unplanned', actor: 'orch', ts: { wall: NOW - 2 * HOUR - 1000 } },
      ageMs: 2 * HOUR + 1000,
    });
  });

  it('defaults the window to 7 days', () => {
    const { root } = mergedBoard();
    const doc = oneJson(ok(run(['health', '--json'], root))) as HealthReport;
    expect(doc.thresholds.unplannedWithin).toBe(WEEK);
    expect(doc.unplannedScope.tickets.map((t) => t.ticket.id)).toEqual([T1]);
  });

  it('keeps the total with a window that lists nothing', () => {
    const { root } = mergedBoard();
    const doc = oneJson(ok(run(['health', '--unplanned-within', '2h', '--json'], root))) as HealthReport;
    expect(doc.thresholds.unplannedWithin).toBe(2 * HOUR);
    expect(doc.unplannedScope).toEqual({ total: 1, tickets: [] });
  });

  it('gives a null reason, measured from the close, for a ticket closed before this change', () => {
    const { root } = undisclosedBoard();
    const doc = oneJson(ok(run(['health', '--json'], root))) as HealthReport;
    expect(doc.unplannedScope.tickets).toHaveLength(1);
    expect(doc.unplannedScope.tickets[0]).toMatchObject({
      ticket: { id: T2, closed: true, adhoc: true, unplanned: null },
      adhoc: 'spike',
      reason: null,
      outcome: 'closed',
      since: { kind: 'ticket.close', actor: 'orch', ts: { wall: NOW - 3 * DAY } },
      ageMs: 3 * DAY,
    });
  });
});

describe('scenario: Malformed --unplanned-within', () => {
  it.each(['7days', '0d', '100000m', 'd', '-7d', '1.5d', '7D', '7', ''])(
    '%j exits 1 usage naming the flag and the accepted forms, with the help hint and no stdout',
    (value) => {
      const { root } = mergedBoard();
      const out = run(['health', '--unplanned-within', value], root);
      expect(out.code).toBe(1);
      expect(out.stdout).toBe('');
      const first = out.stderr.split('\n')[0] ?? '';
      expect(first).toMatch(/^agentboard: /);
      expect(first).toContain('--unplanned-within');
      for (const form of ['<n>m', '<n>h', '<n>d']) {
        expect(first).toContain(form);
      }
      if (value !== '') {
        expect(first).toContain(value);
      }
      expect(out.stderr.trimEnd().split('\n').at(-1)).toBe(
        `hint: ${renderHint('usage', { surface: 'cli', command: 'health' }) ?? ''}`,
      );
    },
  );

  it('is a JSON error document with --json', () => {
    const { root } = mergedBoard();
    const out = run(['health', '--unplanned-within', '7days', '--json'], root);
    expect(out.code).toBe(1);
    const error = errorOf(out);
    expect(error).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(error.message).toContain('--unplanned-within');
    expect(error.message).toContain('7days');
    expect(error.message).toContain('<n>d');
    expect(error.hint).toBe(renderHint('usage', { surface: 'cli', command: 'health' }));
  });

  it('is checked before the board is looked for, after the other two durations', () => {
    expect(run(['health', '--unplanned-within', '7days'], tempDir()).code).toBe(1);
    const both = run(['health', '--stale-after', '2hours', '--unplanned-within', '7days'], tempDir());
    expect(both.code).toBe(1);
    expect(both.stderr.split('\n')[0]).toContain('--stale-after');
    expect(both.stderr.split('\n')[0]).not.toContain('--unplanned-within');
    const blocked = run(
      ['health', '--blocked-after', '2days', '--unplanned-within', '7days'],
      tempDir(),
    );
    expect(blocked.code).toBe(1);
    expect(blocked.stderr.split('\n')[0]).toContain('--blocked-after');
  });

  it('accepts the bounds 1m and 99999d', () => {
    const { root } = mergedBoard();
    const low = oneJson(ok(run(['health', '--unplanned-within', '1m', '--json'], root))) as HealthReport;
    expect(low.thresholds.unplannedWithin).toBe(MINUTE);
    const high = oneJson(
      ok(run(['health', '--unplanned-within', '99999d', '--json'], root)),
    ) as HealthReport;
    expect(high.thresholds.unplannedWithin).toBe(99_999 * DAY);
  });

  it('refuses a missing value as usage', () => {
    const { root } = mergedBoard();
    expect(run(['health', '--unplanned-within'], root).code).toBe(1);
  });
});

/** The golden clock of the fixture board: 3 hours and 20 seconds after its first event. */
const GOLDEN_NOW = START + 3 * HOUR + 20_000;

/** The card of a fixture ticket as `ticketCard` gives it at `GOLDEN_NOW`. */
function goldenCard(index: number, unplanned: { reason: string } | null): Card {
  const ticket = FOLDED[index];
  if (ticket === undefined) {
    throw new Error(`no fixture ticket ${String(index)}`);
  }
  return {
    id: ticket.id,
    shortId: ticket.id.slice(0, 10),
    title: ticket.title,
    status: ticket.status,
    assignee: null,
    task: ticket.task === null ? null : `${ticket.task.source}:${ticket.task.ref}#${ticket.task.item}`,
    adhoc: ticket.adhoc !== null,
    unplanned,
    labels: [],
    checklist: { done: 0, total: 0 },
    blockedFrom: ticket.blockedFrom,
    closed: ticket.closed,
    openDecisions: 0,
    changed: false,
  };
}

/** The expected `--json` document on the fixture board at `GOLDEN_NOW`, by hand. */
function goldenJson(hashes: readonly string[], unplannedWithin = WEEK): HealthReport {
  const closedEntry = {
    ticket: goldenCard(2, { reason: 'abandoned, duplicate of AB' }),
    adhoc: 'spike: try the new parser',
    reason: 'abandoned, duplicate of AB',
    outcome: 'closed' as const,
    since: {
      hash: hashes[UNPLANNED_CLOSED_EVENT] ?? '',
      kind: 'ticket.unplanned',
      actor: 'orch',
      ts: at(UNPLANNED_CLOSED_EVENT, 'orch'),
    },
    ageMs: GOLDEN_NOW - (START + UNPLANNED_CLOSED_EVENT * 1000),
  };
  const mergedEntry = {
    ticket: goldenCard(1, { reason: 'production hotfix, no plan' }),
    adhoc: 'hotfix',
    reason: 'production hotfix, no plan',
    outcome: 'merged' as const,
    since: {
      hash: hashes[UNPLANNED_MERGED_EVENT] ?? '',
      kind: 'ticket.unplanned',
      actor: 'orch',
      ts: at(UNPLANNED_MERGED_EVENT, 'orch'),
    },
    ageMs: GOLDEN_NOW - (START + UNPLANNED_MERGED_EVENT * 1000),
  };
  const listed = [closedEntry, mergedEntry].filter((e) => e.ageMs < unplannedWithin);
  return {
    now: GOLDEN_NOW,
    thresholds: { staleAfter: 2 * HOUR, blockedAfter: DAY, unplannedWithin },
    staleClaims: [],
    stuckBlocked: [],
    unpromotedDecisions: [],
    closeMerged: {
      ready: [],
      heldByDecision: [],
      missingPr: [
        {
          ticket: goldenCard(1, { reason: 'production hotfix, no plan' }),
          prs: [],
          decisions: [],
          decisionLinked: false,
        },
        { ticket: goldenCard(3, null), prs: [], decisions: [], decisionLinked: false },
      ],
    },
    unplannedScope: { total: 2, tickets: listed },
    late: null,
    check: null,
  };
}

/** The expected text on the fixture board at `GOLDEN_NOW`, by hand. */
const GOLDEN_TEXT =
  'thresholds: stale after 2h, blocked after 1d\n' +
  'stale claims: 0\n' +
  'stuck in blocked: 0\n' +
  'unpromoted decisions: 0\n' +
  'close-merged ready: 0\n' +
  'close-merged held by decision: 0\n' +
  'close-merged missing pr: 2\n' +
  `${ID.unplannedMerged}  merged  -  [unplanned] Fix login redirect  no pr link\n` +
  `${ID.linkedAtMerge}  merged  -  Rate limit the API  no pr link\n` +
  'unplanned scope: 2 in the last 7d (2 in all)\n' +
  `${ID.unplannedClosed}  blocked  -  [unplanned] [closed] Try the new parser  closed 3h ago, unplanned: abandoned, duplicate of AB\n` +
  `${ID.unplannedMerged}  merged  -  [unplanned] Fix login redirect  merged 3h ago, unplanned: production hotfix, no plan\n` +
  'cache check: not run\n';

describe('golden health output on the fixture board of task 2.3', () => {
  beforeEach(() => {
    vi.setSystemTime(GOLDEN_NOW);
  });

  it('the fixture is what the goldens assume: 23 events, two unplanned dispositions', () => {
    expect(EVENTS).toHaveLength(23);
    expect(EVENTS[UNPLANNED_MERGED_EVENT]?.[1].kind).toBe('ticket.unplanned');
    expect(EVENTS[UNPLANNED_CLOSED_EVENT]?.[1].kind).toBe('ticket.unplanned');
    expect(fixture().hashes).toHaveLength(23);
  });

  it('text', () => {
    const { root } = fixture();
    expect(ok(run(['health'], root)).stdout).toBe(GOLDEN_TEXT);
  });

  it('--json', () => {
    const { root, hashes } = fixture();
    expect(oneJson(ok(run(['health', '--json'], root)))).toEqual(goldenJson(hashes));
  });

  it('text and --json with a window that lists nothing', () => {
    const { root, hashes } = fixture();
    expect(ok(run(['health', '--unplanned-within', '1m'], root)).stdout).toBe(
      GOLDEN_TEXT.replace(
        /unplanned scope: 2 in the last 7d \(2 in all\)\n[^\n]*\n[^\n]*\n/,
        'unplanned scope: 0 in the last 1m (2 in all)\n',
      ),
    );
    expect(oneJson(ok(run(['health', '--unplanned-within', '1m', '--json'], root)))).toEqual(
      goldenJson(hashes, MINUTE),
    );
  });
});

/** A card for the pure `renderHealth` cases. */
function card(
  id: string,
  title: string,
  status: Card['status'],
  extra: Partial<Card> = {},
): Card {
  return {
    id,
    shortId: id.slice(0, 10),
    title,
    status,
    assignee: null,
    task: null,
    adhoc: true,
    unplanned: null,
    labels: [],
    checklist: { done: 0, total: 0 },
    blockedFrom: null,
    closed: false,
    openDecisions: 0,
    changed: false,
    ...extra,
  };
}

function emptyReport(unplannedWithin = WEEK): HealthReport {
  return {
    now: NOW,
    thresholds: { ...DEFAULT_THRESHOLDS, unplannedWithin },
    staleClaims: [],
    stuckBlocked: [],
    unpromotedDecisions: [],
    closeMerged: { ready: [], heldByDecision: [], missingPr: [] },
    unplannedScope: { total: 0, tickets: [] },
    late: null,
    check: null,
  };
}

const TS = { wall: 1000, counter: 0, actor: 'orch' };

describe('renderHealth: the unplanned scope section (pure)', () => {
  it('writes the heading from the listed count, the window and the total', () => {
    const report = emptyReport(90 * MINUTE);
    report.unplannedScope.total = 5;
    expect(renderHealth(report).split('\n')[7]).toBe('unplanned scope: 0 in the last 90m (5 in all)');
    expect(renderHealth(emptyReport(36 * HOUR)).split('\n')[7]).toBe(
      'unplanned scope: 0 in the last 36h (0 in all)',
    );
  });

  it('writes each entry as its list line, the outcome, the age and the reason', () => {
    const report = emptyReport();
    report.unplannedScope = {
      total: 3,
      tickets: [
        {
          ticket: card(T1, 'Fix login redirect', 'merged', {
            assignee: 'reviewer-1',
            unplanned: { reason: 'production hotfix' },
          }),
          adhoc: 'hotfix',
          reason: 'production hotfix',
          outcome: 'merged',
          since: { hash: 'a'.repeat(64), kind: 'ticket.unplanned', actor: 'orch', ts: TS },
          ageMs: 2 * HOUR,
        },
        {
          ticket: card(T2, 'Try a new parser', 'blocked', { blockedFrom: 'tests', closed: true }),
          adhoc: 'spike',
          reason: null,
          outcome: 'closed',
          since: { hash: 'b'.repeat(64), kind: 'ticket.close', actor: 'orch', ts: TS },
          ageMs: 3 * DAY,
        },
      ],
    };
    const lines = renderHealth(report).split('\n');
    expect(lines[7]).toBe('unplanned scope: 2 in the last 7d (3 in all)');
    expect(lines[8]).toBe(
      `${T1}  merged  reviewer-1  [unplanned] Fix login redirect  merged 2h ago, unplanned: production hotfix`,
    );
    expect(lines[9]).toBe(
      `${T2}  blocked  -  [adhoc] [closed] Try a new parser  closed 3d ago, no reason recorded (ad hoc: spike)`,
    );
    expect(lines[10]).toBe('cache check: not run');
  });

  it('writes an age of 0 as just now and a closed merged ticket as merged', () => {
    const report = emptyReport();
    report.unplannedScope = {
      total: 1,
      tickets: [
        {
          ticket: card(T1, 'Skewed', 'merged', { closed: true, unplanned: { reason: 'r' } }),
          adhoc: 'a',
          reason: 'r',
          outcome: 'merged',
          since: { hash: 'c'.repeat(64), kind: 'ticket.unplanned', actor: 'orch', ts: TS },
          ageMs: 0,
        },
      ],
    };
    expect(renderHealth(report).split('\n')[8]).toBe(
      `${T1}  merged  -  [unplanned] [closed] Skewed  merged just now, unplanned: r`,
    );
  });

  it('writes the reasons through asciiText', () => {
    const E_ACUTE = String.fromCharCode(0xe9);
    const report = emptyReport();
    report.unplannedScope = {
      total: 2,
      tickets: [
        {
          ticket: card(T1, 'One', 'merged', { unplanned: { reason: `caf${E_ACUTE}` } }),
          adhoc: 'x',
          reason: `caf${E_ACUTE} outage`,
          outcome: 'merged',
          since: { hash: 'd'.repeat(64), kind: 'ticket.unplanned', actor: 'orch', ts: TS },
          ageMs: HOUR,
        },
        {
          ticket: card(T2, 'Two', 'blocked', { closed: true }),
          adhoc: `r${E_ACUTE}sum${E_ACUTE}`,
          reason: null,
          outcome: 'closed',
          since: { hash: 'e'.repeat(64), kind: 'ticket.close', actor: 'orch', ts: TS },
          ageMs: HOUR,
        },
      ],
    };
    const text = renderHealth(report);
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    const lines = text.split('\n');
    expect(lines[8]?.endsWith('merged 1h ago, unplanned: caf\\u00E9 outage')).toBe(true);
    expect(lines[9]?.endsWith('closed 1h ago, no reason recorded (ad hoc: r\\u00E9sum\\u00E9)')).toBe(
      true,
    );
  });
});
