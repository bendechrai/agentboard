import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STATUSES, type Status } from '../../events/schema.js';
import { readTicket } from '../../store/cache.js';
import {
  claimTicket,
  commentTicket,
  handoffTicket,
  linkTicket,
  moveTicket,
  releaseTicket,
  setChecklistItem,
} from '../actions.js';
import { SECRET_PATTERN_NAMES } from '../secrets.js';
import {
  SAMPLES,
  TASK,
  cleanEnv,
  create,
  eventCount,
  expectBoardError,
  gitRepo,
  heldTicket,
  makeBoardDir,
  openTracked,
  setup,
  tempDir,
  ticketIn,
} from './helpers.js';

/** The permitted transitions of board-cli "Status state machine", written out. */
const ALLOWED: Record<Exclude<Status, 'blocked'>, readonly Status[]> = {
  todo: ['tests', 'blocked'],
  tests: ['implementing', 'blocked'],
  implementing: ['review', 'blocked'],
  review: ['implementing', 'tests', 'merged', 'blocked'],
  merged: [],
};

const ORIGINS = ['todo', 'tests', 'implementing', 'review'] as const;

describe('moveTicket: every transition from a non-blocked status', () => {
  const cases = (Object.keys(ALLOWED) as Exclude<Status, 'blocked'>[]).flatMap((from) =>
    STATUSES.map((to) => [from, to, ALLOWED[from].includes(to)] as const),
  );

  it.each(cases)('%s -> %s allowed: %s', (from, to, allowed) => {
    const { board } = setup();
    const t = ticketIn(board, from);
    const before = eventCount(board);
    if (allowed) {
      const out = moveTicket(board, 'orch', { id: t.id, to });
      expect(out.ticket.status).toBe(to);
      expect(out.ticket.blockedFrom).toBe(to === 'blocked' ? from : null);
      expect(out.hash).not.toBeNull();
      expect(eventCount(board)).toBe(before + 1);
    } else {
      expectBoardError(() => moveTicket(board, 'orch', { id: t.id, to }), 4, 'invalid-transition');
      expect(eventCount(board)).toBe(before);
      expect(readTicket(board.db, t.id)).toEqual(t);
    }
  });
});

describe('moveTicket: leaving blocked', () => {
  const cases = ORIGINS.flatMap((origin) => STATUSES.map((to) => [origin, to] as const));

  it.each(cases)('blocked from %s -> %s', (origin, to) => {
    const { board } = setup();
    const t = ticketIn(board, 'blocked', origin);
    const before = eventCount(board);
    if (to === origin) {
      const out = moveTicket(board, 'orch', { id: t.id, to });
      expect(out.ticket.status).toBe(origin);
      expect(out.ticket.blockedFrom).toBeNull();
    } else {
      // Includes blocked -> blocked (the current status).
      expectBoardError(() => moveTicket(board, 'orch', { id: t.id, to }), 4, 'invalid-transition');
      expect(eventCount(board)).toBe(before);
    }
  });

  it.each(ORIGINS)('with no target returns to the origin %s (the event names it)', (origin) => {
    const { board } = setup();
    const t = ticketIn(board, 'blocked', origin);
    const out = moveTicket(board, 'orch', { id: t.id });
    expect(out.ticket.status).toBe(origin);
    expect(out.ticket.blockedFrom).toBeNull();
    expect(eventCount(board)).toBeGreaterThan(0);
  });

  it('scenario: blocked remembers where it came from', () => {
    const { board } = setup();
    const t = ticketIn(board, 'implementing');
    moveTicket(board, 'orch', { id: t.id, to: 'blocked' });
    expect(moveTicket(board, 'orch', { id: t.id }).ticket.status).toBe('implementing');
  });

  it('with no target on a ticket that is not blocked exits 1 and writes nothing', () => {
    const { board } = setup();
    const t = ticketIn(board, 'tests');
    const before = eventCount(board);
    expectBoardError(() => moveTicket(board, 'orch', { id: t.id }), 1, 'missing-status');
    expect(eventCount(board)).toBe(before);
  });
});

describe('moveTicket: other rules', () => {
  it('scenario: review sends work back', () => {
    const { board } = setup();
    const t = ticketIn(board, 'review');
    expect(moveTicket(board, 'orch', { id: t.id, to: 'implementing' }).ticket.status).toBe(
      'implementing',
    );
  });

  it('refuses an ad hoc ticket entering implementing with needs-task-link, until linked', () => {
    const { board } = setup();
    const t = create(board, { adhoc: 'hotfix' });
    moveTicket(board, 'orch', { id: t.id, to: 'tests' });
    const before = eventCount(board);
    expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, to: 'implementing' }),
      4,
      'needs-task-link',
    );
    expect(eventCount(board)).toBe(before);
    linkTicket(board, 'orch', { id: t.id, target: { task: TASK } });
    expect(moveTicket(board, 'orch', { id: t.id, to: 'implementing' }).ticket.status).toBe(
      'implementing',
    );
  });

  it('accepts a prefix and refuses an unknown ticket with exit 4', () => {
    const { board } = setup();
    const t = create(board);
    expect(moveTicket(board, 'orch', { id: t.id.slice(0, 12), to: 'tests' }).ticket.id).toBe(t.id);
    expectBoardError(
      () => moveTicket(board, 'orch', { id: '01NOPE00', to: 'tests' }),
      4,
      'unknown-ticket',
    );
  });

  it('refuses an empty actor with exit 1', () => {
    const { board } = setup();
    const t = create(board);
    expectBoardError(() => moveTicket(board, '', { id: t.id, to: 'tests' }), 1, 'missing-actor');
  });
});

describe('claimTicket', () => {
  it('assigns an unassigned ticket to the actor with one event', () => {
    const { board } = setup();
    const t = create(board);
    const out = claimTicket(board, 'impl', { id: t.id });
    expect(out.ticket.assignee).toBe('impl');
    expect(out.hash).not.toBeNull();
    expect(eventCount(board)).toBe(2);
  });

  it('refuses a ticket assigned to someone else with exit 4, naming the assignee', () => {
    const { board } = setup();
    const t = heldTicket(board, 'implementing', 'impl');
    const before = eventCount(board);
    const err = expectBoardError(
      () => claimTicket(board, 'reviewer', { id: t.id }),
      4,
      'already-assigned',
    );
    expect(err.message).toContain('impl');
    expect(eventCount(board)).toBe(before);
    expect(readTicket(board.db, t.id)?.assignee).toBe('impl');
  });

  it('reports success without an event when the actor already holds the ticket', () => {
    const { board } = setup();
    const t = heldTicket(board, 'tests', 'impl');
    const before = eventCount(board);
    const out = claimTicket(board, 'impl', { id: t.id });
    expect(out.hash).toBeNull();
    expect(out.ticket).toEqual(readTicket(board.db, t.id));
    expect(out.ticket.assignee).toBe('impl');
    expect(eventCount(board)).toBe(before);
  });

  it('refuses a ticket assigned by a handoff to someone else', () => {
    const { board } = setup();
    const t = create(board);
    handoffTicket(board, 'orch', { id: t.id, to: 'impl', status: 'todo', note: 'yours' });
    expectBoardError(() => claimTicket(board, 'other', { id: t.id }), 4, 'already-assigned');
  });
});

describe('releaseTicket', () => {
  it('clears the assignment when the actor is the assignee', () => {
    const { board } = setup();
    const t = heldTicket(board, 'tests', 'impl');
    const out = releaseTicket(board, 'impl', { id: t.id });
    expect(out.ticket.assignee).toBeNull();
    expect(out.hash).not.toBeNull();
  });

  it('refuses a release by a non-assignee with exit 4 and writes nothing', () => {
    const { board } = setup();
    const t = heldTicket(board, 'tests', 'impl');
    const before = eventCount(board);
    expectBoardError(() => releaseTicket(board, 'other', { id: t.id }), 4, 'not-assignee');
    expect(eventCount(board)).toBe(before);
  });

  it('refuses releasing an unassigned ticket', () => {
    const { board } = setup();
    const t = create(board);
    expectBoardError(() => releaseTicket(board, 'impl', { id: t.id }), 4, 'not-assignee');
  });
});

describe('commentTicket', () => {
  it('appends comments in order', () => {
    const { board } = setup();
    const t = create(board);
    commentTicket(board, 'a', { id: t.id, text: 'one' });
    const out = commentTicket(board, 'b', { id: t.id, text: 'two' });
    expect(out.ticket.comments.map((c) => [c.actor, c.text])).toEqual([
      ['a', 'one'],
      ['b', 'two'],
    ]);
    expect(out.ticket.comments[1]?.hash).toBe(out.hash);
  });

  it('refuses empty text with exit 1', () => {
    const { board } = setup();
    const t = create(board);
    expectBoardError(() => commentTicket(board, 'a', { id: t.id, text: '' }), 1, 'usage');
  });

  it('scenario: unknown ticket exits 4 with unknown-ticket', () => {
    const { board } = setup();
    expectBoardError(
      () => commentTicket(board, 'a', { id: '01NOPE00', text: 'x' }),
      4,
      'unknown-ticket',
    );
    expect(eventCount(board)).toBe(0);
  });

  it.each(SECRET_PATTERN_NAMES)(
    'refuses %s with exit 1 naming the pattern, writing nothing',
    (name) => {
      const { board } = setup();
      const t = create(board);
      const err = expectBoardError(
        () => commentTicket(board, 'a', { id: t.id, text: `here: ${SAMPLES[name]}` }),
        1,
        'secret-like',
      );
      expect(err.message).toContain(name);
      expect(err.message).not.toContain(SAMPLES[name]);
      expect(eventCount(board)).toBe(1);
    },
  );

  it('writes secret-looking text with allowSecretLike', () => {
    const { board } = setup();
    const t = create(board);
    const text = SAMPLES['pem-private-key'];
    expect(
      commentTicket(board, 'a', { id: t.id, text, allowSecretLike: true }).ticket.comments[0]?.text,
    ).toBe(text);
  });
});

describe('handoffTicket', () => {
  it('scenario: handoff to reviewer is one event with three effects', () => {
    const { board } = setup();
    const t = heldTicket(board, 'implementing', 'impl');
    const before = eventCount(board);
    const out = handoffTicket(board, 'impl', {
      id: t.id,
      to: 'reviewer',
      status: 'review',
      note: 'green, 96%',
    });
    expect(eventCount(board)).toBe(before + 1);
    expect(out.ticket.assignee).toBe('reviewer');
    expect(out.ticket.status).toBe('review');
    expect(out.ticket.comments.at(-1)).toMatchObject({
      actor: 'impl',
      text: 'green, 96%',
      hash: out.hash,
    });
    expect(out.ticket.version).toBe(t.version + 1);
  });

  it('scenario: handoff within the same status reassigns and comments', () => {
    const { board } = setup();
    const t = heldTicket(board, 'implementing', 'impl-1');
    const out = handoffTicket(board, 'impl-1', {
      id: t.id,
      to: 'impl-2',
      status: 'implementing',
      note: 'yours now',
    });
    expect(out.ticket).toMatchObject({ assignee: 'impl-2', status: 'implementing' });
    expect(out.ticket.comments.at(-1)?.text).toBe('yours now');
  });

  it('a same-status handoff on a blocked ticket keeps its origin', () => {
    const { board } = setup();
    const t = ticketIn(board, 'blocked', 'review');
    const out = handoffTicket(board, 'orch', { id: t.id, to: 'x', status: 'blocked', note: 'n' });
    expect(out.ticket).toMatchObject({ status: 'blocked', blockedFrom: 'review', assignee: 'x' });
  });

  it('scenario: handoff with an invalid status writes nothing and exits 4', () => {
    const { board } = setup();
    const t = heldTicket(board, 'tests', 'impl');
    const before = eventCount(board);
    expectBoardError(
      () => handoffTicket(board, 'impl', { id: t.id, to: 'rev', status: 'merged', note: 'n' }),
      4,
      'invalid-transition',
    );
    expect(eventCount(board)).toBe(before);
    expect(readTicket(board.db, t.id)).toEqual(t);
  });

  it('refuses taking an ad hoc ticket into implementing', () => {
    const { board } = setup();
    const t = create(board, { adhoc: 'why' });
    moveTicket(board, 'orch', { id: t.id, to: 'tests' });
    expectBoardError(
      () => handoffTicket(board, 'orch', { id: t.id, to: 'i', status: 'implementing', note: 'n' }),
      4,
      'needs-task-link',
    );
  });

  it('refuses an empty to or note with exit 1', () => {
    const { board } = setup();
    const t = create(board);
    expectBoardError(
      () => handoffTicket(board, 'o', { id: t.id, to: '', status: 'tests', note: 'n' }),
      1,
      'usage',
    );
    expectBoardError(
      () => handoffTicket(board, 'o', { id: t.id, to: 'x', status: 'tests', note: '' }),
      1,
      'usage',
    );
  });

  it.each(SECRET_PATTERN_NAMES)('refuses %s in the note, writing nothing', (name) => {
    const { board } = setup();
    const t = create(board);
    const err = expectBoardError(
      () => handoffTicket(board, 'o', { id: t.id, to: 'x', status: 'tests', note: SAMPLES[name] }),
      1,
      'secret-like',
    );
    expect(err.message).toContain(name);
    expect(err.message).not.toContain(SAMPLES[name]);
    expect(eventCount(board)).toBe(1);
  });

  it('writes a secret-looking note with allowSecretLike', () => {
    const { board } = setup();
    const t = create(board);
    const note = SAMPLES['github-token'];
    const out = handoffTicket(board, 'o', {
      id: t.id,
      to: 'x',
      status: 'tests',
      note,
      allowSecretLike: true,
    });
    expect(out.ticket.comments.at(-1)?.text).toBe(note);
  });
});

describe('linkTicket', () => {
  it('a task link replaces the task and clears the ad hoc reason', () => {
    const { board } = setup();
    const t = create(board, { adhoc: 'why' });
    const task = { source: 'openspec', ref: 'x', item: '2' };
    const out = linkTicket(board, 'o', { id: t.id, target: { task } });
    expect(out.ticket).toMatchObject({ task, adhoc: null });
  });

  it('appends pr and decision links in order', () => {
    const { board, root } = setup();
    const t = create(board);
    linkTicket(board, 'o', { id: t.id, target: { pr: 12 } });
    linkTicket(board, 'o', { id: t.id, target: { pr: 'https://example.invalid/pr/3' } });
    const out = linkTicket(board, 'o', {
      id: t.id,
      target: { decision: 'docs/adr/0009-x.md' },
      cwd: root,
      env: cleanEnv(),
    });
    expect(out.ticket.links.map((l) => (l.type === 'pr' ? l.pr : l.path))).toEqual([
      12,
      'https://example.invalid/pr/3',
      'docs/adr/0009-x.md',
    ]);
  });

  it('records a decision path relative to the git root without requiring the file', () => {
    const root = gitRepo(join(tempDir(), 'proj'));
    const board = openTracked(makeBoardDir(root));
    mkdirSync(join(root, 'src'));
    const t = create(board);
    const out = linkTicket(board, 'o', {
      id: t.id,
      target: { decision: '../docs/adr/0100-new.md' },
      cwd: join(root, 'src'),
      env: cleanEnv(),
    });
    expect(out.ticket.links).toMatchObject([{ type: 'decision', path: 'docs/adr/0100-new.md' }]);
  });

  it('refuses a decision path outside the working tree', () => {
    const root = gitRepo(join(tempDir(), 'proj'));
    const board = openTracked(makeBoardDir(root));
    const t = create(board);
    expectBoardError(
      () =>
        linkTicket(board, 'o', {
          id: t.id,
          target: { decision: '../elsewhere.md' },
          cwd: root,
          env: cleanEnv(),
        }),
      1,
      'path-outside-tree',
    );
    expect(eventCount(board)).toBe(1);
  });

  it.each([[{ pr: '' }], [{ pr: 0 }], [{ pr: -3 }], [{ pr: 1.5 }], [{ decision: '' }]])(
    'refuses the target %j with exit 1',
    (target) => {
      const { board } = setup();
      const t = create(board);
      expectBoardError(() => linkTicket(board, 'o', { id: t.id, target }), 1, 'usage');
      expect(eventCount(board)).toBe(1);
    },
  );
});

describe('setChecklistItem', () => {
  it('ticks the line at a 0-based index and returns a reminder', () => {
    const { board } = setup();
    const t = create(board, { checklist: ['a', 'b', 'c'] });
    const out = setChecklistItem(board, 'impl', { id: t.id, index: 2, done: true });
    expect(out.ticket.checklist).toEqual([
      { text: 'a', done: false },
      { text: 'b', done: false },
      { text: 'c', done: true },
    ]);
    expect(out.reminder).toMatchObject({
      source: 'openspec',
      path: 'openspec/changes/add-board-core/tasks.md',
    });
  });

  it('unticks without a reminder', () => {
    const { board } = setup();
    const t = create(board, { checklist: ['a'] });
    setChecklistItem(board, 'impl', { id: t.id, index: 0, done: true });
    const out = setChecklistItem(board, 'impl', { id: t.id, index: 0, done: false });
    expect(out.ticket.checklist[0]?.done).toBe(false);
    expect(out.reminder).toBeNull();
  });

  it.each([3, -1])('refuses index %i with exit 4 checklist-index', (index) => {
    const { board } = setup();
    const t = create(board, { checklist: ['a', 'b', 'c'] });
    expectBoardError(
      () => setChecklistItem(board, 'impl', { id: t.id, index, done: true }),
      4,
      'checklist-index',
    );
    expect(eventCount(board)).toBe(1);
  });

  it('ticks on a ticket from a source without an adapter', () => {
    const { board } = setup();
    const t = create(board, {
      task: { source: 'speckit', ref: '001-photo-albums', item: 'phase-2' },
      checklist: ['x'],
    });
    const out = setChecklistItem(board, 'impl', { id: t.id, index: 0, done: true });
    expect(out.ticket.checklist[0]?.done).toBe(true);
    expect(out.reminder?.path).toBeNull();
    expect(out.reminder?.message).toContain('speckit');
  });
});
