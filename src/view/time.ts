/**
 * Relative times (board-view-model: "Relative time"). Pure and
 * browser-safe; see `types.ts`.
 */

/**
 * Renders a duration in milliseconds as a short relative time, rounding
 * down to whole units:
 * - below 10000 (10 seconds), and every negative duration: `just now`
 * - below 60000 (a minute): `<n>s ago`, n = floor(ms / 1000), so 10 to 59
 * - below 3600000 (an hour): `<n>m ago`, n = floor(ms / 60000)
 * - below 86400000 (a day): `<n>h ago`, n = floor(ms / 3600000)
 * - otherwise: `<n>d ago`, n = floor(ms / 86400000), with no upper unit
 *
 * Each bound is exclusive: 10000 is `10s ago`, 60000 `1m ago`, 3600000
 * `1h ago` and 86400000 `1d ago`. A fractional duration is rounded down
 * the same way (9999.9 is `just now`). The caller computes the duration,
 * typically `now` minus an event wall, so a wall in the future (clock
 * skew between machines) shows as `just now`, never as a negative age.
 */
export function relativeTime(ms: number): string {
  throw new Error(`not implemented: relativeTime(${String(ms)})`);
}
