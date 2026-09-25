# Design

## Deciding whether to open

`serve` resolves one of three open modes from its flags:

- `--open`: `always`. The browser is opened whatever the environment, as
  today; a user who asks explicitly gets an attempt.
- `--no-open`: `never`.
- neither: `auto`, which opens only when every condition below holds.
- both: exit 1 with reason `usage`, before the board is looked up and
  before listening.

The `auto` conditions, checked by a pure function of the platform, the
environment variables, whether stdout is a terminal and whether `--json`
was given (so it is tested without spawning anything):

1. stdout is a terminal (`process.stdout.isTTY`). A pipe or a file means
   a script or a supervisor is reading the output.
2. `--json` was not given. `--json` is how scripts ask for the start-up
   line.
3. `CI` is unset or empty. CI runners commonly have a terminal-like
   stdout and sometimes a display, and never want a browser.
4. None of `SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` is set and not
   empty. Over SSH the server listens on the remote machine's loopback, so
   a browser on either machine could not usefully open the URL without a
   tunnel the user sets up; opening one on the remote display would be
   surprising.
5. On platforms other than `darwin` and `win32`, `DISPLAY` or
   `WAYLAND_DISPLAY` is set and not empty. Without either there is no
   graphical session for `xdg-open` to use; it would at best start a
   terminal browser inside the terminal `serve` is using.

No check tries to find out whether an opener binary exists: the existing
`openInBrowser` already reports a missing or failing opener, and that
stays a warning on stderr.

## Order and output

Unchanged from today: the start-up line is printed first, then the opener
runs (only in `always`, or `auto` when the conditions hold). A failure is
one warning line on stderr; `serve` keeps serving. Nothing extra is printed
on success, so the stdout contract of `--json` and of the plain start-up
line does not change.

## Security

ADR 0006 lists, as a residual risk, that `--open` passes the URL, token
included, on a command line that other local users can read with `ps`:
briefly on macOS (`open` hands the URL over by Apple Event), and on Linux
possibly for the browser's lifetime when `xdg-open` starts it. Opening by
default makes this the default exposure. The decision is recorded in a new
ADR (0010), which keeps the reasoning of 0006 and states why the default
is acceptable: agentboard targets single-user developer machines, the
server listens on loopback only, and the conditions above already skip the
cases most likely to be shared (SSH sessions, CI). The README's security
model advises `--no-open` on a shared machine, where copying the printed
URL by hand keeps the token off every command line.

## Alternatives considered

- Keep opt-in `--open`. Rejected: it makes the common interactive case
  need a flag.
- Open by default everywhere and rely on the opener failing. Rejected: in
  CI or over SSH the opener can succeed in unhelpful ways (a terminal
  browser, a browser on the remote display), and it would be a new default
  exposure in the places most likely to be shared.
- A config setting instead of a flag. Rejected for now: `--no-open` is
  enough, and the board has no user-level configuration.
