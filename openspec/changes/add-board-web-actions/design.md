# Design

## Context

`add-board-web` serves a read-only app on `127.0.0.1` behind an access
token (query on the entry URL, then an `HttpOnly`, `SameSite=Strict`
per-port cookie, or a bearer header), a Host check, no CORS and a strict
Content-Security-Policy. Every write in agentboard goes through a board
operation run by `runCommand` in one `BEGIN IMMEDIATE` transaction
(ADR 0002). The MCP server already exposes those operations to a caller
that is not a shell: it converts a JSON argument object into the
registry's parsed values (`toolArguments`) and runs the command's `run`
with a `RunContext`. This change gives the browser the same path.

## Goals / Non-Goals

**Goals:**
- A browser write is indistinguishable from the same CLI command by the
  same actor: same validation, same event, same refusal and hint.
- Another web site, or another tab's script on another origin, cannot make
  the server write.
- The actor is fixed by the person who started the server.

**Non-Goals:**
- Ticket creation and orchestration commands in the browser.
- Multiple actors or accounts.

## Decisions

### Only an explicit `--as` enables writes
Write mode is on exactly when `serve` was given a non-empty `--as`.
`AGENTBOARD_ACTOR` is ignored by `serve`: agents commonly run with it set,
and a human starting a viewer from such a shell must not get a writable
server acting as an agent. This is a deliberate exception to "Actor is
explicit" (which lets writing commands fall back to the variable), and
the `board-cli` delta says so. The start-up line and the page both name
the actor.

Alternatives considered: accept `AGENTBOARD_ACTOR` like every writing
command (rejected for the reason above); a separate `--write` flag with
the actor from the usual sources (two flags to express one decision, and
still the environment surprise).

### The actor never comes from the browser
The action body has no actor property: `as` is refused with `usage`
rather than ignored, so a client that tries to act as someone else learns
it cannot. The run context's actor is the server's `--as`.

### One endpoint per command, MCP-shaped bodies, the MCP conversion
`POST /api/actions/<action>`, where `<action>` is the registry command
name with the space written as `-` (`checklist-tick`). The body is the
same JSON object an MCP client would send to the command's tool (for
example `{"id": "01J9K3", "to": "impl-1", "status": "implementing",
"note": "tests are red"}`), converted by `toolArguments` and run by the
command's own `run` with a `RunContext` whose `board()` returns the
server's open board. So the exclusive flag groups (the link target, the
close disposition), required arguments, types and every operation-level
check are literally the same code as the CLI and MCP. The response is the
command's `--json` document (for a tick, including the `tasks.md`
reminder message). `json` is refused (it is implied) and
`allow-secret-like` is refused (see below).

The server's own board connection runs the write. The feed's change
marker already counts commits on its own connection (`total_changes()`),
so a write made through the server reaches every open stream at the next
tick, like a write from another process.

Alternatives considered: REST resources such as `PATCH
/api/tickets/<id>` with a status field (a second argument vocabulary to
validate and keep in step with the registry); one generic
`POST /api/commands` with the command name in the body (harder to
restrict to the permitted set at the routing layer, and to rate or log per
action).

### Status codes
Exit 1 refusals are 400, exit 4 refusals (board state) 409, `busy` 503
(the page offers to retry), anything else 500. The body is always the
`ErrorDocument` with the CLI hint rendered for the server's actor, so the
page can show `hint: agentboard inbox --as ben`, which is also what the
human would type in a shell. A separate web hint surface was considered
and rejected: the person at the page has a shell, and one hint text per
reason is already maintained for two surfaces.

### Close paths relative to the tree root
`close --decision-recorded-in` and `link --decision` resolve relative
paths against the current directory on the CLI. The browser has no
current directory, so the run context's `cwd` for actions is the root of
the working tree containing the directory `serve` was started in (`git
rev-parse --show-toplevel`, or that directory outside git). A path typed
in the page is therefore relative to the repository root, which is also
how the event records it. The file must exist on the machine running
`serve`, as on the CLI.

### No secret-like override in the browser
`comment` and `handoff` notes go through `refuseSecretLike` unchanged.
The CLI's `--allow-secret-like` is not offered: the browser is the
surface where pasted text is most likely to be a real credential, and a
false positive has an easy path through the CLI.

### CSRF protection in depth
The access token is carried by a cookie, which a browser attaches
automatically, so a write endpoint needs more than the cookie. Every
`POST` must pass all of:

1. The Host check and token check of every request (from
   `add-board-web`). The cookie is `SameSite=Strict`, so a cross-site
   request normally carries no cookie at all.
2. `Content-Type: application/json`. A cross-origin page cannot send it
   without a CORS preflight, and the server never approves one.
3. `Origin` equal to `http://127.0.0.1:<port>` or `http://localhost:<port>`
   and consistent with `Host`. Browsers send `Origin` on every `POST`. A
   request without `Origin` is accepted only when authenticated with
   `Authorization: Bearer` (a script, which is not a browser and cannot
   be forged by one).
4. `X-Agentboard-CSRF` equal to a second random token drawn at start-up
   and returned only by `/api/session` of a writable server. Reading it
   requires the token and same-origin script access; setting a custom
   header cross-origin requires a preflight.
5. A body of at most 64 KiB (413 `body-too-large`).

Any failure is 403 `csrf-failed` with nothing written. Each layer alone
would stop the classic form-post attack; together they also cover a
browser bug in any one of them.

Alternatives considered: the cookie alone (`SameSite=Strict` is strong
but has had browser-specific gaps, and gives nothing against a
same-site-but-different-port page on localhost, since SameSite ignores
ports); a double-submit cookie (weaker than a server-held token, since
cookies are shared across ports on the same host).

### The page
The ticket detail gains the controls when the session is writable. The
move control lists only the targets `isTransitionAllowed` (the fold's own
pure function) permits, but the server remains the authority: the page
never pre-validates beyond choosing what to display. A refusal is shown
beside its control with message and hint, and the form keeps its input.
On success the page applies the returned ticket at once and lets the
stream's append confirm it. No control is rendered for a read-only
session.

## Risks / Trade-offs

- [A write blocks the event loop] -> `runCommand` is synchronous and can
  wait up to the busy timeout (twice) for the write lock, stalling other
  requests and streams of this server for that time; acceptable for a
  single-user local tool, and identical in effect to a CLI command.
- [Someone with the URL can write as the actor] -> the URL (with its
  token) is the credential, as documented; it is printed only to the
  terminal that started the server.
- [A stale page submits an action on an old view] -> the operation
  validates against the state at write time, so the worst case is a
  refusal (for example `invalid-transition`) shown with its hint.
