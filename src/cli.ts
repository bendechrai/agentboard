/**
 * CLI entry point for agentboard: runs `runCli` with the real process and
 * sets the exit code (without `process.exit`, so stdout is flushed).
 */

import { runCli } from './cli/main.js';

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
