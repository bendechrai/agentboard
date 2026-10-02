# 9. Write actions in the web app

Date: 2026-09-25

## Status

Accepted

## Context

Change `add-board-web-actions` lets a human act on the board from the page
of `agentboard serve`: comment, move, claim, release, hand off, tick and
untick checklist lines, link and close. ADR 0006 set the security model of
the read-only server (loopback, a per-run token handed over in the URL
fragment and sent only as an `Authorization: Bearer` header, no cookie, a
Host check, no CORS, strict response headers) and said that writes would
build on it without a separate CSRF token. This ADR records the decisions
that writes add.

Every write in agentboard is a board operation run by `runCommand` in one
`BEGIN IMMEDIATE` transaction (ADR 0002), reached through the command
registry by the CLI and, with `toolArguments` converting a JSON argument
object, by the MCP server. The new threats are:

- another web site, or a page on another port of `127.0.0.1`, making the
  server write (cross-site request forgery);
- a request writing as an actor other than the one the person who started
  the server chose;
- a server becoming writable without the person meaning it, for example
  started from a shell where an agent's `AGENTBOARD_ACTOR` is set;
- a browser write that behaves differently from the same CLI command, so
  the board's rules are enforced twice, and could drift;
- a credential pasted into a comment box.

## Decision

- **Write mode only from an explicit `--as`.** `serve` accepts write
  actions exactly when it was started with a non-empty `--as <actor>` on
  its command line; an empty value is `usage`. `serve` ignores
  `AGENTBOARD_ACTOR`, a deliberate exception to the rule that writing
  commands fall back to it (board-cli "Actor is explicit"). The start-up
  line (`serving <board dir> as <actor> at <url>`), the `--json` fields
  `writable` and `actor`, `/api/session` and the page's `acting as
  <actor>` banner all name the actor. Without `--as` every action is 405
  `read-only`.
- **The actor is fixed.** The run context's actor is the server's `--as`.
  An action body has no actor property: `as` is refused with 400 `usage`
  whatever its value (rather than ignored), so a client that tries to act
  as someone else learns it cannot. One actor per server.
- **Actions reuse the registry command path.** `POST
  /api/actions/<action>` for the nine actions, where `<action>` is the
  registry command name with the space written as `-`. The body is the
  JSON object the command's MCP tool takes, converted and validated by
  `toolArguments`, and run by the command's own `run` with a `RunContext`
  built by the same `runContext` as the CLI and MCP, whose board is the
  server's open board. Validation, refusals, hints and the event written
  are therefore the CLI's by construction; the page never pre-validates
  beyond choosing what to offer. Success is 200 with the command's
  `--json` document. Refusals are an `ErrorDocument` with the CLI hint
  rendered for the server's actor, with status 400 for exit 1, 409 for
  exit 4 (`unknown-ticket` included), 503 for `busy` and 500 otherwise.
- **A refusal writes nothing.** Every refusal, whether from the server's
  own checks (Host, token, method, CSRF, body size, read-only, action
  name) or from the command (conversion, operation), is answered before
  or instead of the transaction's commit, and no event file is created.
- **Close and link paths relative to the tree root.** The run context's
  `cwd` is the root of the working tree containing the directory `serve`
  was started in (`git rev-parse --show-toplevel`, else that directory),
  so a path typed in the page is relative to the repository root, which
  is also how the event records it.
- **No secret-like override.** Comments and hand-off notes go through
  `refuseSecretLike` unchanged, and `allow-secret-like` (like `json`) is
  refused with 400 `usage`. A false positive is written with the CLI.
- **CSRF protection is structural, with no CSRF token.** The token is
  accepted only in the `Authorization` header, which a page on another
  origin can neither read from this origin's `sessionStorage` nor send
  without a CORS preflight the server never approves; a form post or a
  `no-cors` fetch carries no token and is 401, a cookie holding the token
  included. The bearer check is therefore itself the CSRF defence. No
  CSRF token is drawn, returned by `/api/session` or required as a header.
  As defence in depth, every `POST`, after the Host and token checks and
  before the read-only check and the action name are looked at, must
  pass:
  1. exactly one `Content-Type` header, `application/json`, with no
     parameter or only `charset=utf-8` (case-insensitive, optionally
     quoted); anything else is 403 `csrf-failed`;
  2. when `Origin` is present, exactly one, equal to
     `http://127.0.0.1:<port>` or `http://localhost:<port>` and naming the
     same host as `Host`; anything else, `null` included, is 403
     `csrf-failed`. A request without `Origin` is accepted;
  3. a body of at most 64 KiB, else 413 `body-too-large`; a larger
     declared length is refused before reading, and a body is read only
     up to the limit.
- **UTF-8 only.** The server always decodes an action body as UTF-8, so
  the content type check refuses every other charset (`utf-16`,
  `iso-8859-1`, even the misspelling `utf8`): a body encoded otherwise
  would be read as something other than what was sent.
- **The URL is a write credential.** Anyone with the start-up URL (or its
  token) can write as the server's actor until the server stops. This is
  stated in the README and accepted: the URL is printed only to the
  terminal that started the server, a browser never sends the fragment to
  any server, and the token dies with the server.

## Rationale

A CSRF token exists to prove that a request comes from a page that could
read something the attacker cannot, when the browser attaches the real
credential by itself. Here the real credential is never attached by the
browser: the page must read it from its own origin's storage and set the
header itself, which is exactly the proof a CSRF token would add. A second
secret proving the same thing would only add a session field to guard.
The content type and `Origin` checks cost one comparison each and do not
depend on the client handling the token correctly, so a browser bug in one
header, or a token that somehow reached another origin, is not enough to
write. `Origin` is not required because scripts and `curl` do not send it
and have already proved the token.

Running the command itself, rather than a web-specific handler, is what
makes "the same rules as the CLI" true without a second implementation to
keep in step; one hint text per reason already serves two surfaces, and
the person at the page has a shell, so the CLI hint is the useful one.

Taking the actor only from `serve --as` keeps writes a decision made by
the person starting the server, visible in the command they typed, and
never inherited from an environment set up for an agent.

## Consequences

- A browser write is indistinguishable from the same CLI command by the
  same actor, event for event; the server's tests compare them byte for
  byte.
- A write runs synchronously on the server's own connection and can wait
  up to the busy timeout twice for the write lock, during which this
  server answers nothing else. Acceptable for a single-user local tool;
  the page offers a Retry on `busy`.
- A stale page can submit an action on an old view; the operation checks
  the state at write time, so the worst case is a refusal shown with its
  hint.
- The residual risks of ADR 0006 (`--open` on a shared machine, the
  terminal scrollback, browser history) now expose write access as well
  as read access for as long as a writable server runs. The README advises
  starting a writable server only while it is used.
- New reasons with hints: `read-only`, `csrf-failed`, `body-too-large`.
  No new event kind and no schema change.

## Alternatives considered

**Accept `AGENTBOARD_ACTOR` like every writing command.** Rejected: agents
commonly run with it set, and a human starting a viewer from such a shell
must not get a server writing as an agent.

**A separate `--write` flag, with the actor from the usual sources.**
Rejected: two flags to express one decision, and still the environment
surprise.

**Choosing the actor per request, or several actors per server.**
Rejected: the browser would then decide who acts, which is what the fixed
actor prevents.

**A per-run CSRF token in an `X-Agentboard-CSRF` header, returned by
`/api/session`.** The first design, when the access token rode in a
cookie. Rejected once the cookie was gone: reading `/api/session` needs the
bearer header already, so the token stops no attacker the bearer check
does not.

**Requiring `Origin` on every `POST`.** Rejected: it breaks scripts and
`curl`, which prove the token and are not browsers.

**Dropping the content type and `Origin` checks as redundant.** Rejected:
they are cheap and independent of the client's token handling.

**REST resources (`PATCH /api/tickets/<id>`) or one generic `POST
/api/commands`.** Rejected: a second argument vocabulary to validate and
keep in step with the registry, or a permitted set that is harder to
restrict at the routing layer.

**An override for secret-like text in the browser.** Rejected: the
browser is where pasted text is most likely to be a real credential, and
the CLI already handles a false positive.
