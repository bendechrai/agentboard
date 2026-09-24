import { describe, expect, it } from 'vitest';

import { warningsDisabled } from '../warnings.js';

describe('warningsDisabled', () => {
  it('is false by default', () => {
    expect(warningsDisabled([], {})).toBe(false);
    expect(
      warningsDisabled(['--trace-warnings'], { NODE_OPTIONS: '--max-old-space-size=64' }),
    ).toBe(false);
  });

  it('honours --no-warnings in execArgv', () => {
    expect(warningsDisabled(['--no-warnings'], {})).toBe(true);
    expect(warningsDisabled(['--enable-source-maps', '--no-warnings'], {})).toBe(true);
  });

  it('honours --no-warnings as a token of NODE_OPTIONS', () => {
    expect(warningsDisabled([], { NODE_OPTIONS: '--no-warnings' })).toBe(true);
    expect(warningsDisabled([], { NODE_OPTIONS: '--max-old-space-size=64   --no-warnings' })).toBe(
      true,
    );
  });

  it('honours NODE_NO_WARNINGS=1', () => {
    expect(warningsDisabled([], { NODE_NO_WARNINGS: '1' })).toBe(true);
    expect(warningsDisabled([], { NODE_NO_WARNINGS: '0' })).toBe(false);
  });

  it('counts only the exact token', () => {
    expect(warningsDisabled(['--no-warnings-x'], {})).toBe(false);
    expect(warningsDisabled([], { NODE_OPTIONS: '--no-warnings-x' })).toBe(false);
  });
});
