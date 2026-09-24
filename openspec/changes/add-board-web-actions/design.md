# Design

## Context

`add-board-web` serves a read-only app on `127.0.0.1` behind an access
token (handed to the page in the start-up URL's fragment, kept in
`sessionStorage` and sent only as `Authorization: Bearer`; no cookie), a
Host check, no CORS and a strict Content-Security-Policy. Every write in agentboard goes through a board
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

### CSRF protection: structural, with defence in depth
Cross-site request forgery needs a credential that the browser attaches
by itself. `add-board-web` has none: there is no cookie, and the token is
sent only in the `Authorization` header, which only this origin's script
sets, from its own `sessionStorage`. A page on another origin (another
site, or another port on `127.0.0.1`) cannot read that storage, and
cannot send an `Authorization` header or a JSON body to the server
without a CORS preflight, which the server never approves (no
`Access-Control-Allow-*` header, and `OPTIONS` is refused). A form post or
a `no-cors` fetch carries no token and gets 401. So the token check of
every request is itself the CSRF defence. Every `POST` must pass:

1. The Host check and the bearer token check of every API request (from
   `add-board-web`).
2. `Content-Type: application/json` (with an optional `charset`). Kept:
   the body is JSON anyway, and it keeps a second, independent reason for
   a browser to preflight any cross-origin write, so a browser bug in the
   handling of one of the two headers is not enough.
3. `Origin`, when present, equal to `http://127.0.0.1:<port>` or
   `http://localhost:<port>` and naming the same host as `Host`. Kept:
   browsers send `Origin` on every `POST`, so this costs one comparison
   and refuses any browser request from another origin even if a token
   ever reached a page there. A request without `Origin` is accepted: it
   does not come from a browser, and it already proved the token.
4. A body of at most 64 KiB (413 `body-too-large`). Kept as a resource
   bound, not as a CSRF measure: the largest real action body is a few
   KiB.

A failure of 2 or 3 is 403 `csrf-failed` with nothing written.

Dropped: the per-run CSRF token in an `X-Agentboard-CSRF` header,
returned by `/api/session`. It existed because the access token rode in a
cookie that the browser attached automatically; it required reading
`/api/session` with the token, which is exactly what the bearer header
already requires. With the cookie gone it would be a second copy of the
same secret proving the same thing.

Alternatives considered: keeping the CSRF header anyway (no attacker is
stopped by it that the bearer header does not stop, and it adds a
session field and a second secret to guard); requiring `Origin` on every
`POST` (breaks scripts and `curl`, which prove the token and are not
browsers); dropping the content type and `Origin` checks as redundant
(they are cheap, and they do not depend on the token handling of the
client being right).

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
  token in the fragment) is the credential, as documented; it is printed
  only to the terminal that started the server, and a browser never sends
  the fragment to any server.
- [A stale page submits an action on an old view] -> the operation
  validates against the state at write time, so the worst case is a
  refusal (for example `invalid-transition`) shown with its hint.
