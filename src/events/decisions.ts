/**
 * Decision comments (board-openspec-integration: "Decisions are promoted,
 * not buried"; board-cli: "Close requires a decision disposition";
 * board-view-model: "Board columns and cards", "Conversation view").
 *
 * Pure and browser-safe: no IO, no clock, and no `node:` import, directly
 * or transitively (the layering test in `src/__tests__/layering.test.ts`
 * enforces this), so the close rule in `src/board/actions.ts` and the view
 * model under `src/view/` share one definition of an open decision.
 *
 * Refactor contract (add-board-web task 1.1). `DECISION_PREFIX`,
 * `RETRACTED_PREFIX` and `openDecisions` move here from
 * `src/board/actions.ts` with no change in behavior, and `actions.ts`
 * re-exports these same bindings (for example
 * `export { DECISION_PREFIX, RETRACTED_PREFIX, openDecisions } from
 * '../events/decisions.js'`), so that `import { openDecisions } from
 * './board/actions.js'` and the library entry `src/index.ts` (which
 * re-exports `actions.ts`) keep working and yield the identical function
 * object. `actions.ts` keeps no copy of its own.
 */

/** The comment prefix that marks a decision (board-openspec-integration). */
export const DECISION_PREFIX = 'DECISION:';

/** The comment prefix that retracts the same actor's earlier decisions. */
export const RETRACTED_PREFIX = 'RETRACTED:';

/**
 * The comments of a ticket that still block a `--no-decision` close: every
 * comment (handoff notes included) whose text starts with
 * `DECISION_PREFIX` (case-sensitive, at the very start of the text) and
 * that is not followed, later in the comment list, by a comment by the
 * same actor starting with `RETRACTED_PREFIX`. One `RETRACTED:` comment
 * retracts every earlier `DECISION:` comment by its actor. Returned in
 * comment order, each as a new object holding only `actor` and `text`.
 * Pure: the input is not modified.
 */
export function openDecisions(
  comments: readonly { actor: string; text: string }[],
): { actor: string; text: string }[] {
  throw new Error(`not implemented: openDecisions(${String(comments.length)})`);
}
