## MODIFIED Requirements

### Requirement: Unknown command suggestions
An unknown command or unknown flag SHALL exit 1 with reason `usage`,
suggest up to three registry commands or flags within an edit distance of
2 (a two-word command is also suggested when its first word is within that
distance), and point to `agentboard help` (for a flag, `agentboard help
<command>`). The refusal SHALL NOT repeat the unknown token, in its
message, its hint or its `--json` document (board-cli "Refusals never
repeat the refused input"): an unknown command is refused as `unknown
command; did you mean <list>? run 'agentboard help' to list the commands`,
and an unknown flag as `unknown flag at argument <n> for <command>; did
you mean <list>? run 'agentboard help <command>' to list its flags`, where
`<n>` is the flag's 1-based position among the arguments after the
program name and the `did you mean <list>? ` part is left out when there
is no suggestion. `help <topic>` with an unknown topic is refused as an
unknown command. `--help` and `-h` anywhere before a lone `--` SHALL
request help for the command named before them.

#### Scenario: Misspelled command
- **WHEN** `agentboard clam 01J9K3 --as impl` runs
- **THEN** it exits 1, suggests `claim`, and the word `clam` appears nowhere in stdout or stderr

#### Scenario: Unknown flag names its position
- **WHEN** `agentboard list --stauts todo` runs
- **THEN** it exits 1 with reason `usage`, the message says `unknown flag at argument 2 for list`, suggests `--status`, and `stauts` appears nowhere in stdout or stderr

#### Scenario: Token in the command position
- **WHEN** `agentboard <token> --as impl` and `agentboard list --<token>` run with a token-shaped value, with and without `--json`
- **THEN** each exits 1 with reason `usage`, and the token appears nowhere in stdout or stderr
