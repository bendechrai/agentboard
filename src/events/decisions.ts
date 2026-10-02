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
 * `src/board/actions.ts` re-exports `DECISION_PREFIX`, `RETRACTED_PREFIX`
 * and `openDecisions` from here (the same bindings), so importing
 * `openDecisions` through `actions.ts` or through the library entry
 * `src/index.ts` (which re-exports `actions.ts`) yields the identical
 * function object. `actions.ts` keeps no copy of its own.
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
  const lastRetraction = new Map<string, number>();
  comments.forEach((comment, index) => {
    if (comment.text.startsWith(RETRACTED_PREFIX)) {
      lastRetraction.set(comment.actor, index);
    }
  });
  return comments
    .filter(
      (comment, index) =>
        comment.text.startsWith(DECISION_PREFIX) &&
        (lastRetraction.get(comment.actor) ?? -1) < index,
    )
    .map((comment) => ({ actor: comment.actor, text: comment.text }));
}
