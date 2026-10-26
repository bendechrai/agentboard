// @vitest-environment happy-dom
/**
 * The description renderer (add-description-markdown task 1.1; board-web:
 * "Description rendered as Markdown", "Description links and images", "Board
 * text is never markup"): every allow-listed mdast node type, the fallback
 * for any other node type (raw HTML among them), link and image references,
 * the URL rule for inline links, references, autolinks and images, images
 * rendered as links, the heading shift, task list checkboxes, code blocks
 * and the plain-text fallback when parsing throws.
 *
 * The rendered tree is mounted into a detached `div` with Preact's `render`
 * and compared through `shape`, a compact serialisation of the DOM: an
 * element is `<name attr="value" ...>children</>` with its attributes
 * sorted, and a run of adjacent text nodes is one JSON string, so how the
 * renderer splits text into nodes does not matter but every element,
 * attribute and character does.
 */

import type { Root } from 'mdast';
import { render } from 'preact';
import { describe, expect, it } from 'vitest';

import type { PhrasingContent, RootContent } from 'mdast';

import {
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_LENGTH,
  headingTag,
  isAllowedUrl,
  parseMarkdown,
  renderMarkdown,
  type MarkdownParser,
} from '../markdown.js';

/** The rendered description of `source`, mounted into a detached `div`. */
function md(source: string, parse?: MarkdownParser): HTMLElement {
  const root = document.createElement('div');
  render(parse === undefined ? renderMarkdown(source) : renderMarkdown(source, parse), root);
  return root;
}

/** The compact serialisation of the children of `node` (see the file comment). */
function shapeOf(node: Node): string {
  let out = '';
  let text: string | null = null;
  for (const child of node.childNodes) {
    if (child.nodeType === child.TEXT_NODE) {
      text = (text ?? '') + (child.textContent ?? '');
      continue;
    }
    if (text !== null) {
      out += JSON.stringify(text);
      text = null;
    }
    if (child instanceof Element) {
      const attrs = child
        .getAttributeNames()
        .sort()
        .map((name) => ` ${name}=${JSON.stringify(child.getAttribute(name))}`)
        .join('');
      out += `<${child.tagName.toLowerCase()}${attrs}>${shapeOf(child)}</>`;
    } else {
      out += `<#${String(child.nodeType)}>`;
    }
  }
  if (text !== null) {
    out += JSON.stringify(text);
  }
  return out;
}

/** The shape of the rendered description of `source`. */
function shape(source: string, parse?: MarkdownParser): string {
  return shapeOf(md(source, parse));
}

/** The `a` attributes of an allowed link to `href`, in `shape`'s order. */
function link(href: string): string {
  return `<a href=${JSON.stringify(href)} rel="noopener noreferrer" target="_blank">`;
}

/** The `a` attributes of an allowed image link to `href`, in `shape`'s order. */
function imageLink(href: string): string {
  return `<a class="image-link" href=${JSON.stringify(href)} rel="noopener noreferrer" target="_blank">`;
}

/** Elements that must never be made from a description. */
function expectNoInjected(root: HTMLElement): void {
  for (const tag of [
    'img',
    'script',
    'iframe',
    'style',
    'object',
    'embed',
    'svg',
    'b',
    'i',
    'div',
  ]) {
    expect(root.querySelector(tag), tag).toBeNull();
  }
  const handlers = [...root.querySelectorAll('*')].filter((el) =>
    el.getAttributeNames().some((name) => name.toLowerCase().startsWith('on')),
  );
  expect(handlers).toEqual([]);
}

/** A unist position covering `start` to `end` of a one-line source. */
function at(start: number, end: number): NonNullable<Root['position']> {
  return {
    start: { line: 1, column: start + 1, offset: start },
    end: { line: 1, column: end + 1, offset: end },
  };
}

/** A parser that returns `tree` whatever the source. */
function returning(tree: Root): MarkdownParser {
  return () => tree;
}

/**
 * `http:` and `https:` URLs without `//` after the scheme: an `href`
 * written this way is resolved by the browser against the page's own
 * origin (`http:/api/session` is `http://127.0.0.1:<port>/api/session`).
 */
const SAME_ORIGIN_FORMS = [
  'http:/api/session',
  'http:api',
  'HTTP:/api/session',
  'https:/x',
  'http:#/board',
  'http:?q',
  'https:api/session',
  'http:\\\\example.com',
];

/** URLs that must never become an `href`, in any position. */
const REFUSED_URLS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'JAVASCRIPT:alert(1)',
  'jAvAsCrIpT:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'DATA:image/png;base64,AAAA',
  'vbscript:msgbox(1)',
  'VBScript:msgbox(1)',
  'file:///etc/passwd',
  'ftp://example.com/x',
  'blob:https://example.com/0f4c',
  '/api/session',
  'api/session',
  './spec.md',
  '../spec.md',
  '//evil.example/x',
  '#/board',
  '?token=x',
  'http://[::1',
  'https://',
  'http//example.com',
  // Same-scheme relative forms: new URL without a base parses them as
  // absolute (host `api`), but a browser resolves them against the page
  // origin, so they are refused unless `//` follows the scheme.
  ...SAME_ORIGIN_FORMS,
];

describe('isAllowedUrl', () => {
  it('allows absolute http, https and mailto URLs, in any letter case', () => {
    for (const url of [
      'http://example.com',
      'https://example.com/spec',
      'https://example.com/a?b=c#d',
      'mailto:someone@example.com',
      'HTTPS://EXAMPLE.COM/X',
      'Http://example.com',
      'MAILTO:someone@example.com',
      'http://127.0.0.1:8080/api/session',
    ]) {
      expect(isAllowedUrl(url), url).toBe(true);
    }
  });

  it('refuses every other scheme and every relative, protocol-relative, fragment or malformed URL', () => {
    for (const url of [
      ...REFUSED_URLS,
      '',
      ' ',
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
    ]) {
      expect(isAllowedUrl(url), JSON.stringify(url)).toBe(false);
    }
  });
});

describe('isAllowedUrl and same-origin forms of http: and https:', () => {
  it('refuses http: and https: URLs not followed by //, although new URL parses most of them', () => {
    expect(new URL('http:/api/session').host).toBe('api');
    for (const url of SAME_ORIGIN_FORMS) {
      expect(isAllowedUrl(url), url).toBe(false);
    }
  });

  it('still allows http://, https:// and mailto: URLs', () => {
    for (const url of [
      'http://example.com',
      'https://example.com',
      'HTTP://example.com/a',
      'https://example.com/api/session',
      'mailto:a@b.co',
    ]) {
      expect(isAllowedUrl(url), url).toBe(true);
    }
  });

  it('never links a same-origin form in an inline link, a reference, an autolink or an image', () => {
    for (const url of SAME_ORIGIN_FORMS) {
      expect(shape(`[t](<${url}>)`), url).toBe('<p>"t"</>');
      expect(shape(`[t][r]\n\n[r]: <${url}>`), url).toBe('<p>"t"</>');
      expect(shape(`![t](<${url}>)`), url).toBe('<p>"t"</>');
      expect(shape(`![t][r]\n\n[r]: <${url}>`), url).toBe('<p>"t"</>');
    }
    expect(shape('<http:/api/session>')).toBe('<p>"http:/api/session"</>');
    expect(shape('<HTTPS:api>')).toBe('<p>"HTTPS:api"</>');
  });

  it('keeps the href of an allowed URL as written', () => {
    expect(shape('[a](HTTP://Example.com/A) [m](mailto:a@b.co)')).toBe(
      `<p>${link('HTTP://Example.com/A')}"a"</>" "${link('mailto:a@b.co')}"m"</></>`,
    );
  });
});

describe('headingTag', () => {
  it('shifts a heading three levels below its depth, capped at h6', () => {
    expect([1, 2, 3, 4, 5, 6].map(headingTag)).toEqual(['h4', 'h5', 'h6', 'h6', 'h6', 'h6']);
  });
});

describe('parseMarkdown', () => {
  it('parses CommonMark with GFM tables, task list items, strikethrough and autolink literals', () => {
    const source = '| a |\n|---|\n| 1 |\n\n~~gone~~ www.example.com\n\n- [x] done';
    const tree = parseMarkdown(source);
    expect(tree.type).toBe('root');
    expect(tree.children.map((n) => n.type)).toEqual(['table', 'paragraph', 'list']);
    const paragraph = tree.children[1];
    expect(paragraph?.type === 'paragraph' ? paragraph.children.map((n) => n.type) : []).toEqual([
      'delete',
      'text',
      'link',
    ]);
    const list = tree.children[2];
    expect(list?.type === 'list' ? list.children[0]?.checked : undefined).toBe(true);
    expect(tree.position?.end.offset).toBe(source.length);
  });

  it('keeps raw HTML as html nodes with their source', () => {
    const tree = parseMarkdown('<script>alert(1)</script>');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.type).toBe('html');
  });
});

describe('block nodes', () => {
  it('renders a paragraph as p, with the text as text', () => {
    expect(shape('Hello world')).toBe('<p>"Hello world"</>');
  });

  it('renders paragraphs separately', () => {
    expect(shape('one\n\ntwo')).toBe('<p>"one"</><p>"two"</>');
  });

  it('renders headings of every depth three levels lower, capped at h6', () => {
    expect(shape('# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f')).toBe(
      '<h4>"a"</><h5>"b"</><h6>"c"</><h6>"d"</><h6>"e"</><h6>"f"</>',
    );
  });

  it('renders setext headings the same way', () => {
    expect(shape('Title\n=====\n\nSub\n---')).toBe('<h4>"Title"</><h5>"Sub"</>');
  });

  it('renders inline content inside a heading', () => {
    expect(shape('## A *b* `c`')).toBe('<h5>"A "<em>"b"</>" "<code>"c"</></>');
  });

  it('renders a thematic break as hr', () => {
    expect(shape('a\n\n---\n\nb')).toBe('<p>"a"</><hr></><p>"b"</>');
  });

  it('renders a block quote as blockquote around its blocks', () => {
    expect(shape('> quoted *text*\n>\n> again')).toBe(
      '<blockquote><p>"quoted "<em>"text"</></><p>"again"</></>',
    );
  });

  it('renders a nested block quote', () => {
    expect(shape('> > deep')).toBe('<blockquote><blockquote><p>"deep"</></></>');
  });
});

describe('code', () => {
  it('renders a fenced code block with an info string as pre > code with data-lang', () => {
    expect(shape('```ts\nconst a = 1;\n```')).toBe(
      '<pre><code data-lang="ts">"const a = 1;"</></>',
    );
  });

  it('keeps only the first word of the info string as data-lang', () => {
    expect(shape('```ts title="x.ts" {1,2}\nconst a = 1;\n```')).toBe(
      '<pre><code data-lang="ts">"const a = 1;"</></>',
    );
  });

  it('renders a fenced code block without an info string with no data-lang', () => {
    expect(shape('```\nplain\n```')).toBe('<pre><code>"plain"</></>');
  });

  it('renders a tilde fence like a backtick fence', () => {
    expect(shape('~~~sh\nnpm test\n~~~')).toBe('<pre><code data-lang="sh">"npm test"</></>');
  });

  it('renders an indented code block as pre > code with no data-lang', () => {
    expect(shape('    indented\n    code')).toBe('<pre><code>"indented\\ncode"</></>');
  });

  it('keeps markup in code as text, with newlines', () => {
    const root = md('```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```');
    expect(shapeOf(root)).toBe(
      '<pre><code data-lang="html">"<script>alert(1)</script>\\n<img src=x onerror=alert(1)>"</></>',
    );
    expectNoInjected(root);
  });

  it('keeps an info string holding markup as the text of data-lang, never as an element or class', () => {
    const root = md('```"><script>alert(1)</script>\nx\n```');
    expect(shapeOf(root)).toBe('<pre><code data-lang="\\"><script>alert(1)</script>">"x"</></>');
    expectNoInjected(root);
  });

  it('renders inline code as code, with markup as text', () => {
    const root = md('Run `<b>npm</b> test` now');
    expect(shapeOf(root)).toBe('<p>"Run "<code>"<b>npm</b> test"</>" now"</>');
    expectNoInjected(root);
  });
});

describe('inline nodes', () => {
  it('renders emphasis, strong and strikethrough as em, strong and del', () => {
    expect(shape('*a* _b_ **c** __d__ ~~e~~')).toBe(
      '<p><em>"a"</>" "<em>"b"</>" "<strong>"c"</>" "<strong>"d"</>" "<del>"e"</></>',
    );
  });

  it('nests inline nodes', () => {
    expect(shape('***both*** and ~~**struck**~~')).toBe(
      '<p><em><strong>"both"</></>" and "<del><strong>"struck"</></></>',
    );
  });

  it('renders a hard line break as br, with trailing spaces or a backslash', () => {
    expect(shape('a  \nb\\\nc')).toBe('<p>"a"<br></>"b"<br></>"c"</>');
  });

  it('keeps a soft line break as a newline in the text, with no br', () => {
    expect(shape('a\nb')).toBe('<p>"a\\nb"</>');
  });

  it('shows text with HTML special characters literally', () => {
    const root = md('a < b && c > d "q" \'s\'');
    expect(shapeOf(root)).toBe('<p>"a < b && c > d \\"q\\" \'s\'"</>');
  });

  it('decodes character references into text, never into elements', () => {
    const root = md('&lt;b&gt;bold&lt;/b&gt; &amp; &#60;i&#62;');
    expect(shapeOf(root)).toBe('<p>"<b>bold</b> & <i>"</>');
    expectNoInjected(root);
  });

  it('keeps backslash escapes as the escaped characters', () => {
    expect(shape('\\*not emphasis\\*')).toBe('<p>"*not emphasis*"</>');
  });
});

describe('lists', () => {
  it('renders a tight bulleted list as ul > li, without p', () => {
    expect(shape('- one\n- two')).toBe('<ul><li>"one"</><li>"two"</></>');
  });

  it('renders a tight ordered list as ol > li, without a start attribute from 1', () => {
    expect(shape('1. one\n2. two')).toBe('<ol><li>"one"</><li>"two"</></>');
  });

  it('carries the start number of an ordered list that does not start at 1', () => {
    expect(shape('3. three\n4. four')).toBe('<ol start="3"><li>"three"</><li>"four"</></>');
  });

  it('renders a loose list with a p in each item', () => {
    expect(shape('- one\n\n- two')).toBe('<ul><li><p>"one"</></><li><p>"two"</></></>');
  });

  it('renders an item with two paragraphs as loose', () => {
    expect(shape('- one\n\n  more\n- two')).toBe(
      '<ul><li><p>"one"</><p>"more"</></><li><p>"two"</></></>',
    );
  });

  it('renders nested lists inside their item', () => {
    expect(shape('- one\n  - inner\n  - other\n- two')).toBe(
      '<ul><li>"one"<ul><li>"inner"</><li>"other"</></></><li>"two"</></>',
    );
    expect(shape('1. a\n   - b\n     1. c')).toBe(
      '<ol><li>"a"<ul><li>"b"<ol><li>"c"</></></></></></>',
    );
  });

  it('renders inline content inside items', () => {
    expect(shape('- *a* [b](https://example.com/b)')).toBe(
      `<ul><li><em>"a"</>" "${link('https://example.com/b')}"b"</></></>`,
    );
  });
});

describe('task list items', () => {
  /** The `li` elements of the rendered `source`. */
  function items(source: string): HTMLLIElement[] {
    return [...md(source).querySelectorAll('li')];
  }

  it('renders a checked and an unchecked item with a leading disabled checkbox', () => {
    const [done, open] = items('- [x] done\n- [ ] open');
    for (const [li, checked, text] of [
      [done, true, 'done'],
      [open, false, 'open'],
    ] as const) {
      const input = li?.firstElementChild;
      expect(input).toBeInstanceOf(HTMLInputElement);
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      expect(input.type).toBe('checkbox');
      expect(input.checked).toBe(checked);
      expect(input.disabled).toBe(true);
      expect(input.hasAttribute('disabled')).toBe(true);
      for (const name of input.getAttributeNames()) {
        expect(['type', 'disabled', 'checked']).toContain(name);
      }
      expect(li?.querySelectorAll('input')).toHaveLength(1);
      expect(li?.textContent?.trim()).toBe(text);
    }
  });

  it('treats an upper-case X as checked', () => {
    const input = items('- [X] done')[0]?.querySelector('input');
    expect(input?.checked).toBe(true);
  });

  it('gives a checkbox only to task items', () => {
    const [task, plain] = items('- [x] task\n- plain');
    expect(task?.querySelectorAll('input')).toHaveLength(1);
    expect(plain?.querySelector('input')).toBeNull();
    expect(plain?.textContent).toBe('plain');
  });

  it('keeps the checkbox leading in a loose task list', () => {
    const [first, second] = items('- [ ] a\n\n- [x] b');
    expect(first?.firstElementChild?.tagName.toLowerCase()).toBe('input');
    expect(second?.firstElementChild?.tagName.toLowerCase()).toBe('input');
    expect(second?.querySelector('p')?.textContent).toBe('b');
  });

  it('works in ordered lists', () => {
    const root = md('1. [x] first\n2. [ ] second');
    expect(root.querySelector('ol')).not.toBeNull();
    expect([...root.querySelectorAll('input')].map((i) => i.checked)).toEqual([true, false]);
  });

  it('cannot be toggled', () => {
    const input = items('- [ ] open')[0]?.querySelector('input');
    input?.click();
    expect(input?.checked).toBe(false);
    expect(input?.disabled).toBe(true);
  });
});

describe('tables', () => {
  it('renders the first row as thead > tr > th and the rest as tbody > tr > td, with alignment', () => {
    expect(
      shape('| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |\n| 5 | 6 | 7 | 8 |'),
    ).toBe(
      '<table><thead><tr>' +
        '<th data-align="left">"a"</><th data-align="center">"b"</><th data-align="right">"c"</><th>"d"</>' +
        '</></><tbody><tr>' +
        '<td data-align="left">"1"</><td data-align="center">"2"</><td data-align="right">"3"</><td>"4"</>' +
        '</><tr>' +
        '<td data-align="left">"5"</><td data-align="center">"6"</><td data-align="right">"7"</><td>"8"</>' +
        '</></></>',
    );
  });

  it('renders a table with only a header row without tbody', () => {
    expect(shape('| a | b |\n|---|---|')).toBe('<table><thead><tr><th>"a"</><th>"b"</></></></>');
  });

  it('renders inline content in cells', () => {
    expect(shape('| *x* | `y` |\n|---|---|\n| ~~z~~ | [l](https://example.com/l) |')).toBe(
      '<table><thead><tr><th><em>"x"</></><th><code>"y"</></></></><tbody><tr>' +
        `<td><del>"z"</></><td>${link('https://example.com/l')}"l"</></>` +
        '</></></>',
    );
  });
});

describe('links', () => {
  it('links an https URL in a new browsing context with no opener and no referrer (scenario "Allowed link")', () => {
    expect(shape('[spec](https://example.com/spec)')).toBe(
      `<p>${link('https://example.com/spec')}"spec"</></>`,
    );
  });

  it('links http and mailto URLs', () => {
    expect(shape('[a](http://example.com/a) [m](mailto:someone@example.com)')).toBe(
      `<p>${link('http://example.com/a')}"a"</>" "${link('mailto:someone@example.com')}"m"</></>`,
    );
  });

  it('links a mixed-case allowed scheme with the URL as written', () => {
    expect(shape('[x](HTTPS://example.com/X)')).toBe(
      `<p>${link('HTTPS://example.com/X')}"x"</></>`,
    );
  });

  it('puts no title attribute on a link', () => {
    expect(shape('[spec](https://example.com/spec "The spec")')).toBe(
      `<p>${link('https://example.com/spec')}"spec"</></>`,
    );
  });

  it('renders inline content inside a link', () => {
    expect(shape('[*a* `b`](https://example.com)')).toBe(
      `<p>${link('https://example.com')}<em>"a"</>" "<code>"b"</></></>`,
    );
  });

  it('shows a javascript: link as its text with no link (scenario "Script link")', () => {
    const root = md('[click](javascript:alert(1))');
    expect(shapeOf(root)).toBe('<p>"click"</>');
    expect(root.querySelector('[href^="javascript:" i]')).toBeNull();
    expect(root.querySelector('a')).toBeNull();
  });

  it('shows a relative link as its text with no link (scenario "Relative link")', () => {
    expect(shape('[api](/api/session)')).toBe('<p>"api"</>');
  });

  it('never links a refused URL in an inline link', () => {
    for (const url of REFUSED_URLS) {
      const root = md(`[click](<${url}>)`);
      expect(shapeOf(root), url).toBe('<p>"click"</>');
    }
  });

  it('never links a URL that is only allowed after decoding a character reference', () => {
    for (const source of [
      '[x](&#106;avascript:alert(1))',
      '[x](&#x6A;avascript:alert(1))',
      '[x](javascript&#58;alert(1))',
      '[x](java&#10;script:alert(1))',
      '[x](%6Aavascript:alert(1))',
    ]) {
      expect(shape(source), source).toBe('<p>"x"</>');
    }
  });

  it('keeps the text and its inline content of a refused link', () => {
    expect(shape('[**bold** text](javascript:alert(1))')).toBe('<p><strong>"bold"</>" text"</>');
  });
});

describe('link references and definitions', () => {
  it('resolves a full reference through its definition, which renders nothing', () => {
    expect(shape('[spec][ref]\n\n[ref]: https://example.com/spec')).toBe(
      `<p>${link('https://example.com/spec')}"spec"</></>`,
    );
  });

  it('resolves collapsed and shortcut references', () => {
    expect(shape('[ref][] and [ref]\n\n[ref]: https://example.com/r')).toBe(
      `<p>${link('https://example.com/r')}"ref"</>" and "${link('https://example.com/r')}"ref"</></>`,
    );
  });

  it('resolves a reference whose definition comes first, matching labels case-insensitively', () => {
    expect(shape('[REF]: https://example.com/r "title"\n\nSee [Text][ref].')).toBe(
      `<p>"See "${link('https://example.com/r')}"Text"</>"."</>`,
    );
  });

  it('uses the first definition of an identifier and ignores later ones, case-insensitively', () => {
    expect(
      shape('[x]: https://example.com/first\n[X]: https://example.com/second\n\n[t][x] [t][X]'),
    ).toBe(
      `<p>${link('https://example.com/first')}"t"</>" "${link('https://example.com/first')}"t"</></>`,
    );
  });

  it('keeps a refused first definition even when a later one is allowed', () => {
    expect(shape('[x]: javascript:alert(1)\n[x]: https://example.com/ok\n\n[t][x]')).toBe(
      '<p>"t"</>',
    );
    expect(shape('[x]: javascript:alert(1)\n[X]: https://example.com/ok\n\n![pic][x]')).toBe(
      '<p>"pic"</>',
    );
  });

  it('resolves references through a definition nested in a list item', () => {
    const root = md('- item\n\n  [n]: https://example.com/n\n\nSee [t][n] and ![p][n].');
    expect(
      [...root.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['t', 'https://example.com/n'],
      ['p', 'https://example.com/n'],
    ]);
    expect(root.textContent).not.toContain('https://example.com/n');
  });

  it('resolves references through a definition nested in a block quote, before or after it', () => {
    const root = md('[t][q]\n\n> quoted\n>\n> [q]: https://example.com/q\n\n- [u][q]');
    expect(
      [...root.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['t', 'https://example.com/q'],
      ['u', 'https://example.com/q'],
    ]);
    expect(root.querySelector('blockquote')?.textContent).toBe('quoted');
  });

  it('renders a definition alone as nothing', () => {
    expect(shape('[ref]: https://example.com/r')).toBe('');
  });

  it('never links a reference whose definition holds a refused URL', () => {
    for (const url of REFUSED_URLS) {
      expect(shape(`[click][bad]\n\n[bad]: <${url}>`), url).toBe('<p>"click"</>');
    }
  });

  it('shows an unresolved link reference as its text', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'linkReference',
              identifier: 'missing',
              label: 'missing',
              referenceType: 'full',
              children: [{ type: 'text', value: 'label' }],
            },
          ],
        },
      ],
    };
    expect(shape('[label][missing]', returning(tree))).toBe('<p>"label"</>');
  });

  it('shows an unresolved image reference as its alt text', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'imageReference',
              identifier: 'missing',
              label: 'missing',
              referenceType: 'full',
              alt: 'pic',
            },
          ],
        },
      ],
    };
    expect(shape('![pic][missing]', returning(tree))).toBe('<p>"pic"</>');
  });

  it('leaves brackets that match no definition as text', () => {
    expect(shape('[not a ref] and [x][y]')).toBe('<p>"[not a ref] and [x][y]"</>');
  });
});

describe('autolinks', () => {
  it('links angle-bracket autolinks with allowed schemes, and email autolinks as mailto', () => {
    expect(shape('<https://example.com/x> <mailto:a@example.com> <a@example.com>')).toBe(
      `<p>${link('https://example.com/x')}"https://example.com/x"</>" "` +
        `${link('mailto:a@example.com')}"mailto:a@example.com"</>" "` +
        `${link('mailto:a@example.com')}"a@example.com"</></>`,
    );
  });

  it('shows angle-bracket autolinks with any other scheme as their text', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'ftp://example.com/x',
    ]) {
      expect(shape(`<${url}>`), url).toBe(`<p>${JSON.stringify(url)}</>`);
    }
  });

  it('links GFM autolink literals: www., http(s) URLs and email addresses', () => {
    expect(shape('see www.example.com, https://example.com/x. or a@example.com')).toBe(
      `<p>"see "${link('http://www.example.com')}"www.example.com"</>", "` +
        `${link('https://example.com/x')}"https://example.com/x"</>". or "` +
        `${link('mailto:a@example.com')}"a@example.com"</></>`,
    );
  });

  it('does not autolink a bare javascript: or data: text', () => {
    expect(shape('javascript:alert(1) data:text/html,x')).toBe(
      '<p>"javascript:alert(1) data:text/html,x"</>',
    );
  });
});

describe('images', () => {
  it('renders an image as a link labelled with its alt text, never an img (scenario "Image is not loaded")', () => {
    const root = md('![diagram](https://example.com/d.png)');
    expect(shapeOf(root)).toBe(`<p>${imageLink('https://example.com/d.png')}"diagram"</></>`);
    expect(root.querySelector('img')).toBeNull();
  });

  it('labels an image with an empty alt text with its URL', () => {
    expect(shape('![](https://example.com/d.png)')).toBe(
      `<p>${imageLink('https://example.com/d.png')}"https://example.com/d.png"</></>`,
    );
  });

  it('puts no title attribute on an image link', () => {
    expect(shape('![d](https://example.com/d.png "Title")')).toBe(
      `<p>${imageLink('https://example.com/d.png')}"d"</></>`,
    );
  });

  it('shows an image with a refused URL as its label text, with no link', () => {
    for (const url of REFUSED_URLS) {
      const root = md(`![pic](<${url}>)`);
      expect(shapeOf(root), url).toBe('<p>"pic"</>');
      expect(root.querySelector('img'), url).toBeNull();
    }
  });

  it('shows an image with a refused URL and no alt text as the URL text', () => {
    expect(shape('![](javascript:alert(1))')).toBe('<p>"javascript:alert(1)"</>');
    expect(shape('![](data:image/png;base64,AAAA)')).toBe('<p>"data:image/png;base64,AAAA"</>');
  });

  it('resolves an image reference through its definition', () => {
    expect(shape('![pic][img]\n\n[img]: https://example.com/p.png')).toBe(
      `<p>${imageLink('https://example.com/p.png')}"pic"</></>`,
    );
  });

  it('shows an image reference with a refused URL as its label text', () => {
    for (const url of REFUSED_URLS) {
      expect(shape(`![pic][img]\n\n[img]: <${url}>`), url).toBe('<p>"pic"</>');
    }
  });

  it('keeps markup in alt text as text', () => {
    const root = md('![<img src=x onerror=alert(1)>](https://example.com/p.png)');
    expect(root.querySelector('a.image-link')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expectNoInjected(root);
  });
});

describe('nodes outside the allow-list', () => {
  it('shows inline HTML literally between its neighbours (scenario "Description with raw HTML")', () => {
    const root = md('Before <img src=x onerror=alert(1)> after');
    expect(shapeOf(root)).toBe('<p>"Before <img src=x onerror=alert(1)> after"</>');
    expectNoInjected(root);
  });

  it('shows an HTML block literally as a paragraph (scenario "Description with a script block")', () => {
    const root = md('<script>alert(1)</script>');
    expect(shapeOf(root)).toBe('<p>"<script>alert(1)</script>"</>');
    expectNoInjected(root);
  });

  it('shows a multi-line HTML block with its newlines', () => {
    const root = md('<div onclick="x()">\n<b>bold</b>\n</div>');
    expect(shapeOf(root)).toBe('<p>"<div onclick=\\"x()\\">\\n<b>bold</b>\\n</div>"</>');
    expectNoInjected(root);
  });

  it('shows an HTML block in a block quote as a paragraph inside it', () => {
    const root = md('> <iframe src="https://example.com"></iframe>');
    expect(shapeOf(root)).toBe(
      '<blockquote><p>"<iframe src=\\"https://example.com\\"></iframe>"</></>',
    );
    expectNoInjected(root);
  });

  it('shows inline HTML in a list item and a table cell as text', () => {
    const root = md('- <b>x</b>\n\n| <i>y</i> |\n|---|');
    expect(shapeOf(root)).toBe(
      '<ul><li>"<b>x</b>"</></><table><thead><tr><th>"<i>y</i>"</></></></>',
    );
    expectNoInjected(root);
  });

  it('shows an HTML comment and a style block literally', () => {
    const root = md('<!-- hidden -->\n\n<style>body{display:none}</style>');
    expect(shapeOf(root)).toBe('<p>"<!-- hidden -->"</><p>"<style>body{display:none}</style>"</>');
    expectNoInjected(root);
  });

  it('shows the raw source of HTML, character references included', () => {
    expect(shape('a <span title="&amp;">b</span>')).toBe(
      '<p>"a <span title=\\"&amp;\\">b</span>"</>',
    );
  });

  it('keeps footnote syntax out: a reference without a definition is text', () => {
    expect(shape('See [^1].')).toBe('<p>"See [^1]."</>');
  });

  it('makes no footnote elements, ids or links from a footnote and its definition', () => {
    const root = md('Note[^1].\n\n[^1]: the note');
    for (const tag of ['a', 'sup', 'section', 'ol', 'hr']) {
      expect(root.querySelector(tag), tag).toBeNull();
    }
    expect(root.querySelector('[id]')).toBeNull();
    expect(root.textContent).toContain('Note');
  });

  it('renders an unsupported block node as a p of its source text', () => {
    const source = '---\nk: v\n---';
    const tree: Root = {
      type: 'root',
      children: [{ type: 'yaml', value: 'k: v', position: at(0, source.length) }],
      position: at(0, source.length),
    };
    expect(shape(source, returning(tree))).toBe(`<p>${JSON.stringify(source)}</>`);
  });

  it('renders an unsupported inline node as bare text of its source', () => {
    const source = 'a[^n]b';
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'a', position: at(0, 1) },
            { type: 'footnoteReference', identifier: 'n', label: 'n', position: at(1, 5) },
            { type: 'text', value: 'b', position: at(5, 6) },
          ],
          position: at(0, 6),
        },
      ],
    };
    expect(shape(source, returning(tree))).toBe('<p>"a[^n]b"</>');
  });

  it('renders an unsupported node without a position as nothing', () => {
    const tree: Root = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'kept' }] },
        { type: 'yaml', value: 'k: v' },
      ],
    };
    expect(shape('anything', returning(tree))).toBe('<p>"kept"</>');
  });
});

describe('the parse-error fallback', () => {
  const failing: MarkdownParser = () => {
    throw new Error('parser failure');
  };

  it('shows the whole description as plain text when parsing throws', () => {
    const source = '# Heading\n\n- *item* [link](https://example.com)';
    const root = md(source, failing);
    expect(root.children).toHaveLength(0);
    expect(root.textContent).toBe(source);
  });

  it('shows markup in the description literally when parsing throws', () => {
    const source = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const root = md(source, failing);
    expect(root.children).toHaveLength(0);
    expect(root.textContent).toBe(source);
  });

  it('falls back on any error, a stack overflow from deep nesting among them', () => {
    const overflow: MarkdownParser = () => {
      throw new RangeError('Maximum call stack size exceeded');
    };
    const root = md('*a*', overflow);
    expect(root.children).toHaveLength(0);
    expect(root.textContent).toBe('*a*');
  });

  it('uses parseMarkdown by default', () => {
    expect(shape('# a')).toBe(shape('# a', parseMarkdown));
    expect(shape('# a')).toBe('<h4>"a"</>');
  });
});

describe('a description with many elements', () => {
  it('renders each in order', () => {
    const source = [
      '# Title',
      '',
      'Some *em*, **strong**, ~~del~~ and `code`, a [link](https://example.com/l)',
      'and ![img](https://example.com/i.png).  ',
      'After a break.',
      '',
      '> quote',
      '',
      '1. first',
      '',
      '```js',
      'x()',
      '```',
      '',
      '***',
      '',
      '| h |',
      '|:-:|',
      '| c |',
    ].join('\n');
    expect(shape(source)).toBe(
      '<h4>"Title"</>' +
        '<p>"Some "<em>"em"</>", "<strong>"strong"</>", "<del>"del"</>" and "<code>"code"</>", a "' +
        `${link('https://example.com/l')}"link"</>"\\nand "${imageLink('https://example.com/i.png')}"img"</>"."<br></>"After a break."</>` +
        '<blockquote><p>"quote"</></>' +
        '<ol><li>"first"</></>' +
        '<pre><code data-lang="js">"x()"</></>' +
        '<hr></>' +
        '<table><thead><tr><th data-align="center">"h"</></></><tbody><tr><td data-align="center">"c"</></></></>',
    );
  });
});

/** The deepest element nesting under `root` (a child of `root` is depth 1). */
function elementDepth(root: Element): number {
  let deepest = 0;
  for (const child of root.children) {
    deepest = Math.max(deepest, 1 + elementDepth(child));
  }
  return deepest;
}

/** A parser that records each call, then hands the source to `inner` (by default the real parser). */
function recording(inner: MarkdownParser = parseMarkdown): {
  parse: MarkdownParser;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    parse: (source) => {
      calls.push(source);
      return inner(source);
    },
  };
}

// Parsing the deepest inputs below takes seconds under coverage with
// parallel workers (micromark's cost, not the renderer's), beyond vitest's
// 5 second default.
const DEEP_PARSE_MS = 60_000;

describe('the depth cap', () => {
  it('is 32', () => {
    expect(MAX_MARKDOWN_DEPTH).toBe(32);
  });

  it('renders block quotes nested exactly to the cap as elements', () => {
    // 31 block quotes and the paragraph: depth 32.
    const root = md('> '.repeat(MAX_MARKDOWN_DEPTH - 1) + 'a');
    expect(root.querySelectorAll('blockquote')).toHaveLength(MAX_MARKDOWN_DEPTH - 1);
    const p = root.querySelector('p');
    expect(p?.textContent).toBe('a');
    expect(p?.parentElement?.tagName.toLowerCase()).toBe('blockquote');
    expect(elementDepth(root)).toBe(MAX_MARKDOWN_DEPTH);
  });

  it('renders the paragraph one level past the cap as its source text', () => {
    const root = md('> '.repeat(MAX_MARKDOWN_DEPTH) + 'a');
    const quotes = [...root.querySelectorAll('blockquote')];
    expect(quotes).toHaveLength(MAX_MARKDOWN_DEPTH);
    expect(root.querySelector('p')).toBeNull();
    expect(shapeOf(quotes.at(-1) ?? root)).toBe('"a"');
  });

  it('renders the block quote past the cap as one text node of its source, children unmapped', () => {
    const root = md('> '.repeat(40) + 'a');
    const quotes = [...root.querySelectorAll('blockquote')];
    expect(quotes).toHaveLength(MAX_MARKDOWN_DEPTH);
    const innermost = quotes.at(-1);
    expect(innermost?.childNodes).toHaveLength(1);
    expect(innermost?.firstChild?.nodeType).toBe(3);
    expect(innermost?.textContent).toBe('> '.repeat(8) + 'a');
  });

  it('renders the list past the cap as its source text', () => {
    // Each `- ` is a list and a list item: 16 levels reach depth 32.
    const root = md('- '.repeat(20) + 'a');
    expect(root.querySelectorAll('ul')).toHaveLength(16);
    expect(root.querySelectorAll('li')).toHaveLength(16);
    const innermost = [...root.querySelectorAll('li')].at(-1);
    expect(innermost?.textContent).toBe('- - - - a');
    expect(innermost?.children).toHaveLength(0);
  });

  it('renders a mix of block quotes, lists and emphasis past the cap as source text', () => {
    const root = md('> - '.repeat(12) + '**_a_**');
    expect(elementDepth(root)).toBeLessThanOrEqual(MAX_MARKDOWN_DEPTH);
    expect(root.querySelector('strong, em')).toBeNull();
    expect(root.textContent).toContain('- > - **_a_**');
  });

  it(
    'renders deep emphasis without throwing, capped, keeping the text',
    () => {
      const root = md('*'.repeat(3000) + 'a' + '*'.repeat(3000));
      expect(elementDepth(root)).toBeLessThanOrEqual(MAX_MARKDOWN_DEPTH);
      expect(root.textContent).toContain('a');
    },
    DEEP_PARSE_MS,
  );

  it(
    'renders 1200 levels of emphasis-only nesting into a DOM without throwing, capped',
    () => {
      // `*x _x *x ... a ... x_ x*`: a chain of emphasis nodes alone, which
      // runs of one delimiter never produce.
      const open: string[] = [];
      const close: string[] = [];
      for (let i = 0; i < 1200; i++) {
        const d = i % 2 === 0 ? '*' : '_';
        open.push(`${d}x `);
        close.unshift(` x${d}`);
      }
      const source = open.join('') + 'a' + close.join('');
      const tree = renderMarkdown(source);
      const root = document.createElement('div');
      render(tree, root);
      expect(root.querySelectorAll('em')).toHaveLength(MAX_MARKDOWN_DEPTH - 1);
      expect(elementDepth(root)).toBe(MAX_MARKDOWN_DEPTH);
      expect(root.textContent).toContain(' a ');
    },
    DEEP_PARSE_MS,
  );

  for (const [name, source] of [
    ['1500 block quotes', '> '.repeat(1500) + 'a'],
    ['5000 block quotes', '> '.repeat(5000) + 'a'],
    ['1000 nested lists', '- '.repeat(1000) + 'a'],
    ['3000 levels of emphasis', '*'.repeat(3000) + 'a' + '*'.repeat(3000)],
    ['2000 nested link brackets', '['.repeat(2000) + 'a' + '](https://example.com)'.repeat(2000)],
    ['a mix 1000 levels deep', '> - *'.repeat(1000) + 'a'],
  ] as const) {
    it(
      `returns a tree and renders it into a DOM without throwing: ${name}`,
      () => {
        // A throw from renderMarkdown or from Preact's render fails the test.
        const tree = renderMarkdown(source);
        const root = document.createElement('div');
        render(tree, root);
        expect(elementDepth(root)).toBeLessThanOrEqual(MAX_MARKDOWN_DEPTH + 2);
        expect(root.textContent).toContain('a');
      },
      DEEP_PARSE_MS,
    );
  }
});

// While the length cap is missing, the over-long inputs below take seconds
// to parse; the timeout keeps them failing on their assertions, not on time.
const SLOW_PARSE_MS = 60_000;

describe('the length cap', () => {
  it('is 16384', () => {
    expect(MAX_MARKDOWN_LENGTH).toBe(16384);
  });

  it(
    'shows a description longer than the cap as plain text without parsing it',
    () => {
      const source = '# Title\n\n' + '_a*'.repeat(6000);
      expect(source.length).toBeGreaterThan(MAX_MARKDOWN_LENGTH);
      // An empty tree in place of a slow real parse; a call would also empty the output.
      const { parse, calls } = recording(() => ({ type: 'root', children: [] }));
      const root = md(source, parse);
      expect(calls).toEqual([]);
      expect(root.children).toHaveLength(0);
      expect(root.textContent).toBe(source);
    },
    SLOW_PARSE_MS,
  );

  it('does not parse a description one character over the cap', () => {
    const source = '# ' + 'a'.repeat(MAX_MARKDOWN_LENGTH - 1);
    expect(source.length).toBe(MAX_MARKDOWN_LENGTH + 1);
    const { parse, calls } = recording();
    const root = md(source, parse);
    expect(calls).toEqual([]);
    expect(root.querySelector('h4')).toBeNull();
    expect(root.textContent).toBe(source);
  });

  it('parses a description of exactly the cap', () => {
    const source = '# ' + 'a'.repeat(MAX_MARKDOWN_LENGTH - 2);
    expect(source.length).toBe(MAX_MARKDOWN_LENGTH);
    const { parse, calls } = recording();
    const root = md(source, parse);
    expect(calls).toEqual([source]);
    expect(root.querySelector('h4')?.textContent).toBe('a'.repeat(MAX_MARKDOWN_LENGTH - 2));
  });

  it(
    'shows an over-long emphasis-heavy description through the default parser as plain text',
    () => {
      const source = '_a*'.repeat(Math.ceil((MAX_MARKDOWN_LENGTH + 1) / 3));
      const root = md(source);
      expect(root.children).toHaveLength(0);
      expect(root.textContent).toBe(source);
    },
    SLOW_PARSE_MS,
  );
});

describe('the fallback covers the mapping', () => {
  it('shows the source as plain text when mapping the root throws', () => {
    const tree: Root = {
      type: 'root',
      get children(): RootContent[] {
        throw new TypeError('malformed children');
      },
    };
    const root = md('# a\n\nb', returning(tree));
    expect(root.children).toHaveLength(0);
    expect(root.textContent).toBe('# a\n\nb');
  });

  it('discards what was mapped before a nested node throws', () => {
    const tree: Root = {
      type: 'root',
      children: [
        { type: 'heading', depth: 1, children: [{ type: 'text', value: 'a' }] },
        {
          type: 'paragraph',
          get children(): PhrasingContent[] {
            throw new TypeError('malformed children');
          },
        },
      ],
    };
    const root = md('# a\n\nb', returning(tree));
    expect(root.children).toHaveLength(0);
    expect(root.textContent).toBe('# a\n\nb');
  });

  it('shows the source as plain text when a node has a malformed position', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'yaml',
          value: 'k',
          get position(): NonNullable<Root['position']> {
            throw new TypeError('malformed position');
          },
        },
      ],
    };
    const root = md('---\nk\n---', returning(tree));
    expect(root.children).toHaveLength(0);
    expect(root.textContent).toBe('---\nk\n---');
  });
});

describe('links inside links', () => {
  it('renders an autolink inside a link as its text, with one a', () => {
    expect(shape('[a <https://x.example> b](https://y.example)')).toBe(
      `<p>${link('https://y.example')}"a https://x.example b"</></>`,
    );
  });

  it('renders a GFM autolink literal inside a link as its text', () => {
    const root = md('[see www.example.com now](https://y.example)');
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(root.querySelector('a a')).toBeNull();
    expect(root.querySelector('a')?.textContent).toBe('see www.example.com now');
  });

  it('renders an image inside a link as its label text, with one a', () => {
    expect(shape('[![alt](https://i.example/p.png)](https://ok.example)')).toBe(
      `<p>${link('https://ok.example')}"alt"</></>`,
    );
  });

  it('labels an image without alt text inside a link with its URL', () => {
    expect(shape('[![](https://i.example/p.png)](https://ok.example)')).toBe(
      `<p>${link('https://ok.example')}"https://i.example/p.png"</></>`,
    );
  });

  it('renders an image reference inside a link reference as its label text', () => {
    expect(shape('[![alt][i]][l]\n\n[i]: https://i.example/p.png\n[l]: https://ok.example')).toBe(
      `<p>${link('https://ok.example')}"alt"</></>`,
    );
  });

  it('nests no a in any a for links in emphasis inside a link', () => {
    const root = md(
      '[*x <https://a.example>* and ![p](https://b.example/p.png)](https://c.example)',
    );
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(root.querySelector('a a')).toBeNull();
    expect(root.querySelector('a em')?.textContent).toBe('x https://a.example');
  });
});
