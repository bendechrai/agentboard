/**
 * Source rules of the web client (board-web: "Board text is never markup";
 * design.md: "Front end": `dangerouslySetInnerHTML` is not used anywhere;
 * add-board-web tasks 4.1 and 4.4). The client imports only Preact, its
 * own modules and the pure, browser-safe view-model and event modules, and
 * authenticates only with the Bearer header: it uses no cookie, no
 * `EventSource` (which cannot send the header) and no `localStorage` (the
 * token is kept in `sessionStorage` only).
 */

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT = join(SRC, 'web', 'client');

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...filesUnder(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

/** The files under `dir` whose text contains `dangerouslySetInnerHTML`. */
function innerHtmlOffenders(dir: string): string[] {
  return filesUnder(dir).filter((file) =>
    readFileSync(file, 'utf8').includes('dangerously' + 'SetInnerHTML'),
  );
}

/** Every module specifier imported or re-exported by a source (static and dynamic). */
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

describe('dangerouslySetInnerHTML', () => {
  it('the scan finds it in a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-client-scan-'));
    try {
      mkdirSync(join(dir, 'views'));
      writeFileSync(
        join(dir, 'views', 'X.tsx'),
        `<div ${'dangerously' + 'SetInnerHTML'}={{ __html: t }} />`,
      );
      writeFileSync(join(dir, 'ok.tsx'), '<div>{t}</div>');
      expect(innerHtmlOffenders(dir)).toEqual([join(dir, 'views', 'X.tsx')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appears nowhere under src/web/client/', () => {
    expect(filesUnder(CLIENT).length).toBeGreaterThan(5);
    expect(innerHtmlOffenders(CLIENT).map((f) => relative(SRC, f))).toEqual([]);
  });
});

describe('client imports', () => {
  it('imports only Preact, its own modules and src/view and src/events', () => {
    const offenders: string[] = [];
    const sources = filesUnder(CLIENT).filter(
      (f) => /\.tsx?$/.test(f) && !f.includes(`${sep}__tests__${sep}`),
    );
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec === 'preact' || spec.startsWith('preact/')) {
          continue;
        }
        if (!spec.startsWith('.')) {
          offenders.push(`${relative(SRC, file)}: ${spec}`);
          continue;
        }
        const target = relative(SRC, resolve(dirname(file), spec));
        const allowed = ['web/client/', 'view/', 'events/'].some((p) =>
          target.split(sep).join('/').startsWith(p),
        );
        if (!allowed) {
          offenders.push(`${relative(SRC, file)}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('client authentication', () => {
  it('uses no cookie, no EventSource and no localStorage', () => {
    const offenders: string[] = [];
    const sources = filesUnder(CLIENT).filter(
      (f) => /\.tsx?$/.test(f) && !f.includes(`${sep}__tests__${sep}`),
    );
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [/document\.cookie/, /\bnew\s+EventSource\b/, /\blocalStorage\b/]) {
        if (pattern.test(text)) {
          offenders.push(`${relative(SRC, file)}: ${pattern.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
