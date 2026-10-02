# 10. Open the browser by default

Date: 2026-09-25

## Status

Accepted

## Context

`agentboard serve` prints a start-up URL, `http://127.0.0.1:<port>/#token=<token>`,
that almost every interactive user opens straight away, and the token in it
is 43 characters long and awkward to copy. Until change
`add-serve-auto-open`, opening the browser was opt-in (`--open`), so the
common case needed a flag while the uncommon cases (a script, CI, an SSH
session, a machine with no display) needed none.

ADR 0006 lists, as a residual risk, that opening the browser passes the
URL, token included, on a command line that other local users can read with
`ps` (on macOS, and on Linux unless `/proc` uses `hidepid`): briefly on
macOS, where `open` hands the URL over by Apple Event and only the
short-lived `open` process shows it, and on Linux possibly for the
browser's lifetime when `xdg-open` starts it. On a shared machine the token
then does not keep other users out. With opt-in `--open` that exposure was
something a user chose; opening by default makes it the default.

## Decision

- **Three open modes.** `serve --open` always asks the system to open the
  URL, whatever the environment (as before). `serve --no-open` never does.
  With neither, `serve` opens the browser only when all of these hold:
  1. stdout is a terminal (a pipe or a file means a script or a supervisor
     is reading the output);
  2. `--json` is not given (it is how scripts ask for the start-up line);
  3. `CI` is unset or empty (runners often have a terminal-like stdout and
     sometimes a display, and never want a browser);
  4. none of `SSH_CONNECTION`, `SSH_CLIENT` and `SSH_TTY` is set to a
     non-empty value (over SSH the server listens on the remote machine's
     loopback, which no browser can usefully open without a tunnel, and a
     browser on the remote display would be surprising);
  5. on platforms other than macOS and Windows, `DISPLAY` or
     `WAYLAND_DISPLAY` is set to a non-empty value (without either there
     is no graphical session for `xdg-open`, which would at best start a
     terminal browser inside the terminal `serve` is using).
- **`--open` with `--no-open` is a usage error**, exit 1 with reason
  `usage`, before the board is looked up and before listening.
- **The decision is a pure function** of the platform, the environment
  variables, whether stdout is a terminal and whether `--json` was given,
  so every condition is tested without spawning anything. Nothing checks
  whether an opener binary exists: a missing or failing opener is already
  one warning line on stderr, and `serve` keeps serving.
- **Output is unchanged.** The start-up line (or the `--json` line) is
  printed first and the opener runs after it; nothing is printed on
  success, so the stdout contract does not change.
- **The ADR 0006 reasoning stands.** The token on a command line is still
  readable by other local users while the opener (and, on Linux, possibly
  the browser it starts) runs. What changes is only that it is now the
  default exposure from an interactive terminal. The README's security
  model says so and advises `--no-open` on a shared machine, where copying
  the printed URL by hand keeps the token off every command line.

## Rationale

The default should follow the common case, provided `serve` can tell when a
browser makes sense. The conditions separate the interactive local session,
where a browser is wanted, from scripts, supervisors, CI and SSH, where it
is not or cannot work.

The wider default exposure is acceptable because:

- agentboard targets single-user developer machines, where no other user
  is there to run `ps`;
- the server listens on loopback only, so even a token read from `ps` is
  usable only from the same machine, and it dies when the server stops;
- the conditions already skip the cases most likely to be shared: an SSH
  session (a shared build or development host) and CI;
- the remaining case, a shared local desktop, is one the user knows about,
  and `--no-open` is one flag away and documented where the risk is.

## Consequences

- Typing `agentboard serve` in a terminal opens the board in the browser;
  scripts, tests and supervisors that read its stdout through a pipe, or
  pass `--json`, see no change.
- On a shared machine a user who does not know to pass `--no-open` exposes
  the token to other local users as `--open` did (briefly on macOS,
  possibly for the browser's lifetime on Linux). With a writable server
  (ADR 0009) that is write access as the server's actor.
- `serve` cannot detect a shared local desktop, a remote desktop session or
  a container with a forwarded display; in those `--no-open` is the
  user's decision.
- The `serve` synopsis becomes
  `serve [--port <port>] [--open | --no-open] [--as <actor>]`.

## Alternatives considered

**Keep opt-in `--open`.** Rejected: the common interactive case would keep
needing a flag.

**Open by default everywhere and rely on the opener failing.** Rejected:
in CI or over SSH the opener can succeed in unhelpful ways (a terminal
browser, a browser on the remote display), and it would put the token on a
command line by default exactly where a machine is most likely shared.

**A configuration setting instead of a flag.** Rejected for now:
`--no-open` is enough, and the board has no user-level configuration.
