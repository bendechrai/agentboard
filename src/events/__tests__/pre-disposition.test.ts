/**
 * The release before the scope disposition folds the same (add-adhoc-ticket-
 * lifecycle tasks 1.1 and 1.2; board-events: "Fold semantics", scenario
 * "Close of an undisposed ticket still folds"; board-openspec-integration:
 * "Linked tickets on an older board are unaffected"; design.md, "Goals").
 *
 * The fixture board under `fixtures/pre-disposition-board/` was written by
 * the library built from commit 079707c (see
 * `src/store/__tests__/pre-disposition.ts`) and `fold.json` is the
 * canonical fold that release computed. Today's fold of the same files
 * must be byte-identical, apart from the two fields that did not exist
 * then, `unplanned` and `superseded`, which must be null on every ticket;
 * and the `ticket.move`, `ticket.close` and `ticket.link` files are
 * golden: the same events built today encode to the same bytes.
 */

import { describe, expect, it } from 'vitest';

import {
  ADHOC,
  LINKED,
  canonText,
  fixtureEvents,
  fixtureFiles,
  recordedFold,
} from '../../store/__tests__/pre-disposition.js';
import { canonicalEncode, sha256Hex } from '../canonical.js';
import { fold, type FoldInput, type FoldResult, type Ticket } from '../fold.js';
import { validateEvent } from '../schema.js';

function fixtureInputs(): FoldInput[] {
  const inputs: FoldInput[] = [];
  for (const [hash, event] of fixtureEvents()) {
    const result = validateEvent(event);
    if (!result.ok) {
      throw new Error(`fixture event ${hash} is malformed`);
    }
    inputs.push({ hash, event: result.event });
  }
  return inputs;
}

/**
 * The fold with `unplanned` and `superseded` removed from every ticket,
 * after asserting both are null.
 */
function withoutUnplanned(result: FoldResult): unknown {
  const tickets: Record<string, Partial<Ticket>> = {};
  for (const [id, ticket] of Object.entries(result.state.tickets)) {
    expect(ticket.unplanned, id).toBeNull();
    expect(ticket.superseded, id).toBeNull();
    tickets[id] = Object.fromEntries(
      Object.entries(ticket).filter(([key]) => key !== 'unplanned' && key !== 'superseded'),
    ) as Partial<Ticket>;
  }
  return {
    state: { tickets, meta: result.state.meta },
    rejected: result.rejected,
    unknown: result.unknown,
    latest: result.latest,
  };
}

describe('golden: the pre-disposition board folds as before', () => {
  it('holds 39 files, each named by the hash of its bytes', () => {
    const files = fixtureFiles();
    expect(files.size).toBe(39);
    for (const [name, bytes] of files) {
      expect(`${sha256Hex(bytes)}.json`).toBe(name);
    }
  });

  it('every file is a well-formed event, canonical byte for byte', () => {
    for (const [name, bytes] of fixtureFiles()) {
      const event = fixtureEvents().get(name.slice(0, -'.json'.length));
      expect(validateEvent(event).ok, name).toBe(true);
      expect(canonicalEncode(event), name).toEqual(bytes);
    }
  });

  it('scenario: the canonical fold is byte-identical to the one the previous release recorded', () => {
    const result = fold(fixtureInputs());
    expect(canonText(withoutUnplanned(result))).toBe(recordedFold());
  });

  it('every ticket is where the previous release left it', () => {
    const { tickets } = fold(fixtureInputs()).state;
    const summary = Object.fromEntries(
      Object.values(tickets).map((t) => [
        t.id,
        { status: t.status, closed: t.closed, task: t.task !== null, adhoc: t.adhoc },
      ]),
    );
    expect(summary).toEqual({
      [ADHOC.todo]: {
        status: 'todo',
        closed: false,
        task: false,
        adhoc: 'spike: try the new parser',
      },
      [ADHOC.tests]: {
        status: 'tests',
        closed: false,
        task: false,
        adhoc: 'bug seen in production',
      },
      [ADHOC.blocked]: { status: 'blocked', closed: false, task: false, adhoc: 'flaky test in CI' },
      [ADHOC.closed]: { status: 'blocked', closed: true, task: false, adhoc: 'idea, abandoned' },
      [LINKED.implementing]: { status: 'implementing', closed: false, task: true, adhoc: null },
      [LINKED.review]: { status: 'review', closed: false, task: true, adhoc: null },
      [LINKED.merged]: { status: 'merged', closed: false, task: true, adhoc: null },
      [LINKED.closed]: { status: 'merged', closed: true, task: true, adhoc: null },
    });
  });

  it('scenario: the close of the undisposed ad hoc ticket from blocked is applied', () => {
    const result = fold(fixtureInputs());
    const closed = result.state.tickets[ADHOC.closed];
    expect(closed?.closed).toBe(true);
    expect(closed?.disposition).toEqual({ noDecision: true });
    expect(closed?.task).toBeNull();
    expect(closed?.unplanned).toBeNull();
    expect(result.rejected.map((r) => r.kind)).toEqual(['ticket.claim']);
  });
});

describe('golden: ticket.move, ticket.close and ticket.link bytes are unchanged', () => {
  const byKind = (kind: string): [string, Uint8Array][] =>
    [...fixtureFiles()].filter(([name]) => {
      const event = fixtureEvents().get(name.slice(0, -'.json'.length));
      return event?.kind === kind;
    });

  it.each(['ticket.move', 'ticket.close', 'ticket.link'])(
    'the fixture holds %s files whose bytes the same event encodes to today',
    (kind) => {
      const files = byKind(kind);
      expect(files.length).toBeGreaterThan(0);
      for (const [name, bytes] of files) {
        const event = fixtureEvents().get(name.slice(0, -'.json'.length));
        if (event === undefined || event.kind === 'board.meta') {
          throw new Error(`unexpected fixture ${name}`);
        }
        // Rebuilt from its parts, not re-encoded from the decoded object.
        const rebuilt = {
          v: 1,
          kind: event.kind,
          ticket: event.ticket,
          actor: event.actor,
          ts: { wall: event.ts.wall, counter: event.ts.counter, actor: event.ts.actor },
          body: JSON.parse(JSON.stringify(event.body)) as unknown,
        };
        expect(validateEvent(rebuilt)).toEqual({ ok: true, known: true, event: rebuilt });
        expect(canonicalEncode(rebuilt), name).toEqual(bytes);
        expect(sha256Hex(canonicalEncode(rebuilt))).toBe(name.slice(0, -'.json'.length));
      }
    },
  );

  it('covers every shape: move to each status used, close with and without a decision, link task, pr and decision', () => {
    const shapes = new Set<string>();
    for (const event of fixtureEvents().values()) {
      if (event.kind === 'ticket.move') shapes.add(`move:${event.body.to}`);
      if (event.kind === 'ticket.close') shapes.add(`close:${Object.keys(event.body).join()}`);
      if (event.kind === 'ticket.link') shapes.add(`link:${Object.keys(event.body).join()}`);
    }
    expect([...shapes].sort()).toEqual([
      'close:decision',
      'close:noDecision',
      'link:decision',
      'link:pr',
      'link:task',
      'move:blocked',
      'move:implementing',
      'move:merged',
      'move:review',
      'move:tests',
    ]);
  });
});
