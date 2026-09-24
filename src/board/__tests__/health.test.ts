/**
 * `boardHealth` (add-board-insights task 2.1; board-insights: "Health
 * command"; design.md: "The `health` command", "Risks / Trade-offs":
 * "`health` reads event files -> only those of open tickets").
 *
 * The expected report is computed independently of `boardHealth`: the
 * group 1 `healthReport` over the whole board as `loadSnapshot` loads it
 * (which reads every event file, closed tickets included). The event
 * files `boardHealth` may read are computed from how the fixture was
 * written, and cross-checked with the independent `foldDir`.
 *
 * The fixture interleaves the events of open and closed tickets in time,
 * and applies a comment to a closed ticket after its close (the fold
 * applies events after a close by their own rules), so no wall range or
 * fold position separates the files of closed tickets from the others.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { dumpCache } from '../../store/cache.js';
import { readEventFile, type ReadOutcome } from '../../store/eventfile.js';
import { P, T1, T2, T3, ev, eventNames, foldDir } from '../../store/__tests__/helpers.js';
import { DEFAULT_THRESHOLDS, healthReport, type HealthThresholds } from '../../view/health.js';
import { commentTicket } from '../actions.js';
import { createEventCache } from '../feed.js';
import { boardHealth } from '../health.js';
import { loadSnapshot } from '../snapshot.js';
import {
  expectBoardError,
  makeBoardDir,
  openTracked,
  putEvent,
  setup,
  tempDir,
} from './helpers.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The wall `hours` hours before `NOW`. */
function ago(hours: number): number {
  return NOW - Math.round(hours * HOUR);
}

// Tickets (valid ULIDs, ascending in this order).
const STALE = T1;
const CLOSED = T2;
const BLOCKED = T3;
const READY = '01C0000000ACTAV9WEVGEMMVRZ';
const HELD = '01D0000000ACTAV9WEVGEMMVRZ';
const NO_PR = '01E0000000ACTAV9WEVGEMMVRZ';
const CLOSED_BLOCKED = '01F0000000ACTAV9WEVGEMMVRZ';

const CLOSED_TICKETS: ReadonlySet<string> = new Set([CLOSED, CLOSED_BLOCKED]);

type Expected = 'applied' | 'rejected' | 'unknown';

/** One event file written by the fixture. */
interface Written {
  hash: string;
  ticket: string;
  expected: Expected;
}

/** The fixture board: its directory, the files written and the open board. */
interface Fixture {
  dir: string;
  eventsDir: string;
  written: Written[];
}

/** Writes the fixture's event files into a fresh board directory (not opened). */
function writeFixture(): Fixture {
  const dir = makeBoardDir(tempDir());
  const eventsDir = join(dir, 'events');
  const written: Written[] = [];
  const put = (event: unknown, ticket: string, expected: Expected = 'applied'): void => {
    written.push({ hash: putEvent(eventsDir, event), ticket, expected });
  };
  const toMerged = (ticket: string, title: string, start: number): void => {
    put(ev(P.create(ticket, title), 'orch', ago(start)), ticket);
    put(ev(P.move(ticket, 'tests'), 'orch', ago(start - 0.1)), ticket);
    put(ev(P.move(ticket, 'implementing'), 'orch', ago(start - 0.2)), ticket);
    put(ev(P.move(ticket, 'review'), 'orch', ago(start - 0.3)), ticket);
    put(ev(P.move(ticket, 'merged'), 'orch', ago(start - 0.4)), ticket);
  };

  // An open ticket with a stale claim and an open decision, interleaved
  // with a closed ticket that also has a DECISION: comment.
  put(ev(P.create(STALE, 'Stale claim'), 'orch', ago(10)), STALE);
  put(ev(P.create(CLOSED, 'Closed one'), 'orch', ago(9.95)), CLOSED);
  put(ev(P.claim(STALE), 'impl', ago(9.9)), STALE);
  put(ev(P.claim(CLOSED), 'impl2', ago(9.85)), CLOSED);
  put(ev(P.move(CLOSED, 'tests'), 'impl2', ago(9.8)), CLOSED);
  put(ev(P.comment(STALE, 'DECISION: use sessions'), 'impl', ago(9.75)), STALE);
  put(ev(P.move(CLOSED, 'implementing'), 'impl2', ago(9.7)), CLOSED);
  put(ev(P.move(CLOSED, 'review'), 'impl2', ago(9.65)), CLOSED);
  put(ev(P.move(CLOSED, 'merged'), 'impl2', ago(9.6)), CLOSED);
  put(ev(P.comment(CLOSED, 'DECISION: closed decision'), 'impl2', ago(9.55)), CLOSED);
  put(ev(P.pr(CLOSED, 11), 'rev', ago(9.5)), CLOSED);
  put(ev(P.close(CLOSED, 'docs/adr/0001-x.md'), 'orch', ago(9.45)), CLOSED);

  // Blocked for 30 hours, from tests, with a comment saying why.
  put(ev(P.create(BLOCKED, 'Blocked one'), 'orch', ago(40)), BLOCKED);
  put(ev(P.move(BLOCKED, 'tests'), 'orch', ago(39)), BLOCKED);
  put(ev(P.move(BLOCKED, 'blocked'), 'impl3', ago(30)), BLOCKED);
  put(ev(P.comment(BLOCKED, 'waiting on the API'), 'impl3', ago(29)), BLOCKED);

  // A ticket closed from blocked, interleaved with the blocked one.
  put(ev(P.create(CLOSED_BLOCKED, 'Closed from blocked'), 'orch', ago(35)), CLOSED_BLOCKED);
  put(ev(P.move(CLOSED_BLOCKED, 'blocked'), 'orch', ago(31)), CLOSED_BLOCKED);
  put(ev(P.close(CLOSED_BLOCKED), 'orch', ago(28)), CLOSED_BLOCKED);

  // close-merged candidates: ready, held by a decision, missing a pr link.
  toMerged(READY, 'Ready', 8);
  put(ev(P.pr(READY, 42), 'rev', ago(7.5)), READY);
  toMerged(HELD, 'Held', 7.4);
  put(ev(P.pr(HELD, 'https://example.invalid/pr/7'), 'rev', ago(6.9)), HELD);
  put(ev(P.comment(HELD, 'DECISION: keep v1'), 'rev', ago(6.8)), HELD);
  toMerged(NO_PR, 'No PR', 6.7);

  // A reviewer's comment does not make the holder look busy.
  put(ev(P.comment(STALE, 'any news?'), 'reviewer', ago(1)), STALE);
  // An event applied to a closed ticket after its close.
  put(ev(P.comment(CLOSED, 'after the close'), 'orch', ago(0.5)), CLOSED);
  // A rejected event and an unknown-kind event of an open ticket.
  put(ev(P.claim(STALE), 'intruder', ago(0.4)), STALE, 'rejected');
  put(
    {
      v: 1,
      kind: 'ticket.future',
      ticket: STALE,
      actor: 'orch',
      ts: { wall: ago(0.3), counter: 0, actor: 'orch' },
      body: { x: 1 },
    },
    STALE,
    'unknown',
  );
  return { dir, eventsDir, written };
}

/** The fixture, opened (the open catches up, folding every file). */
function fixture(): Fixture & { board: ReturnType<typeof openTracked> } {
  const f = writeFixture();
  return { ...f, board: openTracked(f.dir) };
}

/** The hashes `boardHealth` may read: applied events of open tickets. */
function allowed(f: Fixture): Set<string> {
  return new Set(
    f.written
      .filter((w) => w.expected === 'applied' && !CLOSED_TICKETS.has(w.ticket))
      .map((w) => w.hash),
  );
}

/** A cache over the real reader that records every file name it reads. */
function countingCache(): { cache: ReturnType<typeof createEventCache>; reads: string[] } {
  const reads: string[] = [];
  const cache = createEventCache((eventsDir, name): ReadOutcome => {
    reads.push(name);
    return readEventFile(eventsDir, name);
  });
  return { cache, reads };
}

/** The expected report: `healthReport` over the whole board, as JSON. */
function expected(
  board: ReturnType<typeof openTracked>,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): unknown {
  return plain(healthReport({ model: loadSnapshot(board), now: NOW, thresholds }));
}

/** JSON round trip, as the CLI prints it. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Runs one statement on the live cache through its own connection. */
function handEdit(dir: string, sql: string, ...params: string[]): void {
  const db = new DatabaseSync(join(dir, 'cache.sqlite'));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the fixture', () => {
  it('has the outcomes and closed tickets the tests rely on', () => {
    const f = writeFixture();
    const folded = foldDir(f.eventsDir);
    expect(folded.rejected.map((r) => r.hash)).toEqual(
      f.written.filter((w) => w.expected === 'rejected').map((w) => w.hash),
    );
    expect(folded.unknown.map((u) => u.hash)).toEqual(
      f.written.filter((w) => w.expected === 'unknown').map((w) => w.hash),
    );
    const closed = Object.values(folded.state.tickets)
      .filter((t) => t.closed)
      .map((t) => t.id)
      .sort();
    expect(closed).toEqual([...CLOSED_TICKETS].sort());
    // The comment after the close is applied to the closed ticket.
    expect(folded.state.tickets[CLOSED]?.comments.at(-1)?.text).toBe('after the close');
    expect(eventNames(f.eventsDir)).toHaveLength(f.written.length);
  });
});

describe('boardHealth', () => {
  it('equals healthReport over the whole board, with late and check null', () => {
    const { board } = fixture();
    const want = expected(board);
    const report = boardHealth(board, { now: NOW });
    expect(plain(report)).toEqual(want);
    expect(report.late).toBeNull();
    expect(report.check).toBeNull();
    expect(report.now).toBe(NOW);
    // Every section has a finding, so the comparison pins each of them.
    expect(report.staleClaims.map((s) => s.ticket.id)).toEqual([STALE]);
    expect(report.stuckBlocked.map((s) => s.ticket.id)).toEqual([BLOCKED]);
    expect(report.unpromotedDecisions.map((u) => u.ticket.id)).toEqual([STALE, HELD]);
    expect(report.closeMerged.ready.map((c) => c.ticket.id)).toEqual([READY]);
    expect(report.closeMerged.heldByDecision.map((c) => c.ticket.id)).toEqual([HELD]);
    expect(report.closeMerged.missingPr.map((c) => c.ticket.id)).toEqual([NO_PR]);
  });

  it('measures idle time from the claim, not the reviewer comment', () => {
    const { board } = fixture();
    const [stale] = boardHealth(board, { now: NOW }).staleClaims;
    expect(stale?.assignee).toBe('impl');
    // The holder's own latest event is the DECISION: comment, after the claim.
    expect(stale?.idleMs).toBe(NOW - ago(9.75));
    expect(stale?.since).toMatchObject({ kind: 'ticket.comment', actor: 'impl' });
  });

  it('reads only the event files of applied events of open tickets, each at most once', () => {
    const f = fixture();
    const { cache, reads } = countingCache();
    boardHealth(f.board, { now: NOW, cache });
    const ok = allowed(f);
    const names = reads.map((name) => name.replace(/\.json$/, ''));
    const byHash = new Map(f.written.map((w) => [w.hash, w]));
    const offending = names
      .filter((hash) => !ok.has(hash))
      .map((hash) => {
        const w = byHash.get(hash);
        return w === undefined
          ? hash
          : `${w.ticket}${CLOSED_TICKETS.has(w.ticket) ? ' (closed)' : ''} ${w.expected}`;
      });
    expect(offending, 'files read that are not applied events of open tickets').toEqual([]);
    expect(new Set(names).size, 'no file read twice').toBe(names.length);
    // Something had to be read: the checks need the times of specific events.
    expect(names.length).toBeGreaterThan(0);
    // No file of a closed ticket, explicitly.
    const closedHashes = f.written.filter((w) => CLOSED_TICKETS.has(w.ticket)).map((w) => w.hash);
    for (const hash of closedHashes) {
      expect(names).not.toContain(hash);
    }
  });

  it('needs no file but those: with every other event file deleted, the report is unchanged', () => {
    // A read that bypasses the injected cache is caught here: the files of
    // closed tickets and of rejected and unknown-kind events are gone.
    const f = fixture();
    const want = expected(f.board);
    const ok = allowed(f);
    for (const w of f.written) {
      if (!ok.has(w.hash)) {
        rmSync(join(f.eventsDir, `${w.hash}.json`));
      }
    }
    expect(eventNames(f.eventsDir)).toHaveLength(ok.size);
    expect(plain(boardHealth(f.board, { now: NOW }))).toEqual(want);
  });

  it('reads nothing again through the same cache', () => {
    const { board } = fixture();
    const { cache, reads } = countingCache();
    const first = boardHealth(board, { now: NOW, cache });
    const n = reads.length;
    expect(plain(boardHealth(board, { now: NOW, cache }))).toEqual(plain(first));
    expect(reads).toHaveLength(n);
  });

  it('leaves no transaction open, writes no event, cursor or cache row', () => {
    const { board, eventsDir } = fixture();
    const names = eventNames(eventsDir);
    const dump = dumpCache(board.db);
    const cursors = (): unknown => ({
      cursors: board.db.prepare('SELECT * FROM cursors').all(),
      seen: board.db.prepare('SELECT * FROM cursor_seen').all(),
    });
    const before = cursors();
    boardHealth(board, { now: NOW });
    expect(board.db.isTransaction).toBe(false);
    boardHealth(board, { now: NOW, check: true });
    expect(board.db.isTransaction).toBe(false);
    expect(eventNames(eventsDir)).toEqual(names);
    expect(dumpCache(board.db)).toBe(dump);
    expect(cursors()).toEqual(before);
  });

  it('reads one snapshot, and a writer on another connection is not blocked meanwhile', () => {
    const f = fixture();
    const writer = openTracked(f.dir);
    let wrote = false;
    const cache = createEventCache((eventsDir, name): ReadOutcome => {
      if (!wrote) {
        wrote = true;
        // Throws BoardError(5, 'busy') after the busy timeout if blocked.
        commentTicket(writer, 'late-writer', {
          id: STALE,
          text: 'DECISION: written while health reads',
        });
      }
      return readEventFile(eventsDir, name);
    });
    const report = boardHealth(f.board, { now: NOW, cache });
    expect(wrote).toBe(true);
    expect(f.board.db.isTransaction).toBe(false);
    // The comment was written, but the report reflects the state it read.
    const texts = report.unpromotedDecisions.flatMap((u) => u.decisions.map((d) => d.text));
    expect(texts).toContain('DECISION: use sessions');
    expect(texts).not.toContain('DECISION: written while health reads');
    // A later report on the same board sees it.
    const later = boardHealth(f.board, { now: NOW });
    expect(later.unpromotedDecisions.flatMap((u) => u.decisions.map((d) => d.text))).toContain(
      'DECISION: written while health reads',
    );
  });

  it('is not blocked by a writer holding the write lock when there is no check', () => {
    const f = fixture();
    const other = openTracked(f.dir);
    other.db.exec('BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      const report = boardHealth(f.board, { now: NOW });
      expect(Date.now() - started).toBeLessThan(4000);
      expect(report.check).toBeNull();
    } finally {
      other.db.exec('ROLLBACK');
    }
  });

  it('uses DEFAULT_THRESHOLDS for any threshold left out', () => {
    const { board } = fixture();
    expect(boardHealth(board, { now: NOW }).thresholds).toEqual(DEFAULT_THRESHOLDS);
    const half = { staleAfter: 30 * MINUTE };
    const report = boardHealth(board, { now: NOW, thresholds: half });
    expect(report.thresholds).toEqual({
      staleAfter: 30 * MINUTE,
      blockedAfter: DEFAULT_THRESHOLDS.blockedAfter,
    });
    expect(plain(report)).toEqual(expected(board, report.thresholds));
    const other = { blockedAfter: 31 * HOUR };
    const report2 = boardHealth(board, { now: NOW, thresholds: other });
    expect(report2.thresholds).toEqual({
      staleAfter: DEFAULT_THRESHOLDS.staleAfter,
      blockedAfter: 31 * HOUR,
    });
    // Blocked for 30 hours: not stuck at 31.
    expect(report2.stuckBlocked).toEqual([]);
    expect(plain(report2)).toEqual(expected(board, report2.thresholds));
  });

  it('applies thresholds as given: a 12 hour stale threshold leaves the 9.75 hour claim out', () => {
    const { board } = fixture();
    const thresholds = { staleAfter: 12 * HOUR, blockedAfter: 24 * HOUR };
    const report = boardHealth(board, { now: NOW, thresholds });
    expect(report.staleClaims).toEqual([]);
    expect(plain(report)).toEqual(expected(board, thresholds));
  });

  it('reads the clock once when now is not given', () => {
    const { board } = fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const report = boardHealth(board, { check: true });
    expect(report.now).toBe(NOW);
    expect(report.check?.ranAt).toBe(NOW);
    vi.useRealTimers();
    expect(plain({ ...report, check: null })).toEqual(expected(board));
  });

  it('gives an empty report on an empty board', () => {
    const { board } = setup();
    expect(boardHealth(board, { now: NOW })).toEqual({
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

  it('works without options', () => {
    const { board } = setup();
    const report = boardHealth(board);
    expect(report.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(report.check).toBeNull();
    expect(Math.abs(report.now - Date.now())).toBeLessThan(60_000);
  });

  it('reads ticket state from the cache', () => {
    const f = fixture();
    handEdit(f.dir, "UPDATE tickets SET title = 'from the cache' WHERE id = ?", READY);
    const report = boardHealth(f.board, { now: NOW });
    expect(report.closeMerged.ready.map((c) => c.ticket.title)).toEqual(['from the cache']);
  });

  it('throws exit 5 integrity when a file it needs is no longer a well-formed event', () => {
    const f = fixture();
    // The move into blocked: its time is in no cache table, so it must be read.
    const entry = f.written.filter((w) => w.ticket === BLOCKED)[2];
    expect(entry).toBeDefined();
    writeFileSync(join(f.eventsDir, `${entry?.hash ?? ''}.json`), '{"not":"an event"}');
    expectBoardError(() => boardHealth(f.board, { now: NOW }), 5, 'integrity');
  });
});

describe('boardHealth with check', () => {
  it('scenario: a cache matching the event log reports a match with 0 differing rows', () => {
    const { board } = fixture();
    const report = boardHealth(board, { now: NOW, check: true });
    expect(report.check).toEqual({ ranAt: NOW, matches: true, differingRows: 0 });
    expect(plain({ ...report, check: null })).toEqual(expected(board));
  });

  it('reports a differing cache as a finding with the number of differing rows', () => {
    const f = fixture();
    handEdit(f.dir, "UPDATE tickets SET title = 'hacked' WHERE id = ?", READY);
    handEdit(f.dir, "UPDATE comments SET text = 'edited' WHERE ticket = ? AND seq = 0", BLOCKED);
    const report = boardHealth(f.board, { now: NOW, check: true });
    expect(report.check).toEqual({ ranAt: NOW, matches: false, differingRows: 2 });
    expect(f.board.db.isTransaction).toBe(false);
  });

  it('does not run the check unless asked', () => {
    const f = fixture();
    handEdit(f.dir, "UPDATE tickets SET title = 'hacked' WHERE id = ?", READY);
    expect(boardHealth(f.board, { now: NOW }).check).toBeNull();
    expect(boardHealth(f.board, { now: NOW, check: false }).check).toBeNull();
  });

  it('throws exit 5 busy when the check cannot take the write lock', () => {
    const f = fixture();
    const other = openTracked(f.dir);
    other.db.exec('BEGIN IMMEDIATE');
    try {
      expectBoardError(() => boardHealth(f.board, { now: NOW, check: true }), 5, 'busy');
    } finally {
      other.db.exec('ROLLBACK');
    }
    expect(f.board.db.isTransaction).toBe(false);
  }, 20_000);
});
