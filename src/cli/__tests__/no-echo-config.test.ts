/**
 * Configuration repeated in a refusal is escaped (no-echo-refusals review
 * round 1, the AGENTBOARD_DIR note): the board directory named by
 * `AGENTBOARD_DIR` may be repeated in the `board-not-found` refusal
 * (design.md "Out of scope": configuration), but like every other text a
 * refusal repeats it is passed through `asciiText`, so an ESC sequence or
 * a newline in the variable never reaches the terminal raw.
 */

import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../board/__tests__/helpers.js';
import { asciiText } from '../render.js';
import { cliEnv, oneJson, run, spawnCli } from './cli-helpers.js';

// Machines under load: the built CLI is spawned.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ESC = String.fromCharCode(0x1b);

describe('AGENTBOARD_DIR in "no board found"', () => {
  it('is escaped on stderr and in the --json document, in process and in the built CLI', () => {
    const cwd = tempDir();
    const dir = join(cwd, `nope${ESC}[31mred${ESC}]0;title\u0007\nnext`);
    const env = cliEnv({ AGENTBOARD_DIR: dir });
    const message = `no board found at ${asciiText(dir)} (from AGENTBOARD_DIR); run agentboard init to create one`;
    for (const runner of [run, spawnCli]) {
      const plain = runner(['list'], cwd, env);
      expect(plain.code).toBe(2);
      expect(plain.stderr.split('\n')[0]).toBe(`agentboard: ${message}`);
      const json = runner(['list', '--json'], cwd, env);
      expect(json.code).toBe(2);
      expect(oneJson(json)).toMatchObject({ error: { reason: 'board-not-found', message } });
      for (const out of [plain, json]) {
        expect(out.stdout + out.stderr).not.toContain(ESC);
        expect(out.stdout + out.stderr).not.toContain('\u0007');
        expect(out.stderr).toContain('\\u001B[31m');
      }
    }
  });

  it('is escaped when agentboard mcp fails to start', () => {
    const cwd = tempDir();
    const dir = join(cwd, `b${ESC}[2J`);
    const out = spawnCli(['mcp'], cwd, cliEnv({ AGENTBOARD_DIR: dir }));
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).not.toContain(ESC);
    expect(out.stderr).toContain(`no board found at ${asciiText(dir)}`);
  });
});
