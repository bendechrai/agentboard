/**
 * The hook events through the built CLI (add-harness-integration task
 * 2.1; board-harness-hooks "Session start hook", "Stop hook",
 * "Pre-tool-use claim check"): the answers reach the harness as the
 * protocol wants them (one JSON document on stdout, or exit 2 with the
 * reason on stderr), the inbox cursor advances across processes, and the
 * pre-tool-use rate limit is kept across processes in the OS temporary
 * directory (`TMPDIR`, a scratch directory here, never the real one).
 * The detail of each answer is pinned in process by
 * src/board/__tests__/hook-events.test.ts.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ev, P, putEvent, T1 } from '../store/__tests__/helpers.js';
import {
  boardProject,
  cliEnv,
  oneDocument,
  requireBuiltCli,
  runCliAsync,
  scratchDir,
  type RunEnv,
} from './harness/processes.js';

/** Every test spawns several CLI processes; a loaded machine needs time. */
const SLOW = { timeout: 120_000 };

/** A finished hook process. */
interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `node dist/cli.js hook <argv>` in `cwd` with `stdin` as its payload. */
function hookProcess(argv: readonly string[], cwd: string, stdin: string, env: RunEnv): HookRun {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  const result = spawnSync(process.execPath, [requireBuiltCli(), 'hook', ...argv], {
    cwd,
    env: childEnv,
    input: stdin,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A project whose board has T1 created by orch and claimed by impl, cache built. */
async function claimedProject(): Promise<{ root: string; boardDir: string }> {
  const { root, boardDir, eventsDir } = boardProject();
  const now = Date.now();
  putEvent(eventsDir, ev(P.create(T1, 'Held work'), 'orch', now - 60_000));
  putEvent(eventsDir, ev(P.claim(T1), 'impl', now - 50_000));
  const listed = await runCliAsync(['list', '--json'], root, cliEnv());
  expect(listed.code, listed.stderr).toBe(0);
  return { root, boardDir };
}

/** The environment of a hook process: no actor, its temporary directory `tmp`. */
function env(tmp: string): RunEnv {
  return cliEnv({ AGENTBOARD_HOOKS: undefined, TMPDIR: tmp });
}

describe('session-start through the built CLI', SLOW, () => {
  it('prints the SessionStart context with the held ticket and the inbox, and advances the cursor', async () => {
    const { root } = await claimedProject();
    const tmp = scratchDir();
    const payload = JSON.stringify({
      session_id: 'p-1',
      cwd: root,
      hook_event_name: 'SessionStart',
    });
    const first = hookProcess(['session-start', '--as', 'impl'], root, payload, env(tmp));
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toBe('');
    const doc = oneDocument({ ...first, signal: null }) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(doc.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const lines = doc.hookSpecificOutput.additionalContext.replace(/\n$/, '').split('\n');
    expect(lines[0]).toContain(`${T1} impl`);
    expect(lines.slice(1).some((l) => l.includes('ticket.claim'))).toBe(true);

    const second = hookProcess(['session-start', '--as', 'impl'], root, payload, env(tmp));
    const again = oneDocument({ ...second, signal: null }) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(again.hookSpecificOutput.additionalContext.replace(/\n$/, '').split('\n')).toEqual([
      lines[0],
    ]);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe('stop through the built CLI', SLOW, () => {
  it('strict blocks once with the reason on stderr; with stop_hook_active it continues with a systemMessage', async () => {
    const { root } = await claimedProject();
    const tmp = scratchDir();
    const stop = (active: boolean): string =>
      JSON.stringify({
        session_id: 'p-1',
        cwd: root,
        hook_event_name: 'Stop',
        stop_hook_active: active,
      });
    const blocked = hookProcess(['stop', '--strict', '--as', 'impl'], root, stop(false), env(tmp));
    expect(blocked.code).toBe(2);
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr).toContain(T1);
    expect(blocked.stderr).toContain('agentboard handoff');

    const again = hookProcess(['stop', '--strict', '--as', 'impl'], root, stop(true), env(tmp));
    expect(again.code).toBe(0);
    expect(again.stderr).toBe('');
    const doc = oneDocument({ ...again, signal: null }) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['systemMessage']);
    expect(`${String(doc.systemMessage)}\n`).toBe(blocked.stderr);
  });
});

describe('pre-tool-use through the built CLI', SLOW, () => {
  it('warns once per session across processes, with the state in TMPDIR; strict blocks every time', async () => {
    const { root } = await claimedProject();
    const tmp = scratchDir();
    const edit = (session: string): string =>
      JSON.stringify({
        session_id: session,
        cwd: root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: join(root, 'src', 'a.ts'), old_string: 'a', new_string: 'b' },
      });

    const first = hookProcess(['pre-tool-use', '--as', 'nobody'], root, edit('p-1'), env(tmp));
    expect(first.code, first.stderr).toBe(0);
    const doc = oneDocument({ ...first, signal: null }) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(doc.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(doc.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(String(doc.hookSpecificOutput.additionalContext)).toContain('agentboard claim');

    const name = `agentboard-hook-${createHash('sha256').update('p-1').digest('hex')}`;
    expect(readdirSync(tmp)).toEqual([name]);
    expect(readFileSync(join(tmp, name), 'utf8').trim()).toMatch(/^\d+$/);

    const second = hookProcess(['pre-tool-use', '--as', 'nobody'], root, edit('p-1'), env(tmp));
    expect(second).toEqual({ code: 0, stdout: '', stderr: '' });

    for (let i = 0; i < 2; i += 1) {
      const strict = hookProcess(
        ['pre-tool-use', '--strict', '--as', 'nobody'],
        root,
        edit('p-1'),
        env(tmp),
      );
      expect(strict.code).toBe(2);
      expect(strict.stdout).toBe('');
      expect(strict.stderr).toContain('agentboard claim');
    }

    const held = hookProcess(
      ['pre-tool-use', '--strict', '--as', 'impl'],
      root,
      edit('p-2'),
      env(tmp),
    );
    expect(held).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readdirSync(tmp)).toEqual([name]);
  });
});
