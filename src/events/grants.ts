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

import type { FoldInput } from './fold.js';

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
  void inputs;
  void now;
  throw new Error('not implemented');
}
