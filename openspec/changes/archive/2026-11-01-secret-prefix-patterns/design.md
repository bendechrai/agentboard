# Design

## Context

`src/board/secrets.ts` holds the board's secret patterns, a guard rail
and not a scanner (add-board-core design.md, "Secret refusal"). Every
surface that refuses secret-looking input calls it: `refuseSecretLike`
for free text (with or without the `--allow-secret-like` override) and
`isActorName` / `checkActorName` for actor names. Changing the patterns
therefore changes every surface at once, and nothing else needs wiring.

The four patterns today are `pem-private-key`, `aws-access-key-id`,
`github-token` and `generic-secret-assignment`. The last needs a
keyword (`token`, `secret`, `password`, `key`), a `:` or `=` and 32 or
more base64 characters, so it catches `STRIPE_KEY=...` but not the same
key pasted on its own, which is how keys usually reach a comment or a
note (copied from a dashboard or a log line).

## Goals / Non-goals

Goals:

- Recognise the bare keys of the providers an agent is most likely to
  handle, by their documented prefix.
- Close the actor-name gap the ticket names: no key of a covered
  provider that fits the actor form is accepted as an actor.
- No false positive on this repository's board, docs and sources, and
  none on a large body of third-party Markdown.

Non-goals:

- Detecting unprefixed secrets (an AWS secret access key, a Twilio auth
  token, a random password), which a prefix pattern cannot tell from a
  hash or an id. `generic-secret-assignment` remains the only cover for
  them.
- Entropy scoring, checksums (GitHub and npm tokens carry a CRC32), or
  calling a provider to check a key: the check stays pure, local and
  fast.
- Changing messages, reasons, exit codes or which surfaces check.
- Redacting keys already on a board.

## Audit

Each row is a synthetic value built from the format's prefix and a
visibly fake body (repeated `FAKE...EXAMPLE` characters) of the
documented length, never a real key. "Actor form" is whether the bare
value passes `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$`. "Current, bare" is
`secretPatternsIn(value)` on today's code; "current, assigned" is
`secretPatternsIn("export SOME_API_KEY=" + value)`; "proposed" is the
patterns of "Decision" below, on the bare value. `-` is no match.

| Format | Length | Actor form | Current, bare | Current, assigned | Proposed |
|---|---|---|---|---|---|
| Stripe `sk_live_`, `sk_test_` + 24 (legacy) | 32 | fits | - | generic | stripe-secret-key |
| Stripe `sk_live_` + 99 | 107 | no | - | generic | stripe-secret-key |
| Stripe `rk_live_` + 24, `rk_live_` + 99 | 32, 107 | fits, no | - | generic | stripe-secret-key |
| Stripe `rk_test_` + 16 | 24 | fits | - | - | stripe-secret-key |
| Stripe `pk_live_`, `pk_test_` + 24 | 32 | fits | - | generic | - (excluded) |
| Stripe `whsec_` + 32 | 38 | no | - | generic | stripe-webhook-secret |
| GitHub `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` + 36 | 40 | no | github-token | github-token, generic | github-token |
| GitHub `github_pat_` + 22 `_` 59 | 93 | no | github-token | github-token, generic | github-token |
| Slack `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-` | 51 to 73 | no | - | generic | slack-token |
| Slack rotating `xoxe.xoxp-1-` + 140 | 152 | no | - | - | slack-token |
| Slack app-level `xapp-1-` | 97 | no | - | generic | slack-token |
| OpenAI `sk-` + 48 (legacy) | 51 | no | - | generic | openai-api-key |
| OpenAI `sk-proj-`, `sk-svcacct-`, `sk-admin-` | 159 to 167 | no | - | generic | openai-api-key |
| OpenAI user key `sk-None-` + 48 | 56 | no | - | generic | openai-api-key |
| Anthropic `sk-ant-api03-`, `sk-ant-admin01-`, `sk-ant-oat01-` | 108 to 110 | no | - | generic | anthropic-api-key |
| npm `npm_` + 36 | 40 | no | - | generic | npm-token |
| GitLab `glpat-` + 20 | 26 | fits | - | - | gitlab-token |
| AWS `AKIA`, `ASIA` + 16 | 20 | fits | aws-access-key-id | aws-access-key-id | aws-access-key-id |
| Google `AIza` + 35 | 39 | no | - | generic | google-api-key |
| Twilio `SK`, `AC` + 32 hex | 34 | no | - | generic | - (excluded) |
| SendGrid `SG.` + 22 `.` 43 | 69 | no | - | - | sendgrid-api-key |
| Hugging Face `hf_` + 34 | 37 | no | - | generic | huggingface-token |
| PyPI `pypi-AgEIcHlwaS5vcmc` + 150 | 170 | no | - | generic | pypi-token |
| Docker `dckr_pat_` + 27 | 36 | no | - | generic | docker-token |
| DigitalOcean `dop_v1_`, `doo_v1_` + 64 hex | 71 | no | - | generic | digitalocean-token |
| Shopify `shpat_`, `shpss_` + 32 hex | 38 | no | - | generic | shopify-token |
| JWT (HS256, `eyJ...` `.` `eyJ...` `.` 43) | 84 | no | - | - | jwt |
| PEM `PRIVATE KEY`, `RSA`, `OPENSSH`, `ENCRYPTED` headers | 27 to 37 | no | pem-private-key | pem-private-key | pem-private-key |
| PGP `PRIVATE KEY BLOCK` header | 37 | no | - | - | pem-private-key |

Totals over the 50 individual shapes: 12 match today on their own (AWS,
GitHub, PEM), 38 do not; 6 are missed even in the assigned form. The
proposed patterns match 46: all but the four excluded public
identifiers. Of the shapes that fit the actor form, today's patterns
refuse only AWS key ids; the proposed ones also refuse the Stripe
secret and restricted keys and the GitLab token, which are the actor
gap the ticket reports.

## Decision

### The patterns

Names in report order (`SECRET_PATTERN_NAMES`): the three existing
provider patterns, then the new ones alphabetically, then the generic
pattern last, so that a specific name comes before the catch-all.
"Key alphabet" is the character class given; "at least N" means N or
more consecutive characters of it, with no upper bound.

| Name | Matches |
|---|---|
| `pem-private-key` | `-----BEGIN `, any run of `[A-Z0-9 ]` ending in `PRIVATE KEY`, optionally ` BLOCK`, then `-----` |
| `aws-access-key-id` | unchanged: `AKIA` or `ASIA` and exactly 16 `[0-9A-Z]`, not preceded or followed by `[0-9A-Za-z]` |
| `github-token` | unchanged: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and at least 36 `[A-Za-z0-9]`, or `github_pat_` and at least 22 `[A-Za-z0-9_]` |
| `anthropic-api-key` | `sk-ant-` and at least 16 `[A-Za-z0-9_-]` |
| `digitalocean-token` | `dop_v1_`, `doo_v1_` or `dor_v1_` and at least 16 `[a-f0-9]` |
| `docker-token` | `dckr_pat_` or `dckr_oat_` and at least 16 `[A-Za-z0-9_-]` |
| `gitlab-token` | `glpat-` and at least 16 `[A-Za-z0-9_-]` |
| `google-api-key` | `AIza` and at least 32 `[A-Za-z0-9_-]` |
| `huggingface-token` | `hf_` and at least 32 `[A-Za-z0-9]` |
| `jwt` | `eyJ` and at least 8 `[A-Za-z0-9_-]`, `.`, `eyJ` and at least 8 `[A-Za-z0-9_-]`, `.`, at least 16 `[A-Za-z0-9_-]` |
| `npm-token` | `npm_` and at least 32 `[A-Za-z0-9]` |
| `openai-api-key` | `sk-proj-`, `sk-svcacct-`, `sk-admin-` or `sk-None-` and at least 16 `[A-Za-z0-9_-]`, or `sk-` and at least 32 `[A-Za-z0-9]` |
| `pypi-token` | `pypi-AgEIcHlwaS5vcmc` and at least 16 `[A-Za-z0-9_-]` |
| `sendgrid-api-key` | `SG.`, at least 16 `[A-Za-z0-9_-]`, `.`, at least 16 `[A-Za-z0-9_-]` |
| `shopify-token` | `shpat_`, `shpca_`, `shppa_` or `shpss_` and at least 16 `[A-Fa-f0-9]` |
| `slack-token` | `xoxa-`, `xoxb-`, `xoxe-`, `xoxp-`, `xoxr-`, `xoxs-` or `xapp-`, one or more digits, `-`, at least 16 `[A-Za-z0-9-]` |
| `stripe-secret-key` | `sk_` or `rk_`, `live_` or `test_`, at least 16 `[A-Za-z0-9]` |
| `stripe-webhook-secret` | `whsec_` and at least 16 `[A-Za-z0-9]` |
| `generic-secret-assignment` | unchanged |

Anchoring: every new pattern matches only where its first character is
not preceded by an ASCII letter or digit (a lookbehind
`(?<![A-Za-z0-9])`, as `aws-access-key-id` already does). A preceding
`_`, `-`, `.`, `=`, `:`, quote, space or line start is allowed, so
`TOKEN=xoxb-...`, `"sk_live_..."` and `xoxe.xoxp-...` match, while
`task-...`, `desk_live_...` and `self_...` cannot start a match. No new
pattern has a right anchor: the length is a minimum, so a key with
trailing text, or longer than documented, still matches. Patterns are
case-sensitive, like the existing provider patterns, because every
prefix is documented in one case.

`jwt` is anchored more strictly (orchestrator ruling during group 1):
its `eyJ` must not follow an ASCII letter, digit, `_` or `-`, the
characters of its own segment alphabet. With the general anchor a JWT
can start after any `_` or `-` inside a base64url run, and a dot-less
run such as `eyJ_` repeated makes the engine retry the 8-or-more
segment scan from every one of those starts: quadratic, measured at
5.7 s for 64 KB and 23 s for 128 KB. Anchoring on the alphabet boundary
leaves one start per run, which is linear. The cost is that a JWT glued
to a preceding `_` or `-` (`token_eyJ...`) is not named `jwt`; real
tokens are delimited by a space, quote, `=`, `:` or a header prefix
such as `Bearer `, which all still match. Every other pattern keeps the
general anchor, and a test runs every pattern over 64 KB adversarial
inputs within a generous time bound so that a future quadratic pattern
fails.

### Minimum lengths

The rule, applied to every new pattern:

- A prefix of four characters or fewer (`AIza`, `hf_`, `npm_`, bare
  `sk-`) needs at least 32 characters of its alphabet after it, which is
  at or below the shortest real key of each (35, 34, 36 and 48) and long
  enough that no identifier or slug in the corpora reaches it. For bare
  `sk-` the alphabet excludes `-` and `_`, so a hyphenated slug such as
  `sk-learn-and-pandas-...` never matches however long it is, and
  `sk-ant-...` is reported only as `anthropic-api-key`.
- A longer prefix that carries the provider's name or a structure no
  prose has (`sk_live_`, `glpat-`, `dckr_pat_`, `pypi-AgEIcHlwaS5vcmc`)
  needs at least 16, half or less of every real key's length (Stripe 24,
  GitLab 20, Docker 27, DigitalOcean and Shopify 32 or 64), which
  leaves room for a key truncated in a paste and still excludes
  placeholders such as `sk_test_...` or `whsec_short`.
- Structured tokens (`jwt`, `sendgrid-api-key`, `slack-token`) are
  recognised by their structure (two dots, or digits between hyphens)
  as much as by their length, so `SG.example.com`, `xoxo-hugs-...`
  and prose starting with `eyJ` do not match.

16 rather than the 15 the ticket estimated for Stripe restricted keys:
a restricted key has 24 or more characters after `rk_live_` (99 for
keys issued since 2024), so every real one is covered, and the actor
form admits at most 24 after the 8-character prefix.

### Why one name per provider

The refusal names the pattern so that the caller can judge a false
positive and decide on `--allow-secret-like`. `stripe-secret-key` tells
them more than `provider-token`, and a test or reviewer can pin each
prefix to its name. Two names for Stripe because a webhook signing
secret is not an API key and is configured elsewhere.

### PGP private keys

`pem-private-key` gains an optional ` BLOCK` before the closing dashes,
so `-----BEGIN PGP PRIVATE KEY BLOCK-----` is refused under the same
name. A new name was considered and rejected: the remedy is the same,
and the name already means "a private key header". Public key and
certificate headers stay accepted.

## False positives

Measured with a throwaway script that runs every proposed pattern over
each corpus and prints only counts and pattern names, never matched
text:

| Corpus | Units | New-pattern hits | Existing-pattern hits |
|---|---|---|---|
| This repository's board: every string value of every event (`.board/events`, 1193 events) | 6512 strings | 0 | 0 |
| README.md, CONTRIBUTING.md, STATUS.md, CLAUDE.md, `adr/`, `docs/`, `openspec/` (145 files) | 27884 lines | 0 | 11 (8 PEM headers, 3 generic, all spec and doc examples) |
| `src/**/*.ts` (370 files) | 150196 lines | 0 | 5 (test samples) |
| `node_modules/**/*.md` and `*.d.ts` (3622 files) | 487529 lines | 0 | not measured |

The board corpus is biased (its text has passed today's patterns), so
the third-party Markdown corpus is the stronger evidence. Near-misses
checked by hand in the audit script, all accepted by the proposed
patterns: `pk_live_` and 24 characters, `sk_live_` and 15,
`sk_test_...`, `npm_config_cache_directory_setting`,
`npm_package_version`, `hf_hub_download_cache_dir`,
`pypi-publish-workflow-step-two`, `xoxo-hugs-and-kisses-everyone`,
`sk-learn-and-pandas-in-the-notebook`,
`task-runner-for-the-ci-pipeline-and-more`, `SG.example.com`,
`eyJ is how base64 JSON starts`, `glpat-` and 15, `whsec_short` and
`-----BEGIN PUBLIC KEY-----`.

No actor on this repository's board matches a new pattern (they are
among the 6512 strings).

## Alternatives considered

- **A generic "long random string" pattern** (entropy or length only):
  rejected. Commit hashes, ULIDs, cursors and content hashes are on
  every board, and `no-echo-refusals` and `actor-secret-check` already
  accept 40- and 64-character hex and 26-character base32 on purpose.
- **Adopting a scanner's rule set** (gitleaks, trufflehog, GitHub secret
  scanning): rejected as a dependency or a vendored copy. Hundreds of
  rules, many with keyword context, would make the check slow and its
  false positives hard to reason about, and the board needs a short,
  specified list that a test can pin. The prefixes chosen here are the
  same ones those tools use.
- **Including Stripe publishable keys**: rejected. They are public by
  design (shipped in web pages); refusing them would be a false
  positive by definition, and a refused actor name of that shape is
  already rare. If the maintainer wants every Stripe key shape refused
  for simplicity, `pk_` can be added to `stripe-secret-key`'s prefixes
  in review.
- **Including Twilio SIDs**: rejected for the same reason: `AC` and `SK`
  SIDs identify an account or key and are useless without the separate
  secret, which has no prefix.
- **Requiring an exact length** (Stripe 24, GitLab 20, npm 36):
  rejected. Providers lengthen keys (Stripe moved from 24 to 99), and a
  minimum with no maximum keeps matching.
- **Matching case-insensitively**: rejected. Every prefix is documented
  in one case, and folding case would let ordinary words (`Sk-`,
  `HF_`) start a match.

## Residual risk

Unprefixed secrets, keys of providers not listed, and keys shorter than
the minimum (a truncated paste of fewer than 16 characters after the
prefix) are still accepted. A long prefixed key with a non-alphabet
character in its first 16 or 32 characters (none of the documented
formats has one) would also pass. The board stays "not a secret
store": the patterns catch the common accident, not every secret.

Ordinary slugs after a hyphenated or underscored prefix are refused,
an accepted false positive (orchestrator ruling, review round 1): the
alphabets that contain `-` or `_` admit a slug as the key body, so
`sk-proj-migration-to-new-api` and `sk-admin-dashboard-refactor-notes`
(openai-api-key), `glpat-rotation-for-ci-runners` (gitlab-token),
`sk-ant-api-key-rotation-procedure` (anthropic-api-key),
`dckr_pat_rotation_script_v2_final` (docker-token) and
`SG.marketing_campaign_2024.newsletter_template_final`
(sendgrid-api-key) all match, as do actor names such as
`glpat-rotation-bot-for-ci`. None occurs in the corpora measured. The
remedy is `--allow-secret-like` for free text and a different actor
name, since actor names have no override. Tests pin this behaviour so
that it is a deliberate choice.

A key right after a quote written as an escape that ends in a digit
(`\x22`, or `\u0022`) is not caught: the anchor excuses only the five
single-letter backslash escapes and percent-encodings (R2), so the
digit that ends the escape blocks the match. Text that quotes a key
through `JSON.stringify` has `\"` before it, and the quote is not a
letter or digit, so that form is caught. The digit-ending escapes are
accepted residual risk (reviewer's last nit, round 1).

## Existing boards and compatibility

Patterns are checked on writing only. Events already on a board are
not re-checked and fold exactly as before (board-events "Event actors
have no form"); a key that reached a board before this change is still
there and should be rotated. A shared board written by an older version
converges as before, since the event schema is unchanged.

An OpenSpec `tasks.md` whose unit titles or task lines quote a full
key-shaped example now fails `import-change` (exit 1 `secret-like`,
no override); describing the shape ("`rk_live_` and 24 characters")
imports fine. This change's own `tasks.md` is written that way.

## Testing approach

- Every audit row becomes a fixture, built with `join` from fragments
  (as `src/board/__tests__/helpers.ts` and
  `src/__tests__/harness/secret-fixtures.ts` already do) so that no
  complete key-shaped string is in the source, where a secret scanner
  or a host's push protection would flag it. Bodies are visibly fake.
- For each new pattern: the bare value, the value inside surrounding
  text, the value after `=` and after `"`, one character short of the
  minimum (accepted), and the value with a letter or digit immediately
  before the prefix (accepted).
- The near-misses of "False positives" as accepted fixtures, and
  `SECRET_PATTERN_NAMES` pinned in the order above.
- End to end: one new pattern each through `comment`, `import-change`,
  a web action, and `--as` (a Stripe restricted key and a GitLab token,
  both of the actor form, refused with `invalid-actor` naming the
  pattern), with the no-leak assertion of
  `src/__tests__/harness/secret-fixtures.ts` on every output.
- The reviewer recomputes the decision for every fixture with a
  throwaway program that does not import `src/board/secrets.ts`, and
  reruns the false-positive count over the board and docs, printing
  counts only.

### Test-author rulings (group 1)

Where the spec does not spell a case out, the tests of group 1 read it
as follows:

- A key after `TOKEN=` (scenario "Prefixed key after a separator or
  quote") is refused naming its pattern first; when the key's first 32
  characters are all of `[A-Za-z0-9+/_-]` it is also a
  `generic-secret-assignment` and that name follows, as the spec's
  definition of the generic pattern implies. After `"`, `:`, a space or
  `id=` (no keyword) only the provider pattern is named.
- "Not preceded by an ASCII letter or digit" admits every other
  character before a prefix, including `/`, `[`, `<` and a tab, not only
  the ones the design lists. For `jwt` (orchestrator ruling) `_` and `-`
  are excluded too: a JWT after either is not named `jwt`.
- The time guard runs `secretPatternsIn` once per adversarial input of
  64 KB (each pattern's prefix repeated, the prefix and a long run of
  its alphabet with no terminator, and one character short of the
  minimum repeated, as in the implementer's timing script) and requires
  each call to finish within 1 s, about 1/100th of the slowest quadratic
  case measured and well above a linear one.
- ` BLOCK` is optional once: `-----BEGIN PGP PRIVATE KEY BLOCK
  BLOCK-----` matches no pattern.
- Case-sensitivity is pinned with upper-cased (or lower-cased) prefixes
  of every new pattern, all accepted, and with a DigitalOcean token of
  upper-case hex, accepted because its alphabet is `[a-f0-9]`.
- The actor fixtures of actor-secret-check that a new pattern now names
  (the JWT, the Slack token and the OpenAI project key, all longer than
  32 characters) move from the table of names refused for the form to
  the table refused by a pattern, so they get the pattern message
  (patterns are tested first). The short Stripe and GitLab keys join the
  pattern table, so every actor surface that loops over it (`--as`,
  `AGENTBOARD_ACTOR`, `--to`, the MCP `as` and `to`, `serve --as`, the
  web `to`) tests them, and the hook's actor resolution treats them as
  no valid actor.
- The test stub adds the fifteen names to `SECRET_PATTERN_NAMES` with
  an expression that matches nothing, so that test code indexed by
  pattern name typechecks; the implementer replaces each expression.

### Rulings from review round 1

Orchestrator rulings on the second review (reviewer-sp-2):

- R1: no pattern may throw on long input. V8 keeps a backtrack entry
  per character for an open-ended counted repeat such as `{8,}`, and a
  single run of about 5.3 MiB after `eyJ` or `SG.` overflows its stack
  (`RangeError`, refused as exit 5). The open minimums of `jwt` (both
  segments) and of the first `sendgrid-api-key` segment are written as
  a fixed count followed by a star (`[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*`),
  with the same meaning. Tests feed about 6 MiB after `eyJ` and `SG.`,
  6 MiB of every pattern's alphabet after its prefix, an MCP actor
  name of that size (refused for the form, not exit 5) and an
  import-change task line of that size (imported).
- R2: the left anchor admits a key right after a backslash escape or
  a percent-encoding: "not after an ASCII letter or digit, unless that
  letter or digit ends `\n`, `\r`, `\t`, `\b`, `\f` or `%XX`"
  (`\"`, `\\` and `\/` end in a character that is not a letter or
  digit, so the general anchor already admits them). `jwt` keeps its
  own-alphabet anchor with the same exceptions. Each exception is a
  lookbehind of fixed length (two or three characters), so the check
  stays linear. Test-author ruling: the escape is judged on its own two
  characters, without counting the backslashes before it, so in
  `a\\n` followed by a key (an escaped backslash, then a literal `n`)
  the key is matched; refusing is the safe side, and parity cannot be
  judged by a lookbehind of fixed length. `aws-access-key-id` keeps the
  two-sided anchor it had before this change.
- R3: slugs after hyphenated prefixes are accepted residual risk (see
  "Residual risk"), pinned by tests.
- R4: OpenAI user keys `sk-None-` are covered by `openai-api-key` with
  the minimum of `sk-proj-` (16 of `[A-Za-z0-9_-]`).
- R5: tests kill the mutants that survived review: near-misses with
  `_` at or past the minimum for `hf_`, `npm_`, the Stripe secret
  prefixes and `whsec_`; the exact minimum of the second segments of
  `jwt` and `sendgrid-api-key`; `SG` followed by a character other than
  `.`; `xoxb--` (no digits); and the PyPI prefix with a different tail.

