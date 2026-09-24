/**
 * The `agentboard mcp` server (board-cli: "MCP server"; design.md: "MCP
 * server"): the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`)
 * over stdio, one tool per registry command (`toolDefinitions`), each call
 * running the command's own `run` exactly as one CLI invocation does.
 *
 * Board: discovery (`findBoard` with the server's `cwd` and `env`) runs
 * once, at start-up, and fixes the board directory for the server's
 * lifetime; no board there means the server never serves and exits 2.
 * Each tool call then opens that directory with `openBoard` (so the cache
 * catches up with every event file written since, by any process, exactly
 * as a CLI invocation does) and closes it when the call ends. Holding one
 * connection open for the whole session was rejected: reads (`show`,
 * `list`) do not catch up by themselves, so a long-lived handle would serve
 * a stale view of events other processes wrote.
 *
 * Every write therefore runs through the same `runCommand` single
 * `BEGIN IMMEDIATE` transaction as the CLI, so MCP and CLI writers race
 * safely (board-concurrency).
 *
 * Output discipline: stdout carries only MCP protocol messages. Every
 * diagnostic (reaped temporary files, corrupt event files reported by the
 * per-call open, `CommandOutput.warnings`, start-up failures) goes to
 * `stderr` as `agentboard: <line>` and a newline.
 *
 * SDK use: tool schemas are plain JSON Schema generated from the registry,
 * not zod, so the server installs its own `tools/list` and `tools/call`
 * handlers on the SDK's low-level protocol server (for example
 * `new McpServer(info, { capabilities: { tools: {} } }).server`, with
 * `ListToolsRequestSchema` and `CallToolRequestSchema`) rather than
 * `McpServer.registerTool`, which needs zod schemas. The server name is
 * `SERVER_NAME` and its version is `VERSION`.
 *
 * Not in this change (add-agent-guidance adds them later): a `hint` in
 * tool errors, server `instructions`, and the `agentboard://guide`
 * resource. Nothing here may preclude them.
 */

import type { Readable, Writable } from 'node:stream';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { Env } from '../cli/types.js';
import type { ExitCode } from '../store/errors.js';

/** The MCP server name announced at initialization. */
export const SERVER_NAME = 'agentboard';

/**
 * `structuredContent` of a failed call (board-cli: "MCP server"): the
 * `ErrorDocument.error` the CLI prints with `--json` for the same failure
 * (`errorDocument` in `src/cli/main.ts`).
 */
export interface ToolErrorContent {
  /** The exit code the CLI would have exited with. */
  exitCode: Exclude<ExitCode, 0>;
  /** The `BoardError` reason (for example `already-assigned`), or null. */
  reason: string | null;
  message: string;
}

/** The result of one `tools/call`, as sent to the client. */
export interface ToolCallResult {
  /**
   * Exactly one text item. On success its text is
   * `JSON.stringify(output.json)` (the CLI's `--json` stdout without the
   * trailing newline); on failure it is the error message.
   */
  content: { type: 'text'; text: string }[];
  /**
   * On success, the `--json` document when it is a JSON object; when the
   * document is an array (`list`, `show` with `raw`) it is
   * `{ items: <the array> }`, because MCP requires structured content to be
   * an object. On failure, the `ToolErrorContent`.
   */
  structuredContent: Record<string, unknown>;
  /** Present, and true, only on failure. */
  isError?: true;
}

/** Where a server runs: the surroundings of `createMcpServer`. */
export interface McpServerOptions {
  /** Directory discovery starts from; also `RunContext.cwd` of every call. */
  cwd: string;
  /**
   * Environment for discovery and every call: `AGENTBOARD_DIR`, and
   * `AGENTBOARD_ACTOR` as the actor fallback when a call has no `as`.
   */
  env: Env;
  /**
   * The server's default actor: the `--as` of `agentboard mcp --as <actor>`
   * (board-cli: "MCP server"). An empty string is the same as absent.
   * Precedence for a tool that writes or tracks a per-actor cursor: the
   * call's `as` argument, then this, then `AGENTBOARD_ACTOR` from `env`.
   */
  actor?: string;
  /** Receives diagnostic text (never stdout). */
  stderr(text: string): void;
}

/** A located board served over MCP. */
export interface BoardMcpServer {
  /** The absolute board directory found at start-up. */
  readonly boardDir: string;
  /**
   * Handles one `tools/call` (the `tools/call` handler calls this): never
   * throws, every failure is a tool error.
   *
   * 1. `findTool(name)`; an unknown or excluded name is a tool error with
   *    exit code 1, reason `usage`, naming the tool.
   * 2. `toolArguments(command, args)`.
   * 3. The actor, for a command that writes or tracks a per-actor cursor
   *    (as `runCli` decides): `resolveActor(given, options.env)`, the
   *    same function as the CLI, where `given` is the call's `as` when it
   *    is a non-empty string, else `options.actor` (the server's `--as`),
   *    so the order is call `as`, server `--as`, `AGENTBOARD_ACTOR`. With
   *    none, the `missing-actor` error (exit 1) names both `--as` and
   *    `AGENTBOARD_ACTOR`. For any other command the actor is null. This
   *    happens before the board is opened.
   * 4. `command.run(ctx, values)` with a `RunContext` like the CLI's:
   *    `cwd` and `env` from the options, the actor, `boardDir()` returning
   *    `boardDir`, and `board(options)` opening `boardDir` with `openBoard`
   *    on first use (passing `catchUp` and `prepare` as `runCli` does) and
   *    printing the open report's reaped and corrupt files to stderr as
   *    `runCli` does. The board is closed when the call ends, whatever
   *    happens. The implementation should share this context building
   *    with `src/cli/main.ts` rather than copy it.
   * 5. Success: `output.warnings` to stderr, then the result described on
   *    `ToolCallResult`. An output carrying `exitCode` (only `rebuild
   *    --check`, which is not a tool) is a tool error with that exit code,
   *    reason null and the warnings joined with `; ` as the message.
   * 6. Failure (anything thrown in steps 2 to 4): a tool error whose
   *    structured content is `errorDocument(error).error`, so a
   *    `BoardError` keeps its exit code and reason, and any other error is
   *    exit code 5 with reason null. A failure with exit code 5 is also
   *    printed to stderr as `agentboard: <message>`.
   */
  callTool(name: string, args: unknown): ToolCallResult;
  /**
   * Connects the MCP protocol server to `transport` (stdio in production,
   * an in-memory pair in tests) and starts serving `initialize`,
   * `tools/list` (every `toolDefinitions()` entry as `{ name,
   * description, inputSchema, annotations }`) and `tools/call` (via
   * `callTool`). Resolves once connected.
   */
  connect(transport: Transport): Promise<void>;
  /** Closes the protocol server and its transport. Idempotent. */
  close(): Promise<void>;
}

/**
 * Locates the board once and prepares the server; serves nothing until
 * `connect`. Never writes to stdout.
 *
 * @throws BoardError exit 2, reason `board-not-found`, from `findBoard`,
 *   whose message names the path looked at, when there is no board.
 */
export function createMcpServer(options: McpServerOptions): BoardMcpServer {
  void options;
  throw new Error('not implemented');
}

/** The process surroundings of `serveMcp`. */
export interface McpIo extends McpServerOptions {
  /** Protocol input (the process stdin). */
  stdin: Readable;
  /** Protocol output (the process stdout): only protocol messages. */
  stdout: Writable;
  /** Aborting it stops the server (SIGINT or SIGTERM for the CLI). */
  signal?: AbortSignal;
}

/**
 * Runs `agentboard mcp` and returns its exit code.
 *
 * `createMcpServer`; on failure, stderr receives `agentboard: <message>`
 * and a newline, nothing is written to `stdout`, and the result is the
 * error's exit code (`exitCodeFor`: 2 when there is no board) before any
 * request is read. Otherwise it connects over the SDK's stdio server
 * transport on `stdin` and `stdout` and serves until `stdin` ends (the
 * client went away) or `signal` aborts, then closes the server and
 * resolves 0.
 */
export function serveMcp(io: McpIo): Promise<ExitCode> {
  void io;
  return Promise.reject(new Error('not implemented'));
}
