# Proposal

## Why

The board refuses free text, and (since `actor-secret-check`) actor
names, that match one of four secret patterns (`src/board/secrets.ts`:
`pem-private-key`, `aws-access-key-id`, `github-token`,
`generic-secret-assignment`). Only two of them recognise a provider's
key on its own; the generic pattern needs a keyword and a separator in
front (`token: ...`, `API_KEY=...`). A bare key pasted into a comment, a
hand-off note or a ticket description is therefore accepted for almost
every provider but AWS and GitHub, and once written it is synced to
every clone and kept forever.

The reviewer of `actor-secret-check` group 1 found the sharpest case: a
Stripe restricted key (`rk_live_` or `rk_test_` and 24 characters) has
the actor form, matches no pattern, and is accepted as an actor name,
so it would be recorded on every event its caller writes. A legacy
Stripe secret key (`sk_live_` and 24 characters, 32 in all) and a GitLab
personal access token (`glpat-` and 20 characters) fit the actor form
the same way. Ticket 01M69B8W53DGS7CF8XY4H951TC asks for an audit of
common provider prefixes and patterns for the missing ones.

The audit (design.md, "Audit") ran 50 synthetic key shapes through the
current matcher. 38 of them match nothing on their own: every key of a
provider other than AWS and GitHub, and the PGP private key header
(the PEM pattern requires `PRIVATE KEY-----`, and PGP armour writes
`PRIVATE KEY BLOCK-----`). Six are missed even after `API_KEY=`: a
short Stripe restricted key, a GitLab token, a SendGrid key, a JWT, a
Slack rotating token and the PGP header, because each is either shorter
than 32 characters or broken up by `.`.

## What Changes

- Fifteen named patterns are added to the shared secret patterns, each a
  provider prefix followed by a minimum run of the key's alphabet:
  `anthropic-api-key` (`sk-ant-`), `digitalocean-token` (`dop_v1_`,
  `doo_v1_`, `dor_v1_`), `docker-token` (`dckr_pat_`, `dckr_oat_`),
  `gitlab-token` (`glpat-`), `google-api-key` (`AIza`),
  `huggingface-token` (`hf_`), `jwt` (three dot-separated base64url
  segments, the first two starting `eyJ`), `npm-token` (`npm_`),
  `openai-api-key` (`sk-proj-`, `sk-svcacct-`, `sk-admin-`, and `sk-`
  with 32 or more letters and digits), `pypi-token` (a PyPI macaroon,
  `pypi-AgEIcHlwaS5vcmc`), `sendgrid-api-key` (`SG.` and two
  segments), `shopify-token` (`shpat_`, `shpca_`, `shppa_`, `shpss_`),
  `slack-token` (`xoxa-`, `xoxb-`, `xoxe-`, `xoxp-`, `xoxr-`, `xoxs-`,
  `xapp-`, each followed by digits and a hyphen),
  `stripe-secret-key` (`sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`)
  and `stripe-webhook-secret` (`whsec_`).
- A prefix of four characters or fewer (`AIza`, `hf_`, `npm_`, bare
  `sk-`) needs at least 32 characters after it; a longer, punctuated
  prefix needs at least 16. Every new pattern matches only where its
  prefix is not preceded by an ASCII letter or digit, so `task-...`
  or `desk_live_...` never match.
- `pem-private-key` also matches `PRIVATE KEY BLOCK-----`, the PGP
  armour header.
- The names are reported in a fixed order: the three existing provider
  patterns, then the new ones in alphabetical order, then
  `generic-secret-assignment` last. The refusal messages and reasons are
  unchanged; only the set of names they can list grows.
- Not added: Stripe publishable keys (`pk_live_`, `pk_test_`), which are
  public by design and embedded in web pages; Twilio account and API key
  SIDs (`AC`, `SK` and 32 hex digits), which are identifiers, not
  secrets; unprefixed secrets (an AWS secret access key, a Twilio auth
  token), which no prefix pattern can tell from a hash.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `board-cli`: MODIFIED "No secrets on the board" (the patterns listed
  by name, with their prefixes, minimum lengths, anchoring and report
  order; scenarios for each new pattern and for near-misses that stay
  accepted); MODIFIED "Actor names are checked" (one added scenario: a
  short prefixed key given as the actor is refused).

`board-web-actions` "Secret-like text is refused", the hook actor
resolution of the open change `add-harness-integration`, and the agent
guide refer to "the same secret patterns" without listing them, so they
change in behaviour but not in wording.

## Impact

Newly refused, wherever the shared patterns are checked:

- Free text, with `--allow-secret-like` as the override: `new` (title,
  description, labels, checklist lines, ad hoc reason), `comment`,
  `handoff --note`, `move` and `close` with `--unplanned`, and
  `release --force --reason`, on the CLI and over MCP.
- Free text with no override: `import-change` (unit titles and task
  lines of `tasks.md`), and the web app's comment, hand-off note and
  unplanned reason (400 `secret-like`).
- Actor names, with no override: `--as`, `AGENTBOARD_ACTOR`, `--to`,
  the MCP arguments `as` and `to`, `agentboard mcp --as` and
  `agentboard serve --as` (exit 1 `invalid-actor`). A name that is a
  Stripe key or a GitLab token is the realistic case; no actor in use
  matches.
- `agentboard hook` (open change `add-harness-integration`) treats such
  a name as no actor, through `isActorName`.

False positives measured (design.md, "False positives"): the new
patterns match none of the 6512 strings in this repository's 1193 board
events, none of the 27884 lines of README.md, CONTRIBUTING.md, STATUS.md,
`adr/`, `docs/` and `openspec/`, none of the 150196 lines under `src/`,
and none of the 487529 lines of Markdown and type declarations under
`node_modules/`.

- Code: `src/board/secrets.ts` (names, expressions, doc comments) and
  its tests; the token fixtures in `src/__tests__/harness/secret-fixtures.ts`
  and `src/board/__tests__/helpers.ts`; README.md "What the board is
  not". No change to reasons, exit codes, messages, the event schema or
  any surface's wiring.
- Compatibility: text and actor names matching a new pattern are refused
  from the version that ships this (pre-1.0, a minor version). Events
  already on a board are unchanged and fold as before (board-events
  "Event actors have no form"). An OpenSpec `tasks.md` that quotes a
  full key-shaped example will no longer import, since `import-change`
  has no override; the fix is to describe the shape instead.
- Security-relevant: the task group that changes the patterns needs a
  second reviewer (CONTRIBUTING.md, "Three roles per task group").
