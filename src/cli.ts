/**
 * CLI entry point for agentboard: runs `runCli` with the real process and
 * sets the exit code (without `process.exit`, so stdout is flushed).
 *
 * `mcp` (task group 9): when `parseArgs(argv)` succeeds and names the
 * `mcp` command, the entry point does not call `runCli`; it imports
 * `src/mcp/server.ts` (dynamically, so no other command loads the MCP
 * SDK) and sets the exit code to the awaited `serveMcp({ cwd, env, stdin:
 * process.stdin, stdout: process.stdout, stderr, signal, actor })`, where
 * `actor` is the parsed `--as` value when given (`agentboard mcp --as
 * impl` makes `impl` the server's default actor) and absent otherwise, and
 * `signal` is aborted by SIGINT or SIGTERM (handlers installed only for
 * `mcp`). Every other argv, including one that fails to parse, goes to
 * `runCliAsync` unchanged. The warning filter below applies to `mcp` too, and
 * nothing but protocol messages is written to stdout.
 *
 * Task group 5: every other argv goes to `runCliAsync` (which behaves exactly
 * as `runCli` for every non-streaming command) and awaits it. Its
 * `stopSignal` installs SIGINT and SIGTERM handlers that abort one
 * `AbortController` and returns its signal; they are installed only then,
 * so a non-streaming command keeps Node's default signal behaviour. A
 * `watch` stopped by either signal therefore exits 0 once its stream has
 * closed, with every line it printed flushed.
 *
 * add-board-tui task 2.2: `runCliAsync` also receives `terminal`, which
 * imports `src/tui/terminal.ts` dynamically and returns
 * `processTerminal()` over the real `process.stdin`, `process.stdout` and
 * `process`. `runCliAsync` calls it only for `top`, so no other command
 * loads the terminal driver or touches the terminal. `top` stopped by
 * SIGINT or SIGTERM (the same `stopSignal`) restores the terminal and
 * exits 0; its restore also runs on the process `exit` event, so an
 * uncaught exception leaves the terminal usable.
 *
 * Contract: a successful command writes nothing to stderr. Node prints an
 * `ExperimentalWarning` when `node:sqlite` is loaded; the entry point
 * drops exactly that warning (a warning whose name is `ExperimentalWarning`
 * and whose message mentions SQLite) and still prints every other process
 * warning to stderr. The filter must be in place before `node:sqlite` is
 * loaded (for example by installing it and then importing the CLI module
 * dynamically).
 *
 * Every other warning is printed in Node's own format:
 * `(node:<pid>) [<code>] <name>: <message>` (the `[<code>] ` part only when
 * the warning has a code). When `warningsDisabled(process.execArgv,
 * process.env)` is true (`--no-warnings`, or `NODE_NO_WARNINGS=1`), no
 * warning at all is printed, as Node itself would do.
 */

import { warningsDisabled } from './cli/warnings.js';

// Installed before the CLI module (and with it node:sqlite) is loaded.
// Removing the default listeners also removes Node's own printing, so every
// other warning is printed here in Node's format, unless Node was asked not
// to print warnings at all.
const silent = warningsDisabled(process.execArgv, process.env);
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (silent || (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message))) {
    return;
  }
  const code = 'code' in warning && typeof warning.code === 'string' ? `[${warning.code}] ` : '';
  process.stderr.write(
    `(node:${String(process.pid)}) ${code}${warning.name}: ${warning.message}\n`,
  );
});

const argv = process.argv.slice(2);
const { runCliAsync } = await import('./cli/main.js');
const { parseArgs } = await import('./cli/parse.js');

/** One `AbortController` aborted by SIGINT or SIGTERM; handlers installed on call. */
function stopSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return controller.signal;
}

/** The parsed `mcp` command's `--as`, or null when argv is not `mcp`. */
function mcpInvocation(): { actor: string | undefined } | null {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command.name !== 'mcp') {
      return null;
    }
    const given = parsed.values.as;
    return { actor: typeof given === 'string' ? given : undefined };
  } catch {
    return null;
  }
}

const stderr = (text: string): void => {
  process.stderr.write(text);
};
const mcp = mcpInvocation();

if (mcp !== null) {
  const { serveMcp } = await import('./mcp/server.js');
  process.exitCode = await serveMcp({
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr,
    signal: stopSignal(),
    ...(mcp.actor === undefined ? {} : { actor: mcp.actor }),
  });
} else {
  process.exitCode = await runCliAsync({
    argv,
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr,
    stopSignal,
  });
}
