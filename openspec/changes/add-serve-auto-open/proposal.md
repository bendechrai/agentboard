# Proposal

## Why

`agentboard serve` prints a URL that almost every interactive user opens
straight away, and the URL carries a long token that is awkward to copy.
Opening the browser is opt-in today (`--open`), so the common case needs a
flag while the uncommon case (a script, CI, an SSH session, a machine with
no display) needs none. The default should follow the common case, as long
as `serve` can tell when opening a browser makes sense.

## What Changes

- `serve` opens the start-up URL in the default browser by default when
  the environment looks interactive and able to show one:
  - stdout is a terminal;
  - `--json` is not given;
  - the `CI` environment variable is unset or empty;
  - it is not an SSH session (`SSH_CONNECTION`, `SSH_CLIENT` and
    `SSH_TTY` are all unset or empty);
  - on platforms other than macOS and Windows, `DISPLAY` or
    `WAYLAND_DISPLAY` is set and not empty.
  Otherwise it does not try to open a browser.
- `--open` still forces an attempt, whatever the environment (as today).
- New `--no-open` never opens a browser. `--open` together with
  `--no-open` exits 1 with reason `usage`.
- As today, the start-up line is printed first, and failing to open the
  browser is a warning on stderr, not an error.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-web`: "Serve command" (when the browser is opened, `--no-open`).
- `board-cli`: "Command surface" (the `serve` synopsis becomes
  `[--open | --no-open]`; the "Serve has help" scenario names `--no-open`).

## Impact

- `src/web/serve.ts` (the decision whether to open), `src/cli/registry.ts`
  (the `no-open` flag, the description, an example), the help drift guard
  and the serve tests.
- Security: ADR 0006 records that opening the browser puts the URL, token
  included, on a command line that other local users can read (briefly on
  macOS, possibly for the browser's lifetime on Linux). Making it the
  default makes that the default exposure on a shared machine; a new ADR
  records the decision, and the README advises `--no-open` there.
- Tests and scripts that spawn `serve` are unaffected: their stdout is a
  pipe, not a terminal, and most pass `--json`.
