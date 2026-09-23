/**
 * Placeholder used by the group 3 stubs until they are implemented. Not
 * part of the public API; the implementer removes this file.
 */

/** Builds the "not implemented" error thrown by a stub. */
export function notImplemented(...args: unknown[]): Error {
  return new Error(`not implemented (${String(args.length)} arguments)`);
}
