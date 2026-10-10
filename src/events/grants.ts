/**
 * Materialising due grants (board-cli: "Due grants are written during
 * catch-up"; board-events: "Grants"; add-claim-leases design.md: "Grants:
 * derived, backdated, identical from every writer").
 *
 * A grant is derived from the state at its own fold position, never from
 * the latest state: an event that sorts after the grant's slot (a renew
 * from a fast clock, a later `queue.window` setting, a later join) must not
 * change it, because the fold checks the grant against the state just
 * before it. Hashing a grant needs the canonical encoder, which imports
 * `node:crypto`, so this module is not reachable from the browser-safe fold
 * (`fold.ts` never imports it).
 */

import { canonicalHash, type JsonValue } from './canonical.js';
import { applyEvent, compareFoldOrder, dueGrant, type BoardState, type FoldInput } from './fold.js';
import { compareHlc } from './hlc.js';
import { isKnownEvent } from './schema.js';

/**
 * The grants that are due at clock reading `now` (milliseconds since the
 * epoch) and missing from `inputs`, each as a `FoldInput` whose `hash` is
 * `canonicalHash(event)` and whose `event` is exactly the grant `dueGrant`
 * derives at that grant's own fold position, in fold order.
 *
 * Definition. The inputs are de-duplicated by hash and walked in fold order
 * (`compareFoldOrder`), applied with `applyEvent` from an empty state, as
 * `fold` does. Before each input, and once more after the last, every
 * ticket of the state is checked: when `dueGrant(ticket, state.meta)` is
 * not null, its `ts.wall` is at or before `now`, and it sorts strictly
 * before the next input in fold order (so it is not that input), the grant
 * is missing; it is added to the result and applied at that point, and the
 * check is repeated at the same point, because applying it can make another
 * grant due (the next waiter's grant after this one lapses, before the next
 * input). When several tickets have a missing grant at one point, the one
 * that sorts first in fold order is taken first.
 *
 * Consequences the callers rely on:
 * - a grant whose slot time is after `now` is never returned, and neither
 *   is any grant on the same ticket that could only follow it;
 * - a chain of lapsed grants (waiters `a`, `b` and `c`, none renewing) is
 *   returned whole and in order when `now` is past every slot, each later
 *   grant naming the previous grant's lease in `after.lease`;
 * - `dueGrants([...inputs, ...result], now)` is empty, and `fold` of
 *   `[...inputs, ...result]` applies every returned grant;
 * - the result depends on the set of inputs only, never on their order in
 *   the array.
 *
 * Pure: reads no clock (only `now`), no file and no cache.
 */
export function dueGrants(inputs: readonly FoldInput[], now: number): FoldInput[] {
  const byHash = new Map<string, FoldInput>();
  for (const input of inputs) {
    if (!byHash.has(input.hash)) {
      byHash.set(input.hash, input);
    }
  }
  const ordered = [...byHash.values()].sort(compareFoldOrder);
  // A null prototype keeps a meta key such as "__proto__" an ordinary entry, as in `fold`.
  const state: BoardState = { tickets: {}, meta: Object.create(null) as Record<string, JsonValue> };
  // Only a ticket with waiters can have a grant due, so only those are checked.
  const waiting = new Set<string>();
  const result: FoldInput[] = [];
  for (let i = 0; i <= ordered.length; i += 1) {
    const next = ordered[i];
    for (let grant = missingGrant(state, waiting, next, now); grant !== null;) {
      result.push(grant);
      if (!apply(state, waiting, grant)) {
        // dueGrant derived it from this very state, so the fold must apply it.
        throw new Error(`the derived grant ${grant.hash} was not applied`);
      }
      grant = missingGrant(state, waiting, next, now);
    }
    if (next !== undefined) {
      apply(state, waiting, next);
    }
  }
  return result;
}

/**
 * `applyEvent`, keeping `waiting` equal to the ids of the tickets with a
 * non-empty queue. Returns whether the event was applied.
 */
function apply(state: BoardState, waiting: Set<string>, input: FoldInput): boolean {
  const { event } = input;
  if (applyEvent(state, input).status !== 'applied') {
    return false;
  }
  if (isKnownEvent(event) && event.kind !== 'board.meta') {
    if ((state.tickets[event.ticket]?.queue.length ?? 0) > 0) {
      waiting.add(event.ticket);
    } else {
      waiting.delete(event.ticket);
    }
  }
  return true;
}

/**
 * The grant that is due at `now` in `state` and sorts strictly before
 * `next` (any position when `next` is undefined), choosing the first in
 * fold order when several tickets have one; null when there is none.
 */
function missingGrant(
  state: BoardState,
  waiting: ReadonlySet<string>,
  next: FoldInput | undefined,
  now: number,
): FoldInput | null {
  let first: FoldInput | null = null;
  for (const id of waiting) {
    const ticket = state.tickets[id];
    const event = ticket === undefined ? null : dueGrant(ticket, state.meta);
    if (event === null || event.ts.wall > now) {
      continue;
    }
    // The hash only matters when the timestamps tie, so it is computed
    // only for a grant that does not already sort after `next`.
    if (next !== undefined && compareHlc(event.ts, next.event.ts) > 0) {
      continue;
    }
    const grant = { hash: canonicalHash(event), event };
    if (next !== undefined && compareFoldOrder(grant, next) >= 0) {
      continue;
    }
    if (first === null || compareFoldOrder(grant, first) < 0) {
      first = grant;
    }
  }
  return first;
}
