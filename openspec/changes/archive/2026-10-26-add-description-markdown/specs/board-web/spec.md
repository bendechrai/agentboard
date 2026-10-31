# Spec Delta

## MODIFIED Requirements

### Requirement: Board text is never markup
Every text taken from the board (titles, descriptions, labels, comments,
notes, actor names, paths) SHALL be rendered as text, never interpreted as
HTML. A ticket's description SHALL additionally be interpreted as Markdown
as "Description rendered as Markdown" states, and only into page elements:
no text from the board SHALL ever be inserted into the page as HTML.

#### Scenario: Title with markup
- **WHEN** a ticket's title is `<img src=x onerror=alert(1)>`
- **THEN** the board view shows that text literally and the document contains no `img` element for it

#### Scenario: Description with raw HTML
- **WHEN** the detail view of a ticket whose description is `Before <img src=x onerror=alert(1)> after` is open
- **THEN** the description shows `<img src=x onerror=alert(1)>` literally between `Before` and `after`, and the document contains no `img` element

#### Scenario: Description with a script block
- **WHEN** the detail view of a ticket whose description is the HTML block `<script>alert(1)</script>` on its own line is open
- **THEN** the description shows that text literally and the document contains no `script` element other than the page's own

## ADDED Requirements

### Requirement: Description rendered as Markdown
The ticket detail view SHALL render a ticket's description, when it has
one, as Markdown: CommonMark plus GitHub-flavoured tables, task list
items, strikethrough and autolinked URLs, in a section of its own after
the ticket fields. A task list item SHALL show a checkbox that cannot be
changed. Headings in a description SHALL be shown below the level of the
view's own headings. A ticket without a description SHALL show no
description section.

#### Scenario: Structure is rendered
- **WHEN** the detail view of a ticket whose description has a `## Plan` heading, a bulleted list, a fenced code block and a two-column table is open
- **THEN** the description section shows a heading `Plan`, a list, a preformatted code block with the code as text, and a table with two columns

#### Scenario: Task list items
- **WHEN** a description contains `- [x] done` and `- [ ] open`
- **THEN** the detail view shows two list items with a checked and an unchecked checkbox, and neither checkbox can be changed

#### Scenario: No description
- **WHEN** the detail view of a ticket created without a description is open
- **THEN** no description section is shown

### Requirement: Description links and images
A link in a description SHALL be shown as a link only when its URL is
absolute with the scheme `http`, `https` or `mailto`, and SHALL then open
in a new browsing context with no opener and no referrer. Any other link
SHALL be shown as its text without a link. An image SHALL never be
loaded: it SHALL be shown as a link to its URL, under the same rule,
labelled with its alt text (or its URL when the alt text is empty).

#### Scenario: Allowed link
- **WHEN** a description contains `[spec](https://example.com/spec)`
- **THEN** the detail view shows a link `spec` to `https://example.com/spec` that opens in a new browsing context with no opener and no referrer

#### Scenario: Script link
- **WHEN** a description contains `[click](javascript:alert(1))`
- **THEN** the detail view shows the text `click` with no link, and the document contains no element whose `href` starts with `javascript:`

#### Scenario: Relative link
- **WHEN** a description contains `[api](/api/session)`
- **THEN** the detail view shows the text `api` with no link

#### Scenario: Image is not loaded
- **WHEN** a description contains `![diagram](https://example.com/d.png)`
- **THEN** the document contains no `img` element for it and shows a link labelled `diagram` to `https://example.com/d.png`, and the page makes no request for the image
