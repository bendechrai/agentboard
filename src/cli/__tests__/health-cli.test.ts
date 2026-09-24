/**
 * `agentboard health` through the CLI driver (add-board-insights task
 * 2.1; board-insights: "Health command", "Durations"; board-cli: "Command
 * surface" scenario "Health has help"): the registry entry, the help, the
 * JSON report, the check, malformed durations with their hint, the human
 * output (`renderHealth`), and that it writes nothing and needs no actor.
 *
 * The clock is faked (`Date` only) so that ages and the report's `now` are
 * exact. Expected documents are computed independently of the command:
 * `healthReport` over `loadSnapshot` of the same board.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSnapshot } from '../../board/snapshot.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { renderHint } from '../../guidance/hints.js';
import { openBoard } from '../../store/board.js';
import { P, T1, T2, T3, ev, eventNames, putEvent, tempDir } from '../../store/__tests__/helpers.js';
import type { Card } from '../../view/columns.js';
import {
  DEFAULT_THRESHOLDS,
  healthReport,
  type HealthReport,
  type HealthThresholds,
} from '../../view/health.js';
import { parseArgs } from '../parse.js';
import { findCommand } from '../registry.js';
import { renderHealth, renderListLine } from '../render.js';
import { cliEnv, oneJson, project, run, spawnCli, type Run } from './cli-helpers.js';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function ago(hours: number): number {
  return NOW - Math.round(hours * HOUR);
}

const READY = '01C0000000ACTAV9WEVGEMMVRZ';
const HELD = '01D0000000ACTAV9WEVGEMMVRZ';
const ORPHAN = '01E0000000ACTAV9WEVGEMMVRZ';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A board with one finding in every section: T1 claimed by impl 3 hours
 * ago (stale), T2 blocked from tests 26 hours ago with a comment (stuck),
 * T3 with an open decision, and three tickets in merged: READY with a pr
 * link, HELD with a pr link and an open decision, ORPHAN with no pr link.
 */
function seeded(): { root: string; boardDir: string } {
  const { root, boardDir } = project();
  const eventsDir = join(boardDir, 'events');
  const put = (event: unknown): void => {
    putEvent(eventsDir, event);
  };
  const toMerged = (id: string, title: string, start: number): void => {
    put(ev(P.create(id, title), 'orch', ago(start)));
    put(ev(P.move(id, 'tests'), 'orch', ago(start - 0.1)));
    put(ev(P.move(id, 'implementing'), 'orch', ago(start - 0.2)));
    put(ev(P.move(id, 'review'), 'orch', ago(start - 0.3)));
    put(ev(P.move(id, 'merged'), 'orch', ago(start - 0.4)));
  };
  put(ev(P.create(T1, 'Parser'), 'orch', ago(5)));
  put(ev(P.claim(T1), 'impl', ago(3)));
  put(ev(P.create(T2, 'Cache'), 'orch', ago(50)));
  put(ev(P.move(T2, 'tests'), 'orch', ago(49)));
  put(ev(P.move(T2, 'blocked'), 'impl2', ago(26)));
  put(ev(P.comment(T2, 'waiting on the API'), 'impl2', ago(25)));
  put(ev(P.create(T3, 'Decider'), 'orch', ago(4)));
  put(ev(P.comment(T3, 'DECISION: use sessions'), 'rev', ago(3.5)));
  toMerged(READY, 'Ready', 10);
  put(ev(P.pr(READY, 42), 'rev', ago(9)));
  toMerged(HELD, 'Held', 8);
  put(ev(P.pr(HELD, 'https://example.invalid/pr/7'), 'rev', ago(7)));
  put(ev(P.comment(HELD, 'DECISION: keep v1'), 'rev', ago(6.5)));
  toMerged(ORPHAN, 'Orphan', 6);
  return { root, boardDir };
}

/** The expected report of `boardDir` as JSON: `healthReport` over the whole board. */
function expectedDoc(
  boardDir: string,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): HealthReport {
  const board = openBoard(boardDir);
  try {
    const report = healthReport({ model: loadSnapshot(board), now: NOW, thresholds });
    return JSON.parse(JSON.stringify(report)) as HealthReport;
  } finally {
    board.close();
  }
}

function ok(out: Run): void {
  expect(out.code, out.stderr).toBe(0);
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

/** Runs one statement on the live cache through its own connection. */
function handEdit(boardDir: string, sql: string, ...params: string[]): void {
  const db = new DatabaseSync(join(boardDir, 'cache.sqlite'));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

const HUMAN = [
  'thresholds: stale after 2h, blocked after 1d',
  'stale claims: 1',
  `${T1}  todo  impl  Parser  last active 3h ago (ticket.claim by impl)`,
  'stuck in blocked: 1',
  `${T2}  blocked  -  Cache  blocked 1d ago from tests; latest comment by impl2: waiting on the API`,
  'unpromoted decisions: 2',
  `${T3}  todo  -  Decider  1 open decision, no decision link`,
  `${HELD}  merged  -  Held  1 open decision, no decision link`,
  'close-merged ready: 1',
  `${READY}  merged  -  Ready  pr 42`,
  'close-merged held by decision: 1',
  `${HELD}  merged  -  Held  pr https://example.invalid/pr/7; 1 open decision, no decision link`,
  'close-merged missing pr: 1',
  `${ORPHAN}  merged  -  Orphan  no pr link`,
];

describe('health in the registry', () => {
  it('is a read-only awareness command with --stale-after, --blocked-after and --check', () => {
    const command = findCommand('health');
    expect(command).toMatchObject({
      name: 'health',
      group: 'awareness',
      writes: false,
      operation: 'boardHealth',
      positionals: [],
      exclusive: [],
    });
    expect(command?.tracksCursor ?? false).toBe(false);
    expect(command?.stream).toBeUndefined();
    expect(command?.flags.map((f) => [f.name, f.type, f.required, f.repeatable])).toEqual([
      ['stale-after', 'string', false, false],
      ['blocked-after', 'string', false, false],
      ['check', 'boolean', false, false],
    ]);
    expect(command?.exitCodes.map((e) => [e.code, e.reason ?? null])).toEqual([
      [0, null],
      [1, 'usage'],
      [2, 'board-not-found'],
      [5, null],
    ]);
  });
});

describe('scenario: Health has help', () => {
  it('prints the synopsis with the three flags and examples that parse to health, with no board and no actor', () => {
    const out = run(['help', 'health'], tempDir(), cliEnv({ AGENTBOARD_ACTOR: undefined }));
    ok(out);
    expect(out.stdout).toMatch(
      /^Usage: agentboard health \[--stale-after <[a-z-]+>\] \[--blocked-after <[a-z-]+>\] \[--check\] \[--json\]$/m,
    );
    expect(out.stdout).toMatch(/^\s+1 usage\s/m);
    expect(out.stdout).toMatch(/^\s+2 board-not-found\s/m);
    const spec = findCommand('health');
    expect(spec?.examples.length).toBeGreaterThan(0);
    for (const example of spec?.examples ?? []) {
      expect(out.stdout).toContain(example.command);
      expect(parseArgs(splitCommandLine(example.command).slice(1)).command.name).toBe('health');
    }
    expect(spec?.examples.some((e) => e.command.includes('--stale-after'))).toBe(true);
    expect(spec?.examples.some((e) => e.command.includes('--check'))).toBe(true);
  });

  it('is the same through health --help', () => {
    const dir = tempDir();
    expect(run(['health', '--help'], dir).stdout).toBe(run(['help', 'health'], dir).stdout);
  });
});

describe('scenario: JSON report', () => {
  it('prints one JSON document with one stale claim, late null and check null, and exits 0', () => {
    const { root, boardDir } = seeded();
    const out = run(['health', '--json'], root);
    ok(out);
    expect(out.stderr).toBe('');
    const doc = oneJson(out) as HealthReport;
    expect(doc.staleClaims).toHaveLength(1);
    expect(doc.staleClaims[0]?.ticket.id).toBe(T1);
    expect(doc.late).toBeNull();
    expect(doc.check).toBeNull();
    expect(doc).toEqual(expectedDoc(boardDir));
  });

  it('passes the thresholds given, in minutes, hours and days', () => {
    const { root, boardDir } = seeded();
    const doc = oneJson(
      run(['health', '--stale-after', '4h', '--blocked-after', '2d', '--json'], root),
    ) as HealthReport;
    expect(doc.thresholds).toEqual({ staleAfter: 4 * HOUR, blockedAfter: 48 * HOUR });
    expect(doc.staleClaims).toEqual([]);
    expect(doc.stuckBlocked).toEqual([]);
    expect(doc).toEqual(expectedDoc(boardDir, doc.thresholds));
    const minutes = oneJson(
      run(['health', '--stale-after', '90m', '--json'], root),
    ) as HealthReport;
    expect(minutes.thresholds).toEqual({
      staleAfter: 90 * MINUTE,
      blockedAfter: DEFAULT_THRESHOLDS.blockedAfter,
    });
    expect(minutes.staleClaims.map((s) => s.ticket.id)).toEqual([T1]);
  });

  it('exits 0 on an empty board', () => {
    const { root } = project();
    const out = run(['health', '--json'], root);
    ok(out);
    expect(oneJson(out)).toEqual({
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleClaims: [],
      stuckBlocked: [],
      unpromotedDecisions: [],
      closeMerged: { ready: [], heldByDecision: [], missingPr: [] },
      late: null,
      check: null,
    });
  });
});

describe('scenario: Check included on request', () => {
  it('reports a match with 0 differing rows on a cache matching the event log', () => {
    const { root, boardDir } = seeded();
    const out = run(['health', '--check', '--json'], root);
    ok(out);
    const doc = oneJson(out) as HealthReport;
    expect(doc.check).toEqual({ ranAt: NOW, matches: true, differingRows: 0 });
    expect({ ...doc, check: null }).toEqual(expectedDoc(boardDir));
  });

  it('still exits 0 when the cache differs, reporting the differing rows', () => {
    const { root, boardDir } = seeded();
    // The first run creates the cache and folds the fixture.
    ok(run(['health'], root));
    handEdit(boardDir, "UPDATE tickets SET title = 'hacked' WHERE id = ?", READY);
    const out = run(['health', '--check', '--json'], root);
    ok(out);
    expect(out.stderr).toBe('');
    const human = run(['health', '--check'], root);
    expect(human.code).toBe(0);
    expect(human.stderr).toBe('');
    expect((oneJson(out) as HealthReport).check).toEqual({
      ranAt: NOW,
      matches: false,
      differingRows: 1,
    });
  });

  it('ends the human output with the check line', () => {
    const { root, boardDir } = seeded();
    expect(run(['health', '--check'], root).stdout.split('\n').at(-2)).toBe(
      'cache check: matches (0 differing rows)',
    );
    handEdit(boardDir, "UPDATE tickets SET title = 'hacked' WHERE id = ?", READY);
    expect(run(['health', '--check'], root).stdout.split('\n').at(-2)).toBe(
      'cache check: differs (1 differing rows)',
    );
  });
});

describe('scenario: Malformed duration', () => {
  it.each(['2hours', '0h', '100000m', 'h', '-1h', '1.5h', '2H', '2', ''])(
    '--stale-after %j exits 1 usage naming the accepted forms, with the help hint',
    (value) => {
      const { root } = seeded();
      const out = run(['health', '--stale-after', value], root);
      expect(out.code).toBe(1);
      expect(out.stdout).toBe('');
      const first = out.stderr.split('\n')[0] ?? '';
      expect(first).toMatch(/^agentboard: /);
      expect(first).toContain('--stale-after');
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

  it('refuses a malformed --blocked-after the same way, as a JSON error with --json', () => {
    const { root } = seeded();
    const out = run(['health', '--blocked-after', '2hours', '--json'], root);
    expect(out.code).toBe(1);
    const error = errorOf(out);
    expect(error).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(error.message).toContain('--blocked-after');
    expect(error.message).toContain('2hours');
    expect(error.message).toContain('<n>h');
    expect(error.hint).toBe(renderHint('usage', { surface: 'cli', command: 'health' }));
    expect(error.hint).toContain("'agentboard help health'");
  });

  it('checks the durations before looking for a board', () => {
    const out = run(['health', '--stale-after', '2hours'], tempDir());
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('--stale-after');
  });

  it('accepts the bounds 1m and 99999d', () => {
    const { root } = seeded();
    const doc = oneJson(
      run(['health', '--stale-after', '1m', '--blocked-after', '99999d', '--json'], root),
    ) as HealthReport;
    expect(doc.thresholds).toEqual({ staleAfter: MINUTE, blockedAfter: 99999 * 24 * HOUR });
  });

  it('refuses a missing value as usage', () => {
    const { root } = seeded();
    expect(run(['health', '--stale-after'], root).code).toBe(1);
  });
});

describe('human output', () => {
  it('lists each section with its count, one list line and finding per ticket', () => {
    const { root } = seeded();
    const out = run(['health'], root);
    ok(out);
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe(`${[...HUMAN, 'cache check: not run'].join('\n')}\n`);
  });

  it('shows the thresholds given', () => {
    const { root } = seeded();
    const out = run(['health', '--stale-after', '90m', '--blocked-after', '48h'], root);
    ok(out);
    expect(out.stdout.split('\n')[0]).toBe('thresholds: stale after 90m, blocked after 2d');
  });
});

describe('health writes nothing and needs no actor', () => {
  it('leaves the event files alone, and ignores --as', () => {
    const { root, boardDir } = seeded();
    // The first run catches up (folding the fixture); later runs change nothing.
    ok(run(['health'], root));
    const names = eventNames(join(boardDir, 'events'));
    const plainDoc = oneJson(run(['health', '--json'], root));
    expect(oneJson(run(['health', '--json', '--as', 'someone'], root))).toEqual(plainDoc);
    expect(
      oneJson(run(['health', '--json'], root, cliEnv({ AGENTBOARD_ACTOR: 'someone' }))),
    ).toEqual(plainDoc);
    expect(eventNames(join(boardDir, 'events'))).toEqual(names);
  });

  it('exits 2 board-not-found without a board', () => {
    const out = run(['health', '--json'], tempDir());
    expect(out.code).toBe(2);
    expect(errorOf(out)).toMatchObject({ exitCode: 2, reason: 'board-not-found' });
  });
});

/** A card for `renderHealth` unit tests. */
function card(id: string, title: string, status: Card['status'], assignee: string | null): Card {
  return {
    id,
    shortId: id.slice(0, 10),
    title,
    status,
    assignee,
    task: null,
    adhoc: false,
    labels: [],
    checklist: { done: 0, total: 0 },
    blockedFrom: null,
    closed: false,
    openDecisions: 0,
    changed: false,
  };
}

function emptyReport(thresholds: HealthThresholds = DEFAULT_THRESHOLDS): HealthReport {
  return {
    now: NOW,
    thresholds,
    staleClaims: [],
    stuckBlocked: [],
    unpromotedDecisions: [],
    closeMerged: { ready: [], heldByDecision: [], missingPr: [] },
    late: null,
    check: null,
  };
}

describe('renderHealth', () => {
  it('renders an empty report as the headings with 0', () => {
    expect(renderHealth(emptyReport())).toBe(
      [
        'thresholds: stale after 2h, blocked after 1d',
        'stale claims: 0',
        'stuck in blocked: 0',
        'unpromoted decisions: 0',
        'close-merged ready: 0',
        'close-merged held by decision: 0',
        'close-merged missing pr: 0',
        'cache check: not run',
        '',
      ].join('\n'),
    );
  });

  it.each([
    [2 * HOUR, '2h'],
    [24 * HOUR, '1d'],
    [36 * HOUR, '36h'],
    [90 * MINUTE, '90m'],
    [MINUTE, '1m'],
    [99999 * 24 * HOUR, '99999d'],
    [1500, '1500ms'],
  ])('writes the threshold %d as %s', (ms, text) => {
    const line = renderHealth(emptyReport({ staleAfter: ms, blockedAfter: ms })).split('\n')[0];
    expect(line).toBe(`thresholds: stale after ${text}, blocked after ${text}`);
  });

  it('writes the list line of the card, markers included', () => {
    const report = emptyReport();
    const c = { ...card(T1, 'Odd \u00e9 title', 'implementing', 'impl'), adhoc: true };
    report.closeMerged.missingPr.push({ ticket: c, prs: [], decisions: [], decisionLinked: false });
    const line = renderHealth(report).split('\n')[7];
    expect(line).toBe(`${T1}  implementing  impl  [adhoc] Odd \\u00E9 title  no pr link`);
    // The same fields as the list line of a ticket.
    expect(line?.startsWith(renderListLineOf(c))).toBe(true);
  });

  it('writes a stuck ticket without a comment, and decisions in the plural', () => {
    const report = emptyReport();
    report.stuckBlocked.push({
      ticket: card(T2, 'Cache', 'blocked', null),
      blockedFrom: 'review',
      since: { hash: 'a'.repeat(64), kind: 'ticket.handoff', actor: 'rev', ts: ts(1) },
      blockedMs: 5 * MINUTE,
      latestComment: null,
    });
    report.unpromotedDecisions.push({
      ticket: card(T3, 'Decider', 'todo', null),
      decisions: [
        { actor: 'a', text: 'DECISION: one' },
        { actor: 'b', text: 'DECISION: two' },
      ],
    });
    report.closeMerged.ready.push({
      ticket: card(READY, 'Ready', 'merged', 'rev'),
      prs: [42, 'https://example.invalid/pr/9'],
      decisions: [],
      decisionLinked: false,
    });
    const lines = renderHealth(report).split('\n');
    expect(lines[2]).toBe('stuck in blocked: 1');
    expect(lines[3]).toBe(`${T2}  blocked  -  Cache  blocked 5m ago from review; no comment`);
    expect(lines[5]).toBe(`${T3}  todo  -  Decider  2 open decisions, no decision link`);
    expect(lines[7]).toBe(`${READY}  merged  rev  Ready  pr 42, https://example.invalid/pr/9`);
  });

  it('writes the check result', () => {
    const matches = { ...emptyReport(), check: { ranAt: NOW, matches: true, differingRows: 0 } };
    expect(renderHealth(matches).split('\n').at(-2)).toBe(
      'cache check: matches (0 differing rows)',
    );
    const differs = { ...emptyReport(), check: { ranAt: NOW, matches: false, differingRows: 3 } };
    expect(renderHealth(differs).split('\n').at(-2)).toBe(
      'cache check: differs (3 differing rows)',
    );
  });

  it('is plain ASCII', () => {
    const report = emptyReport();
    report.staleClaims.push({
      ticket: card(T1, 'T\u00eftle', 'tests', 'impl\u2014x'),
      assignee: 'impl\u2014x',
      since: { hash: 'b'.repeat(64), kind: 'ticket.claim', actor: 'impl\u2014x', ts: ts(2) },
      idleMs: 3 * HOUR,
    });
    expect(renderHealth(report)).toMatch(/^[\x20-\x7e\n]*$/);
  });
});

/** A timestamp for unit fixtures. */
function ts(wall: number): { wall: number; counter: number; actor: string } {
  return { wall, counter: 0, actor: 'x' };
}

/** `renderListLine` of a ticket with the card's fields. */
function renderListLineOf(c: Card): string {
  return renderListLine({
    id: c.id,
    title: c.title,
    status: c.status,
    assignee: c.assignee,
    adhoc: c.adhoc ? 'reason' : null,
    closed: c.closed,
  } as Parameters<typeof renderListLine>[0]);
}

describe('health through the built CLI', () => {
  it('prints the JSON report and exits 0', () => {
    vi.useRealTimers();
    const { root } = seeded();
    const out = spawnCli(['health', '--json'], root);
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as HealthReport;
    // Real time is later than the fixture NOW, so T1 is still stale.
    expect(doc.staleClaims.map((s) => s.ticket.id)).toEqual([T1]);
    expect(doc.late).toBeNull();
  });
});
