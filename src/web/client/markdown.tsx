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

import type {
  AlignType,
  Definition,
  List,
  ListItem,
  Nodes,
  Parents,
  Root,
  Table,
  TableRow,
} from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { createElement, type ComponentChildren, type VNode } from 'preact';

/** Parses a description into an mdast tree; may throw on input it cannot handle. */
export type MarkdownParser = (source: string) => Root;

/**
 * The deepest nesting `renderMarkdown` renders as elements. The depth of a
 * node is the number of nodes of the types `blockquote`, `list`, `listItem`,
 * `table`, `tableRow`, `tableCell`, `emphasis`, `strong`, `delete`, `link`,
 * `paragraph` and `heading` among the node itself and its ancestors. A node
 * of those types whose depth is greater than this renders as one text node
 * holding its source text (`source.slice(start.offset, end.offset)`), with
 * none of its children mapped, so neither the renderer nor Preact recurses
 * without bound. A tree whose depth is at most this renders as elements.
 */
export const MAX_MARKDOWN_DEPTH = 32;

/**
 * The longest description, in string length (UTF-16 code units), that
 * `renderMarkdown` parses. A longer one is not parsed at all and renders as
 * the plain-text fallback, because the parser's time is super-linear on
 * some inputs (emphasis-heavy text) and a description has no length limit.
 */
export const MAX_MARKDOWN_LENGTH = 16384;

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
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/** The protocols a description link may have. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/** An `http:` or `https:` scheme followed by `//`, as written, in any letter case. */
const HTTP_WITH_AUTHORITY = /^https?:\/\//i;

/**
 * Whether `url` may be the `href` of a link in a description: true exactly
 * when `new URL(url)`, without a base, succeeds and its `protocol` is
 * `http:`, `https:` or `mailto:`. Relative, protocol-relative and
 * fragment-only URLs fail to parse without a base and so are refused, as
 * are malformed URLs and every other scheme (`javascript:`, `data:`,
 * `vbscript:`, `file:` and the rest, in any letter case). An `http:` or
 * `https:` URL must also have `//` right after its scheme as written: a
 * browser resolves an `href` such as `http:/api/session` or `http:api`
 * against the page's own origin, although the parser without a base reads
 * it as absolute with host `api`.
 */
export function isAllowedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }
  return parsed.protocol === 'mailto:' || HTTP_WITH_AUTHORITY.test(url);
}

/**
 * The element of a description heading of depth `depth` (1 to 6): shifted
 * below the detail view's own `h2` and `h3`, so `h(min(depth + 3, 6))`:
 * depth 1 is `h4`, depth 2 is `h5`, depth 3 and deeper are `h6`.
 */
export function headingTag(depth: number): DescriptionHeading {
  if (depth <= 1) {
    return 'h4';
  }
  return depth === 2 ? 'h5' : 'h6';
}

/** What every node of one description is rendered with. */
interface Context {
  /** The description, for the source text of nodes outside the allow-list. */
  source: string;
  /** The tree's `definition` nodes by identifier, collected before rendering. */
  definitions: ReadonlyMap<string, Definition>;
}

/**
 * Renders the description `source` as a Preact tree. `parse` defaults to
 * `parseMarkdown`; it is a parameter so the fallback below can be exercised.
 *
 * When `source` is longer than `MAX_MARKDOWN_LENGTH` (then `parse` is not
 * called), or when parsing or mapping the tree throws, the result is the
 * whole `source` as one text child, with no element. Nodes deeper than
 * `MAX_MARKDOWN_DEPTH` render as their source text (see there). A link or
 * image inside a rendered link renders as its children or its label text,
 * never as a nested `a`. Otherwise the result is a `Fragment` of the rendered
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
  let root: Root;
  try {
    root = parse(source);
  } catch {
    return <>{source}</>;
  }
  const context: Context = { source, definitions: collectDefinitions(root) };
  return <>{renderChildren(root, context)}</>;
}

/** Every `definition` node of the tree, by identifier; the first one of an identifier wins. */
function collectDefinitions(root: Root): ReadonlyMap<string, Definition> {
  const definitions = new Map<string, Definition>();
  const visit = (node: Nodes): void => {
    if (node.type === 'definition') {
      if (!definitions.has(node.identifier)) {
        definitions.set(node.identifier, node);
      }
      return;
    }
    if ('children' in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(root);
  return definitions;
}

/** The rendered children of `parent`, in order. */
function renderChildren(parent: Parents, context: Context): ComponentChildren[] {
  return parent.children.map((child) => renderNode(child, parent, context));
}

/** One node of the tree as Preact children, following the allow-list of `renderMarkdown`. */
function renderNode(node: Nodes, parent: Parents, context: Context): ComponentChildren {
  switch (node.type) {
    case 'paragraph':
      return <p>{renderChildren(node, context)}</p>;
    case 'heading':
      return createElement(headingTag(node.depth), null, renderChildren(node, context));
    case 'thematicBreak':
      return <hr />;
    case 'blockquote':
      return <blockquote>{renderChildren(node, context)}</blockquote>;
    case 'list':
      return renderList(node, context);
    case 'code':
      return (
        <pre>
          {typeof node.lang === 'string' && node.lang !== '' ? (
            <code data-lang={node.lang}>{node.value}</code>
          ) : (
            <code>{node.value}</code>
          )}
        </pre>
      );
    case 'inlineCode':
      return <code>{node.value}</code>;
    case 'emphasis':
      return <em>{renderChildren(node, context)}</em>;
    case 'strong':
      return <strong>{renderChildren(node, context)}</strong>;
    case 'delete':
      return <del>{renderChildren(node, context)}</del>;
    case 'break':
      return <br />;
    case 'text':
      return node.value;
    case 'table':
      return renderTable(node, context);
    case 'link':
      return renderLink(node.url, renderChildren(node, context));
    case 'linkReference': {
      const definition = context.definitions.get(node.identifier);
      const children = renderChildren(node, context);
      return definition === undefined ? children : renderLink(definition.url, children);
    }
    case 'image':
      return renderImage(node.url, node.alt ?? '');
    case 'imageReference': {
      const definition = context.definitions.get(node.identifier);
      const alt = node.alt ?? '';
      return definition === undefined ? alt : renderImage(definition.url, alt);
    }
    case 'definition':
      return null;
    default:
      return renderSourceText(node, parent, context);
  }
}

/** A list as `ol` or `ul`; its items are tight when neither the list nor any item is spread. */
function renderList(list: List, context: Context): ComponentChildren {
  const spread = (node: List | ListItem): boolean => node.spread === true;
  const tight = !spread(list) && list.children.every((item) => !spread(item));
  const items = list.children.map((item) => renderListItem(item, tight, context));
  if (list.ordered === true) {
    const start = list.start;
    if (typeof start === 'number' && start !== 1) {
      return <ol start={start}>{items}</ol>;
    }
    return <ol>{items}</ol>;
  }
  return <ul>{items}</ul>;
}

function renderListItem(item: ListItem, tight: boolean, context: Context): ComponentChildren {
  const content = item.children.flatMap((child) =>
    tight && child.type === 'paragraph'
      ? renderChildren(child, context)
      : [renderNode(child, item, context)],
  );
  const checked = item.checked;
  if (typeof checked === 'boolean') {
    return (
      <li>
        <input type="checkbox" disabled checked={checked} />
        {content}
      </li>
    );
  }
  return <li>{content}</li>;
}

function renderTable(table: Table, context: Context): ComponentChildren {
  const align: readonly AlignType[] = table.align ?? [];
  const [head, ...body] = table.children;
  const cells = (row: TableRow, tag: 'th' | 'td'): ComponentChildren[] =>
    row.children.map((cell, column) => {
      const alignment = align[column] ?? null;
      const children = renderChildren(cell, context);
      return alignment === null
        ? createElement(tag, null, children)
        : createElement(tag, { 'data-align': alignment }, children);
    });
  return (
    <table>
      {head === undefined ? null : (
        <thead>
          <tr>{cells(head, 'th')}</tr>
        </thead>
      )}
      {body.length === 0 ? null : (
        <tbody>
          {body.map((row) => (
            <tr>{cells(row, 'td')}</tr>
          ))}
        </tbody>
      )}
    </table>
  );
}

/** An `a` to `url` around `children` when the URL is allowed; otherwise the children alone. */
function renderLink(url: string, children: ComponentChildren): ComponentChildren {
  if (!isAllowedUrl(url)) {
    return children;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** An image as a link to `url` labelled with `alt` (or the URL), never an `img`. */
function renderImage(url: string, alt: string): ComponentChildren {
  const label = alt === '' ? url : alt;
  if (!isAllowedUrl(url)) {
    return label;
  }
  return (
    <a class="image-link" href={url} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

/**
 * A node outside the allow-list as the text of its source: a `p` under the
 * root or a `blockquote`, bare text elsewhere, nothing without a position.
 */
function renderSourceText(node: Nodes, parent: Parents, context: Context): ComponentChildren {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    return null;
  }
  const text = context.source.slice(start, end);
  return parent.type === 'root' || parent.type === 'blockquote' ? <p>{text}</p> : text;
}
