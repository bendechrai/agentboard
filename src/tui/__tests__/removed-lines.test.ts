/**
 * Removed checklist lines in `top`'s ticket detail (add-claim-leases task
 * 8.4; board-cli: "Removed checklist lines are inactive"): the count leaves
 * them out and the line is shown marked as removed.
 */

import { describe, expect, it } from 'vitest';

import { E, T1, TASK, model } from '../../view/__tests__/helpers.js';
import { detailLines } from '../frame.js';

describe('detailLines with a removed line', () => {
  it('scenario: counts 1 of 2 and marks the removed line', () => {
    const m = model([
      E.create(T1, { title: 'Lines', task: TASK, checklist: ['1.1 A', '1.2 B', '1.3 C'] }),
      E.check(T1, 0, true),
      E.check(T1, 1, true),
      E.reconcile(T1, { removed: [1] }),
    ]);
    const lines = detailLines(m, T1, 140);
    const at = lines.indexOf('checklist: 1/2');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '  [x] 1.1 A',
      '  [x] 1.2 B (removed)',
      '  [ ] 1.3 C',
    ]);
  });

  it('shows checklist: 0/0 when every line is removed', () => {
    const m = model([
      E.create(T1, { title: 'Lines', task: TASK, checklist: ['1.1 A'] }),
      E.reconcile(T1, { removed: [0] }),
    ]);
    const lines = detailLines(m, T1, 140);
    expect(lines).toContain('checklist: 0/0');
    expect(lines).toContain('  [ ] 1.1 A (removed)');
  });
});
