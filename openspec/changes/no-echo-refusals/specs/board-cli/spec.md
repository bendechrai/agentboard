## ADDED Requirements

### Requirement: Refusals never repeat the refused input
A refusal SHALL NOT contain any part of the input it refuses, on any
surface: not in the message, not in the hint, not in any field of the
CLI's `--json` error document, the MCP tool error or the web app's action
error, and not in the `agentboard: <message>` line the CLI or the MCP
server writes to stderr. The refused input is the value, flag name,
command word, tool name or tool argument name whose check failed (it is
unknown, malformed, out of range, not one of the choices, or names no
ticket, event, file or tasks file). It SHALL NOT be shortened, masked or
partially shown instead. The refusal SHALL name the argument it refuses
(the flag, as `--task`; the positional, as `<status>`; or, for an unknown
flag or an extra positional, its 1-based position among the arguments
after the program name) and SHALL state the expected form or list the
valid choices, so that a token pasted into the wrong argument never lands
in a terminal, a log or a transcript and the caller can still correct the
call.

Input of the same call that was not refused MAY be repeated (the actor,
a decision path that passed its checks, a ticket id resolved on the
board), and so MAY board data and configuration, each escaped as plain
ASCII on one line like any other text a refusal repeats (so the board
directory named by `AGENTBOARD_DIR` in `board-not-found` cannot carry a
terminal escape sequence). The one exception to the rule is a ticket id
of the id shape (see "Ticket ids in refusals").

Exit codes, reasons and the fields of the error documents are unchanged
by this rule; only message and hint text are.

#### Scenario: Board directory from the environment is escaped
- **WHEN** `AGENTBOARD_DIR` names a missing directory whose name holds an ESC sequence, a BEL and a newline, and `agentboard list` (with and without `--json`) or `agentboard mcp` runs
- **THEN** it exits 2 with reason `board-not-found`, the message names the directory through the plain ASCII escaping (`\u001B`), and no ESC, BEL or newline from the variable is written to stdout or stderr

#### Scenario: Unknown status
- **WHEN** `agentboard move T1 <token> --as orch` runs with a token-shaped value, with and without `--json`
- **THEN** it exits 1 with reason `usage`, the message is `move takes <status> as one of todo, tests, implementing, review, merged, blocked`, no event is written, and the token appears nowhere in stdout or stderr

#### Scenario: Unknown status over MCP
- **WHEN** `board_move` is called with `{"id": "<T1>", "status": "<token>", "as": "orch"}` and `board_handoff` with `status` `<token>`
- **THEN** each returns a tool error with `exitCode` 1 and `reason` `usage` whose message lists the statuses, and the token appears nowhere in the tool result (text or structured content) or in the server's stderr

#### Scenario: Extra and non-integer arguments
- **WHEN** `agentboard comment T1 --as a hello <token>` (unquoted text) and `agentboard checklist tick T1 <token> --as a` run
- **THEN** the first exits 1 with reason `usage` naming position 6, `comment` and its arguments `<id> <text>`, the second exits 1 with reason `usage` saying `index must be an integer`, and the token appears in neither output

#### Scenario: Malformed task reference, change name, group and filter
- **WHEN** `new "x" --task <token> --as a`, `link T1 --change <token>#1 --group 1 --as a`, `link T1 --change c --group <token> --as a` and `list --task <token>` run
- **THEN** each exits 1 with reason `malformed-task-ref`, each message names the flag and its form (`<source>:<ref>#<item>`, non-empty without `#`, a positive decimal number, `<source>:<ref>[#<item>]`), and the token appears in no output

#### Scenario: Health duration
- **WHEN** `agentboard health --stale-after <token>` runs
- **THEN** it exits 1 with reason `usage`, the message names `--stale-after` and the duration form, and the token appears in no output

#### Scenario: Unknown inbox cursor
- **WHEN** `agentboard inbox --as a --since <token>` runs with a token of 64 lowercase hex characters (the only shape that passes the form check) that names no event
- **THEN** it exits 1 with reason `unknown-cursor`, the message names `--since`, and the token appears in no output; a token of any other shape is refused with reason `usage` by the unchanged form message, which names no value either

#### Scenario: Decision path outside the working tree
- **WHEN** `agentboard link T1 --decision ../<token> --as a` runs
- **THEN** it exits 1 with reason `path-outside-tree`, the message names the working tree's root, and the token appears in no output

#### Scenario: Import target
- **WHEN** `agentboard import-change <token>#1 --as orch`, `import-change <token> --as orch` (no such change) and `import-change Bad_Source:<token> --as orch` run
- **THEN** they exit 1 with reasons `malformed-task-ref`, `tasks-not-found` and `malformed-task-ref`, the second message names `openspec/changes/<name>/tasks.md`, and the token appears in no output

#### Scenario: Guidance arguments
- **WHEN** `agentboard help claim <token>`, `agentboard help agents --role <token>` and `agentboard agents install --target <token>` run
- **THEN** each exits 1 with reason `usage`; the role refusal lists the four roles and the target refusal lists the targets; and the token appears in no output

#### Scenario: Unknown tool and unknown tool argument
- **WHEN** an MCP client calls the tool `<token>`, and calls `board_show` with the argument `{"id": "<T1>", "<token>": true}`
- **THEN** both return tool errors with `exitCode` 1 and `reason` `usage`; the second names `board_show` and its arguments; and the token appears in neither result nor in the server's stderr

#### Scenario: Web action
- **WHEN** a writable `agentboard serve --as orch` receives `POST /api/actions/move` with the body `{"id": "<T1>", "status": "<token>"}` from its own page
- **THEN** the response is 400 with reason `usage`, its body lists the statuses, and the token appears nowhere in the body or in the server's output

### Requirement: Ticket ids in refusals
A ticket id argument (the positional `<id>`, or the tool argument `id`)
whose text could be a ULID or a prefix of one, that is, matches
`^0[0-9A-HJKMNP-TV-Z]{0,25}$` with ASCII letters compared without
regard to case (1 to 26 Crockford base32 characters, the first of them 0,
as in every ULID until about the year 3084; no character outside ASCII
counts, whatever it upper-cases to),
MAY be repeated in a refusal and in its hint, even when it matches no
ticket. Any other text given as a ticket
id SHALL NOT be repeated anywhere in a refusal: an unknown id is refused
with its usual exit code and reason (`unknown-ticket`, or `id-too-short`
below 6 characters) by a message that says the text given is not a
ticket id and states the id form, exactly `no ticket matches the id
given, which is not a ticket id: an id is 26 characters of Crockford
base32 (digits and letters other than I, L, O and U) starting with 0, or
a unique prefix of at least 6 of them` for `unknown-ticket`, and every
hint writes the placeholder `<id>` in its place.

#### Scenario: Ticket id that is not an id
- **WHEN** `agentboard show <token>` and `agentboard move <token> review --as orch` run with a token that is not id-shaped, on the CLI with and without `--json`, and `board_move` is called with that `id`
- **THEN** each exits 4 (or returns `exitCode` 4) with reason `unknown-ticket`, the message says the text given is not a ticket id and states the id form, and the token appears in no output

#### Scenario: Hint for an id that is not an id
- **WHEN** `agentboard close <token> --as orch` runs with neither `--decision-recorded-in` nor `--no-decision` and a token that is not id-shaped, and `board_close` is called with that `id` and no decision argument
- **THEN** each is refused with reason `no-disposition`, the hint names the `close` step with `<id>` in place of the id, and the token appears in no output

#### Scenario: Unknown ticket id that is id-shaped
- **WHEN** `agentboard show 01J9K3ZZZZ` runs and no ticket id starts with it
- **THEN** it exits 4 with reason `unknown-ticket` and the message names `01J9K3ZZZZ`

#### Scenario: Base32 secret that is not a ULID
- **WHEN** `agentboard show <text>` runs, with and without `--json`, where `<text>` is `JBSWY3DPEHPK3PXP` (a TOTP-style seed whose characters are all Crockford base32) or 26 Crockford base32 characters starting with a letter, and `board_show` is called with that `id`
- **THEN** each exits 4 (or returns `exitCode` 4) with reason `unknown-ticket`, the message says the text given is not a ticket id, and the text appears in no output

#### Scenario: Crockford text that starts with 1 to 7
- **WHEN** `agentboard show <text>` runs, with and without `--json`, where `<text>` is 26 Crockford base32 characters starting with 7, or `1J9K3ZZZZ`, and `board_show` is called with that `id`
- **THEN** each exits 4 (or returns `exitCode` 4) with reason `unknown-ticket` and the message above, and the text appears in no output

#### Scenario: Characters that upper-case into the id alphabet
- **WHEN** `agentboard show 01<U+017F><U+017F>ABCDEFGH23` runs (U+017F, the long s, upper-cases to `S`), or a text of `0` and twelve U+FB06 ligatures (each upper-cases to `ST`)
- **THEN** the text is not id-shaped, it exits 4 with reason `unknown-ticket` and the message says the text given is not a ticket id

#### Scenario: Actor read from a command line that failed to parse
- **WHEN** `agentboard close --unplanned --as <token>` or `agentboard close --task --as <token>` runs, with and without `--json` and with and without `AGENTBOARD_ACTOR` (the string flag takes `--as` as its value, so the token is the `<id>` positional and no `--as` is parsed)
- **THEN** it exits 1 with reason `no-disposition`, the hint writes `<id>` for the id and, for the actor, the value of `AGENTBOARD_ACTOR` or else `<actor>`, and the token appears in no output; when parsing fails, the actor a hint or message names comes from the parsed values or `AGENTBOARD_ACTOR`, never from a scan of the raw arguments

#### Scenario: Unknown ticket id with a letter outside the id alphabet
- **WHEN** `agentboard show 01NOPE0000` runs (`O` is not a Crockford base32 letter)
- **THEN** it exits 4 with reason `unknown-ticket`, the message says the text given is not a ticket id, and `01NOPE0000` appears in no output

### Requirement: Git lines quoted from remote commands
When agentboard repeats a line of git's output from a failing git
command that talks to a remote (`ls-remote`, `fetch`, `pull`, `push`,
`clone`, the checkout `init --remote` runs after its clone, and the
`remote:` lines a refusing remote prints), in a refusal or a warning of
`sync`, `init` (joining a host-model board), `init --remote` (including
the `sync` it runs) or `init --into-host`, the line SHALL first be
sanitised, in its raw form before it is escaped for output (so a URL
holding a non-ASCII character or a backslash is still recognised),
against every URL configured for the repository the command ran in (the
board repository for a standalone board, the host repository for a
host-model board, the directory `init --remote` runs git in):

- every `remote.<name>.url` and `remote.<name>.pushurl`, as configured
  and as git resolves it after `insteadOf` and `pushInsteadOf` rewrites;
- every `branch.<b>.remote` and `agentboard.remote` value that names no
  configured remote and contains `:` or `/` (a remote named by URL);
- every proxy git may use: `http.proxy`, every `http.<url>.proxy`,
  `https.proxy`, every `remote.<name>.proxy`, and the `http_proxy`,
  `https_proxy`, `all_proxy`, `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`
  environment variables; a proxy value without `://` also as
  `http://<value>`;
- the value given to `--remote`, and the URL git was given for it, where
  there is one.

Each such URL, and the URL without its user information, SHALL be
replaced by `<url>`; its user information, as configured and
percent-decoded, by `<redacted>` wherever it appears; and the user
information of any other URL in the line (`<scheme>://<userinfo>@`) by
`<scheme>://<redacted>@`. For a proxy URL, whose user information git
and curl split differently, the text from `<scheme>://` up to the last
`@` of the authority SHALL also be redacted in each form the client
prints it: when it holds more than one raw `@`, git splits it at the
first, so the text between the first and the last `@` SHALL be
redacted as given, percent-decoded, and percent-encoded as git encodes a
host (every byte other than an ASCII letter, a digit, `-` and `.`
written `%XX` with upper-case hex); and when the user name holds a raw
`#` or `?`, curl on git 2.32 takes the text before it for the proxy host
(`Could not resolve proxy: <text>`), so that text SHALL be redacted too.
The generic `<scheme>://<userinfo>@` redaction SHALL run before these
pieces are redacted, and a piece SHALL NOT be used when it is shorter
than 6 characters, holds no letter or digit, or is a URL scheme name
(`http`, `https`, `ftp`, `ftps`, `git`, `ssh`, `file`, `git+ssh`,
`ssh+git`, `socks4`, `socks4a`, `socks5`, `socks5h`, in any case), so no
piece can remove a `scheme://` marker the generic step needs or mangle an
ordinary word. (The user information as a whole is still redacted at any
length.) The whole message that quotes the line SHALL be
sanitised the same way, so a remote named by URL in `reaching <remote>
failed` is written `<url>`. A git command of these paths that fails
SHALL be reported as a refusal quoting its sanitised line, never as a raw
error carrying git's output: the `fetch` of `refs/agentboard/board` that
the host-model `init` join runs after a successful `ls-remote` exits 3
with reason `sync-failed`, `fetching refs/agentboard/board from <remote>
failed: <line>`. So no credential or token held in a configured or given
URL, a remote named by URL, or a proxy reaches stdout, stderr, the
`--json` document or an MCP result. Exit codes, reasons and the rest of
each message are unchanged. A line the remote's server writes itself
(an error that quotes the request path it received) can repeat a token
from the path in a form no URL rule recognises; that is a known limit.

#### Scenario: Sync with a token as the user name of the configured remote
- **WHEN** a standalone board's `origin` is `http://<token>@<host>/me/x.git`, the server answers 401, and `agentboard sync` runs with and without `--json`
- **THEN** it exits 3 with reason `sync-failed`, the quoted git line reads `could not read Password for 'http://<redacted>@<host>'`, and the token appears nowhere in stdout or stderr

#### Scenario: Sync with user:pass@ and a token in the path of the configured remote
- **WHEN** `origin` is `http://agent:<secret>@<host>/me/<token>.git` and the remote is unreachable or answers 401, and `agentboard sync` runs
- **THEN** it exits 3 with reason `sync-failed`, git's `unable to access` or `Authentication failed for` line quotes `'<url>/'`, and neither the secret nor the token appears in any output

#### Scenario: Sync on a host-model board
- **WHEN** the host repository's `origin` holds a token as its user name or in its path and answers 401, and `agentboard sync` runs on its host-model board
- **THEN** it exits 3 with reason `sync-failed` and the token appears in no output

#### Scenario: The sync that init --remote runs
- **WHEN** `agentboard init --remote http://<token>@<host>/me/x.git` runs on a standalone board without a remote and the server answers 401
- **THEN** it exits 3 with reason `sync-failed` keeping `origin`, the quoted line reads `http://<redacted>@<host>`, and the token appears in no output

#### Scenario: Joining warnings of init and init --into-host
- **WHEN** `agentboard init` (host model) or `agentboard init --into-host` runs in a host whose `origin` holds a token and answers 401
- **THEN** the warning that the remote could not be reached quotes git sanitised, and the token appears in no output

#### Scenario: URL holding a non-ASCII character or a backslash
- **WHEN** the configured `origin`, the host remote, or the value given to `init --remote` is `http://<host>/<token>/caf\u00e9.git` (or holds a backslash) and cannot be reached, on standalone and host-model `sync`, `init --remote`, the `init` join, `init --into-host` and the `remote:` lines of a refused host push
- **THEN** git's line quotes `<url>`, and the token appears in no output, escaped or not

#### Scenario: Remote named by URL
- **WHEN** `branch.main.remote` or `agentboard.remote` is `http://agent:<secret>@<host>/x.git` and `agentboard sync` fails to reach it
- **THEN** it exits 3 with reason `sync-failed`, the message reads `reaching <url> failed: ...` (or `pulling from <url>`, `pushing to <url>`), and the secret appears in no output

#### Scenario: Proxy credentials
- **WHEN** `http_proxy`, `HTTPS_PROXY`, `all_proxy`, `ALL_PROXY`, `http.proxy` or `remote.origin.proxy` is `http://<token>%20x@<proxy>` (or `%2F`, `%27`), the proxy answers 407, and `agentboard sync` or `init --remote` runs, on git 2.32 (which prints the user name decoded) and later
- **THEN** it exits 3, the proxy is quoted as `<url>` or `http://<redacted>@<proxy>`, and the token appears in no output

#### Scenario: Proxy user information split differently
- **WHEN** `http_proxy` is `http://a@<token>%40x@<proxy>` (git 2.53 prints `http://a@<token, encoded>%2540x%40<proxy>`), or `http://<token>#x@<proxy>` or `http://<token>?x@<proxy>` (curl on git 2.32 prints `Could not resolve proxy: <token>`), and `agentboard sync` runs
- **THEN** it exits 3 with reason `sync-failed` and the token appears in no output, in any encoding

#### Scenario: Split pieces neither unmask nor mangle
- **WHEN** a configured URL is `https://a@http@<host>/x.git` (or `https://a@:@...`, or holds one-letter pieces) and a git line quotes another URL with a token as its user name, or names `refs/agentboard/board` or a host
- **THEN** the other URL is written `http://<redacted>@...`, and the board ref and the host are printed unchanged

#### Scenario: Multi-byte character in a proxy's user information
- **WHEN** `http_proxy` is `http://a@<token>\u00e9@<proxy>` and git 2.53 prints the host `<token, encoded>%C3%A9%40<proxy>`
- **THEN** the token appears in no output

#### Scenario: Remote named by a relative path
- **WHEN** `branch.main.remote` is `../<token>/repo.git` and `agentboard sync` cannot reach it
- **THEN** the message reads `reaching <url> failed: ...` (or `pulling from <url>`), and the token appears in no output

#### Scenario: Every later git step
- **WHEN** a remote whose URL holds a credential answers `ls-remote` but fails the later step: the `sync` pull or push, the host-model fetch of the board ref, a push that is not rejected, or a push whose board ref loses the race on the last retry, either fetch of `init --into-host`, the clone or checkout of `init --remote`, or the fetch of the host-model `init` join
- **THEN** each refusal quotes git's line with the URL as `<url>`, and the credential appears in no output

### Requirement: Remote URLs are shown without credentials
Wherever agentboard shows a remote URL taken from the configuration or
given to `--remote` (the success messages of `init --remote`, `init`,
`init --into-host` and `sync`, the `remoteUrl` field of `init --remote
--json`, the text and `--json` output of `agentboard remote`, and the
refusals that name a configured URL, such as `remote-mismatch`), and
wherever it shows a remote's name, which is a URL when `agentboard.remote`
or `branch.<b>.remote` names the remote by URL (`sync`'s `pulled from` and
`pushed to` lines and its `--json` `remote`, on both board models, and
`agentboard remote`'s `remote:` and `problem:` lines and its `--json`
`remote.name`; `init` on an existing board, standalone and host model,
and its `--json` `remote`; `init` creating, joining or repairing a
host-model board (`sync publishes it to`, `joined ... from`); `init
--into-host` on a board already in the host and its `--json` `remote`;
the `remote-mismatch` variant of `init --remote` that names the remote
`agentboard.remote` sets; and the `sync-conflict` refusals naming the
remote a pull or rebase used), and the old remote URL `init --into-host` reports
(`oldRemoteUrl` and its `kept` line, from the configured URL, also when a
move is resumed), it SHALL show the URL with its user information removed
(`<scheme>://<userinfo>@<rest>` written `<scheme>://<rest>`; a URL
without user information, a path and the scp-like `user@host:path` as
they are). The configuration keeps the URL as given: `git remote get-url`
still prints it.

#### Scenario: init --remote with credentials succeeds
- **WHEN** `agentboard init --remote http://agent:<secret>@<host>/x.git` creates, clones, attaches or finds unchanged a board, with and without `--json`
- **THEN** its message names `http://<host>/x.git`, `remoteUrl` is `http://<host>/x.git`, and the secret appears in no output

#### Scenario: agentboard remote
- **WHEN** a board's remotes hold credentials and `agentboard remote` runs, with and without `--json`
- **THEN** every URL it prints is the URL without its user information, and no credential appears

#### Scenario: Remote named by URL on success
- **WHEN** `agentboard.remote` or `branch.main.remote` is `http://agent:<secret>@<host>/r.git`, git can reach it, and `agentboard sync` (standalone or host model) and `agentboard remote` run, with and without `--json`
- **THEN** `sync` prints `pushed main to http://<host>/r.git` and its `--json` `remote` is `http://<host>/r.git`, `agentboard remote` prints `remote: http://<host>/r.git (chosen by ...)` and its `--json` `remote.name` is `http://<host>/r.git`, and the secret appears in no output

#### Scenario: Every place a remote named by URL is shown
- **WHEN** `agentboard.remote` or `branch.main.remote` is `http://agent:<secret>@<host>/r.git` and `agentboard init` runs on an existing standalone or host-model board, creates, joins or repairs a host-model board, `agentboard init --into-host` runs on a board already in the host, `agentboard init --remote <another url>` runs, or a `sync` or `init --into-host` stops on a conflict, with and without `--json`
- **THEN** each message and each `--json` `remote` names `http://<host>/r.git`, and the secret appears in no output

#### Scenario: Old remote URL of a moved or resumed board
- **WHEN** a standalone board whose `origin` is `http://agent:<secret>@<host>/board.git` is moved with `agentboard init --into-host`, or a move interrupted after the worktree was placed is resumed
- **THEN** `oldRemoteUrl` and the `its remote was` line read `http://<host>/board.git`, and the secret appears in no output

#### Scenario: Remote mismatch names the configured URL without its credentials
- **WHEN** a standalone board's `origin` is `http://agent:<secret>@<host>/configured.git` and `agentboard init --remote <another url>` runs
- **THEN** it exits 1 with reason `remote-mismatch` naming `http://<host>/configured.git`, and the secret appears in no output

## MODIFIED Requirements

### Requirement: Close requires a decision disposition
`close` SHALL require exactly one of `--decision-recorded-in <path>` (a path
that exists in the host project, expected to be a spec delta, ADR or tasks
file) or `--no-decision`. A relative decision path SHALL be resolved against
the current directory, SHALL lie inside the current working tree (the output
of `git rev-parse --show-toplevel`, or the current directory outside git),
and SHALL be recorded relative to that root with `/` separators, so the
recorded path means the same thing in every worktree and clone; a path
outside the working tree SHALL exit 1 with reason `path-outside-tree`,
naming the working tree's root but not the path given. A decision path
that does not exist SHALL exit 1 with reason `decision-path-missing`,
naming `--decision-recorded-in` but not the path given (see "Refusals
never repeat the refused input"). `link --decision` SHALL record its
path the same way but SHALL NOT require it to exist. `close` SHALL be permitted only from `merged` or
`blocked`. Closed tickets SHALL be excluded from `list` unless `--closed` is
given.

#### Scenario: Close without disposition is refused
- **WHEN** `agentboard close T1 --as orch` runs with neither flag
- **THEN** the command exits 1 and explains the rule that decisions made in a ticket must be recorded in a spec or ADR

#### Scenario: Close with a missing decision path
- **WHEN** `--decision-recorded-in docs/adr/0099.md` names a file that does not exist
- **THEN** the command exits 1 with reason `decision-path-missing`, naming `--decision-recorded-in`, and `0099` appears nowhere in stdout or stderr

### Requirement: Board in a separate repository
`agentboard init --remote <url>` SHALL set up a standalone board shared
through the repository at `<url>`, need no actor, and leave the host
repository's refs untouched:

- When `.board` does not exist: if `<url>` is a local path (an absolute or
  relative path, or a `file://` URL) that does not exist, it SHALL first
  create a bare repository there. If the repository at `<url>` cannot be
  read, it SHALL exit 3 with reason `remote-unreachable`, quoting git's
  error and telling the user to create an empty repository at `<url>` (for
  example on their git host) and check their access, and SHALL create
  nothing. If the repository has a branch, it SHALL clone it into `.board`
  (its default branch) and fold the events; when that branch has no
  `events/` directory it SHALL exit 1 with reason `not-a-board` and leave
  no `.board` behind. If the repository has no refs, it SHALL create a
  standalone board, add `<url>` as `origin`, and `sync` (which pushes and
  sets the upstream).
- When `.board` is a standalone board with no remote, it SHALL add `<url>`
  as `origin` and `sync`.
- When `.board` is a standalone board whose chosen remote already has the
  URL `<url>`, it SHALL change nothing and exit 0. When the remote has
  another URL, it SHALL exit 1 with reason `remote-mismatch`, naming the
  remote's URL and `git -C .board remote set-url`.
- When `.board` is a host-model board, it SHALL exit 1 with reason
  `board-in-host` and change nothing.
- When `.board` is a standalone board with several remotes and none chosen
  by the rules of board-concurrency "Sync converges", it SHALL exit 1 with
  reason `ambiguous-remote` and change nothing.
- When `.board` exists and is not a board (a directory holding any entry
  but no `events/`, a regular file, or a symbolic link that does not
  resolve to a board directory), it SHALL exit 2 with reason
  `board-not-a-repository` before any write (no bare repository, no
  temporary directory, no host `.gitignore` entry), telling the user to
  move it aside; whatever it holds is left byte for byte. An empty
  directory counts as absent.

`<url>` SHALL be checked before anything runs: an empty value, a value
that starts with `-`, or a `file://` URL whose host part is neither empty
nor `localhost` SHALL exit 1 with reason `usage`, and no git command SHALL
be given the value (in particular the host repository's own remote is
never contacted). Every git command that takes `<url>` SHALL pass it
after `--`. A relative local path SHALL be resolved against the host
repository's top level when the board was found through a git repository
(the same directory from every linked worktree), else against the current
directory, and the `origin` URL stored SHALL be the absolute path;
`file://localhost/x` and `file:///x` both name the path `/x`; a `file://`
URL and a non-local URL SHALL be stored as given. The matching-URL
comparison SHALL use the raw `remote.<name>.url` as well as the URL
`git remote get-url` prints, so a URL rewritten by `url.<base>.insteadOf`
is not reported as `remote-mismatch`; a matching URL SHALL run no `sync`.
The `remote-mismatch` message SHALL name `git -C .board remote set-url`
only when the remote exists; when `agentboard.remote` names a remote the
board repository does not have, it SHALL name `agentboard.remote` instead.

No refusal of `init --remote` (`usage`, `remote-unreachable`,
`not-a-board`, `remote-mismatch`) SHALL repeat the value given to
`--remote` (see "Refusals never repeat the refused input"): it says "the
value", "the repository given with --remote" or "the URL given", and a
suggested command writes `<url>` for it. A remote's URL read from the
board repository's configuration MAY be named, without its user
information (see "Remote URLs are shown without credentials"). Git's error, where it is
quoted, SHALL be quoted with every occurrence of the value given
replaced by `<url>` (the value as given, as the absolute path git was
given for a relative local path, and without its user information, the
form git prints for a URL with credentials), the user information of
the value given (as given and percent-decoded) replaced by `<redacted>`
wherever it appears, and the user information of every URL in it
(`<scheme>://<userinfo>@`) replaced by `<scheme>://<redacted>@`. The
user name of the scp-like form `user@host:path` is not user information.

A board is cloned into a temporary sibling of `.board` named
`.board-clone-<random>`, renamed to `.board` only once its working tree
holds `events/`. A clone that fails after `ls-remote` succeeded (a remote
whose objects are missing) SHALL exit 3 with reason `remote-unreachable`
and leave nothing behind. When the remote's HEAD names a branch the remote
does not have and the remote has exactly one branch, that branch SHALL be
checked out first; when that checkout fails, `init` SHALL exit 1 with
reason `not-a-board` and leave nothing behind. A `.board-clone-*` left by
an interrupted run SHALL be removed by the next `init --remote`, which
names it in its message.

When the `sync` that `init --remote` runs fails, `init` SHALL exit with that
failure's code and reason, keeping the board and the remote it set.

#### Scenario: Init with a remote that has a board
- **WHEN** a standalone board with three events has been pushed to `<url>` and `agentboard init --remote <url>` runs in another clone with no `.board`
- **THEN** `.board` is a clone of `<url>`, `agentboard list` shows the three events' tickets, and `sync` exits 0

#### Scenario: Init with an empty remote
- **WHEN** `agentboard init --remote <url>` runs with no `.board`, and `<url>` is an empty repository
- **THEN** `.board` is a standalone board with `origin` set to `<url>`, and `<url>` has a branch holding `.gitignore` and `events/.gitkeep`

#### Scenario: Init with a local path that does not exist
- **WHEN** `agentboard init --remote ../boards/project.git` runs and `../boards/project.git` does not exist
- **THEN** `../boards/project.git` is created as a bare repository, the board is pushed to it, and the command exits 0

#### Scenario: Init with a non-local URL that does not exist
- **WHEN** `agentboard init --remote https://git.example.com/me/missing.git` runs and the repository cannot be read
- **THEN** the command exits 3 with reason `remote-unreachable`, the message tells the user to create the empty repository, and no `.board` directory or host `.gitignore` entry was created

#### Scenario: Credentials in an unreachable URL
- **WHEN** `agentboard init --remote https://agent:<token>@git.example.com/me/missing.git` runs, with and without `--json`, and the repository cannot be read
- **THEN** it exits 3 with reason `remote-unreachable`, quotes git's error, and neither the token nor the URL given appears in stdout or stderr

#### Scenario: Token given as the user name of an unreachable URL
- **WHEN** `agentboard init --remote http://<token>@<host>/me/x.git` runs, with and without `--json`, and the server answers 401 so git prints `could not read Password for 'http://<token>@<host>'`
- **THEN** it exits 3 with reason `remote-unreachable`, the quoted line reads `http://<redacted>@<host>`, and the token appears nowhere in stdout or stderr

#### Scenario: Init with a remote on an existing board without one
- **WHEN** a standalone board with unsynced events and no remote exists and `agentboard init --remote <empty url>` runs
- **THEN** `origin` is set to the URL, the events are committed and pushed, and the command exits 0

#### Scenario: Init with a remote on a host-model board
- **WHEN** `.board` is a host-model board and `agentboard init --remote <url>` runs
- **THEN** it exits 1 with reason `board-in-host` and nothing changes

#### Scenario: Remote flags are exclusive
- **WHEN** `agentboard init --remote <url> --into-host` runs
- **THEN** it exits 1 with reason `usage` and nothing changes

#### Scenario: Remote URL that is an option
- **WHEN** `agentboard init --remote '--upload-pack=touch PWNED;:x'` runs in a clone whose host repository has an `origin`
- **THEN** it exits 1 with reason `usage`, no git command received the value, `origin` was not contacted, no file was created, nothing changes, and `PWNED` appears nowhere in stdout or stderr

#### Scenario: Remote mismatch does not repeat the URL given
- **WHEN** a standalone board's `origin` is `https://host/d.git` and `agentboard init --remote https://host/<token>.git` runs
- **THEN** it exits 1 with reason `remote-mismatch`, the message names `origin`, `https://host/d.git` and `remote set-url origin <url>`, and the token appears nowhere in stdout or stderr

#### Scenario: Existing directory that is not a board
- **WHEN** `.board` is a directory holding `notes.txt` and no `events/`, and `agentboard init --remote <url>` runs, whether `<url>` holds a board or is empty
- **THEN** it exits 2 with reason `board-not-a-repository` telling the user to move the directory aside, `notes.txt` is unchanged, and no bare repository, temporary directory or host `.gitignore` entry was created

#### Scenario: Init with a remote on a board with several remotes
- **WHEN** `.board` is a standalone board with the remotes `fork` and `upstream`, no `origin`, no upstream and no `agentboard.remote`, and `agentboard init --remote <url>` runs
- **THEN** it exits 1 with reason `ambiguous-remote` naming both remotes and `agentboard init`, and nothing changes

#### Scenario: Matching URL rewritten by insteadOf
- **WHEN** a standalone board's `origin` is `https://host/d.git`, the board repository has `url.<path>.insteadOf=https://host/`, and `agentboard init --remote https://host/d.git` runs
- **THEN** it exits 0 reporting that nothing changed, and runs no `sync`

#### Scenario: Clone fails after ls-remote
- **WHEN** `agentboard init --remote file://<path>` runs against a repository whose tip commit object is missing
- **THEN** it exits 3 with reason `remote-unreachable` quoting git, and no `.board` or temporary directory is left behind

#### Scenario: Leftover clone directory
- **WHEN** `.board-clone-abc123` was left by an interrupted run and `agentboard init --remote <url>` runs
- **THEN** the leftover is removed, the message names it, and the command otherwise completes as it would have
