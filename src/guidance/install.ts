/**
 * `agentboard agents install` (board-agent-guidance: "Installing guidance
 * into a host project", "Installed guidance never clobbers user content";
 * add-agent-guidance design.md: "Ownership markers", "Where files are
 * written", "Auto-detection"; board-agent-guidance: "Managed MCP entry" and
 * `--mcp-command`).
 *
 * Writes the text of `./installed-text.ts` into the root of the current
 * working tree. Each target owns only its marked region of its file, and
 * everything outside that region is kept. Needs no board and no actor, and
 * runs no git command that modifies anything (only `git rev-parse
 * --show-toplevel`); it never stages or commits what it writes.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Pair, Scalar, YAMLMap, YAMLSeq, isMap, isScalar, isSeq, type Document } from 'yaml';

import type { CommandOutput, Env } from '../cli/types.js';
import { BoardError } from '../store/errors.js';
import {
  AGENTS_MD_PATH,
  GUIDANCE_VERSION,
  MCP_JSON_PATH,
  MCP_SERVER_NAME,
  OPENSPEC_CONFIG_PATH,
  OPENSPEC_GUIDANCE,
  OPENSPEC_OPERATIONS,
  SKILL_PATH,
  manualOpenSpecLines,
  mcpEntry,
  openSpecVersionComment,
  renderAgentsBlock,
  renderSkill,
  type OpenSpecOperation,
} from './installed-text.js';
import {
  PERMISSION_CODES,
  agentsMarkers,
  errorCode,
  hasSkillMarker,
  isAgentboardItem,
  isJsonObject,
  isManagedMcpEntry,
  jsonEqual,
  openSpecItems,
  parseConfig,
  parseMcpJson,
  readBytes,
  readText,
  targetPath,
} from './markers.js';

/**
 * The installation targets, in the order they are always processed and
 * reported (whatever order `--target` gives them in):
 * - `claude`: the Claude Code skill `.claude/skills/agentboard/SKILL.md`
 *   (`SKILL_PATH`), owned whole when it carries the marker;
 * - `agents-md`: the managed block in `AGENTS.md`;
 * - `openspec`: the `agentboard:` guidance entries under
 *   `operations.apply` and `operations.archive` in `openspec/config.yaml`;
 * - `mcp-json`: the `mcpServers.agentboard` key in `.mcp.json`.
 */
export type GuidanceTarget = 'claude' | 'agents-md' | 'openspec' | 'mcp-json';

/** Every `GuidanceTarget`, in processing order. */
export const GUIDANCE_TARGETS: readonly GuidanceTarget[] = [
  'claude',
  'agents-md',
  'openspec',
  'mcp-json',
];

/**
 * The file of each target, relative to the working tree root, with POSIX
 * separators (`SKILL_PATH`, `AGENTS_MD_PATH`, `OPENSPEC_CONFIG_PATH`,
 * `MCP_JSON_PATH`). Results report paths in this form.
 */
export const TARGET_FILES: Readonly<Record<GuidanceTarget, string>> = {
  claude: SKILL_PATH,
  'agents-md': AGENTS_MD_PATH,
  openspec: OPENSPEC_CONFIG_PATH,
  'mcp-json': MCP_JSON_PATH,
};

/**
 * The line `agentboard init` prints last, in text mode, whether or not the
 * board already existed (board-agent-guidance: "`init` SHALL end its
 * output with a line suggesting `agentboard agents install`"). The
 * `init --json` document is unchanged.
 */
export const INIT_SUGGESTION =
  "Next: run 'agentboard agents install' so this project's coding agents learn to use the board.";

/** Options of `installGuidance`. */
export interface InstallOptions {
  /** Directory the command runs in; the working tree root is resolved from it. */
  readonly cwd: string;
  /** Environment for `git rev-parse` (default `process.env`). */
  readonly env?: Env;
  /**
   * The `--target` values as given (repeatable, duplicates allowed). Empty
   * or absent selects by auto-detection (`detectTargets`).
   */
  readonly targets?: readonly string[];
  /** `--force`: overwrite content agentboard does not own (see `RefusalReason`). */
  readonly force?: boolean;
  /**
   * `--mcp-command <executable>`: the executable the
   * `mcp-json` target runs, written as `mcpEntry(mcpCommand)`, that is
   * `{"command": <executable>, "args": ["mcp"]}`, instead of the default
   * `npx` entry. Giving it (any value, even one that is then refused)
   * selects `mcp-json` in addition to the `--target` or auto-detected
   * targets, with reason `requested with --mcp-command`. It must be
   * non-empty and must not contain a line feed (`\n`), else
   * `installGuidance` throws `BoardError(1, 'usage', <message naming
   * --mcp-command>)` before anything is read or written. Otherwise it is
   * used exactly as given (never trimmed, resolved or checked for
   * existence); absolute paths and paths with spaces are fine. Absent: no
   * executable was requested (see `installGuidance`, `mcp-json`, for what
   * that means for an existing entry).
   */
  readonly mcpCommand?: string;
  /**
   * The guidance version to install; default `GUIDANCE_VERSION`. Only tests
   * pass it, to simulate an older or newer CLI.
   */
  readonly version?: number;
}

/** Why a target was selected. */
export interface TargetSelection {
  readonly target: GuidanceTarget;
  /**
   * With `--target`: exactly `requested with --target`. Auto-detected:
   * exactly `.claude/ exists`, `AGENTS.md exists` or
   * `openspec/config.yaml exists`. The `mcp-json` target when
   * `--mcp-command` is given: exactly `requested with --mcp-command`, also
   * when `--target mcp-json` is given too (the output names
   * `--mcp-command` as the reason).
   */
  readonly reason: string;
}

/**
 * What happened to one target:
 * - `created`: its file did not exist and was written;
 * - `updated`: its file existed and its managed region was written
 *   (added, upgraded, restored after a hand edit, or forced);
 * - `unchanged`: the managed region already had exactly the text to
 *   install; the file was not written at all (not even its mtime changes);
 * - `refused`: nothing was written for this target (see `RefusalReason`).
 */
export type InstallAction = 'created' | 'updated' | 'unchanged' | 'refused';

/**
 * Why a target was refused. The first four are overridden by `--force`;
 * the others are refused even with `--force`, because forcing would
 * destroy user content outside the owned region, write outside the working
 * tree, or cannot succeed.
 * - `foreign-file` (`claude`): `SKILL.md` exists and has no line containing
 *   `<!-- agentboard-guidance:`. With `--force` the file is overwritten
 *   whole.
 * - `malformed-marker` (`agents-md`): see `installGuidance`, step
 *   `agents-md`. With `--force` every marker-like line is removed (and
 *   nothing else) and a fresh block is appended as for a file without one.
 * - `not-a-list` (`openspec`): `operations`, `operations.<op>` or
 *   `operations.<op>.guidance` holds a value of the wrong kind (a map is
 *   needed for the first two, a list for the last; a null value counts as
 *   absent). The outcome's `manual` holds `manualOpenSpecLines()`. With
 *   `--force` each such value is replaced by a map or list holding only
 *   the agentboard entries.
 * - `entry-differs` (`mcp-json`): `mcpServers.agentboard` exists and is not
 *   a managed entry (`isManagedMcpEntry`: neither the default `npx` entry
 *   nor exactly `{command: <non-empty string>, args: ["mcp"]}`; extra keys,
 *   such as `env`, or other arguments make it unrecognised). Refused
 *   whether or not `--mcp-command` is given. With `--force` it is replaced
 *   in place (same key position) by the requested entry,
 *   `mcpEntry(mcpCommand)`.
 * - `malformed-file` (`openspec`, `mcp-json`): the file cannot be parsed
 *   (YAML errors; invalid JSON), its top level is not a map/object, or (for
 *   `.mcp.json`) `mcpServers` exists and is not an object.
 * - `missing-file` (`openspec`): `openspec/config.yaml` does not exist; the
 *   message says to run `openspec init` first. agentboard never creates an
 *   OpenSpec config.
 * - `outside-tree` (every target):
 *   the target path, with symlinks resolved (`realpathSync` of the file
 *   when it exists, else of its nearest existing ancestor, with the rest of
 *   the path appended), is not the working tree root or inside it. Inside
 *   means below the root at a path-separator boundary: for the root
 *   `/tmp/x/proj`, a sibling `/tmp/x/proj-evil/AGENTS.md` whose path merely
 *   starts with the root's characters is outside. A target path that
 *   resolves to the root itself is not a file there, so it is refused as
 *   `not-a-file` (never written). Checked
 *   before anything is read, created or written, so nothing outside the
 *   tree is ever touched (no parent directory is created either). A symlink
 *   whose target stays inside the tree is followed normally: the file it
 *   points to is read and written, and the link itself is kept.
 * - `not-a-file` (every target): the target path (after following
 *   symlinks) exists and is not a regular file (a directory, for example:
 *   `EISDIR`), or a parent of it exists and is not a directory, so the
 *   parents cannot be created (`ENOTDIR`, `EEXIST`), or resolving the path
 *   meets a symlink cycle at the path or at any ancestor, including a
 *   dangling multi-segment target through a self-referential directory
 *   (`ELOOP`: more than 40 links followed, or `ELOOP` from a read, mkdir
 *   or write). The message names the code.
 * - `unwritable` (every target): reading the file, creating a parent
 *   directory or writing the file failed with `EACCES` or `EPERM`. A
 *   target that needs no write (`unchanged`) is not refused for a
 *   read-only file.
 *
 * Filesystem errors other than those above still propagate (exit 5).
 */
export type RefusalReason =
  | 'foreign-file'
  | 'malformed-marker'
  | 'not-a-list'
  | 'entry-differs'
  | 'malformed-file'
  | 'missing-file'
  | 'outside-tree'
  | 'not-a-file'
  | 'unwritable';

/** The outcome of one target. */
export interface TargetOutcome {
  readonly target: GuidanceTarget;
  /** `TARGET_FILES[target]`: relative to the root, POSIX separators. */
  readonly path: string;
  /** `TargetSelection.reason` of the target. */
  readonly reason: string;
  readonly action: InstallAction;
  /** The refusal reason; null unless `action` is `refused`. */
  readonly refusal: RefusalReason | null;
  /**
   * One ASCII line. For a refusal it names the file (its relative path),
   * says why, and, for the four reasons `--force` overrides, says that
   * `--force` overwrites it. For `outside-tree` it also names the resolved
   * path outside the tree; for `not-a-file` and `unwritable` the error code
   * (`EISDIR`, `ENOTDIR`, `EACCES`, `EPERM`). A refusal never ends the
   * command early: the other targets are still processed and the command
   * exits 1.
   */
  readonly message: string;
  /**
   * Lines to add by hand: `manualOpenSpecLines()` for a refused `openspec`
   * target with reason `not-a-list`; empty otherwise.
   */
  readonly manual: readonly string[];
}

/** Result of `installGuidance`; also the `agents install --json` document. */
export interface InstallResult {
  /** Absolute working tree root (`workingTreeRoot`), where every file was written. */
  readonly root: string;
  /** The guidance version installed. */
  readonly version: number;
  /** True when no `--target` was given and the targets were auto-detected. */
  readonly autoDetected: boolean;
  /** One outcome per selected target, in `GUIDANCE_TARGETS` order. */
  readonly targets: readonly TargetOutcome[];
  /** Number of outcomes with action `refused`. */
  readonly refused: number;
}

/**
 * The root of the working tree containing `cwd`: the output of `git
 * rev-parse --show-toplevel` run in `cwd` with `env` (so in a linked
 * worktree it is that worktree's root, never the main checkout), or `cwd`
 * itself when that fails (not a git repository, or git missing). The
 * result is passed through `realpathSync`. Runs no git command other than
 * `rev-parse`.
 */
export function workingTreeRoot(cwd: string, env: Env): string {
  let root = cwd;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      env: { ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/, '');
    if (out !== '') {
      root = out;
    }
  } catch {
    // Not a git repository, or git is missing: the current directory.
  }
  return realpathSync(root);
}

/** The kind of what is at `path`: a directory, a file, or nothing. */
function kindOf(path: string): 'dir' | 'file' | null {
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/**
 * The targets auto-detection selects in `root` (add-agent-guidance design.md:
 * "Auto-detection"), in `GUIDANCE_TARGETS` order: `claude` when `.claude`
 * exists and is a directory (reason `.claude/ exists`), `agents-md` when
 * `AGENTS.md` exists (reason `AGENTS.md exists`), `openspec` when
 * `openspec/config.yaml` exists (reason `openspec/config.yaml exists`).
 * `mcp-json` is never selected, because registering a server changes what
 * every session in the project loads. Reads only; may return an empty
 * array.
 */
export function detectTargets(root: string): TargetSelection[] {
  const selected: TargetSelection[] = [];
  if (kindOf(join(root, '.claude')) === 'dir') {
    selected.push({ target: 'claude', reason: '.claude/ exists' });
  }
  if (kindOf(join(root, AGENTS_MD_PATH)) !== null) {
    selected.push({ target: 'agents-md', reason: `${AGENTS_MD_PATH} exists` });
  }
  if (kindOf(join(root, OPENSPEC_CONFIG_PATH)) !== null) {
    selected.push({ target: 'openspec', reason: `${OPENSPEC_CONFIG_PATH} exists` });
  }
  return selected;
}

/** What a target handler did: a `TargetOutcome` without its selection fields. */
interface Handled {
  readonly action: InstallAction;
  readonly refusal: RefusalReason | null;
  readonly message: string;
  readonly manual: readonly string[];
}

/** The four refusal reasons that `--force` overrides. */
const FORCEABLE: readonly RefusalReason[] = [
  'foreign-file',
  'malformed-marker',
  'not-a-list',
  'entry-differs',
];

function done(action: Exclude<InstallAction, 'refused'>, message: string): Handled {
  return { action, refusal: null, message, manual: [] };
}

function refuse(reason: RefusalReason, message: string, manual: readonly string[] = []): Handled {
  const suffix = FORCEABLE.includes(reason) ? '; --force overwrites it' : '';
  return { action: 'refused', refusal: reason, message: `${message}${suffix}`, manual };
}

/** Writes `content` to `path` (creating parent directories) with `encoding`. */
function write(path: string, content: string, encoding: BufferEncoding = 'utf8'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, encoding);
}

/** The `claude` target: the whole of `SKILL.md`. */
function installSkill(path: string, version: number, force: boolean): Handled {
  const wanted = renderSkill(version);
  const existing = readBytes(path);
  if (existing === null) {
    write(path, wanted);
    return done('created', `wrote the Claude Code skill ${SKILL_PATH}`);
  }
  if (!hasSkillMarker(existing) && !force) {
    return refuse(
      'foreign-file',
      `${SKILL_PATH} exists without the agentboard-guidance marker, so it is not agentboard's to overwrite`,
    );
  }
  if (existing === wanted) {
    return done('unchanged', `${SKILL_PATH} is up to date`);
  }
  write(path, wanted);
  return done('updated', `rewrote the Claude Code skill ${SKILL_PATH}`);
}

/**
 * `text` (bytes as latin1) with `block` appended as a new paragraph: a line
 * break when the text does not end with one, then an empty line (both only
 * for a non-empty text), then the block and a line break.
 */
function appendBlock(text: string, block: string): string {
  if (text === '') {
    return `${block}\n`;
  }
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
}

/** The `agents-md` target: the managed block of `AGENTS.md`. */
function installAgentsMd(path: string, version: number, force: boolean): Handled {
  const block = renderAgentsBlock(version);
  const existing = readBytes(path);
  if (existing === null) {
    write(path, `${block}\n`, 'latin1');
    return done('created', `wrote ${AGENTS_MD_PATH} with the agentboard block`);
  }
  const markers = agentsMarkers(existing);
  if (markers.kind === 'none') {
    write(path, appendBlock(existing, block), 'latin1');
    return done('updated', `appended the agentboard block to ${AGENTS_MD_PATH}`);
  }
  if (markers.kind === 'pair') {
    if (existing.slice(markers.start, markers.end) === block) {
      return done('unchanged', `${AGENTS_MD_PATH} is up to date`);
    }
    write(
      path,
      `${existing.slice(0, markers.start)}${block}${existing.slice(markers.end)}`,
      'latin1',
    );
    return done('updated', `replaced the agentboard block in ${AGENTS_MD_PATH}`);
  }
  if (!force) {
    return refuse(
      'malformed-marker',
      `${AGENTS_MD_PATH} has agentboard markers that are not one well-formed start and end pair; fix them by hand`,
    );
  }
  let kept = '';
  let from = 0;
  for (const line of markers.lines) {
    kept += existing.slice(from, line.start);
    from = line.end;
  }
  kept += existing.slice(from);
  write(path, appendBlock(kept, block), 'latin1');
  return done(
    'updated',
    `removed the malformed agentboard markers from ${AGENTS_MD_PATH} and appended a fresh block`,
  );
}

/** True when a YAML node counts as absent (missing, or a null value). */
function absent(node: unknown): boolean {
  return node === undefined || node === null || (isScalar(node) && node.value === null);
}

/** The dotted key paths of the OpenSpec guidance whose value is of the wrong kind. */
function wrongKinds(doc: Document): string[] {
  const wrong: string[] = [];
  const operations: unknown = isMap(doc.contents) ? doc.contents.get('operations', true) : null;
  if (!absent(operations) && !isMap(operations)) {
    return ['operations'];
  }
  for (const op of OPENSPEC_OPERATIONS) {
    const opNode: unknown = isMap(operations) ? operations.get(op, true) : null;
    if (!absent(opNode) && !isMap(opNode)) {
      wrong.push(`operations.${op}`);
      continue;
    }
    const guidance: unknown = isMap(opNode) ? opNode.get('guidance', true) : null;
    if (!absent(guidance) && !isSeq(guidance)) {
      wrong.push(`operations.${op}.guidance`);
    }
  }
  return wrong;
}

/** Copies the comments of `from` (a replaced node) onto `to`. */
function keepComments(from: unknown, to: YAMLMap | YAMLSeq): void {
  if (isScalar(from) || isMap(from) || isSeq(from)) {
    to.commentBefore = from.commentBefore ?? null;
    to.comment = from.comment ?? null;
    to.spaceBefore = from.spaceBefore ?? false;
  }
}

/**
 * The map under `key` of `parent`, created when absent or (only reached
 * with `--force`) of the wrong kind.
 */
function childMap(parent: YAMLMap, key: string): YAMLMap {
  const node: unknown = parent.get(key, true);
  if (isMap(node)) {
    return node;
  }
  const map = new YAMLMap();
  keepComments(node, map);
  parent.set(key, map);
  return map;
}

/**
 * The top-level `operations` map of `doc`. When the key is added, it goes
 * last, after the comments that trail the document (which the `yaml`
 * package keeps as the document comment), so the original text stays a
 * prefix of the new one.
 */
function operationsMap(doc: Document): YAMLMap {
  let top: YAMLMap;
  if (isMap(doc.contents)) {
    top = doc.contents;
  } else {
    top = new YAMLMap();
    doc.contents = top;
  }
  if (top.has('operations')) {
    return childMap(top, 'operations');
  }
  const key = new Scalar('operations');
  if (doc.comment !== null && doc.comment !== '') {
    key.commentBefore = doc.comment;
    key.spaceBefore = true;
    doc.comment = null;
  }
  const map = new YAMLMap();
  top.items.push(new Pair(key, map));
  return map;
}

/** The wanted agentboard items of `op`, each with its version comment. */
function wantedItems(op: OpenSpecOperation, version: number): Scalar[] {
  return OPENSPEC_GUIDANCE[op].map((entry) => {
    const item = new Scalar(entry);
    item.type = Scalar.QUOTE_DOUBLE;
    item.comment = ` ${openSpecVersionComment(version)}`;
    return item;
  });
}

/**
 * Puts the wanted items of `op` into `seq`: every agentboard item is
 * removed and the wanted ones go where the first was (or last). Comment
 * lines above a removed item move to the first wanted item.
 */
function replaceItems(seq: YAMLSeq, op: OpenSpecOperation, version: number): void {
  const wanted = wantedItems(op, version);
  const first = seq.items.findIndex(isAgentboardItem);
  const removed = seq.items.filter(isAgentboardItem);
  const users = seq.items.filter((item) => !isAgentboardItem(item));
  const before = removed
    .map((item) => (isScalar(item) ? item.commentBefore : null))
    .filter((c): c is string => typeof c === 'string' && c !== '');
  const head = wanted[0];
  if (head !== undefined && before.length > 0) {
    head.commentBefore = before.join('\n');
  }
  const at = first === -1 ? users.length : first;
  seq.items = [...users.slice(0, at), ...wanted, ...users.slice(at)];
}

/** The `openspec` target: the `agentboard:` guidance entries of `openspec/config.yaml`. */
function installOpenSpec(path: string, version: number, force: boolean): Handled {
  const text = readText(path);
  if (text === null) {
    return refuse(
      'missing-file',
      `${OPENSPEC_CONFIG_PATH} does not exist; run openspec init first (agentboard never creates it)`,
    );
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    return refuse('malformed-file', `${OPENSPEC_CONFIG_PATH} cannot be edited: ${parsed.why}`);
  }
  const doc = parsed.doc;
  const comment = openSpecVersionComment(version);
  const items = openSpecItems(doc);
  const stale = OPENSPEC_OPERATIONS.filter((op) => {
    const have = items[op];
    const want = OPENSPEC_GUIDANCE[op];
    return !(
      have.length === want.length &&
      have.every((item, i) => item.value === want[i] && item.comment === comment)
    );
  });
  if (stale.length === 0) {
    return done('unchanged', `${OPENSPEC_CONFIG_PATH} is up to date`);
  }
  const wrong = wrongKinds(doc);
  if (wrong.length > 0 && !force) {
    return refuse(
      'not-a-list',
      `${wrong.join(', ')} in ${OPENSPEC_CONFIG_PATH} is not the map or list OpenSpec expects (operations.<op>.guidance must be a list); add the lines below by hand`,
      manualOpenSpecLines(version),
    );
  }
  const operations = operationsMap(doc);
  for (const op of stale) {
    const opMap = childMap(operations, op);
    const node: unknown = opMap.get('guidance', true);
    let seq: YAMLSeq;
    if (isSeq(node)) {
      seq = node;
    } else {
      seq = new YAMLSeq();
      keepComments(node, seq);
      opMap.set('guidance', seq);
    }
    replaceItems(seq, op, version);
  }
  writeFileSync(path, doc.toString({ lineWidth: 0 }), 'utf8');
  return done('updated', `wrote the agentboard guidance entries in ${OPENSPEC_CONFIG_PATH}`);
}

/**
 * The `mcp-json` target: the `mcpServers.agentboard` key of `.mcp.json`.
 * `mcpCommand` is the `--mcp-command` executable, undefined when not given.
 */
function installMcpJson(path: string, force: boolean, mcpCommand: string | undefined): Handled {
  const text = readText(path);
  const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const entry = mcpEntry(mcpCommand);
  if (text === null) {
    write(path, serialize({ mcpServers: { [MCP_SERVER_NAME]: entry } }));
    return done('created', `wrote ${MCP_JSON_PATH} with the agentboard MCP server`);
  }
  const config = parseMcpJson(text);
  const servers = config?.mcpServers;
  if (config === null || (servers !== undefined && !isJsonObject(servers))) {
    return refuse(
      'malformed-file',
      `${MCP_JSON_PATH} cannot be edited: it is not a JSON object with an mcpServers object`,
    );
  }
  const map = servers ?? {};
  if (Object.hasOwn(map, MCP_SERVER_NAME)) {
    const existing = map[MCP_SERVER_NAME];
    if (isManagedMcpEntry(existing)) {
      if (mcpCommand === undefined || jsonEqual(existing, entry)) {
        return done('unchanged', `${MCP_JSON_PATH} is up to date`);
      }
    } else if (!force) {
      return refuse(
        'entry-differs',
        `${MCP_JSON_PATH} already has an mcpServers.agentboard entry that agentboard does not manage (extra keys or other arguments)`,
      );
    }
  }
  map[MCP_SERVER_NAME] = entry;
  config.mcpServers = map;
  writeFileSync(path, serialize(config), 'utf8');
  return done('updated', `wrote the agentboard MCP server into ${MCP_JSON_PATH}`);
}

/** Runs the handler of `target` on its resolved file `path`. */
function runHandler(
  target: GuidanceTarget,
  path: string,
  version: number,
  force: boolean,
  mcpCommand: string | undefined,
): Handled {
  switch (target) {
    case 'claude':
      return installSkill(path, version, force);
    case 'agents-md':
      return installAgentsMd(path, version, force);
    case 'openspec':
      return installOpenSpec(path, version, force);
    case 'mcp-json':
      return installMcpJson(path, force, mcpCommand);
  }
}

/**
 * Installs `target` after checking its path (`outside-tree`, then
 * `not-a-file`), turning a permission error on a read, mkdir or write into
 * `unwritable` and a path that turns out not to hold a file, or a symlink
 * cycle (`ELOOP`), into `not-a-file`. Other errors propagate.
 */
function installTarget(
  target: GuidanceTarget,
  root: string,
  version: number,
  force: boolean,
  mcpCommand: string | undefined,
): Handled {
  const rel = TARGET_FILES[target];
  const where = targetPath(root, rel);
  if (where.kind === 'outside-tree') {
    return refuse(
      'outside-tree',
      `${rel} resolves to ${where.resolved}, outside the working tree ${root}; agentboard only writes inside the working tree`,
    );
  }
  if (where.kind === 'not-a-file') {
    return refuse('not-a-file', `${rel} ${where.what} (${where.code}); nothing was written`);
  }
  try {
    return runHandler(target, where.path, version, force, mcpCommand);
  } catch (error) {
    const code = errorCode(error);
    if (code !== null && PERMISSION_CODES.includes(code)) {
      return refuse('unwritable', `cannot read or write ${rel} (${code}); nothing was written`);
    }
    if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'EEXIST' || code === 'ELOOP') {
      return refuse(
        'not-a-file',
        `${rel} cannot be written as a file (${code}); nothing was written`,
      );
    }
    throw error;
  }
}

/** The reason `mcp-json` is selected when `--mcp-command` is given. */
const MCP_COMMAND_REASON = 'requested with --mcp-command';

/** Throws `usage` when `--mcp-command` was given an empty value or a line feed. */
function validateMcpCommand(mcpCommand: string | undefined): void {
  if (mcpCommand === '') {
    throw new BoardError(1, 'usage', '--mcp-command must not be empty');
  }
  if (mcpCommand?.includes('\n') === true) {
    throw new BoardError(1, 'usage', '--mcp-command must not contain a newline');
  }
}

/** The selected targets of `options`, in `GUIDANCE_TARGETS` order. */
function selectTargets(
  root: string,
  given: readonly string[],
  mcpCommand: string | undefined,
): { selections: TargetSelection[]; autoDetected: boolean } {
  const all = GUIDANCE_TARGETS.join(', ');
  for (const t of given) {
    if (!(GUIDANCE_TARGETS as readonly string[]).includes(t)) {
      throw new BoardError(1, 'usage', `unknown target ${t}; expected one of ${all}`);
    }
  }
  const autoDetected = given.length === 0;
  const chosen: TargetSelection[] = autoDetected
    ? detectTargets(root)
    : GUIDANCE_TARGETS.filter((t) => given.includes(t)).map((target) => ({
        target,
        reason: 'requested with --target',
      }));
  const selections =
    mcpCommand === undefined
      ? chosen
      : GUIDANCE_TARGETS.flatMap((target): TargetSelection[] => {
          if (target === 'mcp-json') {
            return [{ target, reason: MCP_COMMAND_REASON }];
          }
          return chosen.filter((s) => s.target === target);
        });
  if (selections.length === 0) {
    throw new BoardError(
      1,
      'no-targets',
      `nothing to install detected in ${root} (no .claude/, ${AGENTS_MD_PATH} or ${OPENSPEC_CONFIG_PATH}); choose targets with --target: ${all}`,
    );
  }
  return { selections, autoDetected };
}

/**
 * Installs agent guidance into the working tree containing `options.cwd`.
 *
 * 1. `root = workingTreeRoot(cwd, env)`; `version = options.version ??
 *    GUIDANCE_VERSION`.
 * 2. Selection. `mcpCommand`, when given, must be non-empty and contain no
 *    `\n`, else `BoardError(1, 'usage', <message>)` naming `--mcp-command`
 *    and saying why (empty, or contains a newline), before anything else is
 *    checked and before anything is written. Every `--target` value must
 *    be one of `GUIDANCE_TARGETS`, else `BoardError(1, 'usage', 'unknown
 *    target <t>; expected one of claude, agents-md, openspec, mcp-json')`
 *    before anything is written. Given targets are de-duplicated, each with
 *    reason `requested with --target`. With none given, `detectTargets(root)`
 *    (`autoDetected` true). When `mcpCommand` is given, `mcp-json` is
 *    selected as well, in its `GUIDANCE_TARGETS` position, with reason
 *    `requested with --mcp-command` (replacing `requested with --target`
 *    when `--target mcp-json` is also given). When, after that, nothing is
 *    selected, `BoardError(1, 'no-targets', <message>)` whose message names
 *    `root`, says nothing was detected, and lists all four targets
 *    (`claude, agents-md, openspec, mcp-json`) with `--target`. Nothing is
 *    written.
 * 3. Each selected target is processed in `GUIDANCE_TARGETS` order. A
 *    refused target writes nothing and does not stop the others. A target
 *    either writes its whole change or nothing. Before the per-target steps
 *    below, every target is checked for `outside-tree`, then `not-a-file`;
 *    `unwritable` applies whenever a read, mkdir or write fails with
 *    `EACCES` or `EPERM` (see `RefusalReason`). None of the three is
 *    overridden by `force`.
 *
 * `claude` (`SKILL_PATH`), wanted content `renderSkill(version)`:
 * - absent: parent directories created, file written: `created`;
 * - present with a line containing `<!-- agentboard-guidance:` (whatever
 *   the version): `unchanged` when its content is exactly the wanted
 *   content, else overwritten whole: `updated`;
 * - present without such a line: `refused` `foreign-file`, unless `force`
 *   (overwritten: `updated`).
 *
 * `agents-md` (`AGENTS.md`), block `renderAgentsBlock(version)`:
 * - A marker-like line is one containing `<!-- agentboard:start` or
 *   `<!-- agentboard:end`. It is well formed when, without a trailing `\r`
 *   and surrounding spaces and tabs, it is exactly `<!-- agentboard:start
 *   v<digits> -->` or `<!-- agentboard:end -->`. The markers are a pair
 *   when there is exactly one start line and one end line, both well
 *   formed, the start before the end. Any other set of marker-like lines
 *   is `malformed-marker`.
 * - absent: file written as the block plus `\n`: `created`.
 * - present with no marker-like line: the block is appended: the existing
 *   content is kept byte for byte, a `\n` is added when it is non-empty and
 *   does not end with one, then (when it is non-empty) one empty line, then
 *   the block and `\n`: `updated`. (An empty file becomes block + `\n`.)
 * - present with a pair: the managed region runs from the first byte of
 *   the start line to the last byte of the end marker (excluding the line
 *   break after it). `unchanged` when the region is exactly the block,
 *   else the region is replaced by the block and every byte before and
 *   after it is kept: `updated`.
 * - malformed: `refused` `malformed-marker`, unless `force` (see
 *   `RefusalReason`): `updated`.
 *
 * `openspec` (`openspec/config.yaml`), edited with the `yaml` package's
 * Document API (`parseDocument`), which keeps comments, key order and user
 * entries:
 * - absent: `refused` `missing-file` (even with `force`).
 * - errors on parse, or a top level that is neither a map nor empty:
 *   `refused` `malformed-file` (even with `force`). An empty document is
 *   treated as an empty map.
 * - For `apply` then `archive`: the value at `operations.<op>.guidance`
 *   (missing maps and list created; see `not-a-list` for wrong kinds). The
 *   agentboard items are the string scalars starting with
 *   `OPENSPEC_PREFIX`. The wanted items are `OPENSPEC_GUIDANCE[op]`, in
 *   order, each with the trailing comment `openSpecVersionComment(version)`.
 *   The op is up to date when the agentboard items are exactly the wanted
 *   values with exactly that comment (trimmed), in order. Otherwise every
 *   agentboard item is removed and the wanted items are inserted where the
 *   first removed one was, or appended after the user's items. User items
 *   keep their values and order.
 * - Both ops up to date: `unchanged`, the file is not written. Otherwise the
 *   document is written with `toString({ lineWidth: 0 })` (one entry per
 *   line): `updated`. Every comment line of the original survives, in
 *   order.
 *
 * `mcp-json` (`.mcp.json`), requested entry `wanted =
 * mcpEntry(options.mcpCommand)` (the default `npx` entry without
 * `--mcp-command`), rules of add-mcp-command design.md "Reinstall rules":
 * - absent: written as `JSON.stringify({ mcpServers: { agentboard:
 *   wanted } }, null, 2)` plus `\n`: `created`.
 * - invalid JSON, a top level that is not an object, or an `mcpServers`
 *   that is present and not an object: `refused` `malformed-file` (even
 *   with `force`).
 * - absent key (and `mcpServers` created as the last top-level key when
 *   missing): `wanted` added as the last key of `mcpServers`; the file is
 *   rewritten as `JSON.stringify(<parsed object>, null, 2)` plus `\n`,
 *   keeping every other key, value and key order: `updated`. (A file
 *   already in that format therefore changes only by the added entry.)
 * - present and a managed entry (`isManagedMcpEntry`):
 *   - without `mcpCommand`: `unchanged`, not written, whichever managed
 *     shape it is (a local command is never reverted to `npx`);
 *   - with `mcpCommand`: `unchanged` (not written) when it is deep-equal
 *     to `wanted`, else replaced in place by `wanted` and rewritten as
 *     above, without needing `force`: `updated`. Deep-equal means the
 *     local shape with exactly that command: the default `npx` entry is
 *     replaced even by `--mcp-command npx` (which asks for `npx mcp`).
 * - present and not a managed entry: `refused` `entry-differs` (with or
 *   without `mcpCommand`), unless `force`, which replaces it in place by
 *   `wanted` (rewritten as above): `updated`.
 *
 * @throws BoardError exit 1 `usage` (an `mcpCommand` that is empty or
 * contains `\n`, checked first, then an unknown target) or `no-targets`
 * (no `--target`, nothing detected and no `mcpCommand`).
 */
export function installGuidance(options: InstallOptions): InstallResult {
  validateMcpCommand(options.mcpCommand);
  const root = workingTreeRoot(options.cwd, options.env ?? process.env);
  const version = options.version ?? GUIDANCE_VERSION;
  const force = options.force ?? false;
  const { selections, autoDetected } = selectTargets(
    root,
    options.targets ?? [],
    options.mcpCommand,
  );
  const targets: TargetOutcome[] = selections.map(({ target, reason }) => ({
    target,
    path: TARGET_FILES[target],
    reason,
    ...installTarget(target, root, version, force, options.mcpCommand),
  }));
  return {
    root,
    version,
    autoDetected,
    targets,
    refused: targets.filter((t) => t.action === 'refused').length,
  };
}

/**
 * The human output of `agents install`, plain ASCII, one line each, ending
 * with a newline:
 * 1. When `result.autoDetected`: `selected <target>: <reason>` per target.
 *    Otherwise one such line for each target whose reason is `requested
 *    with --mcp-command` (so `selected mcp-json: requested with
 *    --mcp-command` whenever `--mcp-command` was given), and none for the
 *    targets requested with `--target`.
 * 2. Per outcome: `<action> <target> <path>`, followed by ` (up to date)`
 *    for `unchanged`, and for `refused` by `: <message>` and then each
 *    `manual` line indented by four spaces.
 * 3. `agents install: <c> created, <u> updated, <n> unchanged, <r> refused
 *    (guidance v<version>) in <root>`.
 * Pure.
 */
export function renderInstall(result: InstallResult): string {
  const lines: string[] = [];
  for (const t of result.targets) {
    if (result.autoDetected || t.reason === MCP_COMMAND_REASON) {
      lines.push(`selected ${t.target}: ${t.reason}`);
    }
  }
  for (const t of result.targets) {
    const head = `${t.action} ${t.target} ${t.path}`;
    if (t.action === 'unchanged') {
      lines.push(`${head} (up to date)`);
    } else if (t.action === 'refused') {
      lines.push(`${head}: ${t.message}`, ...t.manual.map((line) => `    ${line}`));
    } else {
      lines.push(head);
    }
  }
  const count = (action: InstallAction): string =>
    String(result.targets.filter((t) => t.action === action).length);
  lines.push(
    `agents install: ${count('created')} created, ${count('updated')} updated, ${count('unchanged')} unchanged, ${count('refused')} refused (guidance v${String(result.version)}) in ${result.root}`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The `agents install` command (called by the registry): `installGuidance`
 * with `cwd`, `env`, `targets`, `force` and `mcpCommand` (the
 * `--mcp-command` value, undefined when the flag is absent; an empty string
 * is passed through as given, so it is refused as `usage`); `json` is the
 * `InstallResult`,
 * `text` is `renderInstall`. When any target was refused, `exitCode` is 1
 * and `warnings` holds one line per refused target, `refused <target>:
 * <message>`, so the other targets' outcomes are still printed in full.
 *
 * @throws BoardError as `installGuidance`.
 */
export function installCommand(
  cwd: string,
  env: Env,
  targets: readonly string[],
  force: boolean,
  mcpCommand?: string,
): CommandOutput {
  const result = installGuidance({
    cwd,
    env,
    targets,
    force,
    ...(mcpCommand === undefined ? {} : { mcpCommand }),
  });
  const refused = result.targets.filter((t) => t.action === 'refused');
  const output: CommandOutput = { json: result, text: renderInstall(result) };
  if (refused.length === 0) {
    return output;
  }
  return {
    ...output,
    exitCode: 1,
    warnings: refused.map((t) => `refused ${t.target}: ${t.message}`),
  };
}
