# agentboard

A local, offline, conflict-free ticket board for AI agents working on one project.

Status: pre-alpha. The CLI does not do anything useful yet.

## What it is

Multiple coding agents (and humans) working on the same project need a shared
view of what needs doing, what is in progress, and what is done, without a
hosted service and without merge conflicts when two agents update the board
at the same time.

agentboard keeps an append-only event log as the source of truth: every
change (create a ticket, move it, comment on it, close it) is written as its
own content-addressed file under `.board/` in the project. Because agents
only ever add new event files and never modify existing ones, concurrent
writes from multiple agents (or multiple machines syncing over git) never
clobber each other. A SQLite database is derived from the event log as a
disposable read cache for fast queries; it can be deleted and rebuilt from
the event log at any time.

See `docs/adr/0001-event-log-source-of-truth.md` for the reasoning behind
this design.

## Usage

Run it directly with `npx`, no install required:

```
npx @bendechrai/agentboard
```

(The `agentboard` package name on npm was already taken by an unrelated
project, so this ships as the scoped package `@bendechrai/agentboard`; the
command it installs is still called `agentboard`.)

One `.board/` directory lives per project, at the project root.

## Status

Pre-alpha. This repository currently contains only the project scaffold
(build, lint, test, OpenSpec and CI-equivalent local checks); no board
functionality is implemented yet. Behavior changes go through an OpenSpec
change proposal under `openspec/changes/` before implementation; see
CONTRIBUTING.md.
