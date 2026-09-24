/**
 * Text helpers and messages shared by the board operations and the CLI.
 * Defined here so that nothing under `src/board` imports from `src/cli`;
 * the CLI modules re-export them unchanged. Not re-exported from
 * `src/index.ts` directly (the CLI re-exports cover it).
 */

/**
 * The environment a command runs with.
 *
 * Re-exported unchanged from `src/cli/types.ts`.
 */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The explanation `new` gives when no task reference and no ad hoc reason
 * is given (board-openspec-integration: "Ticket without a task is
 * refused").
 *
 * Re-exported unchanged from `src/cli/registry.ts`.
 */
export const TASK_RULE =
  'tickets must reference a task (--task <source>:<ref>#<item>, or --change <name> ' +
  'with --group <n>) or be marked ad hoc with a reason (--adhoc <reason>)';

/**
 * Makes user text safe for plain ASCII output: every character outside
 * printable ASCII (below 0x20, 0x7F and above) is written as `\uXXXX` with
 * four upper-case hex digits of its UTF-16 code unit (a character outside
 * the BMP becomes two escapes), and a backslash is written as `\\`, so the
 * output is unambiguous and one line. Pure.
 *
 * Re-exported unchanged from `src/cli/render.ts`.
 */
export function asciiText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) {
      out += '\\\\';
    } else if (code < 0x20 || code >= 0x7f) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else {
      out += text[i] ?? '';
    }
  }
  return out;
}
