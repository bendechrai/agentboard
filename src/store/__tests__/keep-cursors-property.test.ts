/**
 * keep-cursors-on-upgrade task 1.2, property: after an upgrade from a
 * constructed 0.2.0 cache, every effective event is delivered to each
 * actor or was delivered before, and an event the old cache applied and
 * delivered is returned again only when a changed-outcome event moved that
 * cursor back over it (design.md: "Why no event is skipped").
 *
 * The old world: random comment events on one ticket arrive in a random
 * order, a random subset of them "unknown to the old version"; between
 * arrivals, actors run real `inbox` calls. The cursors those calls leave,
 * and the `folded` rows of the known events (with the unknown ones added
 * as 0.2.0 records an unknown kind), are written into a cache built from
 * the verbatim 0.2.0 schema (`constructCache`). The delivery rule,
 * `advanceCursor` and fold order are the same in 0.2.0 and today
 * (`src/store/cursors.ts` is unchanged since 0.1.0), so today's `inbox`
 * on a board holding only the known events makes exactly the cursors
 * 0.2.0 would have made.
 */

import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeHlc } from '../../events/hlc.js';
import { readInbox } from '../../board/inbox.js';
import { openBoard, type Board } from '../board.js';
import { CACHE_FILE } from '../cache.js';
import {
  SEEN_WINDOW_MS,
  comparePositions,
  isPending,
  type Cursor,
  type CursorPosition,
} from '../cursors.js';
import { P, T1, ev, putEvent, tempBoard } from './helpers.js';
import {
  constructCache,
  cursorRows,
  foldedRows,
  rowPositionOf,
  type FoldedRow,
} from './v020-cache.js';

const PROPERTY_TIMEOUT_MS = 240_000;
const MINUTE = 60_000;
const ACTORS = ['alice', 'bob', 'carol'] as const;

const open: Board[] = [];

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

/** One comment of the old world. */
interface Step {
  /** Wall in minutes after the create (distinct per step). */
  minute: number;
  /** Arrival order key. */
  arrival: number;
  /** Unknown to the old version. */
  unknown: boolean;
  /** Who runs `inbox` right after this step's arrival (null: nobody). */
  reader: (typeof ACTORS)[number] | null;
}

const stepsArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 14 })
  .chain((minutes) =>
    fc.tuple(
      ...minutes.map((minute) =>
        fc.record({
          minute: fc.constant(minute),
          arrival: fc.nat({ max: 1000 }),
          unknown: fc.boolean(),
          reader: fc.constantFrom<Step['reader']>(null, 'alice', 'bob', 'carol'),
        }),
      ),
    ),
  );

describe('property: no event is skipped across an upgrade (1.2)', () => {
  it(
    'every effective event is delivered or was delivered, and redelivery happens only behind a moved cursor',
    { timeout: PROPERTY_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(stepsArb, fc.boolean(), (steps, readCreateFirst) => {
          const create = ev(P.create(T1), 'orch', 0);
          const comments = steps.map((s) => ({
            step: s,
            event: ev(P.comment(T1, `minute ${String(s.minute)}`), 'impl', s.minute * MINUTE),
          }));

          // The old world: known events arrive in arrival order, readers run inbox.
          const oldDir = tempBoard();
          const oldEvents = join(oldDir, 'events');
          const createHash = putEvent(oldEvents, create);
          const delivered = new Map<string, Set<string>>(ACTORS.map((a) => [a, new Set()]));
          const oldBoard = openBoard(oldDir);
          open.push(oldBoard);
          const read = (actor: string): void => {
            for (const entry of readInbox(oldBoard, actor).entries) {
              delivered.get(actor)?.add(entry.hash);
            }
          };
          if (readCreateFirst) {
            read('alice');
          }
          const byArrival = [...comments].sort(
            (a, b) => a.step.arrival - b.step.arrival || a.step.minute - b.step.minute,
          );
          for (const { step, event } of byArrival) {
            if (!step.unknown) {
              putEvent(oldEvents, event);
            }
            if (step.reader !== null) {
              read(step.reader);
            }
          }
          const old = cursorRows(oldBoard.db);
          const known = foldedRows(join(oldDir, CACHE_FILE));
          oldBoard.close();
          open.pop();

          // The upgraded board: every event, and a 0.2.0 cache of the old rows.
          const dir = tempBoard();
          const events = join(dir, 'events');
          putEvent(events, create);
          const unknownRows: FoldedRow[] = [];
          const all: CursorPosition[] = [{ hash: createHash, ts: create.ts }];
          for (const { step, event } of comments) {
            const hash = putEvent(events, event);
            all.push({ hash, ts: event.ts });
            if (step.unknown) {
              unknownRows.push({
                hash,
                folded: 0,
                reason: 'unknown-kind',
                position: encodeHlc(event.ts),
              });
            }
          }
          all.sort(comparePositions);
          constructCache(join(dir, CACHE_FILE), '0.2.0', {
            cursors: old.cursors,
            seen: old.seen,
            folded: [...known, ...unknownRows],
          });
          const oldApplied = new Set(known.filter((r) => r.folded === 1).map((r) => r.hash));
          const board = openBoard(dir);
          open.push(board);

          for (const row of old.cursors) {
            const actor = String(row.actor);
            const before = rowPositionOf(row);
            const given = delivered.get(actor) ?? new Set<string>();
            const oldCursor: Cursor = {
              actor,
              position: before,
              seen: old.seen
                .filter((r) => r.actor === actor)
                .map((r) => ({ hash: String(r.hash), wall: Number(r.wall) })),
            };
            // Delivered and settled: given by an old inbox and not pending
            // again for the old cursor (an old late event may have moved
            // the old cursor back over events it had given).
            const settled = (e: CursorPosition): boolean =>
              given.has(e.hash) && !isPending(oldCursor, e);
            // The cursor after the first fold, before this actor's inbox.
            const after = cursorRows(board.db).cursors.find((r) => r.actor === actor);
            expect(after, `${actor} keeps a cursor row`).toBeDefined();
            const q = after === undefined ? null : rowPositionOf(after);
            const now = new Set(readInbox(board, actor).entries.map((e) => e.hash));

            // Was some newly effective event late for the old cursor?
            const lateExists =
              before !== null &&
              all.some(
                (e) =>
                  !oldApplied.has(e.hash) &&
                  comparePositions(e, before) < 0 &&
                  e.ts.wall < before.ts.wall - SEEN_WINDOW_MS,
              );
            if (!lateExists) {
              expect(q, `${actor}: no late event, so the position is kept`).toEqual(before);
            }

            for (const e of all) {
              // Never skipped.
              expect(now.has(e.hash) || given.has(e.hash), `${actor} misses ${e.hash}`).toBe(true);
              // Redelivered only behind a moved cursor.
              if (now.has(e.hash) && settled(e)) {
                expect(lateExists, `${actor} gets ${e.hash} again without a late event`).toBe(true);
                if (q !== null) {
                  const afterQ = comparePositions(e, q) > 0;
                  const inWindow = e.ts.wall >= q.ts.wall - SEEN_WINDOW_MS;
                  expect(
                    afterQ || inWindow,
                    `${actor} gets ${e.hash} again before its window`,
                  ).toBe(true);
                }
              }
            }
          }
          board.close();
          open.pop();
        }),
        { numRuns: 40 },
      );
    },
  );
});
