/**
 * The JSON value types of board events, in a module with no import, so
 * browser code (the web client, whose type check has no Node types) can
 * name them without reaching `canonical.ts` and its `node:crypto` import.
 * `canonical.ts` re-exports both unchanged.
 */

/** A JSON value as it appears in an event. Numbers are always safe integers. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

/** A JSON object. Keys are unique by construction. */
export interface JsonObject {
  [key: string]: JsonValue;
}
