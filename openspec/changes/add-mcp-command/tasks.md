# Tasks

Every group is delivered by a test author, an implementer and a reviewer in
turn (see CONTRIBUTING.md), on one branch cut from `origin/staging`.
Verification for every task includes `make check` and `make check-floor`
passing with coverage at or above 90 percent.

## 1. Configurable MCP command

- [ ] 1.1 Add `--mcp-command <executable>` to `agents install` (registry flag, description, example, exit codes; the flag selects the `mcp-json` target; an empty value or one containing a newline is a usage error) and write `{command: <executable>, args: ["mcp"]}` for `mcp-json` when it is given, and verify with tests for a fresh install, the flag selecting the target alongside auto-detected ones, usage errors, and the help drift guard
- [ ] 1.2 Recognise both managed entry shapes in `agents install` and `agents check` (reinstall without the flag leaves a managed entry unchanged; with the flag a managed entry naming another executable is updated without `--force`; unrecognised entries are still refused as `entry-differs` unless `--force`; check reports either shape as `current`) and verify with tests for each rule, including an entry with extra keys or other arguments

## 2. Documentation

- [ ] 2.1 Update README.md (the MCP section, "Installing agent guidance into a project", and the from-source install steps recommending `agents install --mcp-command agentboard` after `npm link`) and verify with `make ascii` and by running the documented commands on a fresh temporary project with a linked build
