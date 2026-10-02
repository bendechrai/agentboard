# Proposal

## Why

Ticket descriptions are written by agents and people who almost always use
Markdown: headings, lists, task lists, code blocks, tables and links. The
web app shows the description as one block of plain text, so the structure
the author wrote is lost and long descriptions are hard to read. The web
app should render a description as Markdown, without weakening the
guarantee that board text can never inject markup or script into the page
(the page holds the access token).

## What Changes

- The ticket detail view renders the description as Markdown (CommonMark
  plus the GitHub extensions for tables, task lists, strikethrough and
  autolinks), in its own section below the ticket fields.
- The Markdown is parsed into a syntax tree and turned into page elements
  from an allow-list of node types. No HTML string is ever produced or
  inserted, so the existing guarantee holds by construction:
  - raw HTML in a description (`<img ...>`, `<script>`) is shown as
    literal text;
  - a link becomes a link only for `http:`, `https:` and `mailto:` URLs,
    and opens in a new tab with no referrer and no opener; any other link
    (including `javascript:`, `data:` and relative URLs) is shown as its
    text;
  - an image is never loaded: it is shown as a link to the image URL (when
    that URL is allowed) labelled with its alt text, so the page still
    requests nothing from another origin;
  - task list items show a checkbox that cannot be changed.
- Titles, labels, comments, hand-off notes, actor names and paths stay
  plain text, and the terminal UI (`top`) is unchanged.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-web`: "Board text is never markup" (a description is rendered as
  Markdown, only into elements, never as HTML); two new requirements,
  "Description rendered as Markdown" (what is rendered) and "Description
  links and images" (which links become links, and that images are never
  loaded).

## Impact

- `src/web/client/`: a new Markdown renderer (syntax tree to Preact
  elements), the ticket detail view and `public/app.css`.
- Dependencies: `mdast-util-from-markdown`, `micromark-extension-gfm` and
  `mdast-util-gfm` as dev dependencies. They are bundled into
  `dist/web/app.js` at build time like Preact, so serving still needs no
  extra runtime package. The bundle grows by about 80 kB minified, and
  contains no external URL (the "No external requests" scan stays green).
- Security: the access token stays in `sessionStorage` and the
  Content-Security-Policy is unchanged. ADR 0006 and the README's security
  model state that board text is never rendered as markup; they are
  updated to say a description is rendered as Markdown into elements only,
  and a new ADR records the decision.
- The JSON API, the stream, the view-model, the CLI and MCP are unchanged.
