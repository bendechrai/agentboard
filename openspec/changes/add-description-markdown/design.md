# Design

## Context

The ticket detail view (`src/web/client/views/TicketView.tsx`) shows the
description as one `dd` in the fields list, as a Preact text child. Every
board text reaches the page that way: Preact escapes text children, no
client module uses `innerHTML` or `dangerouslySetInnerHTML`, and the
Content-Security-Policy (`script-src 'self'`, `img-src 'self' data:`)
backs this up. The access token lives in the tab's `sessionStorage`, so
script injected into the page could read it; ADR 0006 rests on "board text
is never rendered as markup".

The front end is bundled by tsup (esbuild) from `src/web/client/main.tsx`
into `dist/web/app.js`, and `src/web/__tests__/client-build.test.ts` scans
the built assets for any `http://` or `https://` URL other than three W3C
namespace names ("No external requests").

## Goals / Non-Goals

**Goals:**
- Render descriptions as Markdown with no path, however malformed the
  input, from board text to an HTML string in the page.
- Keep the change inside the web client: no API, view-model or event
  change.

**Non-Goals:**
- Markdown in comments, hand-off notes or titles (a later change can reuse
  the renderer).
- Syntax highlighting of code blocks, footnotes, math, HTML passthrough or
  a sanitizer-based allow-list of HTML tags.
- Markdown in the terminal UI.

## Decisions

### Parse to mdast, render the tree to Preact elements

The description is parsed with `mdast-util-from-markdown` and the GFM
extensions (`micromark-extension-gfm` with `mdast-util-gfm`), and the
resulting syntax tree is mapped to Preact elements by a small pure
renderer, `src/web/client/markdown.tsx`. The renderer handles an explicit
allow-list of node types; each produces fixed elements whose only dynamic
content is text children and, for links, an `href` that passed the URL
check. A node type outside the list (including `html`) is rendered as the
plain text of its source.

Alternatives considered:
- *A Markdown-to-HTML library plus a sanitizer (DOMPurify) and
  `dangerouslySetInnerHTML`.* Correctness then depends on the sanitizer's
  configuration and on every future change keeping it in place, and it
  reintroduces an HTML string into the page, which ADR 0006 rules out.
- *`marked`'s lexer tokens.* Smaller (about 44 kB minified), but the
  bundle carries a `https://github.com/markedjs/marked` string that fails
  the "No external requests" scan, and its token shapes are less precisely
  specified than mdast.
- *A hand-written parser.* Markdown's edge cases (nesting, lazy
  continuation, emphasis rules) make this a large, bug-prone surface for
  little gain.

The mdast route adds about 80 kB minified to `app.js` and carries no
external URL. The libraries are dev dependencies, bundled at build time
like Preact.

### GFM without footnotes

The GFM extensions used are tables, task list items, strikethrough and
autolink literals. Footnotes are left out: they need cross-references and
generated ids in the page for little value in a ticket description, so
`[^1]` stays text.

### Link references are resolved by the renderer

mdast keeps `[text][ref]` and `![alt][ref]` as references plus separate
`definition` nodes. The renderer collects the definitions first and
resolves a reference to its definition's URL, then applies the same URL
check. An unresolved reference is its text. Definitions render nothing.

### The URL check

A URL is linked only when `new URL(url)` succeeds without a base and its
`protocol` is `http:`, `https:` or `mailto:`. Relative URLs fail to parse
without a base and so render as text, which also keeps a description from
pointing at the server's own API or changing the app's hash route.
Allowed links get `target="_blank"` and `rel="noopener noreferrer"`. The
page's `Referrer-Policy: no-referrer` already applies; `rel` repeats it on
the element.

### Images become links

An `image` (or resolved `imageReference`) renders as an `a` to its URL
under the same check, with a class marking it as an image link, labelled
with the alt text or, when that is empty, the URL. When the URL is not
allowed it renders as the label text. No `img` element is ever created, so
no request is made, whatever the CSP.

### Headings are shifted

The detail view's own headings are `h2` (ticket title) and `h3`
(sections). A description heading of depth `d` renders as
`h(min(d + 3, 6))`: `#` becomes `h4`, `####` and deeper become `h6`. The
description section itself has an `h3` "Description".

### Task list checkboxes

A list item with `checked` true or false renders a leading
`<input type="checkbox" disabled>` with `checked` set accordingly. A
disabled checkbox cannot be toggled and is skipped by the keyboard.

### Code

Fenced and indented code render as `pre > code` with the code as a text
child; the info string's first word is kept as a `data-lang` attribute
(text, never a class name built from input). Inline code renders as
`code`.

### Placement and style

The description moves out of the fields `dl` into a
`<section class="description">` after it, with the heading "Description".
`public/app.css` gets styles for the Markdown elements scoped under
`.description` (lists, tables with borders and horizontal scrolling, code
blocks with horizontal scrolling, block quotes), using the existing colour
tokens.

### A guard against HTML insertion

A test scans every module under `src/web/client/` for
`dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`,
`insertAdjacentHTML` and `document.write`, and fails on any match, so the
"never as HTML" rule does not depend on review alone.

## Risks / Trade-offs

- [A parser bug throws on some input] -> The renderer catches a parse
  error and falls back to showing the description as plain text, as
  today.
- [Very large descriptions are slow to parse] -> Parsing happens only when
  the detail view renders that ticket, and is memoised on the description
  text, so live updates to other tickets do not re-parse it.
- [Bundle size grows by about 80 kB] -> The page is served from loopback,
  so size affects only the first load from a local disk; acceptable.
- [A future change adds `innerHTML` for convenience] -> The guard test
  above fails.
- [Linkified URLs in descriptions written by an untrusted party lead the
  user to a malicious site] -> Links only open on a click, in a new
  context with no opener and no referrer, carrying no token (the token is
  never in a URL after start-up).
