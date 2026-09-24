/**
 * Task 7.3: `closeMerged` with a stubbed `gh` (board-openspec-integration:
 * "Close merged", "Decisions are promoted, not buried"). The library tests
 * inject a fake `GhRunner`; `runGh` is exercised against a fake `gh`
 * script on a PATH built for the test, never the real one.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import type { Board } from '../../store/board.js';
import { commentTicket, linkTicket } from '../actions.js';
import { closeMerged, ghPrViewArgs, runGh, type CloseMergedInput } from '../merged.js';
import { showTicket } from '../tickets.js';
import { emptyPath, fakeGhOnPath, fakeRunner, ghCalls, missingRunner } from './gh-fake.js';
import { cleanEnv, eventCount, expectBoardError, setup, tempDir, ticketIn } from './helpers.js';

/** A `merged` ticket with each of `prs` linked in order. */
function mergedWithPr(board: Board, ...prs: (string | number)[]): Ticket {
  let ticket = ticketIn(board, 'merged');
  for (const pr of prs) {
    ticket = linkTicket(board, 'orch', { id: ticket.id, target: { pr } }).ticket;
  }
  return ticket;
}

function decisionLink(board: Board, root: string, id: string, path: string): Ticket {
  return linkTicket(board, 'orch', {
    id,
    target: { decision: path },
    cwd: root,
    env: cleanEnv(),
  }).ticket;
}

function writeFile(root: string, path: string): void {
  const abs = join(root, ...path.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '# record\n');
}

function where(root: string, gh: CloseMergedInput['gh']): CloseMergedInput {
  return { cwd: root, env: cleanEnv(), gh };
}

function current(board: Board, id: string): Ticket {
  return showTicket(board, id).ticket;
}

describe('ghPrViewArgs', () => {
  it('asks gh for the state of one PR, by number or URL', () => {
    expect(ghPrViewArgs(7)).toEqual(['pr', 'view', '7', '--json', 'state']);
    expect(ghPrViewArgs('https://github.com/o/r/pull/7')).toEqual([
      'pr',
      'view',
      'https://github.com/o/r/pull/7',
      '--json',
      'state',
    ]);
  });
});

describe('closeMerged (scenario: merged PR closes its ticket)', () => {
  it('closes a merged ticket whose PR is merged with the no-decision disposition', () => {
    const { board, root } = setup();
    const t = mergedWithPr(board, 7);
    const { gh, calls } = fakeRunner({ '7': 'MERGED' });
    const out = closeMerged(board, 'orch', where(root, gh));
    expect(calls).toEqual([['pr', 'view', '7', '--json', 'state']]);
    expect(out.unmerged).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]).toMatchObject({ id: t.id, pr: 7, disposition: { noDecision: true } });
    expect(typeof out.closed[0]?.hash).toBe('string');
    expect(out.closed[0]?.ticket).toMatchObject({
      closed: true,
      disposition: { noDecision: true },
    });
    expect(current(board, t.id).closed).toBe(true);
  });

  it('closes with the decision link path when the ticket has one', () => {
    const { board, root } = setup();
    writeFile(root, 'docs/adr/0002-one-transaction-per-command.md');
    const t = mergedWithPr(board, 'https://github.com/o/r/pull/8');
    decisionLink(board, root, t.id, 'docs/adr/0002-one-transaction-per-command.md');
    const { gh } = fakeRunner({ 'https://github.com/o/r/pull/8': 'MERGED' });
    const out = closeMerged(board, 'orch', where(root, gh));
    const disposition = { decision: 'docs/adr/0002-one-transaction-per-command.md' };
    expect(out.closed.map((c) => [c.id, c.disposition])).toEqual([[t.id, disposition]]);
    expect(current(board, t.id)).toMatchObject({ closed: true, disposition });
  });

  it('uses the last decision link when there are several', () => {
    const { board, root } = setup();
    writeFile(root, 'docs/adr/0001.md');
    writeFile(root, 'docs/adr/0002.md');
    const t = mergedWithPr(board, 7);
    decisionLink(board, root, t.id, 'docs/adr/0001.md');
    decisionLink(board, root, t.id, 'docs/adr/0002.md');
    const out = closeMerged(board, 'orch', where(root, fakeRunner({ '7': 'MERGED' }).gh));
    expect(out.closed[0]?.disposition).toEqual({ decision: 'docs/adr/0002.md' });
  });

  it('queries the last PR link when there are several', () => {
    const { board, root } = setup();
    mergedWithPr(board, 7, 9);
    const { gh, calls } = fakeRunner({ '9': 'MERGED', '7': 'OPEN' });
    const out = closeMerged(board, 'orch', where(root, gh));
    expect(calls).toEqual([['pr', 'view', '9', '--json', 'state']]);
    expect(out.closed.map((c) => c.pr)).toEqual([9]);
  });
});

describe('closeMerged: tickets it leaves open', () => {
  it.each(['OPEN', 'CLOSED'])('lists a ticket whose PR is %s and writes nothing', (state) => {
    const { board, root } = setup();
    const t = mergedWithPr(board, 7);
    const before = eventCount(board);
    const out = closeMerged(board, 'orch', where(root, fakeRunner({ '7': state }).gh));
    expect(out.closed).toEqual([]);
    expect(out.unmerged).toHaveLength(1);
    expect(out.unmerged[0]).toMatchObject({ id: t.id, pr: 7, state });
    expect(eventCount(board)).toBe(before);
    expect(current(board, t.id)).toEqual(t);
  });

  it('leaves a ticket with an unpromoted DECISION comment open and lists it with the rule', () => {
    const { board, root } = setup();
    const t = mergedWithPr(board, 7);
    commentTicket(board, 'impl', { id: t.id, text: 'DECISION: use RFC 6979 for P-256' });
    const before = eventCount(board);
    const out = closeMerged(board, 'orch', where(root, fakeRunner({ '7': 'MERGED' }).gh));
    expect(out.closed).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ id: t.id, pr: 7, reason: 'unpromoted-decision' });
    expect(out.skipped[0]?.message).toContain('DECISION: use RFC 6979 for P-256');
    expect(out.skipped[0]?.message).toMatch(/spec delta or ADR/);
    expect(eventCount(board)).toBe(before);
    expect(current(board, t.id).closed).toBe(false);
  });

  it('closes a ticket with a retracted DECISION comment with no-decision', () => {
    const { board, root } = setup();
    const t = mergedWithPr(board, 7);
    commentTicket(board, 'impl', { id: t.id, text: 'DECISION: use X' });
    commentTicket(board, 'impl', { id: t.id, text: 'RETRACTED: not a decision after all' });
    const out = closeMerged(board, 'orch', where(root, fakeRunner({ '7': 'MERGED' }).gh));
    expect(out.closed.map((c) => c.disposition)).toEqual([{ noDecision: true }]);
  });

  it('closes a ticket with a DECISION comment when it has a decision link', () => {
    const { board, root } = setup();
    writeFile(root, 'docs/adr/0003.md');
    const t = mergedWithPr(board, 7);
    commentTicket(board, 'impl', { id: t.id, text: 'DECISION: use X' });
    decisionLink(board, root, t.id, 'docs/adr/0003.md');
    const out = closeMerged(board, 'orch', where(root, fakeRunner({ '7': 'MERGED' }).gh));
    expect(out.closed.map((c) => c.disposition)).toEqual([{ decision: 'docs/adr/0003.md' }]);
  });

  it('leaves a ticket open when its decision link path does not exist', () => {
    const { board, root } = setup();
    const t = mergedWithPr(board, 7);
    decisionLink(board, root, t.id, 'docs/adr/0099-missing.md');
    const before = eventCount(board);
    const out = closeMerged(board, 'orch', where(root, fakeRunner({ '7': 'MERGED' }).gh));
    expect(out.closed).toEqual([]);
    expect(out.skipped[0]).toMatchObject({ id: t.id, reason: 'decision-path-missing' });
    expect(out.skipped[0]?.message).toContain('docs/adr/0099-missing.md');
    expect(eventCount(board)).toBe(before);
  });

  it('skips a PR gh cannot answer for, and still processes the others', () => {
    const { board, root } = setup();
    const bad = mergedWithPr(board, 404);
    const good = mergedWithPr(board, 7);
    const odd = mergedWithPr(board, 8);
    const { gh, calls } = fakeRunner({
      '7': 'MERGED',
      '8': { code: 0, stdout: 'not json', stderr: '' },
    });
    const out = closeMerged(board, 'orch', where(root, gh));
    expect(calls).toHaveLength(3);
    expect(out.closed.map((c) => c.id)).toEqual([good.id]);
    expect(out.skipped.map((s) => [s.id, s.reason])).toEqual([
      [bad.id, 'gh-error'],
      [odd.id, 'gh-error'],
    ]);
    expect(out.skipped[0]?.message).toContain('no such pull request');
    expect(current(board, bad.id).closed).toBe(false);
  });

  it('only looks at open merged tickets with a PR link', () => {
    const { board, root } = setup();
    const review = ticketIn(board, 'review');
    linkTicket(board, 'orch', { id: review.id, target: { pr: 1 } });
    const blocked = ticketIn(board, 'blocked');
    linkTicket(board, 'orch', { id: blocked.id, target: { pr: 2 } });
    ticketIn(board, 'merged'); // no PR link
    const done = mergedWithPr(board, 3);
    const first = closeMerged(board, 'orch', where(root, fakeRunner({ '3': 'MERGED' }).gh));
    expect(first.closed.map((c) => c.id)).toEqual([done.id]);
    // Now closed, it is no longer a candidate: gh is not run again.
    const { gh, calls } = fakeRunner({ '3': 'MERGED' });
    expect(closeMerged(board, 'orch', where(root, gh))).toEqual({
      closed: [],
      unmerged: [],
      skipped: [],
    });
    expect(calls).toEqual([]);
  });

  it('lists each outcome in ascending ticket id order', () => {
    const { board, root } = setup();
    const ids = [7, 8, 9, 10].map((pr) => mergedWithPr(board, pr).id);
    const { gh, calls } = fakeRunner({ '7': 'MERGED', '8': 'OPEN', '9': 'MERGED', '10': 'OPEN' });
    const out = closeMerged(board, 'orch', where(root, gh));
    expect(calls.map((c) => c[2])).toEqual(['7', '8', '9', '10']);
    expect(out.closed.map((c) => c.id)).toEqual([ids[0], ids[2]]);
    expect(out.unmerged.map((c) => c.id)).toEqual([ids[1], ids[3]]);
  });
});

describe('closeMerged without gh', () => {
  it('exits 1 naming gh when there is a candidate, writing nothing', () => {
    const { board, root } = setup();
    mergedWithPr(board, 7);
    const before = eventCount(board);
    const err = expectBoardError(
      () => closeMerged(board, 'orch', where(root, missingRunner().gh)),
      1,
      'gh-missing',
    );
    expect(err.message).toMatch(/\bgh\b/);
    expect(err.message).toMatch(/PATH/);
    expect(eventCount(board)).toBe(before);
  });

  it('succeeds without running gh when there is no candidate', () => {
    const { board, root } = setup();
    ticketIn(board, 'review');
    const { gh, calls } = missingRunner();
    expect(closeMerged(board, 'orch', where(root, gh))).toEqual({
      closed: [],
      unmerged: [],
      skipped: [],
    });
    expect(calls).toEqual([]);
  });

  it('requires an actor', () => {
    const { board, root } = setup();
    expectBoardError(
      () => closeMerged(board, '', where(root, fakeRunner({}).gh)),
      1,
      'missing-actor',
    );
  });
});

describe('runGh (the default runner) against a fake gh on PATH', () => {
  it('runs gh from env.PATH in cwd and captures its output', () => {
    const { dir, log } = fakeGhOnPath({ '7': 'MERGED' });
    const env = cleanEnv({ PATH: dir });
    const out = runGh(['pr', 'view', '7', '--json', 'state'], { cwd: tempDir(), env });
    expect(out).toEqual({ status: 'exited', code: 0, stdout: '{"state":"MERGED"}\n', stderr: '' });
    expect(ghCalls(log)).toEqual(['pr view 7 --json state']);
  });

  it('reports a non-zero exit with its stderr', () => {
    const { dir } = fakeGhOnPath({});
    const out = runGh(['pr', 'view', '404', '--json', 'state'], {
      cwd: tempDir(),
      env: cleanEnv({ PATH: dir }),
    });
    expect(out).toMatchObject({ status: 'exited', code: 1, stdout: '' });
    expect(out.status === 'exited' ? out.stderr : '').toContain('Could not resolve');
  });

  it('reports missing when env.PATH has no gh', () => {
    expect(
      runGh(['pr', 'view', '7', '--json', 'state'], {
        cwd: tempDir(),
        env: cleanEnv({ PATH: emptyPath() }),
      }),
    ).toEqual({ status: 'missing' });
  });

  it('is what closeMerged uses by default', () => {
    const { board, root } = setup();
    const t = mergedWithPr(board, 7);
    const { dir, log } = fakeGhOnPath({ '7': 'MERGED' });
    const out = closeMerged(board, 'orch', { cwd: root, env: cleanEnv({ PATH: dir }) });
    expect(out.closed.map((c) => c.id)).toEqual([t.id]);
    expect(ghCalls(log)).toEqual(['pr view 7 --json state']);
  });
});
