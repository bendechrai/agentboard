/**
 * Guard against refusals that repeat refused input (no-echo-refusals task
 * 1.6; board-cli "Refusals never repeat the refused input"; design.md
 * "Testing approach").
 *
 * Method. Every TypeScript source under `src/` (not the tests, not the
 * browser client under `src/web/client/`, which builds no refusal) is
 * parsed with the TypeScript compiler API, and every refusal message site
 * is collected:
 * - the third argument of `new BoardError(code, reason, message)`;
 * - the third argument of a `super(code, reason, message)` call (in a
 *   class that extends `BoardError`), and, for such a subclass whose
 *   constructor passes one of its own parameters as that message, the
 *   argument in that position of every `new <Subclass>(...)`;
 * - the first argument of every call of a function named `usage` (the
 *   local message-to-`BoardError` helpers of the parser, the MCP tools
 *   and `init --remote`).
 * Each message expression is split into the values it interpolates: the
 * expressions of a template literal's `${...}`, the operands of `+`, both
 * branches of `?:` (not its condition), through parentheses; a string
 * literal interpolates nothing. Anything else (an identifier, a call, a
 * property access, `.join(...)`) is one interpolated value, compared as
 * its source text with all whitespace removed.
 *
 * Every interpolated value must be allowed by `ALLOWED` for its file and
 * enclosing function (the nearest named function, method, constructor or
 * function-valued `const`), either as that exact text or, for a message
 * builder, as any call of the named function (`callee`). Each entry says
 * why its value is compliant: registry text (command, flag and argument
 * names, constants), board data (resolved ticket ids, holders, hashes,
 * paths of the board), configuration and environment (remote names and
 * URLs, the board directory, the working tree root), accepted input (an
 * actor, a checked setting key, a validated number), or the id helper (an
 * id repeated only when `isIdShaped`). A message builder is allowed only
 * when its own output is pinned by unit tests that pass token fixtures
 * through it. A literal-only message needs no entry.
 *
 * Precision. A value is keyed by file, function and text, not by branch:
 * allowing `asciiText(text)` in `resolveTicketId` (id-shaped only) does
 * not allow it in `parseTaskFilter` of the same file, but it does allow it
 * on every branch of `resolveTicketId`, so a branch that interpolated it
 * without the `isIdShaped` guard would pass the scan (the behavioural
 * tests, which run the token fixtures through every branch, catch that).
 * A refusal that interpolates a new value fails here until an entry with
 * its reason is added in review. The
 * old echoing forms (`unknown status ${asciiText(text)}` in `status`,
 * `${asciiText(raw)}` in `parseInteger`, ...) are deliberately absent, so
 * restoring one fails (recorded in the PR: the test fails when `status`'s
 * old message is restored on a scratch copy). The list says what may be
 * interpolated, not what must be: an entry whose site was rewritten
 * without it is harmless, so the list does not fail on unused entries.
 *
 * What it does not cover, by design. It cannot see a refused value that
 * reaches a message through a variable whose name is allowed (the pass-
 * through `message` parameters, which are allowed only where every
 * construction site is itself scanned); the behavioural no-echo tests
 * (src/cli/__tests__/no-echo-*.test.ts, src/mcp/__tests__/no-echo-mcp.test.ts,
 * src/web/__tests__/no-echo-web.test.ts, src/board/__tests__/no-echo-library.test.ts)
 * pass token fixtures through every refusal class and cover that. Hint
 * templates are not scanned: src/guidance/__tests__/no-echo-hints.test.ts
 * renders every reason, on both surfaces and for every command, with every
 * fixture as the id and requires the hint with no id known, which covers
 * every template, present and future. `src/board/init-remote.ts` was left
 * to task group 2 (`sharing/no-echo-remote-url`) while it rewrote its
 * refusals; group 2 merged second, so it is scanned like every other file
 * and its entries are listed with the rest (the git lines it quotes go through
 * `sanitizeRemoteLine`, and the remote names and URLs it shows through
 * `withoutUserinfo`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');

/** One interpolated value of one refusal message. */
interface Site {
  /** The file, relative to the repository root, with `/` separators. */
  readonly file: string;
  /** The enclosing function (see the module comment). */
  readonly fn: string;
  /** The interpolated value's source text, without whitespace. */
  readonly value: string;
  /** The called function's name when the value is a call, else null. */
  readonly callee: string | null;
  readonly line: number;
}

/** One allowed value (exact `value`) or message builder (`callee`). */
type Allowed = { readonly fn: string; readonly why: string } & (
  { readonly value: string } | { readonly callee: string }
);

const REGISTRY = 'registry text: a command, flag or argument name, or a constant';
const BOARD = 'board data: a resolved ticket id, ticket state or event of the board';
const CONFIG = 'configuration or environment: a path of the board or the working tree';
const PASS = 'pass-through: the message parameter of a helper whose every call is scanned';
const BUILDER =
  'message builder from registry objects only; its output is pinned by unit tests with token fixtures';
const SANITISED =
  'git output about the board, sanitised before escaping: every configured remote, proxy or given URL ' +
  'becomes <url> and URL credentials <redacted> (sanitizeRemoteLine; pinned by the no-echo tests of group 2)';
const REMOTE_SHOWN = 'configuration: the chosen remote, shown without its user information (withoutUserinfo)';

/** Every allowed interpolated value, by file. */
const ALLOWED: Readonly<Record<string, readonly Allowed[]>> = {
  'src/board/actions.ts': [
    { fn: 'ClaimRefusedError.constructor', value: 'message', why: PASS },
    { fn: 'checkTtl', value: 'String(TTL_MIN_MS)', why: REGISTRY },
    { fn: 'checkTtl', value: 'String(TTL_MAX_MS)', why: REGISTRY },
    { fn: 'claimTicket', value: 'id', why: `${BOARD} (const id = ticket.id)` },
    { fn: 'claimTicket', value: 'String(ticket.queue.length)', why: BOARD },
    { fn: 'claimTicket', value: 'assigned', why: `${BOARD}: the resolved id and the holder` },
    { fn: 'claimTicket', value: 'isoTime(lease.expiresAt)', why: BOARD },
    { fn: 'claimTicket', value: 'isoTime(claimableAt)', why: BOARD },
    {
      fn: 'closeTicket',
      value:
        "[`ticket${ticket.id}cannotbeclosedwith--no-decision;ithasdecisioncomments:`,...quoted,'AdecisionmadeinaticketmustberecordedinaspecdeltaorADRandnamed'+'with--decision-recorded-in<path>,orretractedwithaRETRACTED:comment'+'bythesameactor.',].join('\\n')",
      why: `${BOARD}: the ticket's DECISION: comments (design.md "Out of scope")`,
    },
    {
      fn: 'closeTicket',
      value: "alreadyLinkedMessage('ticket.unplanned',ticket.id,ticket.task)",
      why: BOARD,
    },
    { fn: 'closeTicket', value: 'ticket.id', why: BOARD },
    { fn: 'moveTicket', value: 'ticket.id', why: BOARD },
    { fn: 'moveTicket', value: 'ticket.status', why: BOARD },
    { fn: 'releaseTicket', value: 'ticket.id', why: BOARD },
    { fn: 'renewTicket', value: 'ticket.id', why: BOARD },
  ],
  'src/board/config.ts': [
    { fn: 'setConfig', value: 'String(SETTING_MIN_MS)', why: REGISTRY },
    { fn: 'setConfig', value: 'String(SETTING_MAX_MS)', why: REGISTRY },
    { fn: 'setConfig', value: 'key', why: 'accepted input: the key settingKey checked' },
    { fn: 'settingKey', value: "SETTING_KEYS.join('and')", why: REGISTRY },
  ],
  'src/board/feed.ts': [
    { fn: 'get', value: 'hash', why: `${BOARD}: an event hash read from the cache` },
    { fn: 'appendOf', value: 'ticketId', why: `${BOARD}: a ticket id of a folded event` },
  ],
  'src/board/host-sync.ts': [
    { fn: 'checkDetached', value: 'BOARD_REF', why: REGISTRY },
    { fn: 'checkDetached', value: 'asciiText(branch.trim())', why: CONFIG },
    { fn: 'checkDetached', value: 'dir', why: CONFIG },
    { fn: 'checkGitFloor', value: 'dir', why: CONFIG },
    { fn: 'checkGitFloor', value: 'floor', why: REGISTRY },
    { fn: 'checkGitFloor', value: 'found', why: 'environment: the git version found' },
    { fn: 'integrateLocalRef', value: 'BOARD_REF', why: REGISTRY },
    { fn: 'push', callee: 'remoteMessage', why: SANITISED },
    { fn: 'rebaseOnto', value: "conflicted.map((p)=>asciiText(p)).join(',')", why: BOARD },
    { fn: 'rebaseOnto', value: 'dir', why: CONFIG },
    {
      fn: 'rebaseOnto',
      value: 'what',
      why: 'a phrase from the callers that names the remote only as withoutUserinfo(name)',
    },
  ],
  'src/board/import.ts': [
    { fn: 'ImportRefusedError.constructor', value: 'message', why: PASS },
    { fn: 'importChange', value: 'ambiguousMessage(result)', why: BOARD },
    { fn: 'importChange', value: 'blockedMessage(blocked)', why: BOARD },
    {
      fn: 'importChange',
      value: "SOURCE_ADAPTERS.map((a)=>a.source).join(',')",
      why: REGISTRY,
    },
    { fn: 'parseImportTarget', value: 'String(TASK_SOURCE_PATTERN)', why: REGISTRY },
  ],
  'src/board/init-remote.ts': [
    { fn: 'checkNothingInTheWay', value: 'dir', why: CONFIG },
    { fn: 'checkNothingInTheWay', value: 'kind', why: 'a fixed phrase naming what is in the way' },
    { fn: 'cloneBoard', callee: 'quote', why: SANITISED },
    {
      fn: 'cloneBoard',
      value: "asciiText(checkout.branch??'')",
      why: 'server-supplied: a branch name read from the remote (not the value given; accepted as board data)',
    },
    {
      fn: 'cloneBoard',
      value: 'asciiText(branch)',
      why: 'server-supplied: a branch name read from the remote (not the value given; accepted as board data)',
    },
    { fn: 'existingBoard', value: 'BOARD_REF', why: REGISTRY },
    {
      fn: 'existingBoard',
      value: 'key',
      why: 'configuration: the key that chose the remote, agentboard.remote or branch.<b>.remote with the board branch, escaped',
    },
    { fn: 'existingBoard', value: 'dir', why: CONFIG },
    { fn: 'existingBoard', value: 'asciiText(chosen.name)', why: 'configuration: the name of an existing remote (git refuses a URL as a remote name)' },
    { fn: 'existingBoard', value: 'asciiText(withoutUserinfo(chosen.name))', why: REMOTE_SHOWN },
    { fn: 'existingBoard', value: 'asciiText(withoutUserinfo(chosen.url))', why: 'configuration: the configured URL, shown without its user information (withoutUserinfo)' },
    { fn: 'initBoardWithRemote', callee: 'quote', why: SANITISED },
    { fn: 'usage', value: 'why', why: 'a fixed phrase: the value given is never named' },
  ],
  'src/board/into-host.ts': [
    { fn: 'MoveSyncFailure.constructor', value: 'message', why: PASS },
    {
      fn: 'syncOrFail',
      value: "[...moveLines,...error.message.split('\\n')].join('\\n')",
      why: 'the move steps and a scanned BoardError message',
    },
    ...['checkGit', 'checkStandalone', 'lockedMove', 'mismatchedEvents', 'moveBoardIntoHost'].map(
      (fn) => ({ fn, value: 'AGAIN', why: REGISTRY }),
    ),
    ...['rebaseOnto', 'replayFreshCommits', 'stoppedInTemporary'].map((fn) => ({
      fn,
      value: 'AGAIN',
      why: REGISTRY,
    })),
    { fn: 'checkGit', value: 'floor', why: REGISTRY },
    { fn: 'checkGit', value: 'found', why: 'environment: the git version found' },
    { fn: 'checkStandalone', value: 'asciiText(branch.trim())', why: CONFIG },
    { fn: 'checkStandalone', value: 'asciiText(dir)', why: CONFIG },
    { fn: 'checkStandalone', value: "asciiText(join(dir,'events'))", why: CONFIG },
    { fn: 'checkStandalone', value: 'asciiText(name)', why: 'configuration: a remote name' },
    {
      fn: 'checkStandalone',
      value: "modified.map((p)=>`git-C${asciiText(dir)}checkout--${asciiText(p)}`).join('and')",
      why: BOARD,
    },
    { fn: 'checkStandalone', value: "modified.map((p)=>asciiText(p)).join(',')", why: BOARD },
    { fn: 'checkStandalone', value: "plural(modified.length,'committedeventfile')", why: BOARD },
    { fn: 'checkStandalone', value: "plural(pending.length,'eventfile')", why: BOARD },
    { fn: 'lockedMove', value: 'BOARD_REF', why: REGISTRY },
    { fn: 'lockedMove', value: 'asciiText(dir)', why: CONFIG },
    { fn: 'lockedMove', value: 'asciiText(temp)', why: CONFIG },
    { fn: 'lockedMove', value: "dirty.map((p)=>asciiText(p)).join(',')", why: BOARD },
    {
      fn: 'lockedMove',
      value: 'firstErrorLine(added)',
      why: 'git output about the host repository',
    },
    { fn: 'mismatchedEvents', value: 'asciiText(from)', why: CONFIG },
    { fn: 'mismatchedEvents', value: 'asciiText(to)', why: CONFIG },
    { fn: 'mismatchedEvents', value: 'list', why: BOARD },
    { fn: 'mismatchedEvents', value: "plural(names.length,'eventfile')", why: BOARD },
    { fn: 'moveBoardIntoHost', value: 'asciiText(dir)', why: CONFIG },
    { fn: 'notFound', value: 'dir', why: CONFIG },
    { fn: 'rebaseOnto', value: 'asciiText(dir)', why: CONFIG },
    { fn: 'rebaseOnto', value: 'asciiText(temp)', why: CONFIG },
    { fn: 'rebaseOnto', value: "conflicted.map((p)=>asciiText(p)).join(',')", why: BOARD },
    {
      fn: 'rebaseOnto',
      value: 'what',
      why: 'a phrase from the callers that names the remote only as withoutUserinfo(name)',
    },
    { fn: 'replayFreshCommits', value: 'asciiText(dir)', why: CONFIG },
    { fn: 'replayFreshCommits', value: 'asciiText(temp)', why: CONFIG },
    {
      fn: 'replayFreshCommits',
      value: "conflicted.map((p)=>asciiText(p)).join(',')",
      why: BOARD,
    },
    { fn: 'replayFreshCommits', value: 'remoteErrorLine(out,worktree)', why: SANITISED },
    { fn: 'replayFreshCommits', value: 'local', why: CONFIG },
    { fn: 'stoppedInTemporary', value: 'asciiText(dir)', why: CONFIG },
    { fn: 'stoppedInTemporary', value: 'asciiText(path)', why: CONFIG },
    { fn: 'stoppedInTemporary', value: 'operation', why: 'a fixed phrase from the callers' },
    { fn: 'stoppedInTemporary', value: 'origin', why: CONFIG },
    { fn: 'stoppedInTemporary', value: 'steps', why: 'fixed recovery steps' },
    { fn: 'undoForeignUpdates', value: 'BOARD_REF', why: REGISTRY },
    {
      fn: 'undoForeignUpdates',
      value: 'asciiText(equal.path)',
      why: 'configuration: the path of a temporary worktree under the host git directory, not refused input',
    },
    { fn: 'undoForeignUpdates', value: 'asciiText(dir)', why: CONFIG },
    { fn: 'undoForeignUpdates', value: 'AGAIN', why: REGISTRY },
    {
      fn: 'cannotSetBack',
      value: 'asciiText(path)',
      why: 'configuration: the path of a temporary worktree under the host git directory, not refused input',
    },
    { fn: 'cannotSetBack', value: 'asciiText(dir)', why: CONFIG },
    { fn: 'cannotSetBack', value: 'BOARD_REF', why: REGISTRY },
    {
      fn: 'cannotSetBack',
      value: 'why',
      why: 'one of two fixed phrases from the caller; a record that failed validation is never quoted',
    },
    { fn: 'cannotSetBack', value: 'AGAIN', why: REGISTRY },
  ],
  'src/board/leases.ts': [{ fn: 'parseDuration', value: 'form.message', why: REGISTRY }],
  'src/board/openspec.ts': [
    { fn: 'groupHeading', value: 'String(first)', why: 'a line number of the tasks file' },
    { fn: 'groupHeading', value: 'String(number)', why: 'a line number of the tasks file' },
    { fn: 'groupHeading', value: 'item', why: 'tasks file content (design.md "Out of scope")' },
    { fn: 'groupHeading', value: 'where', why: 'the tasks file path, read successfully' },
    { fn: 'parseOpenSpecTasks', value: 'String(number)', why: 'a line number of the tasks file' },
    { fn: 'parseOpenSpecTasks', value: 'where', why: 'the tasks file path, read successfully' },
  ],
  'src/board/paths.ts': [{ fn: 'treePath', value: 'asciiText(root)', why: CONFIG }],
  'src/board/pending.ts': [{ fn: 'toEntry', value: 'hash', why: BOARD }],
  'src/board/remote.ts': [
    { fn: 'ambiguousRemoteError', value: 'SET_REMOTE', why: REGISTRY },
    { fn: 'ambiguousRemoteError', value: 'command', why: REGISTRY },
    { fn: 'ambiguousRemoteError', value: 'remoteNames(choice.remotes)', why: CONFIG },
  ],
  'src/board/resolve.ts': [
    {
      fn: 'resolveTicketId',
      value: 'asciiText(text)',
      why: 'the id helper: only in the branches where isIdShaped(text) holds, and the ambiguous prefix, which matched ids',
    },
    { fn: 'resolveTicketId', value: 'String(MIN_PREFIX_LENGTH)', why: REGISTRY },
    { fn: 'resolveTicketId', value: "matches.join(',')", why: BOARD },
    { fn: 'resolveTicketId', value: 'NOT_AN_ID_MESSAGE', why: REGISTRY },
    { fn: 'taskRefFromArgs', value: 'TASK_REF_FORM', why: REGISTRY },
  ],
  'src/board/secrets.ts': [
    { fn: 'refuseSecretLike', value: 'names', why: 'the matching secret pattern names' },
  ],
  'src/board/sync-steps.ts': [
    { fn: 'checkCommittedEventsPresent', value: 'board.dir', why: CONFIG },
    { fn: 'checkCommittedEventsPresent', value: "names.join(',')", why: BOARD },
    {
      fn: 'checkCommittedEventsPresent',
      value: "names.map((p)=>`git-C${board.dir}checkout--${p}`).join('and')",
      why: BOARD,
    },
    {
      fn: 'checkCommittedEventsPresent',
      value: "plural(missing.length,'committedeventfile')",
      why: BOARD,
    },
    { fn: 'checkNothingForeignStaged', value: 'dir', why: CONFIG },
    {
      fn: 'checkNothingForeignStaged',
      value: "foreign.map((p)=>asciiText(p)).join(',')",
      why: 'paths staged in the board repository',
    },
    { fn: 'checkNothingInProgress', value: 'dir', why: CONFIG },
    { fn: 'syncFailed', callee: 'remoteMessage', why: SANITISED },
  ],
  'src/board/sync.ts': [
    { fn: 'checkRepository', value: 'dir', why: CONFIG },
    { fn: 'checkRepository', value: "info.detail??'thelinkcannotberead'", why: CONFIG },
    {
      fn: 'pull',
      value: 'asciiText(withoutUserinfo(remote))',
      why: REMOTE_SHOWN,
    },
    { fn: 'pull', value: "conflicted.map((p)=>asciiText(p)).join(',')", why: BOARD },
    { fn: 'pull', value: 'dir', why: CONFIG },
  ],
  'src/board/tickets.ts': [{ fn: 'newTicket', value: 'TASK_RULE', why: REGISTRY }],
  'src/board/wait.ts': [
    { fn: 'waitForGrant', value: 'String(TTL_MIN_MS)', why: REGISTRY },
    { fn: 'waitForGrant', value: 'String(TTL_MAX_MS)', why: REGISTRY },
    { fn: 'waitForGrant', value: 'String(TIMEOUT_MIN_MS)', why: REGISTRY },
    { fn: 'waitForGrant', value: 'String(TIMEOUT_MAX_MS)', why: REGISTRY },
    { fn: 'end', value: 'String(timeout)', why: 'accepted input: the timeout checked in range' },
    { fn: 'end', value: 'actor', why: 'accepted input: the actor (design.md "Out of scope")' },
    { fn: 'end', value: 'id', why: `${BOARD} (the id the claim resolved)` },
    { fn: 'operation', value: 'id', why: `${BOARD} (the id the claim resolved)` },
    { fn: 'wake', value: 'actor', why: 'accepted input: the actor (design.md "Out of scope")' },
    { fn: 'wake', value: 'id', why: `${BOARD} (the id the claim resolved)` },
  ],
  'src/cli/parse.ts': [
    { fn: 'parseArgs', callee: 'unknownFlagMessage', why: BUILDER },
    { fn: 'parseArgs', callee: 'unexpectedArgumentMessage', why: BUILDER },
    { fn: 'parseArgs', callee: 'choicesMessage', why: BUILDER },
    { fn: 'parseArgs', value: 'name', why: `${REGISTRY} (a flag the registry declares)` },
    { fn: 'parseArgs', value: 'command.name', why: REGISTRY },
    { fn: 'parseArgs', value: 'spec.name', why: REGISTRY },
    { fn: 'parseArgs', value: "spec.choices.join(',')", why: REGISTRY },
    {
      fn: 'parseArgs',
      value: "group.alternatives.map((alt)=>alt.map((n)=>`--${n}`).join('with')).join(',')",
      why: REGISTRY,
    },
    { fn: 'parseArgs', value: 'group.message', why: REGISTRY },
    { fn: 'parseArgs', value: "chosen.map((n)=>`--${n}`).join('and')", why: REGISTRY },
    { fn: 'parseArgs', value: "missing.map((n)=>`--${n}`).join(',')", why: REGISTRY },
    { fn: 'parseInteger', value: 'name', why: REGISTRY },
    { fn: 'selectCommand', callee: 'unknownCommandMessage', why: BUILDER },
    { fn: 'resolveActor', value: 'ACTOR_ENV', why: REGISTRY },
    { fn: 'refuseReservedActor', value: 'SYSTEM_ACTOR', why: REGISTRY },
    { fn: 'usage', value: 'message', why: PASS },
  ],
  'src/cli/registry.ts': [
    { fn: 'status', callee: 'choicesMessage', why: BUILDER },
    { fn: 'status', value: "STATUSES.join(',')", why: REGISTRY },
    { fn: 'durationFlag', value: 'name', why: REGISTRY },
    { fn: 'linkTarget', value: 'LINK_GROUP.message', why: REGISTRY },
  ],
  'src/guidance/guide.ts': [{ fn: 'agentsHelpOutput', value: "ROLES.join(',')", why: REGISTRY }],
  'src/guidance/help.ts': [
    { fn: 'helpOutput', value: 'HELP_AGENTS', why: REGISTRY },
    { fn: 'helpOutput', value: 'first', why: `${REGISTRY} (checked to be a command name)` },
    { fn: 'helpOutput', callee: 'unknownCommandMessage', why: BUILDER },
  ],
  'src/guidance/install.ts': [
    { fn: 'selectTargets', value: 'all', why: REGISTRY },
    { fn: 'selectTargets', value: 'AGENTS_MD_PATH', why: REGISTRY },
    { fn: 'selectTargets', value: 'OPENSPEC_CONFIG_PATH', why: REGISTRY },
    { fn: 'selectTargets', value: 'root', why: CONFIG },
  ],
  'src/mcp/tools.ts': [
    { fn: 'toolArguments', callee: 'unknownArgumentMessage', why: BUILDER },
    { fn: 'toolArguments', value: 'command.name', why: REGISTRY },
    { fn: 'toolArguments', value: 'spec.name', why: REGISTRY },
    { fn: 'toolArguments', value: 'toolName(command.name)', why: REGISTRY },
    { fn: 'argumentValue', value: 'name', why: `${REGISTRY} (a schema property)` },
    { fn: 'usage', value: 'message', why: PASS },
  ],
  'src/store/board.ts': [{ fn: 'openBoard', value: 'asciiText(abs)', why: `${CONFIG}, escaped` }],
  'src/store/cache.ts': [
    { fn: 'inspectCache', value: 'path', why: CONFIG },
    { fn: 'schemaMismatch', value: 'String(CACHE_SCHEMA_VERSION)', why: REGISTRY },
    { fn: 'schemaMismatch', value: 'found', why: BOARD },
    { fn: 'schemaMismatch', value: 'path', why: CONFIG },
  ],
  'src/store/eventfile.ts': [{ fn: 'writeEventFile', value: 'path', why: BOARD }],
  'src/store/locate.ts': [
    { fn: 'findBoard', value: 'SOURCE_TEXT[location.source]', why: REGISTRY },
    {
      fn: 'findBoard',
      value: 'asciiText(location.dir)',
      why: `${CONFIG} (AGENTBOARD_DIR), escaped (review round 1)`,
    },
  ],
  'src/store/transaction.ts': [
    { fn: 'accept', value: 'message', why: `${BOARD}: the fold's rejection of a scanned command` },
    { fn: 'build', value: 'built.kind', why: 'an event kind the board itself built' },
    { fn: 'build', value: 'fields', why: 'validation of an event the board itself built' },
    { fn: 'decide', value: 'decision.message', why: `${PASS} (the commands' own refusals)` },
    { fn: 'write', value: 'left', why: BOARD },
    { fn: 'write', value: 'written.path', why: BOARD },
  ],
  'src/web/actions.ts': [
    { fn: 'actionArguments', value: 'name', why: `${REGISTRY} (one of REFUSED_PROPERTIES)` },
    { fn: 'actionArguments', value: "REFUSED_WHY[name]??''", why: REGISTRY },
    { fn: 'runAction', value: "ACTION_NAMES.join(',')", why: REGISTRY },
  ],
  'src/web/api.ts': [{ fn: 'eventsPage', value: 'String(EVENTS_PAGE_MAX)', why: REGISTRY }],
  'src/web/security.ts': [
    { fn: 'checkRequest', value: 'String(guard.port)', why: 'configuration: the port served' },
  ],
  'src/web/server.ts': [
    { fn: 'onError', value: 'LOOPBACK', why: REGISTRY },
    {
      fn: 'onError',
      value: 'String(requested)',
      why: 'accepted input: a --port that passed the integer and range checks (at most 5 digits)',
    },
    { fn: 'openStream', value: 'String(maxStreams)', why: 'configuration of the server' },
    { fn: 'tooLarge', value: 'String(ACTION_BODY_LIMIT/1024)', why: REGISTRY },
  ],
};

/** Every `.ts` source under `dir`, without tests and the browser client. */
function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && path !== join(SRC, 'web', 'client')) {
        out.push(...sources(path));
      }
    } else if (name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out.sort();
}

/** The name of the function enclosing `node` (see the module comment). */
function enclosing(node: ts.Node, sf: ts.SourceFile): string {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name !== undefined) {
      return p.name.getText(sf);
    }
    if (ts.isConstructorDeclaration(p)) {
      return `${p.parent.name?.getText(sf) ?? '<class>'}.constructor`;
    }
    if (
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      ts.isVariableDeclaration(p.parent)
    ) {
      return p.parent.name.getText(sf);
    }
  }
  return '<module>';
}

/** The interpolated values of a message expression (see the module comment). */
function interpolated(node: ts.Expression, out: ts.Expression[] = []): ts.Expression[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return out;
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      interpolated(span.expression, out);
    }
  } else if (ts.isParenthesizedExpression(node)) {
    interpolated(node.expression, out);
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    interpolated(node.left, out);
    interpolated(node.right, out);
  } else if (ts.isConditionalExpression(node)) {
    interpolated(node.whenTrue, out);
    interpolated(node.whenFalse, out);
  } else {
    out.push(node);
  }
  return out;
}

/**
 * The classes of `sf` that extend `BoardError` and pass a constructor
 * parameter as the message, with that parameter's index.
 */
function subclasses(sf: ts.SourceFile, into: Map<string, number>): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) &&
      node.name !== undefined &&
      node.heritageClauses?.some((h) =>
        h.types.some((t) => t.expression.getText(sf) === 'BoardError'),
      ) === true
    ) {
      for (const member of node.members) {
        if (!ts.isConstructorDeclaration(member) || member.body === undefined) {
          continue;
        }
        const names = member.parameters.map((p) => p.name.getText(sf));
        const findSuper = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) {
            const message = n.arguments[2];
            const index = message === undefined ? -1 : names.indexOf(message.getText(sf));
            if (index >= 0 && node.name !== undefined) {
              into.set(node.name.text, index);
            }
          }
          ts.forEachChild(n, findSuper);
        };
        findSuper(member.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Parses `text` as the file `file`. */
function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/**
 * Every interpolated value of every refusal message site in `files`
 * (`[relative path, source text]`), with `extraSubclasses` added to the
 * `BoardError` subclasses found in them.
 */
function scan(files: readonly (readonly [string, string])[]): Site[] {
  const parsed = files.map(([file, text]) => [file, parse(file, text)] as const);
  const subs = new Map<string, number>();
  for (const [, sf] of parsed) {
    subclasses(sf, subs);
  }
  const sites: Site[] = [];
  for (const [file, sf] of parsed) {
    const visit = (node: ts.Node): void => {
      let message: ts.Expression | undefined;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const index = name === 'BoardError' ? 2 : subs.get(name);
        message = index === undefined ? undefined : node.arguments?.[index];
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
          message = node.arguments[2];
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'usage') {
          message = node.arguments[0];
        }
      }
      if (message !== undefined) {
        for (const value of interpolated(message)) {
          sites.push({
            file,
            fn: enclosing(node, sf),
            value: value.getText(sf).replace(/\s+/g, ''),
            callee:
              ts.isCallExpression(value) && ts.isIdentifier(value.expression)
                ? value.expression.text
                : null,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

/** True when `site` is allowed by `allowed`. */
function isAllowed(site: Site, allowed: Readonly<Record<string, readonly Allowed[]>>): boolean {
  return (allowed[site.file] ?? []).some(
    (entry) =>
      entry.fn === site.fn &&
      ('callee' in entry ? site.callee === entry.callee : site.value === entry.value),
  );
}

/** The sites of `files` that `allowed` does not allow, as `file:line fn: value`. */
function violations(
  files: readonly (readonly [string, string])[],
  allowed: Readonly<Record<string, readonly Allowed[]>> = ALLOWED,
): string[] {
  return scan(files)
    .filter((site) => !isAllowed(site, allowed))
    .map((site) => `${site.file}:${String(site.line)} ${site.fn}: ${site.value}`);
}

/** Every source under `src/` as `[relative path, text]`. */
function srcFiles(): [string, string][] {
  return sources().map((path) => [
    relative(ROOT, path).split('\\').join('/'),
    readFileSync(path, 'utf8'),
  ]);
}

describe('the scanner', () => {
  const sample = [
    "import { BoardError } from './errors.js';",
    'class Refused extends BoardError {',
    '  constructor(reason: string, message: string) {',
    '    super(4, reason, message);',
    '  }',
    '}',
    'function usage(message: string): BoardError {',
    "  return new BoardError(1, 'usage', message);",
    '}',
    'export function check(text: string, n: number): void {',
    "  if (n > 1) throw new BoardError(1, 'usage', 'a literal only');",
    "  if (n > 2) throw new BoardError(1, 'usage', `bad ${asciiText(text)}`);",
    "  if (n > 3) throw usage('value ' + text + ' refused');",
    "  if (n > 4) throw new Refused('queued', ok ? `x ${String(n)}` : `y ${ asciiText( text ) }`);",
    "  if (n > 5) throw new BoardError(1, 'usage', builder(text, 1));",
    '}',
    'const arrow = (word: string): never => {',
    "  throw new BoardError(1, 'usage', `${word}`);",
    '};',
  ].join('\n');

  it('finds every interpolated value of every kind of site, by function', () => {
    const found = scan([['src/x.ts', sample]]).map(
      (s) => `${s.fn}: ${s.value} (${String(s.callee)})`,
    );
    expect(found).toEqual([
      'Refused.constructor: message (null)',
      'usage: message (null)',
      'check: asciiText(text) (asciiText)',
      'check: text (null)',
      'check: String(n) (String)',
      'check: asciiText(text) (asciiText)',
      'check: builder(text,1) (builder)',
      'arrow: word (null)',
    ]);
  });

  it('allows by file, function and exact value, or by callee', () => {
    const allowed: Record<string, readonly Allowed[]> = {
      'src/x.ts': [
        { fn: 'Refused.constructor', value: 'message', why: PASS },
        { fn: 'usage', value: 'message', why: PASS },
        { fn: 'check', value: 'String(n)', why: REGISTRY },
        { fn: 'check', callee: 'builder', why: BUILDER },
        { fn: 'arrow', value: 'asciiText(text)', why: 'not this function' },
      ],
    };
    expect(violations([['src/x.ts', sample]], allowed)).toEqual([
      'src/x.ts:12 check: asciiText(text)',
      'src/x.ts:13 check: text',
      'src/x.ts:14 check: asciiText(text)',
      'src/x.ts:18 arrow: word',
    ]);
  });
});

describe('refusal messages under src/', () => {
  it('every interpolated value is allowed, with a reason', () => {
    expect(violations(srcFiles())).toEqual([]);
  });

  it('fails when the old status message is restored', () => {
    const before = new Set(violations(srcFiles()));
    const files = srcFiles().map(([file, text]): [string, string] =>
      file === 'src/cli/registry.ts'
        ? [
            file,
            `${text}\nfunction status(text: string): void {\n  throw new BoardError(1, 'usage', \`unknown status \${asciiText(text)}; expected one of \${STATUSES.join(', ')}\`);\n}\n`,
          ]
        : [file, text],
    );
    expect(violations(files).filter((v) => !before.has(v))).toEqual([
      expect.stringMatching(/^src\/cli\/registry\.ts:\d+ status: asciiText\(text\)$/),
    ]);
  });

  it('every allow-list entry names a reason and a scanned file', () => {
    const files = new Set(srcFiles().map(([file]) => file));
    for (const [file, entries] of Object.entries(ALLOWED)) {
      expect(files.has(file), file).toBe(true);
      for (const entry of entries) {
        expect(entry.why.length, `${file} ${entry.fn}`).toBeGreaterThan(10);
      }
    }
  });

  it('scans init-remote.ts like every other file, with its own allow-list entries', () => {
    expect(srcFiles().map(([file]) => file)).toContain('src/board/init-remote.ts');
    expect(ALLOWED['src/board/init-remote.ts']?.length ?? 0).toBeGreaterThan(0);
  });
});
