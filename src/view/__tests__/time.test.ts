import { describe, expect, it } from 'vitest';

import { relativeTime } from '../time.js';

describe('relativeTime (board-view-model: "Relative time")', () => {
  it.each([
    [0, 'just now'],
    [1, 'just now'],
    [9999, 'just now'],
    [9999.9, 'just now'],
    [10000, '10s ago'],
    [10999, '10s ago'],
    [11000, '11s ago'],
    [59999, '59s ago'],
    [60000, '1m ago'],
    [119999, '1m ago'],
    [120000, '2m ago'],
    [299999, '4m ago'],
    [300000, '5m ago'],
    [3599999, '59m ago'],
    [3600000, '1h ago'],
    [7199999, '1h ago'],
    [7200000, '2h ago'],
    [86399999, '23h ago'],
    [86400000, '1d ago'],
    [172799999, '1d ago'],
    [172800000, '2d ago'],
    [400 * 86400000, '400d ago'],
  ])('renders %d ms as %s', (ms, expected) => {
    expect(relativeTime(ms)).toBe(expected);
  });

  it.each([-1, -9999, -10000, -86400000, -Number.MAX_SAFE_INTEGER])(
    'renders the negative duration %d as just now',
    (ms) => {
      expect(relativeTime(ms)).toBe('just now');
    },
  );

  it('scenario Minutes: relativeTime(299999) is 4m ago', () => {
    expect(relativeTime(299999)).toBe('4m ago');
  });
});
