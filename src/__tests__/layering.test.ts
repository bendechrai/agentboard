import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
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

// add-board-web tasks 1.1 and 1.2 (board-view-model: "Pure view-model
// layer", scenario "No Node-only import"): the view-model and the pure
// fold must be bundleable for the browser.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Module specifiers that survive compilation: every import, re-export,
 * side-effect import and dynamic import except whole-statement type-only
 * ones (`import type ...`, `export type ... from`), which are erased.
 */
function valueSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
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

/** True for a specifier naming a Node built-in: any `node:` specifier or a bare built-in name. */
function isNodeOnly(spec: string): boolean {
  return spec.startsWith('node:') || isBuiltin(spec);
}

/** Every `.ts` module under `dir`, recursively, excluding `__tests__` directories. */
function modulesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        out.push(...modulesUnder(path));
      }
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

interface Walk {
  /** Every module reached, as paths relative to src. */
  reached: string[];
  /** `<module>: <specifier>` for each Node-only or unresolvable import. */
  offenders: string[];
}

/** Follows value imports from `entries`, resolving relative `.js` specifiers to `.ts` files. */
function walk(entries: string[]): Walk {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const name = relative(SRC, file);
    for (const spec of valueSpecifiers(readFileSync(file, 'utf8'))) {
      if (isNodeOnly(spec)) {
        offenders.push(`${name}: ${spec}`);
      } else if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
        if (existsSync(target)) {
          queue.push(target);
        } else {
          offenders.push(`${name}: ${spec} (unresolved)`);
        }
      }
    }
  }
  return { reached: [...seen].map((f) => relative(SRC, f)).sort(), offenders };
}

describe('layering: browser-safe modules', () => {
  it('follows value imports and skips type-only ones', () => {
    const sample = [
      "import { a, type B } from './value.js';",
      "import type { C } from './type-only.js';",
      "import type D from './type-default.js';",
      "export { e } from './reexport.js';",
      "export * from './star.js';",
      "export type { F } from './type-reexport.js';",
      "import './side.js';",
      "const g = await import('./dyn.js');",
      "import {\n  h,\n} from 'node:fs';",
      "import typeScript from './named-type.js';",
      "import { type I } from './inline-type.js';",
      '/** Prose: `import type` is exempt, and an export type is too. */',
      "import type { J } from './after-prose.js';",
    ].join('\n');
    expect(valueSpecifiers(sample).sort()).toEqual(
      [
        './value.js',
        './reexport.js',
        './star.js',
        './side.js',
        './dyn.js',
        'node:fs',
        './named-type.js',
        './inline-type.js',
      ].sort(),
    );
    expect(isNodeOnly('node:crypto')).toBe(true);
    expect(isNodeOnly('crypto')).toBe(true);
    expect(isNodeOnly('fs/promises')).toBe(true);
    expect(isNodeOnly('./crypto.js')).toBe(false);
    expect(isNodeOnly('preact')).toBe(false);
  });

  it('finds a Node-only import reached transitively', () => {
    const result = walk([join(SRC, 'events', 'canonical.ts')]);
    expect(result.offenders).toContain('events/canonical.ts: node:crypto');
  });

  it('reaches src/events/ulid.ts from src/events/fold.ts through schema.ts', () => {
    const { reached } = walk([join(SRC, 'events', 'fold.ts')]);
    expect(reached).toEqual(
      expect.arrayContaining([
        'events/fold.ts',
        'events/schema.ts',
        'events/ulid.ts',
        'events/hlc.ts',
      ]),
    );
  });

  it('no module reachable from src/events/fold.ts or src/events/decisions.ts imports a node: specifier', () => {
    const entries = [join(SRC, 'events', 'fold.ts'), join(SRC, 'events', 'decisions.ts')];
    expect(walk(entries).offenders).toEqual([]);
  });

  it('src/view holds the view-model modules', () => {
    const names = modulesUnder(join(SRC, 'view')).map((f) => relative(SRC, f));
    expect(names).toEqual(
      expect.arrayContaining([
        'view/types.ts',
        'view/columns.ts',
        'view/feed.ts',
        'view/describe.ts',
        'view/conversation.ts',
        'view/lanes.ts',
        'view/time.ts',
        'view/health.ts',
        'view/replay.ts',
        'view/graph.ts',
      ]),
    );
  });

  // add-board-insights tasks 1.1 and 1.2: the insight view-models are
  // bundled into the web client, reuse the store's fold for replay and
  // `openDecisions` for the health report, and stay free of Node-only
  // imports.
  it('the insight view-models reach no node: specifier', () => {
    const entries = ['health.ts', 'replay.ts', 'graph.ts'].map((f) => join(SRC, 'view', f));
    expect(walk(entries).offenders).toEqual([]);
  });

  it('replay.ts uses the store fold and health.ts uses openDecisions', () => {
    expect(walk([join(SRC, 'view', 'replay.ts')]).reached).toContain('events/fold.ts');
    expect(walk([join(SRC, 'view', 'health.ts')]).reached).toContain('events/decisions.ts');
  });

  it('no module reachable from any module under src/view imports a node: specifier', () => {
    expect(walk(modulesUnder(join(SRC, 'view'))).offenders).toEqual([]);
  });

  it('no module under src/view reads a clock or draws random numbers', () => {
    const offenders: string[] = [];
    for (const file of modulesUnder(join(SRC, 'view'))) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [
        /\bDate\.now\s*\(/,
        /\bnew\s+Date\s*\(/,
        /\bMath\.random\s*\(/,
        /\bperformance\.now\s*\(/,
      ]) {
        if (pattern.test(source)) {
          offenders.push(`${relative(SRC, file)}: ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// add-board-tui tasks 1.1 and 1.2 (design.md, "Hand-rolled ANSI rather
// than a library"): the key decoder, the UI state and the frame renderer
// are pure. `src/tui/terminal.ts` (group 2) is the only IO module there, so
// these three modules are listed rather than the whole directory.

describe('layering: pure terminal UI modules', () => {
  const PURE_TUI = ['keys.ts', 'state.ts', 'frame.ts'].map((name) => join(SRC, 'tui', name));

  it('src/tui holds the key decoder, the UI state and the frame renderer', () => {
    for (const file of PURE_TUI) {
      expect(existsSync(file)).toBe(true);
    }
  });

  it('no module reachable from src/tui/keys.ts, state.ts or frame.ts imports a node: specifier', () => {
    const result = walk(PURE_TUI);
    expect(result.offenders).toEqual([]);
    expect(result.reached).toEqual(
      expect.arrayContaining(['tui/keys.ts', 'tui/state.ts', 'tui/frame.ts']),
    );
  });

  it('src/tui/keys.ts, state.ts and frame.ts read no clock and draw no random numbers', () => {
    const offenders: string[] = [];
    for (const file of PURE_TUI) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [
        /\bDate\.now\s*\(/,
        /\bnew\s+Date\s*\(/,
        /\bMath\.random\s*\(/,
        /\bperformance\.now\s*\(/,
        /\bprocess\./,
        /\bsetTimeout\s*\(/,
        /\bsetInterval\s*\(/,
      ]) {
        if (pattern.test(source)) {
          offenders.push(`${relative(SRC, file)}: ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/tui/state.ts and frame.ts contain no escape character (styles are data)', () => {
    const offenders: string[] = [];
    for (const name of ['state.ts', 'frame.ts']) {
      const source = readFileSync(join(SRC, 'tui', name), 'utf8');
      for (const pattern of [
        /\\x1b/i,
        /\\u001b/i,
        /\\u\{1b\}/i,
        /\\033/,
        /\b0x1b\b/i,
        /\bfromCharCode\(\s*(27|0x1b)\b/i,
      ]) {
        if (pattern.test(source)) {
          offenders.push(`tui/${name}: ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
