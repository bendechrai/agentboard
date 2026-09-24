/**
 * The `agentboard mcp` server (board-cli: "MCP server"; design.md: "MCP
 * server"): the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`)
 * over stdio, one tool per registry command (`toolDefinitions`), each call
 * running the command's own `run` exactly as one CLI invocation does.
 *
 * Board: discovery (`findBoard` with the server's `cwd` and `env`) runs
 * once, at start-up, and fixes the board directory for the server's
 * lifetime; no board there means the server never serves and exits 2.
 * Each tool call then opens that directory with `openBoard` and closes it
 * when the call ends, exactly as one CLI invocation does.
 *
 * Freshness, precisely: a writing tool is kept fresh by the store, not by
 * the open. `runCommand` runs catch-up inside its own `BEGIN IMMEDIATE`
 * transaction, before it validates, so every event file written since, by
 * any process, is folded under the write lock; `inbox` and the other
 * commands that call `catchUp` themselves are fresh the same way. The
 * cache-only reads (`show`, `list`) do not catch up by themselves: for
 * them it is the catch-up that `openBoard` runs at each call's open that
 * folds what other processes wrote. So a handle held for the whole session
 * would still write correctly, and would only serve stale reads.
 *
 * The per-call open exists for three reasons: it gives each read that
 * catch-up; it gives each call its own open diagnostics (reaped temporary
 * files and corrupt event files, printed to stderr for the call that met
 * them); and it bounds the lifetime of the SQLite handle to one call, so
 * no connection is held between calls (a cache file deleted or replaced
 * between calls is reopened, not written through a stale handle, and a
 * board removed after start-up is reported as exit 2 by the next call).
 *
 * Every write runs through the same `runCommand` single `BEGIN IMMEDIATE`
 * transaction as the CLI, so MCP and CLI writers race safely
 * (board-concurrency).
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { LazyBoard, commandActor, errorDocument, exitCodeFor, runContext } from '../cli/main.js';
import type { Env } from '../cli/types.js';
import { BoardError, type ExitCode } from '../store/errors.js';
import { findBoard } from '../store/locate.js';
import { VERSION } from '../version.js';
import { findTool, toolArguments, toolDefinitions } from './tools.js';

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
  const boardDir = findBoard({ cwd: options.cwd, env: options.env }).dir;
  const mcp = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );
  const callTool = (name: string, args: unknown): ToolCallResult =>
    runTool(options, boardDir, name, args);
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolDefinitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: tool.inputSchema.type,
        properties: { ...tool.inputSchema.properties },
        required: [...tool.inputSchema.required],
        additionalProperties: tool.inputSchema.additionalProperties,
      },
      annotations: { ...tool.annotations },
    })),
  }));
  // Spread: the SDK's result type has an index signature, which an
  // interface does not implicitly satisfy.
  mcp.server.setRequestHandler(CallToolRequestSchema, (request) => ({
    ...callTool(request.params.name, request.params.arguments),
  }));
  let closed = false;
  return {
    boardDir,
    callTool,
    connect: (transport) => mcp.connect(transport),
    close: async () => {
      if (!closed) {
        closed = true;
        await mcp.close();
      }
    },
  };
}

/** Steps 1 to 6 of `BoardMcpServer.callTool`. Never throws. */
function runTool(
  options: McpServerOptions,
  boardDir: string,
  name: string,
  args: unknown,
): ToolCallResult {
  const opened = new LazyBoard(
    () => boardDir,
    (text) => {
      options.stderr(text);
    },
  );
  try {
    const tool = findTool(name);
    if (tool === undefined) {
      throw new BoardError(1, 'usage', `unknown tool ${JSON.stringify(name)}`);
    }
    const { command } = tool;
    const values = toolArguments(command, args);
    const given = values.as;
    const actor = commandActor(
      command,
      typeof given === 'string' && given !== '' ? given : options.actor,
      options.env,
    );
    const output = command.run(runContext(options.cwd, options.env, actor, opened), values);
    const warnings = output.warnings ?? [];
    for (const line of warnings) {
      options.stderr(`agentboard: ${line}\n`);
    }
    if (output.exitCode !== undefined) {
      return toolError({ exitCode: output.exitCode, reason: null, message: warnings.join('; ') });
    }
    const json: unknown = output.json;
    return {
      content: [{ type: 'text', text: JSON.stringify(json) }],
      structuredContent: isObject(json) ? json : { items: json },
    };
  } catch (error) {
    const { error: content } = errorDocument(error);
    if (content.exitCode === 5) {
      options.stderr(`agentboard: ${content.message}\n`);
    }
    return toolError(content);
  } finally {
    opened.close();
  }
}

/** A JSON object (not an array, not null). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The failed `ToolCallResult` for `content`. */
function toolError(content: ToolErrorContent): ToolCallResult {
  return {
    content: [{ type: 'text', text: content.message }],
    structuredContent: { ...content },
    isError: true,
  };
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
 * transport on `stdin` and `stdout` and serves until `stdin` ends or
 * closes (the client went away), `stdout` emits an error (a broken pipe),
 * `stdin` emits an error, or `signal` aborts, then closes the server (the
 * transport stops listening on `stdin`) and resolves 0.
 *
 * A `stdin` error is a shutdown, not a crash: it never escapes as an
 * uncaught exception or a rejection. It writes exactly one diagnostic line
 * to stderr, `agentboard: ` followed by a message naming stdin and
 * including the error's message (for example `agentboard: stdin error:
 * <message>`) and a newline, however many times the stream reports errors
 * or closes afterwards, and still resolves 0: the session ended because
 * the client's side of the pipe failed, and every answer already sent
 * stands. Nothing but protocol messages is ever written to `stdout`.
 *
 * Under the CLI (`src/cli.ts`), SIGINT and SIGTERM abort `signal`, so a
 * signal after an initialize exchange ends the process with exit code 0,
 * nothing on stderr and only protocol messages on stdout; nothing left
 * behind keeps the event loop alive.
 */
export async function serveMcp(io: McpIo): Promise<ExitCode> {
  let server: BoardMcpServer;
  try {
    server = createMcpServer(io);
  } catch (error) {
    io.stderr(`agentboard: ${error instanceof Error ? error.message : String(error)}\n`);
    return exitCodeFor(error);
  }
  const { stdin, stdout, signal } = io;
  let stop = (): void => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  // A client that goes away ends stdin; a broken stdout pipe means the same.
  const onEnd = (): void => {
    stop();
  };
  stdin.once('end', onEnd);
  stdin.once('close', onEnd);
  stdout.on('error', onEnd);
  signal?.addEventListener('abort', onEnd, { once: true });
  try {
    if (signal?.aborted !== true) {
      await server.connect(new StdioServerTransport(stdin, stdout));
      await stopped;
      // Let the answers to requests read just before the end go out.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
    stdout.off('error', onEnd);
    signal?.removeEventListener('abort', onEnd);
    await server.close();
  }
  return 0;
}
