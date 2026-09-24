# 4. Source-neutral task reference

Date: 2026-09-24

## Status

Accepted

## Context

Every ticket must reference the planned work it delivers, so that the board
never introduces scope of its own. The first planning tool agentboard
serves is OpenSpec, where a unit of work is a numbered task group in a
change's `tasks.md`. The first draft of the event schema carried that shape
directly, as `change` and `group` fields on `ticket.create`.

Other planning tools exist (Spec Kit, for example, organizes work as
feature directories with phases and task ids), and event files are
immutable and kept forever. Whatever shape the schema gives the link is
folded by every future version of the tool.

## Decision

A ticket carries a task reference `{source, ref, item}`, written in text as
`<source>:<ref>#<item>`:

- `source` is a lowercase identifier (`^[a-z][a-z0-9-]*$`) naming the
  planning tool, `openspec` for OpenSpec;
- `ref` names the change, feature or plan within that source (for
  OpenSpec, the change directory name);
- `item` names the unit of work within `ref` (for OpenSpec, the task group
  number as a decimal string).

The event schema type-checks the three strings and interprets nothing
else. Everything source-specific (locating the planning root, listing
importable units, mapping an item to its tasks file and line for the tick
reminder) lives behind a source adapter keyed by `source`. This version
ships only the `openspec` adapter. A ticket whose source has no adapter is
created, listed, moved and closed normally; only `import-change` needs an
adapter and refuses an unsupported source by name, and `checklist tick`
says that no tasks-file reminder is available.

The CLI keeps OpenSpec shorthand: `--change <name> --group <n>` is exactly
`--task openspec:<name>#<n>`, and `list --change <name>` is exactly
`list --task openspec:<name>`.

## Rationale

A new source then needs an adapter, not a schema version bump. Keeping
`change` and `group` and adding another shape later would have meant a v2
event schema and a fold that understands both shapes forever, to save
three strings now. The text form makes a reference easy to type, log and
grep, and the shorthand keeps the common OpenSpec case as short as it was.

## Consequences

- The schema cannot validate that a reference points at real planned work;
  only an adapter can, and only `import-change` asks it to.
- Labels written by `import-change` (`change:<name>`, `group:<n>`) are
  OpenSpec conventions, not schema fields.
- A Spec Kit adapter, or any other, is a separate change that adds code
  but no event kind or field.

## Alternatives considered

**OpenSpec-shaped `change` and `group` fields.** Simplest for the one
source used today. Rejected for the schema cost above.

**A free-form string link.** Maximally flexible, but nothing could route
it to an adapter or filter on it reliably (`list --task` matches source,
ref and optionally item). Rejected in favour of three typed parts.
