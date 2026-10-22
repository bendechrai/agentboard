import { describe, expect, it } from 'vitest';

import { describeEvent } from '../describe.js';
import { feedEntries, type FeedEntry } from '../feed.js';
import { E, OTHER, T1, T2, T3, TASK, model } from './helpers.js';

describe('feedEntries (board-view-model: "Activity feed entries")', () => {
  const create1 = E.create(T1, { title: 'Build the feed', task: TASK }, { actor: 'orch' });
  const create2 = E.create(T2, { title: 'Other change', task: OTHER }, { actor: 'orch' });
  const create3 = E.create(T3, { title: 'Ad hoc', adhoc: 'hotfix' }, { actor: 'orch' });
  const claim1 = E.claim(T1, { actor: 'impl-1' });
  const rejectedClaim = E.claim(T1, { actor: 'impl-2' });
  const handoff1 = E.handoff(T1, 'reviewer', 'tests', 'green', { actor: 'impl-1' });
  const meta = E.meta('project', 'agentboard', { actor: 'orch' });
  const unknown = E.unknown(T1, { actor: 'impl-1' });
  const comment2 = E.comment(T2, 'hi', { actor: 'impl-1' });
  const claim2 = E.claim(T2, { actor: 'impl-2' });
  const handoff2 = E.handoff(T2, 'reviewer', 'tests', 'done', { actor: 'impl-2' });
  const comment3 = E.comment(T3, 'on ad hoc', { actor: 'impl-2' });
  const handoff3 = E.handoff(T3, 'impl-2', 'todo', 'yours', { actor: 'impl-1' });
  const inputs = [
    create1,
    create2,
    create3,
    claim1,
    rejectedClaim,
    handoff1,
    meta,
    unknown,
    comment2,
    claim2,
    handoff2,
    comment3,
    handoff3,
  ];
  const m = model(inputs);
  const applied = [
    create1,
    create2,
    create3,
    claim1,
    handoff1,
    meta,
    comment2,
    claim2,
    handoff2,
    comment3,
    handoff3,
  ];
  const hashes = (entries: FeedEntry[]): string[] => entries.map((e) => e.hash);

  it('the fixture has one rejected and one unknown event', () => {
    expect(m.events.find((e) => e.hash === rejectedClaim.hash)?.outcome).toBe('rejected');
    expect(m.events.find((e) => e.hash === unknown.hash)?.outcome).toBe('unknown');
  });

  it('returns one entry per applied event, newest first', () => {
    expect(hashes(feedEntries(m))).toEqual(applied.map((i) => i.hash).reverse());
  });

  it('is empty for a model with no events', () => {
    expect(feedEntries({ events: [], tickets: {}, late: [] })).toEqual([]);
  });

  it('carries hash, kind, actor, ts, ticket, title, change, summary and late', () => {
    const entry = feedEntries(m).find((e) => e.hash === handoff1.hash);
    expect(entry).toEqual({
      hash: handoff1.hash,
      kind: 'ticket.handoff',
      actor: 'impl-1',
      ts: handoff1.event.ts,
      ticket: T1,
      title: 'Build the feed',
      change: 'openspec:add-board-web',
      summary: 'handed off to reviewer (tests): green',
      late: false,
    });
  });

  it('gives board.meta no ticket, title or change', () => {
    const entry = feedEntries(m).find((e) => e.hash === meta.hash);
    expect(entry).toMatchObject({
      kind: 'board.meta',
      ticket: null,
      title: null,
      change: null,
      summary: 'set project',
    });
  });

  it('gives an ad hoc ticket no change', () => {
    const entry = feedEntries(m).find((e) => e.hash === comment3.hash);
    expect(entry).toMatchObject({ ticket: T3, title: 'Ad hoc', change: null });
  });

  it('uses describeEvent for every summary', () => {
    for (const entry of feedEntries(m)) {
      const input = inputs.find((i) => i.hash === entry.hash);
      expect(input).toBeDefined();
      if (input !== undefined) {
        expect(entry.summary).toBe(describeEvent(input.event));
      }
    }
  });

  it('uses the current task of the ticket as the change', () => {
    const linked = model([
      E.create(T1, { title: 'x', adhoc: 'first' }),
      E.comment(T1, 'before the link'),
      E.link(T1, { task: OTHER }),
    ]);
    expect(feedEntries(linked).map((e) => e.change)).toEqual([
      'openspec:add-board-tui',
      'openspec:add-board-tui',
      'openspec:add-board-tui',
    ]);
  });

  it('gives a null title and change when the ticket is not in the model', () => {
    const entries = feedEntries({ events: m.events, tickets: {}, late: [] });
    const entry = entries.find((e) => e.hash === claim1.hash);
    expect(entry).toMatchObject({ ticket: T1, title: null, change: null });
  });

  it('marks entries the model recorded as late', () => {
    const lateModel = model(inputs, [comment2.hash, rejectedClaim.hash]);
    const entries = feedEntries(lateModel);
    expect(entries.filter((e) => e.late).map((e) => e.hash)).toEqual([comment2.hash]);
  });

  it('scenario Filter by actor and kind', () => {
    const entries = feedEntries(m, { actor: 'impl-1', kinds: ['ticket.handoff'] });
    expect(hashes(entries)).toEqual([handoff3.hash, handoff1.hash]);
  });

  it('filters by actor alone', () => {
    expect(hashes(feedEntries(m, { actor: 'impl-2' }))).toEqual([
      comment3.hash,
      handoff2.hash,
      claim2.hash,
    ]);
    expect(feedEntries(m, { actor: 'nobody' })).toEqual([]);
  });

  it('filters by a set of kinds', () => {
    expect(hashes(feedEntries(m, { kinds: ['ticket.claim', 'board.meta'] }))).toEqual([
      claim2.hash,
      meta.hash,
      claim1.hash,
    ]);
  });

  it('an empty kinds list matches nothing', () => {
    expect(feedEntries(m, { kinds: [] })).toEqual([]);
  });

  it('filters by change, leaving out board.meta and tickets with no task', () => {
    expect(hashes(feedEntries(m, { change: 'openspec:add-board-tui' }))).toEqual([
      handoff2.hash,
      claim2.hash,
      comment2.hash,
      create2.hash,
    ]);
    expect(feedEntries(m, { change: 'openspec:add-board-tui#1' })).toEqual([]);
  });

  describe('the unplanned disposition (ADR 0013)', () => {
    const createAdhoc = E.create(T1, { title: 'Hotfix one', adhoc: 'found in prod' }, { actor: 'orch' });
    const steps = [
      E.move(T1, 'tests', { actor: 'impl-1' }),
      E.move(T1, 'implementing', { actor: 'impl-1' }),
      E.move(T1, 'review', { actor: 'impl-1' }),
    ];
    // `orch` runs `move T1 merged --unplanned "hotfix"`: the disposition, then the move.
    const unplanned = E.unplanned(T1, 'hotfix', { actor: 'orch' });
    const merge = E.move(T1, 'merged', { actor: 'orch' });

    it('scenario Unplanned summary: the feed has, newest first, moved to merged and then recorded as unplanned: hotfix, both by orch', () => {
      const m = model([createAdhoc, ...steps, unplanned, merge]);
      const entries = feedEntries(m);
      expect(entries.slice(0, 2)).toMatchObject([
        { hash: merge.hash, kind: 'ticket.move', actor: 'orch', summary: 'moved to merged' },
        {
          hash: unplanned.hash,
          kind: 'ticket.unplanned',
          actor: 'orch',
          summary: 'recorded as unplanned: hotfix',
        },
      ]);
    });

    it('gives the disposition entry the ticket, its title, no change and the event time', () => {
      const m = model([createAdhoc, ...steps, unplanned, merge]);
      const entry = feedEntries(m).find((e) => e.hash === unplanned.hash);
      expect(entry).toEqual({
        hash: unplanned.hash,
        kind: 'ticket.unplanned',
        actor: 'orch',
        ts: unplanned.event.ts,
        ticket: T1,
        title: 'Hotfix one',
        change: null,
        summary: 'recorded as unplanned: hotfix',
        late: false,
      });
    });

    it('a rejected ticket.unplanned (already-linked) produces no feed entry', () => {
      const linked = E.create(T2, { title: 'Planned', task: TASK }, { actor: 'orch' });
      const rejected = E.unplanned(T2, 'hotfix', { actor: 'orch' });
      const m = model([linked, rejected]);
      expect(m.events.find((e) => e.hash === rejected.hash)).toMatchObject({
        outcome: 'rejected',
        reason: 'already-linked',
      });
      expect(hashes(feedEntries(m))).toEqual([linked.hash]);
      expect(feedEntries(m, { kinds: ['ticket.unplanned'] })).toEqual([]);
      expect(feedEntries(m, { actor: 'orch' }).map((e) => e.kind)).toEqual(['ticket.create']);
    });

    it('a rejected ticket.unplanned on an unknown ticket produces no feed entry either', () => {
      const rejected = E.unplanned(T3, 'hotfix', { actor: 'orch' });
      const m = model([createAdhoc, rejected]);
      expect(m.events.find((e) => e.hash === rejected.hash)?.outcome).toBe('rejected');
      expect(hashes(feedEntries(m))).toEqual([createAdhoc.hash]);
    });

    it('filters the disposition by its kind', () => {
      const m = model([createAdhoc, ...steps, unplanned, merge]);
      expect(hashes(feedEntries(m, { kinds: ['ticket.unplanned'] }))).toEqual([unplanned.hash]);
      expect(hashes(feedEntries(m, { kinds: ['ticket.unplanned', 'ticket.move'] }))).toEqual([
        merge.hash,
        unplanned.hash,
        ...steps.map((s) => s.hash).reverse(),
      ]);
    });
  });

  it('combines change, actor and kinds with AND', () => {
    expect(
      hashes(
        feedEntries(m, {
          change: 'openspec:add-board-web',
          actor: 'impl-1',
          kinds: ['ticket.claim', 'ticket.handoff'],
        }),
      ),
    ).toEqual([handoff1.hash, claim1.hash]);
    expect(
      feedEntries(m, {
        change: 'openspec:add-board-tui',
        actor: 'impl-1',
        kinds: ['ticket.claim'],
      }),
    ).toEqual([]);
  });
});
