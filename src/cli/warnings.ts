/**
 * Process warning policy of the CLI entry point (`src/cli.ts`; group 3
 * round 2 ruling).
 */

/**
 * True when Node was asked not to print warnings, which the entry point
 * must honour even though it replaces Node's own warning listener:
 * - `--no-warnings` is an element of `execArgv`; or
 * - `--no-warnings` is one of the whitespace-separated tokens of
 *   `env.NODE_OPTIONS`; or
 * - `env.NODE_NO_WARNINGS` is exactly `1`.
 * Only the exact token counts (`--no-warnings-x` does not). Pure.
 */
export function warningsDisabled(
  execArgv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  throw new Error(`not implemented (${String(execArgv.length)}, ${String(Object.keys(env).length)})`);
}
