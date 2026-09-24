# Tasks

Depends on `add-board-web` (all groups). Archive after `add-board-web`:
its `board-web` delta modifies requirements that change adds (OpenSpec
refuses to archive it earlier). Independent of `add-board-insights` and
`add-board-tui`. Every group is delivered by a test author, an
implementer and a reviewer in turn (see CONTRIBUTING.md), on one branch
per group named `<area>/<group-slug>` and cut from `origin/staging`; the
test author's first commit defines the group's exported API as stubs.
Verification for every task includes `make check` and `make check-floor`
passing with coverage at or above 90 percent. Group 1 is
security-critical: the orchestrator runs a second reviewer on the
strongest model.

## 1. Write mode and action endpoints (`web/actions`)

- [ ] 1.1 Give `serve` its `--as` meaning (non-empty explicit value only, `AGENTBOARD_ACTOR` ignored, empty value `usage`, start-up line and `--json` fields, `actorHelp` in the registry entry), and extend `/api/session` with `writable` and `actor`. Verify: tests for the "Environment actor does not enable writes" and "Writable start-up" scenarios, the empty `--as` refusal, the help drift guard, and no `csrf` field and no `Set-Cookie` in any response
- [ ] 1.2 Implement `src/web/actions.ts`: `POST /api/actions/<action>` for the nine actions, body conversion with `toolArguments`, refusal of `as`, `json` and `allow-secret-like`, the run context (server board, fixed actor, working-tree root as `cwd`) shared with the CLI and MCP context building, status mapping, and `read-only` on a read-only server; add hints for `read-only`, `csrf-failed` and `body-too-large`. Verify: for each action, a test that the event written through the server is byte-identical in body to the one the CLI writes for the same arguments and actor on a copy of the board; tests for every "Action endpoints", "Close from the browser" and "Secret-like text is refused" scenario; a write through the server reaching an open stream within 3 seconds; ten concurrent claims (five through the server, five by CLI child processes) giving exactly one winner; and the hint completeness test
- [ ] 1.3 Implement the CSRF checks (JSON content type, 64 KiB limit, the `Origin` rule when an `Origin` is present) ahead of every action, after the Host and bearer token checks. Verify: one test per rule and scenario of "Cross-site request forgery protection", including an `Origin` of another port on `127.0.0.1`, a `null` origin, a mismatch between `Origin` and `Host`, a cookie holding the token with no Authorization header (401), and no event file created by any refused request

## 2. Action controls (`web/action-controls`)

- [ ] 2.1 Implement the controls on the ticket detail (comment, move with permitted targets from `isTransitionAllowed`, claim, release, hand-off, checklist checkboxes, link, close with exactly one disposition), the acting-as banner, refusals with message and hint beside the control keeping the input, immediate application of a success, and the bearer header (from the client of `add-board-web`) on every request. Verify: component tests in `happy-dom` for each control's request body, the two "Action controls in the web app" scenarios, a `busy` refusal offering a retry, and no write control rendered for a read-only session; and the smoke test extended to claim a ticket through the page of a writable server and see `agentboard show` report the new assignee

## 3. Documentation (`docs/web-actions`)

- [ ] 3.1 Document write mode in README.md (enabling it, the fixed actor, the actions, close paths relative to the tree root, no secret override, the CSRF protections (bearer header only, content type, `Origin`) and what the URL grants), record the write-mode security decisions in an ADR (a section of ADR 0006 while it is proposed, else ADR 0009), and update docs/STATUS.md. Verify: `make ascii`, `make validate-specs`, and running `agentboard serve --as <you>` on a temporary board, performing every action in a browser, and checking each with `agentboard show`
