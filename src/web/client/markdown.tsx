/**
 * Ticket descriptions rendered as Markdown (board-web: "Description rendered
 * as Markdown", "Description links and images", "Board text is never
 * markup"; add-description-markdown design.md).
 *
 * A description is parsed into an mdast syntax tree by
 * `mdast-util-from-markdown` with the GFM extensions for tables, task list
 * items, strikethrough and autolink literals (no footnotes), and the tree is
 * mapped to Preact elements from an allow-list of node types. No HTML string
 * is ever produced: every text from the description reaches the page as a
 * text child, and the only attribute taken from it is the `href` of a link
 * that passed `isAllowedUrl` (plus the code block's `data-lang`, which is
 * text). The module is pure: no hooks, no state, no side effects.
 */

import type { Root } from 'mdast';
import type { VNode } from 'preact';

/** Parses a description into an mdast tree; may throw on input it cannot handle. */
export type MarkdownParser = (source: string) => Root;

/** The heading element a description heading of a given depth renders as. */
export type DescriptionHeading = 'h4' | 'h5' | 'h6';

/**
 * Parses `source` with `fromMarkdown` from `mdast-util-from-markdown`,
 * called exactly once per call of this function, with the micromark GFM
 * syntax and the matching mdast GFM extensions for tables, task list items,
 * strikethrough and autolink literals. Footnotes are not part of the
 * supported syntax. Whatever the parser throws is thrown to the caller.
 */
export function parseMarkdown(source: string): Root {
  void source;
  throw new Error('not implemented');
}

/**
 * Whether `url` may be the `href` of a link in a description: true exactly
 * when `new URL(url)`, without a base, succeeds and its `protocol` is
 * `http:`, `https:` or `mailto:`. Relative, protocol-relative and
 * fragment-only URLs fail to parse without a base and so are refused, as
 * are malformed URLs and every other scheme (`javascript:`, `data:`,
 * `vbscript:`, `file:` and the rest, in any letter case).
 */
export function isAllowedUrl(url: string): boolean {
  void url;
  throw new Error('not implemented');
}

/**
 * The element of a description heading of depth `depth` (1 to 6): shifted
 * below the detail view's own `h2` and `h3`, so `h(min(depth + 3, 6))`:
 * depth 1 is `h4`, depth 2 is `h5`, depth 3 and deeper are `h6`.
 */
export function headingTag(depth: number): DescriptionHeading {
  void depth;
  throw new Error('not implemented');
}

/**
 * Renders the description `source` as a Preact tree. `parse` defaults to
 * `parseMarkdown`; it is a parameter so the fallback below can be exercised.
 *
 * When `parse` throws, the result is the whole `source` as one text child,
 * with no element. Otherwise the result is a `Fragment` of the rendered
 * children of the root, built only from string-typed element vnodes,
 * `Fragment`s and text (no component, no event handler, no
 * raw HTML prop, no `style`), as follows:
 * - `paragraph`: `p`;
 * - `heading`: `headingTag(depth)`;
 * - `thematicBreak`: `hr`;
 * - `blockquote`: `blockquote`;
 * - `list`: `ol` when ordered, else `ul`; an ordered list whose `start` is a
 *   number other than 1 carries that `start` attribute;
 * - `listItem`: `li`. When `checked` is true or false, its first child is
 *   `<input type="checkbox" disabled>` with `checked` set accordingly (and
 *   no other attribute). In a tight list (the list's `spread` and every
 *   item's `spread` false) the content of a paragraph child is rendered
 *   directly in the `li`, without a `p`; in a loose list it is a `p`;
 * - `code`: `pre > code`, the code value as the text child of `code`; when
 *   the node has a non-empty `lang` (the first word of the info string),
 *   `code` carries it as `data-lang`, and `code` has no other attribute;
 * - `inlineCode`: `code` holding the value as text;
 * - `emphasis`: `em`; `strong`: `strong`; `delete`: `del`;
 * - `break`: `br`; `text`: its value as text (a soft line break stays the
 *   newline character inside the text);
 * - `table`: `table`, the first row as `thead > tr > th`, the other rows as
 *   `tbody > tr > td` (no `tbody` without other rows); a cell whose column
 *   has an alignment carries `data-align` set to `left`, `center` or
 *   `right`;
 * - `link` (autolinks and GFM autolink literals included): when
 *   `isAllowedUrl(url)`, an `a` with exactly the attributes `href` (the
 *   node's `url`), `target="_blank"` and `rel="noopener noreferrer"` around
 *   its rendered children; otherwise its rendered children with no `a`;
 * - `linkReference`: resolved through the tree's `definition` nodes by
 *   `identifier` (the definitions are collected before rendering, so a
 *   definition may follow its use), then as `link` with the definition's
 *   URL; an unresolved reference is its rendered children;
 * - `image`: never an `img`. The label is the `alt` text, or the `url`
 *   when `alt` is empty or missing. When `isAllowedUrl(url)`, an `a` with
 *   `class="image-link"`, `href`, `target="_blank"` and
 *   `rel="noopener noreferrer"` holding the label as text; otherwise the
 *   label as text;
 * - `imageReference`: resolved like `linkReference`, then as `image` with
 *   the definition's URL; an unresolved one is its `alt` text;
 * - `definition`: nothing;
 * - any other node type (`html` among them, block or inline, and every type
 *   of a syntax this renderer does not support): the text of its source,
 *   `source.slice(start.offset, end.offset)` of its position, as a `p` when
 *   its parent is the root or a `blockquote` and as bare text elsewhere; a
 *   node without position offsets renders nothing.
 */
export function renderMarkdown(source: string, parse: MarkdownParser = parseMarkdown): VNode {
  void source;
  void parse;
  throw new Error('not implemented');
}
