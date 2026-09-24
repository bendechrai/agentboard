import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const BOARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'board');

/** Every module specifier imported or re-exported by a TypeScript source (static and dynamic). */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1] ?? '');
    }
  }
  return found;
}

describe('layering', () => {
  it('finds the import forms it scans for', () => {
    const sample = [
      "import { a } from '../cli/x.js';",
      "import type { B } from '../cli/y.js';",
      "export { c } from '../cli/z.js';",
      "import '../cli/side.js';",
      "const m = await import('../cli/dyn.js');",
      'import {\n  d,\n  e,\n} from "../store/w.js";',
    ].join('\n');
    expect(specifiers(sample).sort()).toEqual(
      [
        '../cli/dyn.js',
        '../cli/side.js',
        '../cli/x.js',
        '../cli/y.js',
        '../cli/z.js',
        '../store/w.js',
      ].sort(),
    );
  });

  it('no module under src/board imports from src/cli', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(BOARD)) {
      if (!name.endsWith('.ts')) {
        continue;
      }
      for (const spec of specifiers(readFileSync(join(BOARD, name), 'utf8'))) {
        if (/(^|\/)cli(\/|\.js$)/.test(spec)) {
          offenders.push(`${name}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
