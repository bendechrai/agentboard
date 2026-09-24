# Spec Delta

## MODIFIED Requirements

### Requirement: Actor is explicit
Every writing command SHALL require `--as <actor>` or the `AGENTBOARD_ACTOR`
environment variable; with neither, it SHALL exit 1 and explain. The actor
SHALL be recorded on the event and SHALL never be inferred from the OS user.
Every command SHALL accept `--as`; commands that neither write nor track a
per-actor cursor SHALL ignore it, so an agent can pass it habitually. The
one exception is `serve`, which writes only through the write actions of
its web app: those are enabled only by an explicit `--as <actor>` on the
`serve` command line, `serve` SHALL ignore `AGENTBOARD_ACTOR`, and every
event written through it carries that `--as` actor (see
board-web-actions).

#### Scenario: Missing actor
- **WHEN** `agentboard comment T1 "hi"` runs with no `--as` and no `AGENTBOARD_ACTOR`
- **THEN** the command exits 1 and names both ways to supply an actor

#### Scenario: Serve ignores the environment actor
- **WHEN** `agentboard serve` runs with `AGENTBOARD_ACTOR` set and no `--as`
- **THEN** the server is read-only
