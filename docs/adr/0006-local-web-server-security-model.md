# 6. Local web server security model

Date: 2026-09-24

## Status

Accepted

## Context

`agentboard serve` (change `add-board-web`) serves a live, read-only view
of the board to a browser. It runs on a developer machine where the same
browser has arbitrary web sites open, and where other local processes,
possibly of other OS users, can connect to any loopback port. Board data
is not secret in the way a credential is, but it includes ticket threads,
decisions and file paths that a web page must not be able to read, and
change `add-board-web-actions` will later add writes behind the same
server, so the access model has to hold for writes too.

The threats considered:

- a web page in the same browser making requests to `127.0.0.1:<port>`
  (cross-site requests, CORS reads, embedding the page in a frame);
- DNS rebinding: an attacker's domain re-pointed at `127.0.0.1`, so the
  browser treats the local server as same-origin with the attacker's page;
- another local process or OS user connecting to the port directly;
- another local web server (another project's dev server, another user's
  process) that the browser also talks to on `127.0.0.1`;
- leaks of the credential through history, logs, `Referer` or cookies.

The first design set an `HttpOnly`, `SameSite=Strict` cookie
`agentboard-<port>` from a `/?token=` entry URL answered with a 303. The
security review of group 3 rejected it: browsers do not isolate cookies
by port (RFC 6265 section 8.5), and SameSite treats every port of
`127.0.0.1` as the same site. The cookie was therefore sent to every
server listening on `127.0.0.1`, whatever its port and owner, as soon as
anything led the browser there (the review reproduced this in Chromium with
a plain navigation followed by a same-origin `fetch`). It also landed in
other dev servers' logs, could be overwritten or shadowed from another port
(cookie tossing), and the `/?token=` URL stayed in history as a redirect
source.

## Decision

- **Loopback only.** The server binds `127.0.0.1` and nothing else. The
  port is chosen by the OS unless `--port` is given.
- **A per-run token, sent only as a bearer header.** Each start draws 32
  random bytes (43 characters of base64url). Every `/api/*` request, the
  SSE stream included, must carry exactly one `Authorization: Bearer
  <token>` header; more than one `Authorization` header is 401 even when
  the first is valid, because `node:http` keeps only the first in
  `req.headers` and a proxy or client could disagree about which counts
  (the check reads `req.headersDistinct.authorization`). A `token` query
  parameter and every cookie are ignored, and the server never sends
  `Set-Cookie`. Comparison is constant time. The token is never logged,
  written to disk or returned in a response.
- **The token is handed over in the URL fragment.** The start-up URL is
  `http://127.0.0.1:<port>/#token=<token>`. A browser never sends the
  fragment to a server or in a `Referer`. The page moves it into
  `sessionStorage` (`agentboard-token`, per tab and per origin, and the
  origin includes the port), removes it from the address bar with
  `history.replaceState`, and sends it as the bearer header on every
  request. The stream is read with `fetch` and a small SSE parser, because
  `EventSource` cannot set headers. The page and its static assets need no
  token: they are the same bytes for every board and hold no board data.
- **Host check first.** Every request, on every path, must carry exactly
  one `Host` header whose value is exactly `127.0.0.1:<port>` or
  `localhost:<port>`, else 403 `forbidden-host`. This defeats DNS
  rebinding, whose requests name the attacker's host. Repeated `Host`
  headers are refused for the same reason as repeated `Authorization`
  headers.
- **No CORS.** No response carries any `Access-Control-Allow-*` header,
  and only `GET` is answered (405 otherwise, with `Allow: GET`), so a
  preflight never succeeds. On API paths the token is checked before the
  method, so an unauthenticated preflight is 401.
- **Headers on every response**, errors and the 400 for a malformed request
  included: a strict `Content-Security-Policy` (`default-src 'none'`, only
  the server's own script, style and connections, `frame-ancestors
  'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy:
  same-origin` (the tab that opened the start-up URL keeps a window
  handle, but it is severed: it reports `closed` and cannot navigate or
  script the page) and `Cross-Origin-Resource-Policy: same-origin` (no
  other origin can embed a response), plus `Cache-Control: no-store` on
  API and stream responses.
- Order of checks: Host, then (on `/api/*` only) the token, then the
  method, then the route. All of it is in one audited module,
  `src/web/security.ts`, as pure functions of the request line and
  headers.

## Rationale

Loopback keeps other machines out; the token keeps out everything on this
machine that has not seen the start-up URL, which is what an attacker's web
page or another user's process lacks. A header the page sets itself goes
only where the page sends it, unlike a cookie, which the browser attaches
to every port of `127.0.0.1`. The fragment is the one part of a URL that
reaches the page without reaching any server or log. The Host check closes
the rebinding path that the same-origin policy alone does not, and the
absence of CORS plus the CSP and frame headers keep other origins from
reading, framing or scripting the page.

## Consequences

- A new tab has no token (`sessionStorage` is per tab) and shows a message
  pointing to the URL printed by `agentboard serve`; a reload keeps
  working. This is the accepted price of not using cookies.
- A server restart invalidates every open tab, which then shows the same
  message.
- The token is readable by script of the page's origin. The CSP admits
  only the server's own script and board text is never rendered as markup,
  so there is no injection point.
- Residual risks, stated in the README:
  - Other users: `--open` passes the URL, token included, on a command
    line. On macOS, and on Linux unless `/proc` uses `hidepid`, every
    local user can read command lines with `ps`. On macOS `open` hands the
    URL over by Apple Event, so only the short-lived `open` process shows
    it; on Linux `xdg-open` starts the browser with the URL as an
    argument, where it can stay for the browser's lifetime if `--open`
    started it. With `--open` on a shared machine the token therefore does
    not keep other users out; the README advises copying the printed URL
    by hand there. ADR 0010 makes opening the browser, and with it this
    exposure, the default from an interactive terminal, which `--no-open`
    avoids.
  - The user's own account: anyone who can read the terminal sees the
    token, and a browser may keep the first URL, fragment included, in its
    history database.
  - Up to 64 authenticated streams that never read can each hold about a
    board's worth of memory until they disconnect.
- The write actions of `add-board-web-actions` build on this model without
  a separate CSRF token: the bearer header, which a page on another origin
  cannot send, is itself the CSRF defence, backed by a JSON content-type
  check, a same-origin `Origin` check when the header is present and a
  body size limit (see that change's design.md).

## Alternatives considered

**No token, Host check only.** Rejected: any local process can connect
with a correct Host header.

**A per-port cookie** (the first design). Rejected after the security
review, for the reasons in Context.

**The token in a query parameter on every request.** Rejected: it lands in
history, server logs and `Referer`.

**The fragment exchanged by script for a cookie.** Rejected: the cookie
problem again.

**HTTP basic auth.** Rejected: browsers cache it, prompt for it and send it
to the whole host.

**Requiring the token for the page too.** Rejected: loading the page would
need the token in the query or a cookie again, to protect files that hold
no board data.

**Binding `::1` as well.** Rejected: one address keeps the Host check and
the printed URL simple.
