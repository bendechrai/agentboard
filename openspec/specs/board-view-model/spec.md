# board-view-model Specification

## Purpose
Defines the pure view-model layer that turns board state and events into
view data: board columns and cards, activity feed entries, the conversation
view, agent lanes, relative time, and applying feed messages to that data.
It is browser-safe and shared by every front end.

## Requirements

### Requirement: Pure view-model layer
View data for every board view SHALL be computed by pure functions under
`src/view/` from explicit inputs: ticket states, events with their fold
outcome (`applied`, `rejected` or `unknown`, and the rejection reason),
the current time `now` in milliseconds, and filters. These functions SHALL
read no clock, perform no IO, use no randomness, and SHALL NOT import any
`node:` module directly or transitively, so that the web client and the
terminal UI run the same code. Equal inputs SHALL produce deep-equal
outputs.

#### Scenario: No Node-only import
- **WHEN** the layering test follows every import from each module under `src/view/`
- **THEN** no module reached imports a `node:` specifier

#### Scenario: Deterministic output
- **WHEN** any view-model function is called twice with deep-equal inputs
- **THEN** the outputs are deep-equal

### Requirement: Board columns and cards
`boardColumns` SHALL return one column per status in the order `todo`,
`tests`, `implementing`, `review`, `blocked`, `merged`, each holding the
cards of the tickets in that status, most recently updated first (by
`updatedAt` in fold order). Closed tickets SHALL be excluded unless the
`includeClosed` filter is set. A card SHALL carry the ticket id and its
first 10 characters, title, assignee or none, task reference in text form
or the ad hoc marker, labels, checklist progress as done and total counts,
the status it was blocked from when blocked, whether it is closed, the
count of open `DECISION:` comments (as `openDecisions` defines them), and
whether it changed within the last 5 seconds before `now`. Filters by task
reference (`<source>:<ref>`, or `<source>:<ref>#<item>`) and by assignee
SHALL be combined with AND.

#### Scenario: Blocked card remembers its origin
- **WHEN** a ticket in `implementing` is moved to `blocked`
- **THEN** its card is in the `blocked` column and carries `implementing` as the status it was blocked from

#### Scenario: Closed tickets are hidden by default
- **WHEN** a board has one open and one closed ticket in `merged`
- **THEN** the `merged` column holds only the open ticket's card, and both when `includeClosed` is set

### Requirement: Activity feed entries
`feedEntries` SHALL return one entry per applied event, newest first
(reverse fold order), each with the event hash, kind, actor, timestamp,
ticket id and title (null for `board.meta`), the change (task reference
`<source>:<ref>` of the ticket, when it has one), and a one-line summary
produced by `describeEvent`: `created <title>`, `commented: <text>`,
`moved to <status>`, `claimed`, `released`, `assigned to <actor>`,
`handed off to <actor> (<status>): <note>`, `linked <task|pr|decision>
<value>`, `closed (decision <path>)` or `closed (no decision)`,
`checked <n>` or `unchecked <n>` (1-based line number), `added <k>
checklist line(s)`, and `set <key>` for `board.meta`. Filters by change,
by actor and by a set of kinds SHALL be combined with AND. An entry SHALL
be marked `late` when the consumer's model recorded it as a late arrival.

#### Scenario: Filter by actor and kind
- **WHEN** the feed is filtered to actor `impl-1` and kind `ticket.handoff`
- **THEN** only hand-offs written by `impl-1` are returned, newest first

#### Scenario: Hand-off summary
- **WHEN** `impl` hands T1 off to `reviewer` with status `review` and note `green`
- **THEN** its entry's summary is `handed off to reviewer (review): green`

### Requirement: Conversation view
`conversation` SHALL return the messages of one ticket in fold order,
built from its applied events: each `ticket.comment` as a chat message by
its actor with the text; each `ticket.handoff` as a chat message by its
actor with the note, the recipient and the status; every other kind as a
system line (the `describeEvent` summary). A message whose text starts
with `DECISION:` SHALL be flagged `decision`, and additionally `retracted`
when it is not in `openDecisions` for the ticket; a message whose text
starts with `RETRACTED:` SHALL be flagged `retraction`.

#### Scenario: Decision and retraction
- **WHEN** `impl` comments `DECISION: use sessions` and later comments `RETRACTED: see ADR`
- **THEN** the first message is flagged `decision` and `retracted`, and the second is flagged `retraction`

#### Scenario: Hand-off in the conversation
- **WHEN** a ticket was created, claimed by `test-1` and handed off to `impl-1` with a note
- **THEN** the conversation has two system lines followed by a chat message by `test-1` naming `impl-1`, the status and the note

### Requirement: Agent lanes
`agentLanes` SHALL return one lane per actor that wrote an applied event or
is the assignee of an open ticket, with: the open tickets assigned to the
actor (as cards); the actor's last applied event (hash, kind, ticket and
timestamp); and `lastSeenMs`, equal to `now` minus that event's wall, or 0
when that is negative. Lanes SHALL be ordered by the last event in reverse
fold order, then by actor name. "Last seen" is derived from events only;
no presence event exists.

#### Scenario: Last seen
- **WHEN** `impl-1`'s last applied event has wall 1000000 and `now` is 1300000
- **THEN** `impl-1`'s lane has `lastSeenMs` 300000

#### Scenario: Assignee without events
- **WHEN** ticket T1 was handed off to `reviewer-1`, who has written nothing
- **THEN** a lane for `reviewer-1` holds T1 and has no last event

### Requirement: Relative time
`relativeTime(ms)` SHALL render a non-negative duration as `just now`
under 10 seconds, `<n>s ago` under a minute, `<n>m ago` under an hour,
`<n>h ago` under a day and `<n>d ago` otherwise, rounding down; a negative
duration SHALL render as `just now`.

#### Scenario: Minutes
- **WHEN** `relativeTime(299999)` is called
- **THEN** it returns `4m ago`

### Requirement: Applying feed messages
`applyFeedMessage(model, message)` SHALL return, for an `append`, a new
model whose tickets, events, head and position id equal those of a model
built from a snapshot taken right after the appended events; and, for a
`resync`, the model unchanged with a flag telling the consumer to reload,
together with the late event hashes, which the reloaded model SHALL mark
as late. The feed carries only effective events, so a model kept up to date
by appends holds no rejected or unknown-kind events that arrived after its
snapshot; the equality above holds when every appended event is effective,
and views that show rejected events (the ticket detail) SHALL load them
from the JSON API rather than from the feed.

#### Scenario: Append equals reload
- **WHEN** a model built from a snapshot receives an `append` of three effective events
- **THEN** it deep-equals a model built from a snapshot taken after those three events
