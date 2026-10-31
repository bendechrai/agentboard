## ADDED Requirements

### Requirement: Guide states the actor form
The actor rule section of `agentboard help agents`, and the MCP guide
(`agentboard://guide`), SHALL state the actor form (1 to 32 ASCII
letters, digits, `.`, `_`, `-` or `@`, the first a letter or digit),
that a name outside it or matching a secret pattern is refused with exit
1 `invalid-actor`, and that `--allow-secret-like` does not apply to it,
within the guide's line limit. `help` for every command that takes an
actor SHALL list exit code 1 `invalid-actor`, and the help of `--as` and
`--to` SHALL state the form. The `invalid-actor` hint SHALL name, on the
CLI, `--as <actor>` and `AGENTBOARD_ACTOR` (or `--to <actor>` when `--to`
was refused), over MCP the `as` argument and `agentboard mcp --as
<actor>`, and on the web `agentboard serve --as <actor>` (or the
hand-off's `to`), always with the placeholder `<actor>` and never the
refused name. Every guide line beginning `agentboard ` SHALL still parse.

#### Scenario: Guide names the form
- **WHEN** `agentboard help agents` runs, and an MCP client reads `agentboard://guide`
- **THEN** the actor rule says the form, names `invalid-actor`, says `--allow-secret-like` does not apply, and every output (with and without `--role`) is within the guide's line limit

#### Scenario: Help lists the reason
- **WHEN** `agentboard help comment`, `agentboard help handoff` and `agentboard help inbox` run
- **THEN** each lists exit code 1 `invalid-actor`, and the `--as` (and for `handoff` the `--to`) line states the form

#### Scenario: Hint for a refused actor
- **WHEN** `agentboard comment T1 "hi" --as <token>` runs, and `board_comment` is called with `as` set to the token
- **THEN** the CLI hint names `--as <actor>` and `AGENTBOARD_ACTOR`, the tool error's hint names the `as` argument and `agentboard mcp --as <actor>`, and neither contains the token
