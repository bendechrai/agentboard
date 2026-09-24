/**
 * CLI entry point for agentboard: runs `runCli` with the real process and
 * sets the exit code (without `process.exit`, so stdout is flushed).
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

const { runCli } = await import('./cli/main.js');

process.exitCode = runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
});
