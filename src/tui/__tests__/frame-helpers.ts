/**
 * Helpers for reading the style map of a frame in the terminal UI tests.
 */

import { expect } from 'vitest';

import type { Frame, Style } from '../frame.js';

/** The default style: no attribute, no color. */
export const DEFAULT: Style = { bold: false, dim: false, inverse: false, color: null };

/** The style of cell `x` of line `y`, read from the frame's runs. */
export function styleAt(frame: Frame, y: number, x: number): Style {
  const run = (frame.styles[y] ?? []).find((r) => x >= r.start && x < r.start + r.length);
  return run?.style ?? DEFAULT;
}

/** The styles of cells [a, b) of line `y`. */
export function stylesOf(frame: Frame, y: number, a: number, b: number): Style[] {
  const out: Style[] = [];
  for (let x = a; x < b; x += 1) {
    out.push(styleAt(frame, y, x));
  }
  return out;
}

/** A style with the given fields set and the others default. */
export const style = (s: Partial<Style>): Style => ({ ...DEFAULT, ...s });

/** `n` copies of `s`. */
export const all = (n: number, s: Style): Style[] => Array.from({ length: n }, () => s);

/**
 * Checks the invariants of `Frame.styles`: one list per line, runs sorted,
 * not overlapping, inside the line, at least one cell long, never the
 * default style, and maximal (adjacent runs differ).
 */
export function expectCanonical(frame: Frame, columns: number): void {
  expect(frame.styles).toHaveLength(frame.lines.length);
  for (const runs of frame.styles) {
    let end = 0;
    let previous: Style | null = null;
    for (const run of runs) {
      expect(Number.isInteger(run.start) && Number.isInteger(run.length)).toBe(true);
      expect(run.length).toBeGreaterThanOrEqual(1);
      expect(run.start).toBeGreaterThanOrEqual(end);
      expect(run.start + run.length).toBeLessThanOrEqual(columns);
      expect(run.style).not.toEqual(DEFAULT);
      if (previous !== null && run.start === end) {
        expect(run.style).not.toEqual(previous);
      }
      end = run.start + run.length;
      previous = run.style;
    }
  }
}
