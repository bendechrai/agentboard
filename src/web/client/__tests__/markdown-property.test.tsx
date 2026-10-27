// @vitest-environment happy-dom
/**
 * Property tests for the description renderer (add-description-markdown
 * task 1.1; board-web: "Board text is never markup", "Description links and
 * images"). For arbitrary input, from random Unicode to dense mixes of
 * Markdown and HTML syntax, the tree `renderMarkdown` returns holds only
 * allow-listed element names and attributes, no event handler, no raw
 * HTML prop, no `style`, no component other than
 * `Fragment`, no `img`, `script`, `iframe` or `style` element, and no
 * `href` outside `http:`, `https:` and `mailto:`. The same holds for the
 * DOM it renders to. The URL oracle is restated here as a pattern over the
 * `href` as written, independently of `isAllowedUrl`, and a bracket link
 * is a link exactly when the oracle allows its URL. Plain words keep their
 * text (so a renderer that drops content fails), input nested past
 * `MAX_MARKDOWN_DEPTH` renders into a DOM without throwing, and input
 * longer than `MAX_MARKDOWN_LENGTH` is shown as text without being parsed. With a throwing parser the output is exactly the input as
 * text.
 */

import fc from 'fast-check';
import { Fragment, isValidElement, render, type ComponentChildren } from 'preact';
import { describe, expect, it } from 'vitest';

import {
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_LENGTH,
  isAllowedUrl,
  renderMarkdown,
  type MarkdownParser,
} from '../markdown.js';

// Each run parses and renders up to a few hundred inputs; under a loaded
// machine the whole property can exceed vitest's 5 second default.
const PROPERTY_TIMEOUT_MS = 120_000;

/** The element names a description may render to. */
const ELEMENTS = new Set([
  'p',
  'h4',
  'h5',
  'h6',
  'em',
  'strong',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'input',
  'hr',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
]);

/** The attributes (props) each element may carry, `children` aside. */
const ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'target', 'rel', 'class']),
  input: new Set(['type', 'checked', 'disabled']),
  code: new Set(['data-lang']),
  th: new Set(['data-align']),
  td: new Set(['data-align']),
  ol: new Set(['start']),
};

const ALIGNMENTS = new Set(['left', 'center', 'right']);

/** Preact's raw HTML prop, spelt in two parts so the source scans do not match this file. */
const INNER_HTML_PROP = 'dangerously' + 'SetInnerHTML';

/**
 * The scheme an `href` must start with, restated as a pattern over the URL
 * as written: `http://` or `https://` (so never a same-origin form such as
 * `http:/api/session`) or `mailto:`, in any letter case.
 */
const ALLOWED_HREF = /^(https?:\/\/|mailto:)/i;

/** The URL rule, restated: the URL as written matches `ALLOWED_HREF` and parses without a base. */
function oracleAllowed(url: string): boolean {
  if (!ALLOWED_HREF.test(url)) {
    return false;
  }
  try {
    new URL(url);
  } catch {
    return false;
  }
  return true;
}

/** The rule violations in a rendered vnode tree, as readable strings. */
function vnodeViolations(node: ComponentChildren, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node as ComponentChildren[]) {
      vnodeViolations(child, out);
    }
    return out;
  }
  if (!isValidElement(node)) {
    if (node !== null && node !== undefined && typeof node === 'object') {
      out.push(`non-vnode object child ${JSON.stringify(node)}`);
    }
    return out;
  }
  const props: Record<string, unknown> = node.props;
  if (node.type === Fragment) {
    for (const name of Object.keys(props)) {
      if (name !== 'children') {
        out.push(`Fragment prop ${name}`);
      }
    }
    vnodeViolations(props['children'] as ComponentChildren, out);
    return out;
  }
  if (typeof node.type !== 'string') {
    out.push('component vnode');
    return out;
  }
  const tag = node.type;
  // Preact keeps `ref` on the vnode, never in `props`.
  if (node.ref !== null && node.ref !== undefined) {
    out.push(`${tag} ref`);
  }
  if (!ELEMENTS.has(tag)) {
    out.push(`element ${tag}`);
  }
  if (INNER_HTML_PROP in props) {
    out.push(`${tag} prop ${INNER_HTML_PROP}`);
  }
  for (const name of Object.keys(props)) {
    if (/^on/i.test(name) || name === 'style') {
      out.push(`${tag} prop ${name}`);
    }
  }
  const allowed = ATTRIBUTES[tag] ?? new Set<string>();
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children') {
      continue;
    }
    if (!allowed.has(name)) {
      out.push(`${tag} prop ${name}`);
      continue;
    }
    if (name === 'href') {
      if (typeof value !== 'string' || !oracleAllowed(value)) {
        out.push(`href ${JSON.stringify(value)}`);
      }
    } else if (name === 'target' && value !== '_blank') {
      out.push(`target ${JSON.stringify(value)}`);
    } else if (name === 'rel' && value !== 'noopener noreferrer') {
      out.push(`rel ${JSON.stringify(value)}`);
    } else if (name === 'class' && value !== 'image-link') {
      out.push(`class ${JSON.stringify(value)}`);
    } else if (name === 'type' && value !== 'checkbox') {
      out.push(`type ${JSON.stringify(value)}`);
    } else if (name === 'disabled' && value !== true) {
      out.push(`disabled ${JSON.stringify(value)}`);
    } else if (name === 'checked' && typeof value !== 'boolean') {
      out.push(`checked ${JSON.stringify(value)}`);
    } else if (name === 'data-lang' && typeof value !== 'string') {
      out.push(`data-lang ${JSON.stringify(value)}`);
    } else if (name === 'data-align' && !(typeof value === 'string' && ALIGNMENTS.has(value))) {
      out.push(`data-align ${JSON.stringify(value)}`);
    } else if (name === 'start' && !(typeof value === 'number' && Number.isInteger(value))) {
      out.push(`start ${JSON.stringify(value)}`);
    }
  }
  if (tag === 'a') {
    for (const name of ['href', 'target', 'rel']) {
      if (!(name in props)) {
        out.push(`a without ${name}`);
      }
    }
  }
  if (tag === 'input' && props['disabled'] !== true) {
    out.push('input not disabled');
  }
  vnodeViolations(props['children'] as ComponentChildren, out);
  return out;
}

/** The rule violations in the DOM rendered under `root`. */
function domViolations(root: Element): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (!ELEMENTS.has(tag)) {
      out.push(`element ${tag}`);
    }
    const allowed = ATTRIBUTES[tag] ?? new Set<string>();
    for (const name of el.getAttributeNames()) {
      if (!allowed.has(name)) {
        out.push(`${tag} attribute ${name}`);
      }
    }
    const href = el.getAttribute('href');
    if (href !== null && !oracleAllowed(href)) {
      out.push(`href ${JSON.stringify(href)}`);
    }
  }
  if (root.querySelector('img, script, iframe, style') !== null) {
    out.push('forbidden element');
  }
  return out;
}

/** Fragments that make the parser take its interesting paths. */
const TOKENS = [
  'a',
  'b c',
  ' ',
  '  ',
  '\n',
  '\n\n',
  '\t',
  '    ',
  '#',
  '## ',
  '###### ',
  '*',
  '**',
  '_',
  '~~',
  '~',
  '`',
  '```',
  '~~~',
  '> ',
  '- ',
  '+ ',
  '1. ',
  '3) ',
  '- [ ] ',
  '- [x] ',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  '![',
  '](',
  ']: ',
  '[^1]',
  '[^1]: ',
  '|',
  '|---|',
  '|:-:|',
  '---',
  '===',
  '\\',
  '&',
  '&amp;',
  '&#106;',
  '&#x3C;',
  '"',
  "'",
  '=',
  'javascript:',
  'JavaScript:',
  'vbscript:',
  'data:text/html,',
  'http://',
  'https://',
  'http:/',
  'http:',
  'HTTPS:',
  'mailto:',
  'ftp://',
  '//',
  '/api/session',
  '#/board',
  'example.com',
  'www.',
  '@',
  'alert(1)',
  '<script>',
  '</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe src=x>',
  '<style>',
  '<a href="javascript:alert(1)">',
  '<div>',
  '<!--',
  '-->',
  '<![CDATA[',
  '<?',
  ' onclick=',
  'style=',
];

const markdownish = fc.string({ unit: fc.constantFrom(...TOKENS), maxLength: 60 });
const anyText = fc.oneof(
  { weight: 4, arbitrary: markdownish },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 80 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 80 }) },
);

describe('renderMarkdown on arbitrary input', () => {
  it(
    'returns a tree of allow-listed elements and attributes with only allowed hrefs',
    () => {
      fc.assert(
        fc.property(anyText, (source) => {
          expect(vnodeViolations(renderMarkdown(source))).toEqual([]);
        }),
        { numRuns: 400 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'renders to a DOM of allow-listed elements and attributes with only allowed hrefs',
    () => {
      fc.assert(
        fc.property(anyText, (source) => {
          const root = document.createElement('div');
          render(renderMarkdown(source), root);
          expect(domViolations(root)).toEqual([]);
          for (const a of root.querySelectorAll('a')) {
            expect(a.getAttribute('target')).toBe('_blank');
            expect(a.getAttribute('rel')).toBe('noopener noreferrer');
          }
          for (const input of root.querySelectorAll('input')) {
            expect(input.disabled).toBe(true);
          }
        }),
        { numRuns: 300 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'links a URL only when the oracle allows it, in links, references, autolinks and images',
    () => {
      const url = fc.oneof(
        fc.constantFrom(
          'https://example.com/x',
          'http://example.com',
          'mailto:a@example.com',
          'HTTPS://EXAMPLE.COM',
          'javascript:alert(1)',
          'JavaScript:alert(1)',
          'data:text/html,x',
          'vbscript:x',
          '/api/session',
          '//evil.example/x',
          '#/board',
          'http://[::1',
          'ftp://example.com',
          'http:/api/session',
          'http:api',
          'HTTPS:/x',
          'http:#/board',
        ),
        fc.string({
          unit: fc.constantFrom(
            'a',
            ':',
            '/',
            '.',
            'h',
            't',
            'p',
            's',
            'java',
            'script',
            '%',
            '#',
            '?',
          ),
          maxLength: 12,
        }),
      );
      // Each form, and whether it is a link exactly when the oracle allows
      // its URL (the bracket forms are; an autolink needs a scheme first).
      const form = fc.constantFrom(
        { make: (u: string) => `[t](<${u}>)`, exact: true },
        { make: (u: string) => `[t][r]\n\n[r]: <${u}>`, exact: true },
        { make: (u: string) => `<${u}>`, exact: false },
        { make: (u: string) => `![t](<${u}>)`, exact: true },
        { make: (u: string) => `![t][r]\n\n[r]: <${u}>`, exact: true },
      );
      fc.assert(
        fc.property(url, form, (u, { make, exact }) => {
          const root = document.createElement('div');
          render(renderMarkdown(make(u)), root);
          for (const a of root.querySelectorAll('a')) {
            const href = a.getAttribute('href') ?? '';
            expect(oracleAllowed(href), href).toBe(true);
            expect(isAllowedUrl(href)).toBe(true);
          }
          if (exact) {
            const hrefs = [...root.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
            expect(hrefs, u).toEqual(oracleAllowed(u) ? [u] : []);
          }
          expect(root.querySelector('img')).toBeNull();
        }),
        { numRuns: 300 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'shows the input exactly as text when the parser throws',
    () => {
      fc.assert(
        fc.property(anyText, (source) => {
          const root = document.createElement('div');
          render(
            renderMarkdown(source, () => {
              throw new Error('parser failure');
            }),
            root,
          );
          expect(root.children).toHaveLength(0);
          expect(root.textContent).toBe(source);
        }),
        { numRuns: 200 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});

describe('isAllowedUrl on arbitrary input', () => {
  it('agrees with the restated URL rule', () => {
    const urlish = fc.oneof(
      fc.string({
        unit: fc.constantFrom(
          'http',
          'https',
          'mailto',
          'javascript',
          'data',
          ':',
          '//',
          '/',
          'a',
          '.',
          '@',
          ' ',
          '\n',
          '\t',
          'H',
          'S',
          '[',
          ']',
          '%',
          '#',
        ),
        maxLength: 10,
      }),
      fc.webUrl(),
      fc.string({ maxLength: 30 }),
    );
    fc.assert(
      fc.property(urlish, (url) => {
        expect(isAllowedUrl(url)).toBe(oracleAllowed(url));
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * `n` levels of inline nesting alternating the two delimiters of `pair`:
 * `*x _x *x ... a ... x_ x*` for `['*', '_']` (emphasis only) and the same
 * with `**` and `__` (strong only).
 */
function nestedInline(pair: readonly [string, string], n: number): string {
  const open: string[] = [];
  const close: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = pair[i % 2] ?? '';
    open.push(`${d}x `);
    close.unshift(` x${d}`);
  }
  return open.join('') + 'a' + close.join('');
}

/** The deepest element nesting under `root` (a child of `root` is depth 1). */
function elementDepth(root: Element): number {
  let deepest = 0;
  for (const child of root.children) {
    deepest = Math.max(deepest, 1 + elementDepth(child));
  }
  return deepest;
}

/**
 * The nesting a deep input reaches in the deterministic case: eight times
 * the cap. The parser's time grows faster than linearly with the nesting
 * of lists and inline chains, so this stays far beyond the cap without
 * costing seconds a case.
 */
const FAR_BEYOND_DEPTH = 8 * MAX_MARKDOWN_DEPTH;

/** `unit` repeated `n` times around `a`, closed where the unit needs closing. */
function repeatedUnit(unit: string, n: number): string {
  const close =
    unit === '*' ? '*'.repeat(n) : unit === '[' ? '](https://example.com)'.repeat(n) : '';
  return unit.repeat(n) + 'a' + close;
}

/**
 * The shapes of deeply nested input, each made at a given nesting `n`. The
 * repeated units nest as containers; a run of `~~` is not one (from three
 * tildes on it opens a code fence), so it is left out. Runs of `*` alone
 * parse as strong with at most one emphasis, so the inline chains
 * alternate the delimiters for emphasis-only and strong-only nesting.
 */
const DEEP_SHAPES: readonly { name: string; make: (n: number) => string }[] = [
  ...['> ', '- ', '*', '[', '> - ', '1. ', '> *'].map((unit) => ({
    name: JSON.stringify(unit),
    make: (n: number) => repeatedUnit(unit, n),
  })),
  { name: 'emphasis chain', make: (n: number) => nestedInline(['*', '_'], n) },
  { name: 'strong chain', make: (n: number) => nestedInline(['**', '__'], n) },
];

/**
 * Renders `source` (short enough to be parsed, not shown whole as text) to a
 * vnode tree and a DOM, and expects both within the rules and the DOM no
 * deeper than the cap allows. A throw from `renderMarkdown` or from Preact's
 * `render` fails the caller.
 */
function expectCappedRender(source: string, label: string): void {
  expect(source.length, label).toBeLessThanOrEqual(MAX_MARKDOWN_LENGTH);
  const tree = renderMarkdown(source);
  expect(vnodeViolations(tree), label).toEqual([]);
  const root = document.createElement('div');
  render(tree, root);
  expect(domViolations(root), label).toEqual([]);
  expect(elementDepth(root), label).toBeLessThanOrEqual(MAX_MARKDOWN_DEPTH + 2);
  expect(root.textContent, label).toContain('a');
}

describe('renderMarkdown renders what it is given', () => {
  it('keeps the text of plain words and lines exactly (a renderer that drops content fails)', () => {
    const word = fc.stringMatching(/^[a-z0-9]{1,10}$/);
    const text = fc
      .array(fc.tuple(word, fc.constantFrom(' ', '\n')), { minLength: 1, maxLength: 12 })
      .map((parts) => parts.map(([w, sep], i) => (i === parts.length - 1 ? w : w + sep)).join(''));
    fc.assert(
      fc.property(text, (source) => {
        const root = document.createElement('div');
        render(renderMarkdown(source), root);
        expect(root.textContent).toBe(source);
        expect([...root.children].map((el) => el.tagName.toLowerCase())).toEqual(['p']);
      }),
      { numRuns: 200 },
    );
  });

  it('shows a single plain word as itself in a paragraph', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z]{1,20}$/), (wordText) => {
        const root = document.createElement('div');
        render(renderMarkdown(wordText), root);
        expect(root.querySelector('p')?.textContent).toBe(wordText);
      }),
      { numRuns: 100 },
    );
  });
});

describe('renderMarkdown on deep and long input', () => {
  it('renders each deep shape nested far beyond the depth cap into a DOM without throwing, capped', () => {
    for (const { name, make } of DEEP_SHAPES) {
      expectCappedRender(make(FAR_BEYOND_DEPTH), name);
    }
  });

  it(
    'renders input nested beyond the depth cap into a DOM without throwing, capped, at any depth',
    () => {
      const deep = fc
        .tuple(
          fc.constantFrom(...DEEP_SHAPES),
          fc.integer({ min: MAX_MARKDOWN_DEPTH, max: 4 * MAX_MARKDOWN_DEPTH }),
        )
        .map(([{ make }, n]) => make(n));
      fc.assert(
        fc.property(deep, (source) => {
          expectCappedRender(source, source.slice(0, 40));
        }),
        { numRuns: 25 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'shows input longer than the length cap as plain text without parsing it',
    () => {
      const long = fc
        .tuple(
          fc.constantFrom('_a*', '*a', '# a\n', '> ', '[a](https://example.com) ', '<b>x</b>'),
          fc.integer({ min: MAX_MARKDOWN_LENGTH + 1, max: MAX_MARKDOWN_LENGTH + 4096 }),
        )
        .map(([unit, n]) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n));
      fc.assert(
        fc.property(long, (source) => {
          const calls: string[] = [];
          // Returns an empty tree rather than parsing, so a call costs nothing
          // and leaves the output empty.
          const parse: MarkdownParser = (s) => {
            calls.push(s);
            return { type: 'root', children: [] };
          };
          const root = document.createElement('div');
          render(renderMarkdown(source, parse), root);
          expect(calls).toEqual([]);
          expect(root.children).toHaveLength(0);
          expect(root.textContent).toBe(source);
        }),
        { numRuns: 40 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
