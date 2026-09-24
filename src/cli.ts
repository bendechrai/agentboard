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
 */

// Installed before the CLI module (and with it node:sqlite) is loaded.
// Removing the default listeners also removes Node's own printing, so every
// other warning is printed here in Node's format.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) {
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
