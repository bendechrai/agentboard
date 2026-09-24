import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STATUSES } from '../../events/schema.js';
import { readTicket } from '../../store/cache.js';
import {
  DECISION_PREFIX,
  RETRACTED_PREFIX,
  closeTicket,
  commentTicket,
  handoffTicket,
  openDecisions,
  type CloseInput,
} from '../actions.js';
import {
  cleanEnv,
  eventCount,
  expectBoardError,
  gitRepo,
  makeBoardDir,
  openTracked,
  setup,
  tempDir,
  ticketIn,
} from './helpers.js';

/** A host project root containing `docs/adr/0002-x.md`. */
function withAdr(root: string): string {
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(root, 'docs', 'adr', '0002-x.md'), '# ADR\n');
  return 'docs/adr/0002-x.md';
}

describe('openDecisions', () => {
  const c = (actor: string, text: string): { actor: string; text: string } => ({ actor, text });

  it('uses the DECISION: and RETRACTED: prefixes', () => {
    expect(DECISION_PREFIX).toBe('DECISION:');
    expect(RETRACTED_PREFIX).toBe('RETRACTED:');
  });

  it('returns DECISION: comments in order', () => {
    const d1 = c('a', 'DECISION: use RFC 6979 for P-256');
    const d2 = c('b', 'DECISION: keep the old name');
    expect(openDecisions([d1, c('a', 'chatter'), d2])).toEqual([d1, d2]);
  });

  it('only counts the prefix at the very start, case-sensitively', () => {
    expect(
      openDecisions([
        c('a', ' DECISION: x'),
        c('a', 'decision: x'),
        c('a', 'we made a DECISION: x'),
      ]),
    ).toEqual([]);
  });

  it('a later RETRACTED: by the same actor retracts every earlier decision of that actor', () => {
    const other = c('b', 'DECISION: theirs');
    expect(
      openDecisions([
        c('a', 'DECISION: one'),
        c('a', 'DECISION: two'),
        other,
        c('a', 'RETRACTED: both'),
      ]),
    ).toEqual([other]);
  });

  it('a RETRACTED: by another actor or before the decision retracts nothing', () => {
    const late = c('a', 'DECISION: after');
    const d = c('a', 'DECISION: x');
    expect(openDecisions([c('a', 'RETRACTED: early'), late])).toEqual([late]);
    expect(openDecisions([d, c('b', 'RETRACTED: not yours')])).toEqual([d]);
  });
});

describe('closeTicket: dispositions', () => {
  it('closes a merged ticket with --no-decision', () => {
    const { board } = setup();
    const t = ticketIn(board, 'merged');
    const out = closeTicket(board, 'orch', { id: t.id, noDecision: true });
    expect(out.ticket).toMatchObject({
      closed: true,
      disposition: { noDecision: true },
      status: 'merged',
    });
    expect(out.hash).not.toBeNull();
  });

  it('closes a blocked ticket with a decision path that exists, recording it root-relative', () => {
    const { board, root } = setup();
    const path = withAdr(root);
    const t = ticketIn(board, 'blocked');
    const out = closeTicket(board, 'orch', {
      id: t.id,
      decisionRecordedIn: path,
      cwd: root,
      env: cleanEnv(),
    });
    expect(out.ticket).toMatchObject({
      closed: true,
      disposition: { decision: path },
      status: 'blocked',
    });
  });

  it('outside git, resolves against cwd and records relative to cwd', () => {
    const { board, root } = setup();
    withAdr(root);
    const t = ticketIn(board, 'merged');
    const out = closeTicket(board, 'orch', {
      id: t.id,
      decisionRecordedIn: 'adr/0002-x.md',
      cwd: join(root, 'docs'),
      env: cleanEnv(),
    });
    expect(out.ticket.disposition).toEqual({ decision: 'adr/0002-x.md' });
  });

  it('scenario: a missing decision path exits 1 naming the path and writes nothing', () => {
    const { board, root } = setup();
    const t = ticketIn(board, 'merged');
    const before = eventCount(board);
    const err = expectBoardError(
      () =>
        closeTicket(board, 'orch', {
          id: t.id,
          decisionRecordedIn: 'docs/adr/0099.md',
          cwd: root,
          env: cleanEnv(),
        }),
      1,
      'decision-path-missing',
    );
    expect(err.message).toContain('docs/adr/0099.md');
    expect(eventCount(board)).toBe(before);
  });

  it.each(STATUSES.filter((s) => s !== 'merged' && s !== 'blocked'))(
    'refuses closing a ticket in %s with exit 4 invalid-transition',
    (status) => {
      const { board } = setup();
      const t = ticketIn(board, status);
      const before = eventCount(board);
      expectBoardError(
        () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
        4,
        'invalid-transition',
      );
      expect(eventCount(board)).toBe(before);
    },
  );

  it('refuses closing an already closed ticket', () => {
    const { board } = setup();
    const t = ticketIn(board, 'merged');
    closeTicket(board, 'orch', { id: t.id, noDecision: true });
    expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
      4,
      'invalid-transition',
    );
  });
});

describe('closeTicket: decision paths inside the working tree', () => {
  /** A git repository hosting the board, with docs/adr/0002-x.md and a merged ticket. */
  function inRepo(): { root: string; board: ReturnType<typeof openTracked>; id: string } {
    const root = gitRepo(join(tempDir(), 'proj'));
    const board = openTracked(makeBoardDir(root));
    withAdr(root);
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    return { root, board, id: ticketIn(board, 'merged').id };
  }

  it('run from a subdirectory, records the path relative to the repository root', () => {
    const { root, board, id } = inRepo();
    const out = closeTicket(board, 'orch', {
      id,
      decisionRecordedIn: '../../docs/adr/0002-x.md',
      cwd: join(root, 'src', 'deep'),
      env: cleanEnv(),
    });
    expect(out.ticket.disposition).toEqual({ decision: 'docs/adr/0002-x.md' });
  });

  it('records an absolute path inside the tree relative to the root', () => {
    const { root, board, id } = inRepo();
    const out = closeTicket(board, 'orch', {
      id,
      decisionRecordedIn: join(root, 'docs', 'adr', '0002-x.md'),
      cwd: join(root, 'src'),
      env: cleanEnv(),
    });
    expect(out.ticket.disposition).toEqual({ decision: 'docs/adr/0002-x.md' });
  });

  it('refuses ../outside with exit 1 even when the file exists, writing nothing', () => {
    const { root, board, id } = inRepo();
    writeFileSync(join(root, '..', 'outside.md'), '# outside\n');
    const before = eventCount(board);
    const err = expectBoardError(
      () =>
        closeTicket(board, 'orch', {
          id,
          decisionRecordedIn: '../outside.md',
          cwd: root,
          env: cleanEnv(),
        }),
      1,
      'path-outside-tree',
    );
    expect(err.message).toContain('../outside.md');
    expect(eventCount(board)).toBe(before);
  });
});

describe('closeTicket: decisions are promoted, not buried', () => {
  it('scenario: a DECISION: comment blocks --no-decision, quoting it and the rule', () => {
    const { board } = setup();
    const t = ticketIn(board, 'merged');
    commentTicket(board, 'impl', { id: t.id, text: 'DECISION: use RFC 6979 for P-256' });
    const before = eventCount(board);
    const err = expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
      1,
      'unpromoted-decision',
    );
    expect(err.message).toContain('DECISION: use RFC 6979 for P-256');
    expect(err.message).toContain('--decision-recorded-in');
    expect(err.message).toMatch(/spec/);
    expect(err.message).toMatch(/ADR/);
    expect(eventCount(board)).toBe(before);
    expect(readTicket(board.db, t.id)?.closed).toBe(false);
  });

  it('a DECISION: in a handoff note blocks too', () => {
    const { board } = setup();
    const t = ticketIn(board, 'review');
    handoffTicket(board, 'rev', {
      id: t.id,
      to: 'orch',
      status: 'merged',
      note: 'DECISION: ship it',
    });
    expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
      1,
      'unpromoted-decision',
    );
  });

  it('a decision path closes despite DECISION: comments', () => {
    const { board, root } = setup();
    const path = withAdr(root);
    const t = ticketIn(board, 'merged');
    commentTicket(board, 'impl', { id: t.id, text: 'DECISION: x' });
    const input: CloseInput = { id: t.id, decisionRecordedIn: path, cwd: root, env: cleanEnv() };
    expect(closeTicket(board, 'orch', input).ticket.closed).toBe(true);
  });

  it('a RETRACTED: by the same actor allows --no-decision', () => {
    const { board } = setup();
    const t = ticketIn(board, 'blocked');
    commentTicket(board, 'impl', { id: t.id, text: 'DECISION: x' });
    commentTicket(board, 'impl', { id: t.id, text: 'RETRACTED: not needed after all' });
    expect(closeTicket(board, 'orch', { id: t.id, noDecision: true }).ticket.closed).toBe(true);
  });

  it('a RETRACTED: by another actor does not', () => {
    const { board } = setup();
    const t = ticketIn(board, 'merged');
    commentTicket(board, 'impl', { id: t.id, text: 'DECISION: x' });
    commentTicket(board, 'orch', { id: t.id, text: 'RETRACTED: x' });
    expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
      1,
      'unpromoted-decision',
    );
  });
});
