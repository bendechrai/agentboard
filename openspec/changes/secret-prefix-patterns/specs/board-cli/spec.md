## MODIFIED Requirements

### Requirement: No secrets on the board
The board is not a secret store. `new`, `comment` and `handoff`, and `move`
and `close` when given `--unplanned`, SHALL refuse
text that matches a secret pattern, exiting 1
with the pattern name and not the matched text, unless `--allow-secret-like`
is given. The patterns, in the order their names are reported, SHALL be:

- `pem-private-key`: `-----BEGIN `, any run of upper-case ASCII letters,
  digits and spaces ending in `PRIVATE KEY`, optionally followed by
  ` BLOCK`, then `-----` (PEM private key headers and the PGP private key
  block header).
- `aws-access-key-id`: `AKIA` or `ASIA` followed by exactly 16 characters
  of `[0-9A-Z]`, not preceded or followed by another ASCII letter or
  digit.
- `github-token`: `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` followed by at
  least 36 characters of `[A-Za-z0-9]`, or `github_pat_` followed by at
  least 22 characters of `[A-Za-z0-9_]`.
- `anthropic-api-key`: `sk-ant-` followed by at least 16 characters of
  `[A-Za-z0-9_-]`.
- `digitalocean-token`: `dop_v1_`, `doo_v1_` or `dor_v1_` followed by at
  least 16 characters of `[a-f0-9]`.
- `docker-token`: `dckr_pat_` or `dckr_oat_` followed by at least 16
  characters of `[A-Za-z0-9_-]`.
- `gitlab-token`: `glpat-` followed by at least 16 characters of
  `[A-Za-z0-9_-]`.
- `google-api-key`: `AIza` followed by at least 32 characters of
  `[A-Za-z0-9_-]`.
- `huggingface-token`: `hf_` followed by at least 32 characters of
  `[A-Za-z0-9]`.
- `jwt`: `eyJ` and at least 8 characters of `[A-Za-z0-9_-]`, a `.`,
  `eyJ` and at least 8 characters of `[A-Za-z0-9_-]`, a `.`, then at
  least 16 characters of `[A-Za-z0-9_-]`.
- `npm-token`: `npm_` followed by at least 32 characters of
  `[A-Za-z0-9]`.
- `openai-api-key`: `sk-proj-`, `sk-svcacct-`, `sk-admin-` or `sk-None-`
  followed by at least 16 characters of `[A-Za-z0-9_-]`, or `sk-` followed by at
  least 32 characters of `[A-Za-z0-9]`.
- `pypi-token`: `pypi-AgEIcHlwaS5vcmc` followed by at least 16
  characters of `[A-Za-z0-9_-]`.
- `sendgrid-api-key`: `SG.`, at least 16 characters of `[A-Za-z0-9_-]`,
  a `.`, then at least 16 characters of `[A-Za-z0-9_-]`.
- `shopify-token`: `shpat_`, `shpca_`, `shppa_` or `shpss_` followed by
  at least 16 characters of `[A-Fa-f0-9]`.
- `slack-token`: `xoxa-`, `xoxb-`, `xoxe-`, `xoxp-`, `xoxr-`, `xoxs-` or
  `xapp-`, one or more ASCII digits, a `-`, then at least 16 characters
  of `[A-Za-z0-9-]`.
- `stripe-secret-key`: `sk_live_`, `sk_test_`, `rk_live_` or `rk_test_`
  followed by at least 16 characters of `[A-Za-z0-9]`.
- `stripe-webhook-secret`: `whsec_` followed by at least 16 characters
  of `[A-Za-z0-9]`.
- `generic-secret-assignment`: one of the words `token`, `secret`,
  `password` or `key` (ASCII case-insensitive, possibly the end of a
  longer identifier such as `api_key`), optional spaces, `:` or `=`,
  optional spaces, an optional `"` or `'`, then at least 32 characters of
  `[A-Za-z0-9+/_-]`.

Every pattern from `anthropic-api-key` to `stripe-webhook-secret` SHALL
match only where its first character is not preceded by an ASCII letter
or digit, except `jwt`, which SHALL match only where its first `eyJ` is
not preceded by an ASCII letter, digit, `_` or `-` (a character of its
own alphabet). For both anchors, a preceding letter or digit that ends
a backslash escape (`\n`, `\r`, `\t`, `\b` or `\f`, judged on those
two characters alone) or a percent-encoding (`%` and two hexadecimal
digits) does not prevent a match, so a key right after an escape in
pasted JSON or a URL is matched. Every such pattern SHALL be
case-sensitive. Checking any text SHALL take time linear in its length:
a run of a pattern's prefix and alphabet with no terminator never makes
the check quadratic, and no input, however long, makes the check fail
with an error instead of a result. Each "at least" is a minimum with
no maximum: a longer run, or a run followed by other text, still
matches. A refusal SHALL name every matching pattern once, in the order
above. Stripe publishable keys (`pk_live_`, `pk_test_`) and Twilio
account and API key SIDs are public identifiers and match no pattern.

#### Scenario: PEM header refused
- **WHEN** a comment contains `-----BEGIN PRIVATE KEY-----`
- **THEN** the command exits 1 naming the `pem-private-key` pattern and writes no event

#### Scenario: PGP private key block refused
- **WHEN** a comment contains `-----BEGIN PGP PRIVATE KEY BLOCK-----`
- **THEN** the command exits 1 naming `pem-private-key` and writes no event

#### Scenario: Public key header accepted
- **WHEN** a comment contains `-----BEGIN PUBLIC KEY-----` or `-----BEGIN PGP PUBLIC KEY BLOCK-----`
- **THEN** the comment is written

#### Scenario: Secret-like unplanned reason refused
- **WHEN** `move T1 merged --unplanned "token: <40 base64 characters>"` runs without `--allow-secret-like`
- **THEN** the command exits 1 naming the pattern, not the text, and writes no event

#### Scenario: Bare provider key refused
- **WHEN** a comment consists of, or contains between spaces, each of: `sk-ant-api03-` and 95 characters of `[A-Za-z0-9_-]`; `dop_v1_` and 64 lowercase hex digits; `dckr_pat_` and 27 characters of `[A-Za-z0-9_-]`; `glpat-` and 20 characters of `[A-Za-z0-9_-]`; `AIza` and 35 characters of `[A-Za-z0-9_-]`; `hf_` and 34 letters; a JWT whose three segments are 20, 24 and 43 characters; `npm_` and 36 letters and digits; `sk-proj-` and 156 characters of `[A-Za-z0-9_-]`; `sk-` and 48 letters and digits; `pypi-AgEIcHlwaS5vcmc` and 150 characters of `[A-Za-z0-9_-]`; `SG.`, 22 characters, `.` and 43 characters; `shpat_` and 32 hex digits; `xoxb-`, digits, `-`, digits, `-` and 24 letters and digits; `sk_live_` and 24 letters and digits; `rk_test_` and 99 letters and digits; `whsec_` and 32 letters and digits
- **THEN** each is refused with exit 1 and reason `secret-like`, naming respectively `anthropic-api-key`, `digitalocean-token`, `docker-token`, `gitlab-token`, `google-api-key`, `huggingface-token`, `jwt`, `npm-token`, `openai-api-key`, `openai-api-key`, `pypi-token`, `sendgrid-api-key`, `shopify-token`, `slack-token`, `stripe-secret-key`, `stripe-secret-key` and `stripe-webhook-secret` and no other pattern, no part of the key appears in any output, and no event is written

#### Scenario: Prefixed key after a separator or quote
- **WHEN** a comment contains `TOKEN=`, `"`, `:` or `xoxe.` immediately followed by a key of a new pattern (for example `xoxe.xoxp-1-` and 140 letters and digits, or `"glpat-` and 20 characters)
- **THEN** it is refused naming that pattern

#### Scenario: Short key that fits the actor form
- **WHEN** a comment is exactly `rk_live_` followed by 16 letters and digits
- **THEN** it is refused naming `stripe-secret-key`

#### Scenario: Assigned key names both patterns
- **WHEN** a comment contains `STRIPE_KEY=sk_live_` followed by 24 letters and digits
- **THEN** it is refused naming `stripe-secret-key, generic-secret-assignment`, in that order

#### Scenario: Override writes a prefixed key
- **WHEN** a comment holding `glpat-` and 20 characters runs with `--allow-secret-like`
- **THEN** the comment is written

#### Scenario: Near-misses stay accepted
- **WHEN** comments contain `pk_live_` and 24 letters and digits, `pk_test_` and 24, `sk_live_` and 15, `sk_test_...`, `glpat-` and 15 characters, `whsec_short`, `npm_config_cache_directory_setting`, `npm_package_version`, `hf_hub_download_cache_dir`, `pypi-publish-workflow-step-two`, `xoxo-hugs-and-kisses-everyone`, `sk-learn-and-pandas-in-the-notebook`, `task-runner-for-the-ci-pipeline-and-more`, `SG.example.com`, `eyJ is how base64 JSON starts`, `SK` or `AC` and 32 hex digits, and `AIza` and 31 characters
- **THEN** each comment is written

#### Scenario: Prefix inside a word
- **WHEN** a comment contains a key of a new pattern immediately preceded by an ASCII letter or digit (for example `x` then `sk_live_` and 24 letters and digits, or `2` then `npm_` and 36 letters and digits)
- **THEN** that pattern does not match and the comment is written unless another pattern matches

#### Scenario: JWT inside a base64url run
- **WHEN** a comment contains `_` or `-` immediately followed by a JWT whose three segments are 20, 24 and 43 characters
- **THEN** `jwt` does not match and the comment is written unless another pattern matches; the same JWT after a space, `.`, `=`, `:` or a quote is refused naming `jwt`

#### Scenario: Adversarial input is checked in linear time
- **WHEN** free text of 64 KB consists of a pattern's prefix repeated, or a prefix followed by a long run of its alphabet with no terminator (for example `eyJ_` repeated)
- **THEN** the check finishes well within a second for every pattern

#### Scenario: Key after an escape or a percent-encoding
- **WHEN** a comment contains `\n`, `\t`, `%22`, `%3D` or `%20` immediately followed by a key of a new pattern (for example `line1\n` then `sk_live_` and 24 letters and digits, or `cfg%3D` then `glpat-` and 20 characters)
- **THEN** it is refused naming that pattern; `desk_live_` and 24 letters and digits, and a key after `\q` or `%2G`, still match no pattern

#### Scenario: Very long input is checked without error
- **WHEN** free text or an actor name holds about 6 MiB of a pattern's alphabet straight after its prefix (for example `eyJ` or `SG.` followed by 6 MiB of `A`)
- **THEN** the check returns its result as for any other text: the text is written, or refused with `secret-like` or `invalid-actor` for a pattern or the actor form, and never refused with an internal error

#### Scenario: Anthropic key is not an OpenAI key
- **WHEN** a comment contains `sk-ant-api03-` and 95 characters of `[A-Za-z0-9_-]`
- **THEN** the refusal names `anthropic-api-key` and not `openai-api-key`

#### Scenario: Every surface uses the same patterns
- **WHEN** a key of a new pattern is given as a ticket title to `new`, a task line to `import-change`, a hand-off note, a `release --force --reason`, and a comment through the web app's write action
- **THEN** each is refused with reason `secret-like` naming the pattern (with the bypass hint on the CLI commands that have `--allow-secret-like`, without it for `import-change`, and with 400 on the web), and nothing is written

### Requirement: Actor names are checked
An actor name supplied by the caller SHALL pass the actor check before
anything is written: the actor of a command (from `--as`, from
`AGENTBOARD_ACTOR` when the command falls back to it, from the MCP tool
argument `as`, or from the actor given to `agentboard mcp --as`), and
the new assignee of `handoff` (from `--to` or the tool argument `to`). A
name passes when it matches none of the secret patterns of "No secrets
on the board" and has the actor form: 1 to 32 characters, each an ASCII
letter, digit, `.`, `_`, `-` or `@`, the first a letter or digit
(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$`, tested on ASCII only, without
case folding or normalisation; actors stay case-sensitive).

A name that fails SHALL be refused with exit 1 and reason
`invalid-actor`, before the board is opened, writing nothing.
`--allow-secret-like` SHALL NOT bypass the check. The patterns are
tested first; a name that matches one SHALL be refused with exactly
`refused: the actor name given with <source> matches the secret
pattern(s) <names>; an actor name is recorded on every event and shared
with the board, so choose another name (--allow-secret-like does not
apply to actor names)`, and any other failing name with exactly
`refused: the actor name given with <source> is not of the actor form: 1
to 32 ASCII letters, digits, dots, underscores, hyphens or @ signs, the
first a letter or digit, such as impl-1`. `<names>` is the matching
pattern names in the order and form of "No secrets on the board", and
`<source>` is `--as`, `AGENTBOARD_ACTOR` or `--to` on the CLI and
`the argument as`, `AGENTBOARD_ACTOR` or `the argument to` over MCP.

The check SHALL apply on every command to a given `--as`, including
commands that need no actor, `agentboard mcp` (which then exits 1 and
does not start) and `agentboard serve`; to `AGENTBOARD_ACTOR` only when
it is the actor of a command that needs one (a command that needs no
actor SHALL neither check nor refuse it); and on every MCP tool call to
the call's `as`, to the server's `AGENTBOARD_ACTOR` when the call falls
back to it, and to the `to` of `board_handoff`, refused as a tool error
with `exitCode` 1 and `reason` `invalid-actor`. The reserved actor
`agentboard` passes the check and SHALL still be refused with reason
`usage` as before.

No refusal, message or hint SHALL repeat an actor name that has not
passed the check: an `invalid-actor` refusal names the source and not
the name, and wherever a hint would name an actor that is unchecked or
failed (the refused name, the actor of a call whose parsing failed, an
`AGENTBOARD_ACTOR` a command ignores) it SHALL write the placeholder
`<actor>`. The `invalid-actor` hint SHALL say to choose a name of the
actor form and how to pass it on that surface. Actor names recorded on
the board before this check, and names filtered by `list --assignee`,
are not checked.

#### Scenario: Token as the actor of a write
- **WHEN** `agentboard comment T1 "hi" --as <token>` runs with each token fixture (GitHub-style, AWS-style key id, 40 hexadecimal characters), with and without `--json`, and again with `--allow-secret-like`
- **THEN** each exits 1 with reason `invalid-actor`, the GitHub-style and AWS-style tokens get the pattern message naming `github-token` and `aws-access-key-id`, the hex string gets the form message, no event file is written, and the token appears nowhere in stdout or stderr

#### Scenario: Token in the environment
- **WHEN** `agentboard claim T1` runs with no `--as` and `AGENTBOARD_ACTOR` set to a GitHub-style token
- **THEN** it exits 1 with reason `invalid-actor`, the message says `the actor name given with AGENTBOARD_ACTOR matches the secret pattern(s) github-token`, the hint writes `<actor>`, no event is written, and the token appears nowhere in stdout or stderr

#### Scenario: Read command ignores the environment actor
- **WHEN** `agentboard list` and `agentboard show <unknown-id>` run with no `--as` and `AGENTBOARD_ACTOR` set to a token
- **THEN** `list` exits 0, `show` exits 4 with reason `unknown-ticket`, and neither output nor hint contains the token

#### Scenario: Ignored environment actor that passes the check
- **WHEN** `agentboard top` runs without a terminal, with no `--as` and `AGENTBOARD_ACTOR` set to 32 hexadecimal characters (a name that passes the check)
- **THEN** its hint writes `watch --as <actor>` and does not repeat the value, because `top` does not use the variable as its actor

#### Scenario: Names outside the actor form
- **WHEN** a writing command runs with `--as` set to a 33-character name, `impl 1`, `claude/opus`, `-impl`, `.impl`, `_impl`, a name holding a non-ASCII letter, and a name holding an ESC character
- **THEN** each exits 1 with reason `invalid-actor` and the form message, writes nothing, and the name appears nowhere in stdout or stderr

#### Scenario: Existing actor styles are accepted
- **WHEN** writing commands run with `--as` set to `orch`, `orchestrator`, `impl-1`, `reviewer-3-2`, `test-author-ne2`, `implementer-dm2`, `merger-2`, `ben`, `a`, `0`, `Ben`, `ben.dechrai`, `test_author`, `ben@laptop` and a 32-character name of the form
- **THEN** each is accepted and recorded exactly as given

#### Scenario: Reserved actor keeps its refusal
- **WHEN** `agentboard comment T1 "x" --as agentboard` runs
- **THEN** it exits 1 with reason `usage`, not `invalid-actor`, and writes nothing

#### Scenario: Hand-off to a token
- **WHEN** `agentboard handoff T1 --to <token> --status review --note "n" --as impl-1` runs
- **THEN** it exits 1 with reason `invalid-actor`, the message names `--to`, the ticket is unchanged, and the token appears nowhere in stdout or stderr

#### Scenario: Failed parse names no unchecked actor
- **WHEN** `agentboard close --unplanned --as <token>` and `agentboard close T1 --as <token>` (no disposition) run
- **THEN** each is refused, every hint writes `<actor>` where the actor goes, and the token appears in no output

#### Scenario: MCP server started with a token
- **WHEN** `agentboard mcp --as <token>` is started
- **THEN** it exits 1 with reason `invalid-actor` without serving, and the token appears nowhere in its stdout or stderr

#### Scenario: Token as the actor over MCP
- **WHEN** `board_comment` is called with `as` set to a token, `board_claim` is called with no `as` on a server whose `AGENTBOARD_ACTOR` is a token, and `board_handoff` is called with `to` set to a token and a valid `as`
- **THEN** each returns a tool error with `exitCode` 1 and `reason` `invalid-actor`, naming `the argument as`, `AGENTBOARD_ACTOR` and `the argument to` respectively, no event is written, and the token appears nowhere in the tool result (text or structured content) or in the server's stderr

#### Scenario: Events from before the check
- **WHEN** a board holds events whose actor is a GitHub-style token, written before this check or by an older version, and `agentboard show`, `list`, `inbox --as orch` and `rebuild --check` run
- **THEN** the events are folded as before and every command succeeds

#### Scenario: Short prefixed key as the actor
- **WHEN** `agentboard comment T1 "hi" --as <key>` runs with `<key>` each of `rk_live_` and 24 letters and digits, `sk_test_` and 24 letters and digits, and `glpat-` and 20 characters of `[A-Za-z0-9_-]` (all of the actor form), with and without `--json`, and again with `--allow-secret-like`, and `AGENTBOARD_ACTOR` set to the first of them for `agentboard claim T1`
- **THEN** each exits 1 with reason `invalid-actor` and the pattern message naming `stripe-secret-key`, `stripe-secret-key` and `gitlab-token` respectively (`stripe-secret-key` for the environment), no event file is written, and the key appears nowhere in stdout or stderr
