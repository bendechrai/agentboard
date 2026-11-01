# Tasks

Requirements this change modifies: board-cli "No secrets on the board"
and "Actor names are checked" (one added scenario; the rest of that
requirement is unchanged). If another open change also modifies either
requirement, whichever is archived second rebases its delta onto the
first.

Each group is delivered by a test author, an implementer and a reviewer in
turn (see CONTRIBUTING.md), on its own branch cut from `origin/staging`.
Group 1 is security-relevant (it decides what reaches a board that is
synced and kept forever), so it also needs a second reviewer on the
strongest model, reviewing independently. Group 2 starts after group 1 is
merged.

Fixtures are built with `join` from fragments, with visibly fake bodies,
so that no complete key-shaped string is in any source file, test or
document (design.md "Testing approach"); unit titles and task lines here
describe shapes in words, so that `import-change` accepts them.
Verification for every task includes `make check` passing with coverage
at or above 90 percent.

## 1. The patterns (`board/secret-prefix-patterns`)

- [ ] 1.1 The patterns: `SECRET_PATTERN_NAMES` in `src/board/secrets.ts` gains the fifteen names of design.md "The patterns" in the stated order (the three existing provider patterns, the new ones alphabetically, `generic-secret-assignment` last); `PATTERNS` gains their expressions with the left anchor and minimum lengths given there; `pem-private-key` accepts an optional ` BLOCK`; the doc comment on `SECRET_PATTERN_NAMES` describes every pattern as the spec does. No change to `refuseSecretLike`, `isActorName`, `ACTOR_FORM` or any message. Verify: unit tests in `src/board/__tests__/secrets.test.ts` over every audit row of design.md (bare, inside text, after `=`, after a quote), one character short of each minimum (accepted), a letter or digit immediately before each prefix (that pattern does not match), the near-misses of design.md "False positives" (accepted), the Anthropic key named only as `anthropic-api-key`, the assigned Stripe key naming both patterns in order, `SECRET_PATTERN_NAMES` pinned; board-cli scenarios "PGP private key block refused", "Public key header accepted", "Bare provider key refused", "Prefixed key after a separator or quote", "Short key that fits the actor form", "Assigned key names both patterns", "Near-misses stay accepted", "Prefix inside a word" and "Anthropic key is not an OpenAI key"; the existing tests that pin four names updated by the test author
- [ ] 1.2 The surfaces: no production change beyond 1.1 is expected; tests pin that every caller of the shared patterns picks up the new names. Verify: board-cli scenarios "Every surface uses the same patterns" (in process and against the built CLI; the web action against a real server), "Override writes a prefixed key" and "Short prefixed key as the actor" (plain and `--json`, `--allow-secret-like` changing nothing for an actor, `AGENTBOARD_ACTOR`, and `board_comment` with such an `as` over a real stdio MCP client), with the no-leak assertion of `src/__tests__/harness/secret-fixtures.ts` on every output; the new fixtures added to that module's actor table of names refused by a pattern
- [ ] 1.3 Review evidence: the reviewer recomputes the accept or refuse decision and the reported names for every fixture with a throwaway program that does not import `src/board/secrets.ts`, and reruns the false-positive count of design.md over the board events, the docs and `src/`, printing counts and pattern names only. Verify: the reviewer's report records both, with zero new-pattern hits or each hit explained

## 2. Documentation (`docs/secret-prefix-patterns`)

- [ ] 2.1 README.md "What the board is not": the list of what is refused names the provider keys now recognised (PEM and PGP private key headers, AWS access key ids, Anthropic, DigitalOcean, Docker, GitHub, GitLab, Google, Hugging Face, npm, OpenAI, PyPI, SendGrid, Shopify, Slack and Stripe keys, JWTs, and long base64 strings after `token`, `secret`, `password` or `key`), says Stripe publishable keys are not refused, and that actor names are checked against the same patterns; no key-shaped example is written. Verify: `make ascii` and `make validate-specs` green; README searched for every pattern name of `SECRET_PATTERN_NAMES` or its provider; the throwaway false-positive script of 1.3 reports no new-pattern hit in README.md
