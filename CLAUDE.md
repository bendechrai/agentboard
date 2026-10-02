# agentboard

TypeScript CLI, Node 22.16+. Uses `node:sqlite` (unflagged from 22.13;
`DatabaseSync.isTransaction` from 22.16, which sets the floor).

Specs in `openspec/` are the source of truth. Any behavior change goes
through an OpenSpec change proposal before implementation.

Decisions are recorded as ADRs in `adr/`.

See `STATUS.md` for a cold-start handover: what exists, what to build
next, and the current gap list.

Workflow, branch model and the test-author / implementer / reviewer split
are in CONTRIBUTING.md; follow it.

Run `make hooks` once per worktree; never push without `make check` passing.

Plain ASCII punctuation only in everything written (no em dashes, no curly
quotes).
