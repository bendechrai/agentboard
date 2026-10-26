/**
 * Property test for reconciles in the fold (add-claim-leases task 8.1;
 * board-events: "Reconcile events"): folding a random ticket history
 * followed by random reconciles and ticks is independent of read order and
 * never changes the meaning of an existing checklist index.
 *
 * The oracle is `ModelLine[]`, an independent restatement of the spec's
 * checklist rules written for this test (create, `ticket.checklist`,
 * `ticket.checklist.add`, `ticket.reconcile`). It predicts every outcome,
 * which the fold must match event by event; on top of that, each applied
 * event is checked not to move, delete or rewrite any line it does not
 * name.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalEncode, canonicalHash, type JsonValue } from '../canonical.js';
import {
  applyEvent,
  compareFoldOrder,
  fold,
  type BoardState,
  type ChecklistItem,
  type FoldInput,
  type FoldResult,
} from '../fold.js';
import type { BoardEvent } from '../schema.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const SOURCE = `openspec/changes/add-x/tasks.md@sha256:${'1'.repeat(64)}`;
const PROPERTY_TIMEOUT_MS = 120_000;

function input(event: BoardEvent): FoldInput {
  return { hash: canonicalHash(event), event };
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

// ---------------------------------------------------------------------------
// Generated operations. Indices range a little beyond any checklist, and
// reconciles may name removed lines or the same index twice, so rejections
// are generated too.

type Op =
  | { kind: 'tick'; index: number; done: boolean }
  | { kind: 'add'; texts: string[] }
  | {
      kind: 'reconcile';
      title: string | null;
      updated: { index: number; text: string; done: boolean }[];
      removed: number[];
      added: { text: string; done: boolean }[];
    };

const text = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f');
const index = fc.integer({ min: -1, max: 9 });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('tick' as const), index, done: fc.boolean() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('add' as const),
      texts: fc.array(text, { minLength: 1, maxLength: 2 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc
      .record({
        kind: fc.constant('reconcile' as const),
        title: fc.option(text, { nil: null }),
        updated: fc.array(fc.record({ index, text, done: fc.boolean() }), { maxLength: 2 }),
        removed: fc.array(index, { maxLength: 2 }),
        added: fc.array(fc.record({ text, done: fc.boolean() }), { maxLength: 2 }),
      })
      .filter((r) => r.title !== null || r.updated.length + r.removed.length + r.added.length > 0),
  },
);

/** Each operation with its wall (random, with ties) and actor. */
const historyArb = fc.record({
  initial: fc.array(text, { maxLength: 4 }),
  ops: fc.array(
    fc.record({
      op: opArb,
      wall: fc.integer({ min: 2, max: 40 }),
      actor: fc.constantFrom('o', 'p'),
    }),
    { minLength: 1, maxLength: 25 },
  ),
  seeds: fc.array(fc.integer(), { minLength: 3, maxLength: 3 }),
});

function eventOf(op: Op, wall: number, actor: string): BoardEvent {
  const base = { v: 1 as const, ticket: T1, actor, ts: { wall, counter: 0, actor } };
  switch (op.kind) {
    case 'tick':
      return { ...base, kind: 'ticket.checklist', body: { index: op.index, done: op.done } };
    case 'add':
      return {
        ...base,
        kind: 'ticket.checklist.add',
        body: { items: op.texts.map((t) => ({ text: t, done: false })) },
      };
    case 'reconcile':
      return {
        ...base,
        kind: 'ticket.reconcile',
        body: {
          ...(op.title === null ? {} : { title: op.title }),
          updated: op.updated,
          removed: op.removed,
          added: op.added,
          forced: false,
          source: SOURCE,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// The oracle.

interface ModelLine {
  text: string;
  done: boolean;
  removed: boolean;
}

function live(lines: readonly ModelLine[], i: number): boolean {
  const line = lines[i];
  return line !== undefined && !line.removed;
}

/** Applies `event` to the model; returns false when the spec rejects it. */
function modelApply(lines: ModelLine[], event: BoardEvent): boolean {
  switch (event.kind) {
    case 'ticket.checklist': {
      const line = lines[event.body.index];
      if (!live(lines, event.body.index) || line === undefined) {
        return false;
      }
      line.done = event.body.done;
      return true;
    }
    case 'ticket.checklist.add':
      for (const item of event.body.items) {
        lines.push({ text: item.text, done: item.done, removed: false });
      }
      return true;
    case 'ticket.reconcile': {
      const named = [...event.body.updated.map((u) => u.index), ...event.body.removed];
      if (new Set(named).size !== named.length || !named.every((i) => live(lines, i))) {
        return false;
      }
      for (const u of event.body.updated) {
        lines[u.index] = { text: u.text, done: u.done, removed: false };
      }
      for (const r of event.body.removed) {
        const line = lines[r];
        if (line !== undefined) {
          line.removed = true;
        }
      }
      for (const a of event.body.added) {
        lines.push({ text: a.text, done: a.done, removed: false });
      }
      return true;
    }
    default:
      throw new Error(`unexpected kind ${event.kind}`);
  }
}

function asModel(items: readonly ChecklistItem[]): ModelLine[] {
  return items.map((i) => ({ text: i.text, done: i.done, removed: i.removed === true }));
}

describe('property: reconciles and ticks fold independently of read order', () => {
  it(
    'folds every sampled permutation to identical bytes, matching the oracle event by event',
    { timeout: PROPERTY_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(historyArb, ({ initial, ops, seeds }) => {
          const create = input({
            v: 1,
            kind: 'ticket.create',
            ticket: T1,
            actor: 'o',
            ts: { wall: 1, counter: 0, actor: 'o' },
            body: { title: 'T', ...(initial.length === 0 ? {} : { checklist: initial }) },
          });
          const inputs = [create, ...ops.map((o) => input(eventOf(o.op, o.wall, o.actor)))];
          const reference = bytesOf(fold(inputs));
          for (const seed of seeds) {
            expect(bytesOf(fold(shuffle(inputs, seed)))).toBe(reference);
          }

          // Replay in fold order against the oracle.
          const ordered = [...new Map(inputs.map((i) => [i.hash, i])).values()].sort(
            compareFoldOrder,
          );
          const state: BoardState = {
            tickets: {},
            meta: Object.create(null) as Record<string, JsonValue>,
          };
          const model: ModelLine[] = initial.map((t) => ({ text: t, done: false, removed: false }));
          for (const step of ordered) {
            const before = asModel(state.tickets[T1]?.checklist ?? []);
            const outcome = applyEvent(state, step);
            if (step.event.kind === 'ticket.create') {
              expect(outcome.status).toBe('applied');
              continue;
            }
            const event = step.event as BoardEvent;
            const expected = modelApply(model, event);
            expect(outcome.status, JSON.stringify(event.body)).toBe(
              expected ? 'applied' : 'rejected',
            );
            if (outcome.status === 'rejected') {
              expect(outcome.rejected.reason).toBe('checklist-index');
            }
            const after = asModel(state.tickets[T1]?.checklist ?? []);
            expect(after).toEqual(model);

            // No index changes meaning: nothing is deleted or moved, a
            // removed line stays removed and unchanged, and only the lines
            // the event names change.
            expect(after.length).toBeGreaterThanOrEqual(before.length);
            const named = new Set<number>();
            if (outcome.status === 'applied') {
              if (event.kind === 'ticket.checklist') {
                named.add(event.body.index);
              } else if (event.kind === 'ticket.reconcile') {
                event.body.updated.forEach((u) => named.add(u.index));
                event.body.removed.forEach((r) => named.add(r));
              }
            }
            before.forEach((line, i) => {
              if (line.removed) {
                expect(after[i]).toEqual(line);
              } else if (!named.has(i)) {
                expect(after[i]).toEqual(line);
              }
            });
          }
          const folded = fold(inputs).state.tickets[T1];
          expect(asModel(folded?.checklist ?? [])).toEqual(model);
        }),
        { numRuns: 300 },
      );
    },
  );
});
