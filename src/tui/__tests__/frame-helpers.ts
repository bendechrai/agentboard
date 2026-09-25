/**
 * Helpers for reading the style map of a frame in the terminal UI tests.
 */

import { isDeepStrictEqual } from 'node:util';

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
  // The violations are collected and asserted once per frame: the property
  // tests check hundreds of frames, and one `expect` per run made the
  // assertions, not the rendering, most of their running time under load.
  const problems: string[] = [];
  frame.styles.forEach((runs, y) => {
    let end = 0;
    let previous: Style | null = null;
    for (const run of runs) {
      const at = `line ${String(y)} run ${JSON.stringify(run)}`;
      if (!Number.isInteger(run.start) || !Number.isInteger(run.length)) {
        problems.push(`${at}: start and length are not integers`);
      }
      if (!(run.length >= 1)) {
        problems.push(`${at}: shorter than one cell`);
      }
      if (!(run.start >= end)) {
        problems.push(`${at}: starts before the previous run ends at ${String(end)}`);
      }
      if (!(run.start + run.length <= columns)) {
        problems.push(`${at}: ends past column ${String(columns)}`);
      }
      if (isDeepStrictEqual(run.style, DEFAULT)) {
        problems.push(`${at}: has the default style`);
      }
      if (previous !== null && run.start === end && isDeepStrictEqual(run.style, previous)) {
        problems.push(`${at}: has the style of the adjacent previous run`);
      }
      end = run.start + run.length;
      previous = run.style;
    }
  });
  expect(problems).toEqual([]);
}
