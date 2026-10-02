# Tasks

Every group is delivered by a test author, an implementer and a reviewer in
turn (see CONTRIBUTING.md), on one branch cut from `origin/staging`.
Verification for every task includes `make check` passing (CI runs it on
every supported Node line) with coverage at or above 90 percent. Group 1 is
security-critical: it gets a second reviewer on the strongest model.

## 1. Markdown descriptions (`web/description-markdown`)

- [ ] 1.1 Add `mdast-util-from-markdown`, `micromark-extension-gfm` and `mdast-util-gfm` as dev dependencies, and the pure renderer `src/web/client/markdown.tsx`: parse with GFM tables, task list items, strikethrough and autolink literals (no footnotes); render an allow-list of mdast node types to Preact elements, with any other node (including `html`) as its source text; resolve link and image references through definitions; link only absolute `http:`, `https:` and `mailto:` URLs, with `target="_blank"` and `rel="noopener noreferrer"`; render images as links labelled with the alt text (or the URL) and never as `img`; shift headings by three levels (capped at `h6`); render task items with a disabled checkbox and code as `pre > code` with a `data-lang` attribute; fall back to plain text when parsing throws. Verify: unit tests for every node type and every scenario of "Description rendered as Markdown" and "Description links and images", tests that `javascript:`, `data:`, `vbscript:`, relative, protocol-relative and malformed URLs (in inline links, references, autolinks and images) are never linked, that raw HTML blocks and inline HTML are shown literally, and a property test that for arbitrary input the rendered tree contains only allow-listed elements and no `href` outside the allowed schemes
- [ ] 1.2 Show the description in the ticket detail view as a `section.description` with the heading "Description" after the fields (and no section without a description), memoising the parse on the description text, and style the Markdown elements under `.description` in `public/app.css` with the existing colour tokens. Verify: ticket-view tests for the "Structure is rendered", "Task list items" and "No description" scenarios; markup tests for the "Description with raw HTML" and "Description with a script block" scenarios; a guard test that no module under `src/web/client/` uses `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`; the "No external requests" scan of `dist/web/` still passing; and a manual check in a browser of a description with every supported element

## 2. Documentation (`docs/description-markdown`)

- [ ] 2.1 Update README.md ("Watching the board in a browser" and the security model's "Script in the page", which says board text is never rendered as markup), write ADR 0012 (Markdown descriptions rendered to elements, never HTML) noting what it changes in ADR 0006's reasoning, and update the ADR index and docs/STATUS.md. Verify: `make ascii`, `make validate-specs`
