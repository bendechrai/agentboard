/**
 * Property tests for the scope disposition (add-adhoc-ticket-lifecycle task
 * 1.2; board-events: "Fold semantics", "Unplanned disposition";
 * board-openspec-integration: "Scope disposition at merge and close").
 *
 * Random sequences of creates (planned or ad hoc), links, unplanned
 * dispositions, moves, hand-offs, blocks and closes over three tickets,
 * with small walls so timestamps collide, are folded one event at a time.
 * At every fold position no ticket in `merged` has both `task` and
 * `unplanned` null, and the final result is byte-identical over sampled
 * read orders. The oracle `Model` is an independent restatement, written
 * for this test, of the disposition rules: which `ticket.unplanned` and
 * `ticket.link` apply and what `task` and `unplanned` they leave, and when
 * a move or hand-off into `merged` is refused for want of a disposition.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalEncode, canonicalHash, type JsonValue } from '../canonical.js';
import {
  applyEvent,
  compareFoldOrder,
  fold,
  type BoardState,
  type FoldInput,
  type FoldResult,
  type Ticket,
} from '../fold.js';
import type { Hlc } from '../hlc.js';
import type { BoardEvent, Status, TaskRef } from '../schema.js';

const TICKETS = ['01ARYZ6S41TSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '01BX5ZZKBKACTAV9WEVGEMMVRZ'] as const;
const ACTORS = ['a', 'b', 'c'] as const;
const STATUS_LIST: readonly Status[] = ['todo', 'tests', 'implementing', 'review', 'merged', 'blocked'];
const TASKS: readonly TaskRef[] = [
  { source: 'openspec', ref: 'add-login', item: '2' },
  { source: 'speckit', ref: '001-albums', item: 'phase-2' },
];
const REASONS = ['hotfix', 'abandoned: duplicate', 'maintenance'] as const;

// Each run folds up to a few hundred events; under a loaded machine the
// whole property can exceed vitest's 5 second default.
const PROPERTY_TIMEOUT_MS = 120_000;

type Op =
  | { op: 'create'; task: TaskRef | null; adhoc: string | null }
  | { op: 'reach-review'; task: TaskRef | null }
  | { op: 'link'; body: { task: TaskRef } | { pr: number } | { decision: string } }
  | { op: 'unplanned'; reason: string }
  | { op: 'move'; to: Status }
  | { op: 'handoff'; to: string; status: Status }
  | { op: 'block' }
  | { op: 'close'; decision: string | null };

interface Step {
  ticket: string;
  actor: string;
  wall: number;
  counter: number;
  op: Op;
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TASKS, null).map((task): Op => ({
    op: 'create',
    task,
    adhoc: task === null ? 'found in prod' : null,
  })) },
  // A create followed by the three moves to review, one millisecond apart,
  // so undisposed tickets in review (where the merged rule bites) are common.
  { weight: 3, arbitrary: fc.constantFrom(...TASKS, null).map((task): Op => ({
    op: 'reach-review',
    task,
  })) },
  { weight: 2, arbitrary: fc.oneof(
    fc.constantFrom(...TASKS).map((task) => ({ task })),
    fc.integer({ min: 1, max: 99 }).map((pr) => ({ pr })),
    fc.constant({ decision: 'adr/0013.md' }),
  ).map((body): Op => ({ op: 'link', body })) },
  { weight: 3, arbitrary: fc.constantFrom(...REASONS).map((reason): Op => ({ op: 'unplanned', reason })) },
  { weight: 6, arbitrary: fc.constantFrom(...STATUS_LIST).map((to): Op => ({ op: 'move', to })) },
  { weight: 2, arbitrary: fc.tuple(fc.constantFrom(...ACTORS), fc.constantFrom(...STATUS_LIST)).map(
    ([to, status]): Op => ({ op: 'handoff', to, status }),
  ) },
  { weight: 1, arbitrary: fc.constant<Op>({ op: 'block' }) },
  { weight: 2, arbitrary: fc.constantFrom('adr/0001.md', null).map((decision): Op => ({ op: 'close', decision })) },
);

const stepArb: fc.Arbitrary<Step> = fc.record({
  ticket: fc.constantFrom(...TICKETS),
  actor: fc.constantFrom(...ACTORS),
  wall: fc.integer({ min: 0, max: 60 }),
  counter: fc.integer({ min: 0, max: 2 }),
  op: opArb,
});

function toEvents(step: Step): BoardEvent[] {
  const { ticket, actor, op } = step;
  const ts: Hlc = { wall: step.wall, counter: step.counter, actor };
  const base = { v: 1 as const, ticket, actor, ts };
  switch (op.op) {
    case 'create':
      return [
        {
          ...base,
          kind: 'ticket.create',
          body:
            op.task === null ? { title: 't', adhoc: op.adhoc ?? 'x' } : { title: 't', task: op.task },
        },
      ];
    case 'reach-review': {
      const at = (offset: number): Hlc => ({ wall: step.wall + offset, counter: 0, actor });
      const create: BoardEvent = {
        ...base,
        ts: at(0),
        kind: 'ticket.create',
        body: op.task === null ? { title: 't', adhoc: 'found in prod' } : { title: 't', task: op.task },
      };
      const moves = (['tests', 'implementing', 'review'] as const).map(
        (to, i): BoardEvent => ({ ...base, ts: at(i + 1), kind: 'ticket.move', body: { to } }),
      );
      return [create, ...moves];
    }
    case 'link':
      return [{ ...base, kind: 'ticket.link', body: op.body }];
    case 'unplanned':
      return [{ ...base, kind: 'ticket.unplanned', body: { reason: op.reason } }];
    case 'move':
      return [{ ...base, kind: 'ticket.move', body: { to: op.to } }];
    case 'handoff':
      return [
        { ...base, kind: 'ticket.handoff', body: { to: op.to, status: op.status, note: 'n' } },
      ];
    case 'block':
      return [{ ...base, kind: 'ticket.move', body: { to: 'blocked' } }];
    case 'close':
      return [
        {
          ...base,
          kind: 'ticket.close',
          body: op.decision === null ? { noDecision: true } : { decision: op.decision },
        },
      ];
  }
}

/** A fold input whose event is known to be a `BoardEvent` (every event here is). */
interface TypedInput extends FoldInput {
  event: BoardEvent;
}

function toInputs(steps: readonly Step[]): TypedInput[] {
  const seen = new Map<string, TypedInput>();
  for (const step of steps) {
    for (const event of toEvents(step)) {
      const hash = canonicalHash(event);
      if (!seen.has(hash)) {
        seen.set(hash, { hash, event });
      }
    }
  }
  return [...seen.values()];
}

function emptyState(): BoardState {
  return { tickets: {}, meta: Object.create(null) as Record<string, JsonValue> };
}

function bytesOf(result: FoldResult): string {
  return new TextDecoder().decode(
    canonicalEncode({
      state: result.state,
      rejected: result.rejected,
      unknown: result.unknown,
      latest: result.latest,
    }),
  );
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** The invariant: no ticket in `merged` has both `task` and `unplanned` null. */
function expectDisposed(state: BoardState, at: string): void {
  for (const ticket of Object.values(state.tickets)) {
    if (ticket.status === 'merged') {
      expect(
        ticket.task !== null || ticket.unplanned !== null,
        `${at}: ${ticket.id} is merged with neither a task nor an unplanned disposition`,
      ).toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
// The oracle: the disposition rules for one ticket, restated independently.

interface ModelTicket {
  task: TaskRef | null;
  unplanned: { reason: string; actor: string; ts: Hlc } | null;
}

class Model {
  readonly tickets = new Map<string, ModelTicket>();

  /**
   * What the rules say about `event` against the ticket's state before it:
   * `applied` or `rejected` with the reason, for the kinds the disposition
   * rules decide (`ticket.unplanned` always; a move or hand-off to
   * `merged` from `review`, where the state machine allows it); `other`
   * for everything the model does not decide. Applying an accepted
   * `ticket.unplanned` or task link updates the model.
   */
  decide(
    event: BoardEvent,
    before: Ticket | null,
  ): { verdict: 'applied' | 'other' } | { verdict: 'rejected'; reason: string } {
    if (event.kind === 'board.meta') {
      return { verdict: 'other' };
    }
    const existing = this.tickets.get(event.ticket);
    if (event.kind === 'ticket.create') {
      if (existing === undefined) {
        const { task } = event.body;
        this.tickets.set(event.ticket, { task: task === undefined ? null : { ...task }, unplanned: null });
      }
      return { verdict: 'other' };
    }
    if (existing === undefined) {
      return { verdict: 'rejected', reason: 'unknown-ticket' };
    }
    if (event.kind === 'ticket.unplanned') {
      if (existing.task !== null) {
        return { verdict: 'rejected', reason: 'already-linked' };
      }
      existing.unplanned = { reason: event.body.reason, actor: event.actor, ts: { ...event.ts } };
      return { verdict: 'applied' };
    }
    if (event.kind === 'ticket.link' && 'task' in event.body) {
      existing.task = { ...event.body.task };
      existing.unplanned = null;
      return { verdict: 'applied' };
    }
    const target =
      event.kind === 'ticket.move'
        ? event.body.to
        : event.kind === 'ticket.handoff'
          ? event.body.status
          : null;
    if (target === 'merged' && before !== null && before.status === 'review') {
      return existing.task === null && existing.unplanned === null
        ? { verdict: 'rejected', reason: 'needs-scope-disposition' }
        : { verdict: 'applied' };
    }
    return { verdict: 'other' };
  }
}

function cloneTicket(ticket: Ticket | undefined): Ticket | null {
  return ticket === undefined ? null : (JSON.parse(JSON.stringify(ticket)) as Ticket);
}

/** Fixed fast-check seed for the vacuity check; see the comment on that test. */
const VACUITY_SEED = 1;

describe('property: the scope disposition', () => {
  it(
    'no merged ticket is undisposed at any fold position, the oracle agrees, and read order is irrelevant',
    { timeout: PROPERTY_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(fc.array(stepArb, { minLength: 1, maxLength: 80 }), fc.nat(), (steps, seed) => {
          const inputs = toInputs(steps);
          const ordered = [...inputs].sort(compareFoldOrder);
          const state = emptyState();
          const model = new Model();
          const rejections: string[] = [];
          for (const [i, input] of ordered.entries()) {
            const { event } = input;
            const before =
              event.kind === 'board.meta' ? null : cloneTicket(state.tickets[event.ticket]);
            const expected = model.decide(event, before);
            const outcome = applyEvent(state, input);
            const at = `position ${String(i)} (${event.kind})`;
            expectDisposed(state, at);
            if (outcome.status === 'rejected') {
              rejections.push(outcome.rejected.reason);
              expect(outcome.rejected.reason, at).not.toBe('needs-task-link');
            }
            if (expected.verdict === 'applied') {
              expect(outcome.status, at).toBe('applied');
            } else if (expected.verdict === 'rejected') {
              expect(outcome, at).toEqual({
                status: 'rejected',
                rejected: {
                  hash: input.hash,
                  kind: event.kind,
                  ticket: event.kind === 'board.meta' ? '' : event.ticket,
                  reason: expected.reason,
                },
              });
            }
            // After every event, task and unplanned agree with the model.
            for (const [id, modelled] of model.tickets) {
              const folded = state.tickets[id];
              expect(folded?.task ?? null, `${at}: task of ${id}`).toEqual(modelled.task);
              expect(folded?.unplanned ?? null, `${at}: unplanned of ${id}`).toEqual(
                modelled.unplanned,
              );
            }
          }
          // No rule depends on a task reference for a move into any status
          // but merged: a rejection for want of a disposition only ever
          // comes from a move or hand-off to merged (checked above through
          // the oracle), and never from the removed reason.
          expect(rejections).not.toContain('needs-task-link');

          // The one-at-a-time fold equals `fold`, and `fold` is independent
          // of read order.
          const reference = fold(inputs);
          expect(bytesOf({ ...reference, state: reference.state })).toBe(
            bytesOf({
              state,
              rejected: reference.rejected,
              unknown: reference.unknown,
              latest: reference.latest,
            }),
          );
          expectDisposed(reference.state, 'final');
          const referenceBytes = bytesOf(reference);
          for (let round = 0; round < 3; round += 1) {
            expect(bytesOf(fold(shuffle(inputs, seed + round)))).toBe(referenceBytes);
          }
        }),
        { numRuns: 150 },
      );
    },
  );

  // This check is seeded, unlike the main property above, so that it is
  // deterministic. With a random seed about 1 run in 800 (measured 4 failures in
  // 3300 seeds) draws no merged unplanned ticket, which failed CI
  // once. The seed was chosen by measurement: all four outcomes occur under
  // it. If the generator changes and a count reaches 0, search for a new
  // seed that restores all four rather than relaxing the assertions.
  it('is not vacuous: some runs merge an unplanned ticket, link one and refuse one', () => {
    const outcomes = { merged: 0, refused: 0, linked: 0, alreadyLinked: 0 };
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 20, maxLength: 80 }), (steps) => {
        const result = fold(toInputs(steps));
        for (const t of Object.values(result.state.tickets)) {
          if (t.status === 'merged' && t.unplanned !== null) outcomes.merged += 1;
          if (t.task !== null && t.adhoc === null && t.unplanned === null) outcomes.linked += 1;
        }
        for (const r of result.rejected) {
          if (r.reason === 'needs-scope-disposition') outcomes.refused += 1;
          if (r.reason === 'already-linked') outcomes.alreadyLinked += 1;
        }
      }),
      { numRuns: 150, seed: VACUITY_SEED },
    );
    expect(outcomes.merged).toBeGreaterThan(0);
    expect(outcomes.refused).toBeGreaterThan(0);
    expect(outcomes.linked).toBeGreaterThan(0);
    expect(outcomes.alreadyLinked).toBeGreaterThan(0);
  });
});
