# 15. Markdown descriptions rendered to elements, never HTML

Date: 2026-10-26

## Status

Accepted. Amends ADR 0006 (see Consequences).

## Context

Ticket descriptions are written by agents and people who almost always
use Markdown: headings, lists, task lists, code blocks, tables and links.
The web app (`agentboard serve`) showed a description as one block of
plain text, so the structure the author wrote was lost and a long
description was hard to read.

ADR 0006 rests on one sentence for the safety of the page: the access
token sits in the tab's `sessionStorage`, where script of the page's
origin could read it, and the Content-Security-Policy admits only the
server's own script "and board text is never rendered as markup, so there
is no injection point". Every board text reached the page as a Preact
text child, no client module used `innerHTML` or
`dangerouslySetInnerHTML`, and the CSP (`script-src 'self'`, `img-src
'self' data:`) backed that up. Rendering a description as Markdown has to
keep that guarantee, however malformed or hostile the description is: a
board is shared through `sync`, so a description may come from anyone with
write access to the board's repository.

## Decision

- A description is parsed into an mdast syntax tree with
  `mdast-util-from-markdown` and the GFM extensions
  (`micromark-extension-gfm` with `mdast-util-gfm`) for tables, task list
  items, strikethrough and autolink literals. Footnotes are not supported;
  `[^1]` stays text.
- A small pure renderer, `src/web/client/markdown.tsx`, maps the tree to
  Preact elements from an explicit allow-list of node types. Each type
  produces fixed elements whose only dynamic content is text children, for
  links an `href` that passed the URL rule, and a fixed vocabulary of
  attributes whose values are fields of the tree rather than input text
  (`data-lang`, `checked`, `start`, `data-align`). Any node outside the
  allow-list, `html` blocks and inline HTML included, is rendered as the
  text of its source. No HTML string is ever produced or inserted.
- The URL rule: a link becomes a link only when `new URL(url)` succeeds
  without a base and its protocol is `http:`, `https:` or `mailto:`, and
  the URL as written starts with the scheme (no leading whitespace, which
  the parser would strip) with `//` right after an `http:` or `https:`
  scheme (a browser resolves `http:/api/session` against the page's own
  origin). Everything else (`javascript:`, `data:`, `vbscript:`, relative
  and protocol-relative URLs, malformed URLs) is shown as its text. An
  allowed link carries `target="_blank"` and `rel="noopener noreferrer"`.
- An image is never an `img` element, so it is never loaded: it renders as
  a link to its URL under the same rule, labelled with its alt text or,
  when that is empty, the URL. Link and image references are resolved
  through the tree's `definition` nodes and then follow the same rules.
- Headings are shifted three levels (`#` is `h4`, `###` and deeper `h6`)
  under the detail view's own `h2` and `h3`; task list items carry a
  disabled checkbox; code blocks render as `pre > code` with the info
  string's first word as `data-lang`.
- The renderer is bounded by two caps. `MAX_MARKDOWN_DEPTH` is 32: a
  container (block quote, list, list item, table, row, cell, emphasis,
  strong, strikethrough, link, paragraph or heading) nested deeper than
  that renders as its source text with no children mapped, so neither the
  renderer nor Preact recurses without bound. `MAX_MARKDOWN_LENGTH` is
  16384 characters (UTF-16 code units): a longer description is not parsed
  at all and is shown as plain text, because the parser's time is
  super-linear on some input and a description has no length limit.
- Any error thrown by parsing or by mapping the tree falls back to the
  whole description as plain text, as before this decision.
- A guard test scans every module under `src/web/client/` for
  `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`,
  `insertAdjacentHTML` and `document.write` and fails on any match, so the
  rule does not depend on review alone.
- Titles, labels, comments, hand-off notes, actor names and paths stay
  plain text; the terminal UI (`top`), the JSON API, the stream, the
  view-model, the CLI and MCP are unchanged. The CSP and the token
  handling of ADR 0006 are unchanged.

## Rationale

Rendering from a syntax tree keeps the guarantee by construction rather
than by filtering: there is no HTML string at any point, so there is
nothing to sanitise and nothing a sanitiser could miss. The allow-list is
closed, every attribute value is either a tree field or a URL that passed
the rule, and the guard test turns the rule into a failing build rather
than a review note. Refusing every URL that does not parse as absolute
`http:`, `https:` or `mailto:` also keeps a description from pointing at
the server's own API or at the app's hash routes. Images as links keep the
page from requesting anything from another origin, whatever the CSP
allows, and the two caps keep a hostile description from stalling the tab
or overflowing the stack past the fallback. mdast's node shapes are
precisely typed, which is what makes a closed allow-list checkable.

## Consequences

- ADR 0006's sentence "board text is never rendered as markup" no longer
  holds as written. Its reasoning now reads: board text is never inserted
  as HTML; a description is rendered to elements from an allow-list, every
  other board text is shown as text, and the Content-Security-Policy and
  the token handling are unchanged. ADR 0006's Status records the
  amendment.
- The front-end bundle `dist/web/app.js` grows by about 80 kB minified.
  The page is served from loopback, so this affects only the first load
  from a local disk. The libraries are dev dependencies bundled at build
  time, like Preact, so serving needs no extra runtime package and the
  "No external requests" scan of the built assets stays green.
- A crafted description just under the 16384 character cap can still take
  a few seconds to parse once (emphasis-heavy text is the worst case). The
  parse is memoised on the description text and happens only when the
  detail view renders that ticket, so it is paid once per description, not
  on every live update.
- Footnote syntax is parsed by the GFM umbrella packages but is outside the
  allow-list, so it appears as its source text rather than as a footnote.
- A later change can reuse the renderer for comments or hand-off notes
  under the same rules; until then only the description is Markdown.

## Alternatives considered

**A Markdown-to-HTML library plus a sanitiser (DOMPurify) and
`dangerouslySetInnerHTML`.** Rejected: correctness would depend on the
sanitiser's configuration and on every future change keeping it in place,
and it reintroduces an HTML string into the page through `innerHTML`,
which ADR 0006 rules out and which the guard test exists to catch.

**`marked`'s lexer tokens rendered to elements.** Rejected: smaller (about
44 kB minified), but the bundle would carry a `https://github.com/markedjs/marked`
string that fails the "No external requests" scan, and its token shapes
are less precisely specified than mdast, which makes a closed allow-list
harder to check.

**A hand-written parser.** Rejected: Markdown's edge cases (nesting, lazy
continuation, emphasis rules) make it a large, bug-prone surface for
little gain over a tested parser whose output is rendered under the same
allow-list.
