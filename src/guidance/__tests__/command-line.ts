/**
 * Test helper: splits an example command line (`CommandExample.command`,
 * and later the agent guide's `agentboard ` lines) into argv words the way
 * a POSIX shell would for the subset the examples use: words separated by
 * spaces, `"..."` and `'...'` quoting (no escapes, no expansion), and
 * adjacent quoted and unquoted parts joined into one word.
 */

export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        word += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === ' ') {
      if (inWord) {
        words.push(word);
        word = '';
        inWord = false;
      }
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote !== null) {
    throw new Error(`unterminated quote in ${line}`);
  }
  if (inWord) {
    words.push(word);
  }
  return words;
}
