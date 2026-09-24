/**
 * Internal orderings shared by the view-model modules (not re-exported
 * from `index.ts`). Pure and browser-safe; see `types.ts`.
 */

import type { Ticket } from '../events/fold.js';
import { compareHlc } from '../events/hlc.js';

/**
 * Card order of `boardColumns` and agent lanes: most recently updated
 * first, that is descending by `updatedAt` as `compareHlc` orders it (wall,
 * then counter, then actor), then ascending by id in string order.
 */
export function byRecentUpdate(a: Ticket, b: Ticket): number {
  return compareHlc(b.updatedAt, a.updatedAt) || compareStrings(a.id, b.id);
}

/** Ascending string order (UTF-16 code units, as `<`). */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
