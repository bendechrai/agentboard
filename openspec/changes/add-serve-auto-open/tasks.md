# Tasks

Every group is delivered by a test author, an implementer and a reviewer in
turn (see CONTRIBUTING.md), on one branch cut from `origin/staging`.
Verification for every task includes `make check` and `make check-floor`
passing with coverage at or above 90 percent. The `board-cli` delta
restates "Command surface" from the main spec; `add-claim-leases` does not
modify it today, but if either change is archived after the other has
changed that requirement, re-sync its MODIFIED text with the main spec
first.

## 1. Open by default (`web/serve-auto-open`)

- [ ] 1.1 Add the open-mode decision (`always` for `--open`, `never` for `--no-open`, `auto` otherwise, `usage` for both) and the pure `auto` check (stdout a terminal, no `--json`, `CI` unset or empty, no SSH variables, and `DISPLAY` or `WAYLAND_DISPLAY` on platforms other than macOS and Windows); add the `no-open` flag, description and an example to the `serve` registry entry. Verify: unit tests for every condition of the `auto` check on each platform, tests that `serve` calls the opener once after the start-up line in `always` and in `auto` when the check passes and never otherwise, that both flags exit 1 `usage` before listening, that an opener failure is one warning on stderr while serving continues, and the help drift guard

## 2. Documentation (`docs/serve-auto-open`)

- [ ] 2.1 Update README.md ("Starting it", the security model's residual risks with the advice to use `--no-open` on a shared machine, and the command reference), write ADR 0010 (opening the browser by default) and update the ADR index and docs/STATUS.md. Verify: `make ascii`, `make validate-specs`, and running `agentboard serve` from a terminal (the browser opens), `agentboard serve --no-open`, `agentboard serve | cat` and `CI=1 agentboard serve` (no browser in the last three)
