# Spec Delta

## MODIFIED Requirements

### Requirement: Serve command
`agentboard serve [--port <port>] [--open | --no-open] [--as <actor>]` SHALL start a local HTTP server
for the board found by the usual discovery rules and run until SIGINT or
SIGTERM, then close every connection and exit 0. Without `--port` the port
SHALL be chosen by the operating system (port 0); `--port` SHALL accept an
integer from 0 to 65535 and anything else SHALL exit 1 with reason
`usage`. When the port cannot be bound because it is in use, the command
SHALL exit 1 with reason `port-in-use` before serving anything. When no
board is found it SHALL exit 2 before listening. At start-up it SHALL print
on stdout the line `serving <board dir> read-only at <url>`, or, when
started with `--as <actor>`, `serving <board dir> as <actor> at <url>`,
where `<url>` is `http://127.0.0.1:<port>/#token=<token>`; with `--json`
it SHALL instead print exactly one line holding the JSON object
`{"url", "port", "token", "writable", "actor"}`, with `writable` true and
`actor` the actor exactly when `--as` was given (else false and null), and
nothing else on stdout afterwards. After printing the start-up line it
SHALL ask the system to open `<url>` in the default browser when `--open`
is given, or when neither `--open` nor `--no-open` is given and all of
these hold: stdout is a terminal; `--json` is not given; the `CI`
environment variable is unset or empty; none of `SSH_CONNECTION`,
`SSH_CLIENT` and `SSH_TTY` is set to a non-empty value; and, on platforms
other than macOS and Windows, `DISPLAY` or `WAYLAND_DISPLAY` is set to a
non-empty value. With `--no-open`, or when a condition does not hold, it
SHALL NOT try to open a browser. `--open` and `--no-open` together SHALL
exit 1 with reason `usage` before listening. Failing to open the browser
SHALL be a warning on stderr, not an error. `serve` needs no
actor. Without `--as` it writes no event; with a non-empty `--as` it
accepts write actions as that actor (see board-web-actions), and an empty
`--as` value SHALL exit 1 with reason `usage`. `AGENTBOARD_ACTOR` SHALL be
ignored by `serve`.

#### Scenario: Start and stop
- **WHEN** `agentboard serve --port 0 --json` runs on a board and receives SIGINT after printing its start-up line
- **THEN** the line parses as JSON with a numeric `port`, a 43-character `token` and `writable` false, and the process exits 0

#### Scenario: Port in use
- **WHEN** `agentboard serve --port <p>` runs while another process listens on `127.0.0.1:<p>`
- **THEN** it exits 1 with reason `port-in-use` and a hint naming `--port`

#### Scenario: No board
- **WHEN** `agentboard serve` runs where discovery finds no board
- **THEN** it exits 2 naming the path it looked at, and no port is bound

#### Scenario: Writable start-up
- **WHEN** `agentboard serve --port 0 --json --as ben` starts
- **THEN** its start-up line has `writable` true and `actor` `ben`

#### Scenario: Opens the browser from an interactive terminal
- **WHEN** `agentboard serve` starts on macOS with stdout a terminal, no `--json`, and `CI` and the SSH variables unset
- **THEN** it prints the start-up line and then asks the system to open `<url>` in the default browser once

#### Scenario: No browser for a script
- **WHEN** `agentboard serve` starts with stdout a pipe, or with `--json`, or with `CI=1`, or with `SSH_CONNECTION` set, and neither `--open` nor `--no-open`
- **THEN** it does not try to open a browser

#### Scenario: No browser without a display on Linux
- **WHEN** `agentboard serve` starts on Linux from a terminal with neither `DISPLAY` nor `WAYLAND_DISPLAY` set
- **THEN** it does not try to open a browser

#### Scenario: Explicit open and no-open
- **WHEN** `agentboard serve --open --json` starts with stdout a pipe, and separately `agentboard serve --no-open` starts from an interactive terminal on macOS
- **THEN** the first asks the system to open `<url>` and the second does not

#### Scenario: Conflicting open flags
- **WHEN** `agentboard serve --open --no-open` runs
- **THEN** it exits 1 with reason `usage` and no port is bound

#### Scenario: Opener failure is a warning
- **WHEN** `agentboard serve` would open the browser and the system opener cannot be started
- **THEN** it prints one warning line on stderr and keeps serving
