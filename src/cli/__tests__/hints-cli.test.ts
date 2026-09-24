/**
 * Error hints at the CLI (board-agent-guidance: "Error hints";
 * add-agent-guidance task 2.2): every refusal prints `agentboard:
 * <message>` then `hint: <hint>` on stderr, the `--json` error document
 * carries the same hint, and the spec scenarios (claim race loser, missing
 * actor, needs-task-link, the decision rule on close) name the command
 * that moves the caller forward. The hint texts themselves are pinned in
 * src/guidance/__tests__/hints.test.ts; here they must match what the CLI
 * prints, with the id and actor of the invocation filled in.
 */

import { describe, expect, it } from 'vitest';

import { renderHint } from '../../guidance/hints.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import { cliEnv, oneJson, project, run, spawnCli, written, type Run } from './cli-helpers.js';

const TASK = 'openspec:add-agent-guidance#2';

/** A fresh board with one ticket created by `orch`; returns its full id. */
function withTicket(extra: readonly string[] = ['--task', TASK]): { root: string; id: string } {
  const { root } = project();
  const out = run(['new', 'A ticket', ...extra, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return { root, id: written(out).id };
}

function ok(out: Run): void {
  expect(out.code, out.stderr).toBe(0);
}

/**
 * The hint of a failed run: stderr is `agentboard: <message>` (the message
 * may span several lines) then exactly one `hint: <hint>` line, last, each
 * line ending with a newline.
 */
function hintOf(out: Run): string {
  expect(out.code).not.toBe(0);
  expect(out.stderr).toMatch(/^agentboard: \S/);
  expect(out.stderr.endsWith('\n')).toBe(true);
  const lines = out.stderr.slice(0, -1).split('\n');
  const hints = lines.filter((line) => line.startsWith('hint: '));
  expect(hints, out.stderr).toHaveLength(1);
  const last = lines.at(-1) ?? '';
  expect(last).toMatch(/^hint: \S/);
  return last.slice('hint: '.length);
}

/** The `--json` error document of a failed run. */
function errorOf(out: Run): {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
} {
  return (
    oneJson(out) as {
      error: { exitCode: number; reason: string | null; message: string; hint: string | null };
    }
  ).error;
}

describe('scenario: claim race loser is told what to do', () => {
  it('prints a hint naming agentboard inbox --as reviewer and agentboard show <id>', () => {
    const { root, id } = withTicket();
    ok(run(['claim', id, '--as', 'impl'], root));
    const out = run(['claim', id, '--as', 'reviewer'], root);
    expect(out.code).toBe(4);
    expect(out.stdout).toBe('');
    const hint = hintOf(out);
    expect(hint).toContain("'agentboard inbox --as reviewer'");
    expect(hint).toContain(`'agentboard show ${id}'`);
    expect(hint).toBe(
      renderHint('already-assigned', { surface: 'cli', command: 'claim', id, actor: 'reviewer' }),
    );
  });

  it('uses the id prefix as given and the actor from AGENTBOARD_ACTOR', () => {
    const { root, id } = withTicket();
    ok(run(['claim', id, '--as', 'impl'], root));
    const prefix = id.slice(0, 8);
    const out = run(['claim', prefix], root, cliEnv({ AGENTBOARD_ACTOR: 'reviewer' }));
    expect(out.code).toBe(4);
    const hint = hintOf(out);
    expect(hint).toContain("'agentboard inbox --as reviewer'");
    expect(hint).toContain(`'agentboard show ${prefix}'`);
  });

  it('the --json error document carries the same hint', () => {
    const { root, id } = withTicket();
    ok(run(['claim', id, '--as', 'impl'], root));
    const out = run(['claim', id, '--as', 'reviewer', '--json'], root);
    expect(out.code).toBe(4);
    const error = errorOf(out);
    expect(error).toMatchObject({ exitCode: 4, reason: 'already-assigned' });
    expect(error.message).toContain('impl');
    expect(error.hint).toBe(hintOf(out));
  });

  it('through the built CLI', () => {
    const { root, id } = withTicket();
    ok(spawnCli(['claim', id, '--as', 'impl'], root));
    const out = spawnCli(['claim', id, '--as', 'reviewer'], root);
    expect(out.code).toBe(4);
    expect(out.stderr).toMatch(/^hint: .*'agentboard inbox --as reviewer'/m);
  });
});

describe('scenario: missing actor', () => {
  it('hints both --as and AGENTBOARD_ACTOR', () => {
    const { root, id } = withTicket();
    const out = run(['comment', id, 'hi'], root);
    expect(out.code).toBe(1);
    const hint = hintOf(out);
    expect(hint).toContain('--as <actor>');
    expect(hint).toContain('AGENTBOARD_ACTOR');
    expect(hint).not.toContain('agentboard mcp');
    expect(errorOf(run(['comment', id, 'hi', '--json'], root))).toMatchObject({
      exitCode: 1,
      reason: 'missing-actor',
      hint,
    });
  });

  it('hints even where there is no board (the actor is checked first)', () => {
    const hint = hintOf(run(['claim', '01J9K3'], tempDir()));
    expect(hint).toContain('AGENTBOARD_ACTOR');
  });
});

describe('scenario: needs-task-link', () => {
  it('an ad hoc ticket entering implementing hints link --task', () => {
    const { root, id } = withTicket(['--adhoc', 'found in CI']);
    ok(run(['claim', id, '--as', 'impl'], root));
    ok(run(['move', id, 'tests', '--as', 'impl'], root));
    const out = run(['move', id, 'implementing', '--as', 'impl'], root);
    expect(out.code).toBe(4);
    expect(hintOf(out)).toContain(`'agentboard link ${id} --task <source>:<ref>#<item> --as impl'`);
    const viaHandoff = run(
      ['handoff', id, '--to', 'impl2', '--status', 'implementing', '--note', 'go', '--as', 'impl'],
      root,
    );
    expect(viaHandoff.code).toBe(4);
    expect(hintOf(viaHandoff)).toContain(`'agentboard link ${id} --task <source>:<ref>#<item>`);
  });
});

describe('scenario: the decision rule on close', () => {
  /** A blocked ticket with an unretracted DECISION: comment. */
  function decided(): { root: string; id: string } {
    const { root, id } = withTicket();
    ok(run(['claim', id, '--as', 'impl'], root));
    ok(run(['comment', id, 'DECISION: ids are ULIDs', '--as', 'impl'], root));
    ok(run(['move', id, 'blocked', '--as', 'impl'], root));
    return { root, id };
  }

  it('close --no-decision with a DECISION: comment hints --decision-recorded-in <path>', () => {
    const { root, id } = decided();
    const out = run(['close', id, '--no-decision', '--as', 'orch'], root);
    expect(out.code).toBe(1);
    const hint = hintOf(out);
    expect(hint).toContain(`'agentboard close ${id} --decision-recorded-in <path> --as orch'`);
    expect(hint).toContain(`'agentboard show ${id}'`);
    expect(hint).toContain('RETRACTED:');
  });

  it('close with no disposition hints both dispositions', () => {
    const { root, id } = decided();
    const out = run(['close', id, '--as', 'orch'], root);
    expect(out.code).toBe(1);
    const hint = hintOf(out);
    expect(hint).toContain('--decision-recorded-in <path> --as orch');
    expect(hint).toContain('--no-decision --as orch');
    expect(errorOf(run(['close', id, '--as', 'orch', '--json'], root))).toMatchObject({
      reason: 'no-disposition',
      hint,
    });
  });

  it('close naming a missing decision record hints --decision-recorded-in <path>', () => {
    const { root, id } = decided();
    const out = run(
      ['close', id, '--decision-recorded-in', 'docs/adr/missing.md', '--as', 'orch'],
      root,
    );
    expect(out.code).toBe(1);
    expect(hintOf(out)).toContain(
      `'agentboard close ${id} --decision-recorded-in <path> --as orch'`,
    );
  });
});

describe('every refusal prints a hint line after the message', () => {
  it.each([
    [
      'an unknown ticket (exit 4)',
      (root: string) => run(['show', '01NOPE00'], root),
      4,
      "'agentboard list'",
    ],
    [
      'an unknown flag (exit 1)',
      (root: string) => run(['claim', '01J9K3', '--bogus', '--as', 'a'], root),
      1,
      "'agentboard help claim'",
    ],
    [
      'an unknown command (exit 1)',
      (root: string) => run(['frobnicate'], root),
      1,
      "'agentboard help'",
    ],
    [
      'an id prefix too short (exit 1)',
      (root: string) => run(['show', '01J'], root),
      1,
      "'agentboard list'",
    ],
    [
      'an invalid transition (exit 4)',
      (root: string) => {
        const out = run(['new', 'x', '--task', TASK, '--as', 'o', '--json'], root);
        return run(['move', written(out).id, 'review', '--as', 'o'], root);
      },
      4,
      "'agentboard help move'",
    ],
    [
      'secret-like text (exit 1)',
      (root: string) => {
        const out = run(['new', 'x', '--task', TASK, '--as', 'o', '--json'], root);
        return run(
          ['comment', written(out).id, '--as', 'o', '--', '-----BEGIN PRIVATE KEY-----'],
          root,
        );
      },
      1,
      '--allow-secret-like',
    ],
  ])('%s', (_name, act, code, fragment) => {
    const out = act(project().root);
    expect(out.code).toBe(code);
    expect(hintOf(out)).toContain(fragment);
  });

  it('no board (exit 2) hints agentboard init', () => {
    const out = run(['list'], tempDir());
    expect(out.code).toBe(2);
    expect(hintOf(out)).toContain("'agentboard init'");
  });

  it('a help usage error hints the overview, not help help', () => {
    const out = run(['help', 'claim', 'extra'], tempDir());
    expect(out.code).toBe(1);
    const hint = hintOf(out);
    expect(hint).toContain("'agentboard help'");
    expect(hint).not.toContain("'agentboard help help'");
  });

  it('a success prints no hint', () => {
    const { root, id } = withTicket();
    const out = run(['show', id], root);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
  });
});
