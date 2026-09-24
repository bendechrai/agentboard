import { describe, expect, it } from 'vitest';

import type { FoldInput } from '../../events/fold.js';
import { describeEvent } from '../describe.js';
import { E, T1, TASK } from './helpers.js';

const d = (input: FoldInput): string => describeEvent(input.event);

describe('describeEvent (board-view-model: "Activity feed entries")', () => {
  it.each<[string, FoldInput, string]>([
    ['create', E.create(T1, { title: 'Build the feed', task: TASK }), 'created Build the feed'],
    ['comment', E.comment(T1, 'looks good'), 'commented: looks good'],
    ['move', E.move(T1, 'tests'), 'moved to tests'],
    ['move to blocked', E.move(T1, 'blocked'), 'moved to blocked'],
    ['claim', E.claim(T1, { actor: 'impl' }), 'claimed'],
    ['release', E.release(T1, { actor: 'impl' }), 'released'],
    ['assign', E.assign(T1, 'reviewer-1'), 'assigned to reviewer-1'],
    [
      'handoff',
      E.handoff(T1, 'reviewer', 'review', 'green', { actor: 'impl' }),
      'handed off to reviewer (review): green',
    ],
    [
      'link task',
      E.link(T1, { task: { source: 'speckit', ref: '001-albums', item: 'phase-2' } }),
      'linked task speckit:001-albums#phase-2',
    ],
    ['link pr number', E.link(T1, { pr: 42 }), 'linked pr 42'],
    [
      'link pr url',
      E.link(T1, { pr: 'https://example.invalid/pr/7' }),
      'linked pr https://example.invalid/pr/7',
    ],
    [
      'link decision',
      E.link(T1, { decision: 'docs/adr/0007-feed.md' }),
      'linked decision docs/adr/0007-feed.md',
    ],
    [
      'close with decision',
      E.close(T1, { decision: 'docs/adr/0006-web.md' }),
      'closed (decision docs/adr/0006-web.md)',
    ],
    ['close without decision', E.close(T1, { noDecision: true }), 'closed (no decision)'],
    ['checklist tick of index 0', E.check(T1, 0, true), 'checked 1'],
    ['checklist tick of index 2', E.check(T1, 2, true), 'checked 3'],
    ['checklist untick of index 0', E.check(T1, 0, false), 'unchecked 1'],
    ['checklist untick of index 4', E.check(T1, 4, false), 'unchecked 5'],
    [
      'checklist add of one line',
      E.addLines(T1, [{ text: 'a', done: false }]),
      'added 1 checklist line(s)',
    ],
    [
      'checklist add of three lines',
      E.addLines(T1, [
        { text: 'a', done: false },
        { text: 'b', done: true },
        { text: 'c', done: false },
      ]),
      'added 3 checklist line(s)',
    ],
    ['board.meta', E.meta('project', 'agentboard'), 'set project'],
    ['board.meta with a null value', E.meta('retired', null), 'set retired'],
    ['a kind this version does not define', E.unknown(T1), 'unknown kind ticket.future'],
  ])('summarises %s', (_name, input, expected) => {
    expect(d(input)).toBe(expected);
  });

  it('keeps text verbatim, markup included', () => {
    expect(d(E.create(T1, { title: '<img src=x onerror=alert(1)>', adhoc: 'x' }))).toBe(
      'created <img src=x onerror=alert(1)>',
    );
    expect(d(E.comment(T1, 'DECISION: use sessions'))).toBe('commented: DECISION: use sessions');
  });

  it('replaces each line break with one space so the summary is one line', () => {
    expect(d(E.comment(T1, 'first\nsecond\r\nthird\rfourth'))).toBe(
      'commented: first second third fourth',
    );
    expect(d(E.comment(T1, 'a\n\nb'))).toBe('commented: a  b');
    expect(d(E.handoff(T1, 'reviewer', 'review', 'line one\nline two', { actor: 'impl' }))).toBe(
      'handed off to reviewer (review): line one line two',
    );
    expect(d(E.create(T1, { title: 'multi\nline', adhoc: 'x' }))).toBe('created multi line');
  });

  it('does not truncate long text', () => {
    const long = 'x'.repeat(5000);
    expect(d(E.comment(T1, long))).toBe(`commented: ${long}`);
  });
});
