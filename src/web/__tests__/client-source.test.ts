/**
 * Source rules of the web client (board-web: "Board text is never markup";
 * add-board-web design.md: "Front end": `dangerouslySetInnerHTML` is not
 * used anywhere). The client imports only Preact, the Markdown parser of
 * the description renderer, its own modules and the pure, browser-safe
 * view-model and event modules, and authenticates only
 * with the Bearer header: it uses no cookie, no `EventSource` (which cannot
 * send the header) and no `localStorage` (the token is kept in
 * `sessionStorage` only).
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

import { CONTENT_SECURITY_POLICY } from '../security.js';

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

/**
 * The Markdown parser of the description renderer and its syntax tree types
 * (add-description-markdown design.md: "Parse to mdast, render the tree to
 * Preact elements"), bundled into `app.js` like Preact.
 */
const MARKDOWN_PACKAGES = new Set([
  'mdast',
  'mdast-util-from-markdown',
  'mdast-util-gfm',
  'micromark-extension-gfm',
]);

/**
 * The HTML insertion APIs no client module may use (add-description-markdown
 * design.md: "A guard against HTML insertion"), each spelt in two parts so
 * this file does not match itself.
 */
const HTML_INSERTION: readonly { name: string; pattern: RegExp }[] = [
  { name: 'dangerously' + 'SetInnerHTML', pattern: new RegExp('dangerously' + 'SetInnerHTML') },
  { name: 'inner' + 'HTML', pattern: new RegExp('\\binner' + 'HTML\\b') },
  { name: 'outer' + 'HTML', pattern: new RegExp('\\bouter' + 'HTML\\b') },
  { name: 'insertAdjacent' + 'HTML', pattern: new RegExp('\\binsertAdjacent' + 'HTML\\b') },
  {
    name: 'document.' + 'write',
    pattern: new RegExp('\\bdocument\\s*\\.\\s*' + 'write(?:ln)?\\b'),
  },
];

/** `<file>: <api>` for every client source (tests excluded) under `dir` using an HTML insertion API. */
function htmlInsertionOffenders(dir: string): string[] {
  const offenders: string[] = [];
  const sources = filesUnder(dir).filter(
    (f) => /\.tsx?$/.test(f) && !f.includes(`${sep}__tests__${sep}`),
  );
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const { name, pattern } of HTML_INSERTION) {
      if (pattern.test(text)) {
        offenders.push(`${relative(dir, file).split(sep).join('/')}: ${name}`);
      }
    }
  }
  return offenders;
}

describe('HTML insertion APIs', () => {
  it('the scan finds each API in a source and ignores tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-client-html-'));
    try {
      mkdirSync(join(dir, 'views'));
      mkdirSync(join(dir, '__tests__'));
      const uses = [
        `<div ${'dangerously' + 'SetInnerHTML'}={{ __html: t }} />`,
        `el.${'inner' + 'HTML'} = t;`,
        `const s = el.${'outer' + 'HTML'};`,
        `el.${'insertAdjacent' + 'HTML'}('beforeend', t);`,
        `document . ${'write'}(t);`,
      ];
      uses.forEach((use, i) => {
        writeFileSync(join(dir, 'views', `U${String(i)}.tsx`), use);
      });
      writeFileSync(join(dir, 'views', 'W.ts'), `document.${'writeln'}(t);`);
      writeFileSync(join(dir, '__tests__', 'x.test.tsx'), `el.${'inner' + 'HTML'} = t;`);
      writeFileSync(join(dir, 'ok.tsx'), '<div>{t}</div>; el.textContent = t; doc.writer = 1;');
      expect(htmlInsertionOffenders(dir).sort()).toEqual([
        `views/U0.tsx: ${'dangerously' + 'SetInnerHTML'}`,
        `views/U1.tsx: ${'inner' + 'HTML'}`,
        `views/U2.tsx: ${'outer' + 'HTML'}`,
        `views/U3.tsx: ${'insertAdjacent' + 'HTML'}`,
        `views/U4.tsx: ${'document.' + 'write'}`,
        `views/W.ts: ${'document.' + 'write'}`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no module under src/web/client/ uses one', () => {
    const names = filesUnder(CLIENT).map((f) => relative(CLIENT, f).split(sep).join('/'));
    expect(names).toContain('markdown.tsx');
    expect(names).toContain('views/TicketView.tsx');
    expect(htmlInsertionOffenders(CLIENT)).toEqual([]);
  });
});

describe('client imports', () => {
  it('imports only Preact, the Markdown parser, its own modules and src/view and src/events', () => {
    const offenders: string[] = [];
    const sources = filesUnder(CLIENT).filter(
      (f) => /\.tsx?$/.test(f) && !f.includes(`${sep}__tests__${sep}`),
    );
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec === 'preact' || spec.startsWith('preact/') || MARKDOWN_PACKAGES.has(spec)) {
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

describe('inline styles and the Content-Security-Policy', () => {
  /** The client sources (not tests) whose text sets an inline style or holds a style element. */
  function styleOffenders(dir: string): string[] {
    const offenders: string[] = [];
    const sources = filesUnder(dir).filter(
      (f) => /\.tsx?$/.test(f) && !f.includes(`${sep}__tests__${sep}`),
    );
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [
        /\bstyle\s*=/,
        /<style\b/,
        /\.style\b/,
        /setAttribute\(\s*['"]style['"]/,
        /\bcssText\b/,
      ]) {
        if (pattern.test(text)) {
          offenders.push(`${relative(SRC, file)}: ${pattern.source}`);
        }
      }
    }
    return offenders;
  }

  it('the policy allows styles only from the stylesheet of the page itself', () => {
    const styleSrc = CONTENT_SECURITY_POLICY.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('style-src '));
    expect(styleSrc).toBe("style-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
  });

  it('the scan finds an inline style', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-client-style-'));
    try {
      mkdirSync(join(dir, 'views'));
      writeFileSync(join(dir, 'views', 'A.tsx'), '<g style={{ opacity: 1 }} />');
      writeFileSync(join(dir, 'views', 'B.tsx'), '<svg><style>{css}</style></svg>');
      writeFileSync(join(dir, 'ok.tsx'), '<g class="edge animated" stroke-width={2} />');
      expect(styleOffenders(dir).map((f) => f.split(sep).join('/'))).toEqual([
        expect.stringContaining('views/A.tsx'),
        expect.stringContaining('views/B.tsx'),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no client source sets an inline style or uses a style element', () => {
    expect(styleOffenders(CLIENT)).toEqual([]);
  });

  it('the insight views exist and are scanned', () => {
    const names = filesUnder(join(CLIENT, 'views')).map((f) => f.split(sep).at(-1));
    for (const view of ['HealthView.tsx', 'ReplayView.tsx', 'GraphView.tsx']) {
      expect(names).toContain(view);
    }
  });
});
