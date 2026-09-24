/**
 * `inbox` and `watch` through the CLI (board-cli: "Command surface",
 * "Actor is explicit", "Output conventions", "Exit codes";
 * board-openspec-integration: "Inbox shows a handoff"). Task group 5.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { InboxEntry, InboxResult } from '../../board/inbox.js';
import { P, T1, ev } from '../../store/__tests__/helpers.js';
import { putEvent, tempDir } from '../../board/__tests__/helpers.js';
import { runCliAsync, type AsyncCliIo } from '../main.js';
import { renderInboxLine } from '../render.js';
import {
  cliEnv,
  oneJson,
  project,
  run,
  spawnCli,
  written,
  type Run,
  type RunEnv,
} from './cli-helpers.js';

const TASK3 = ['--task', 'openspec:add-board-core#3'];

function inbox(out: Run): InboxResult {
  return oneJson(out) as InboxResult;
}

/** A project with one ticket moved to implementing and claimed by impl. */
function implementing(): { root: string; boardDir: string; id: string } {
  const { root, boardDir } = project();
  const id = written(run(['new', 'T', ...TASK3, '--as', 'orch', '--json'], root)).id;
  run(['move', id, 'tests', '--as', 'orch'], root);
  run(['move', id, 'implementing', '--as', 'orch'], root);
  run(['claim', id, '--as', 'impl'], root);
  return { root, boardDir, id };
}

function entry(partial: Partial<InboxEntry>): InboxEntry {
  return {
    hash: 'a'.repeat(64),
    kind: 'ticket.claim',
    ticket: T1,
    from: 'impl',
    ts: { wall: 1, counter: 0, actor: 'impl' },
    to: null,
    status: null,
    note: null,
    event: ev(P.claim(T1), 'impl', 1),
    ...partial,
  };
}

describe('renderInboxLine', () => {
  it('prints ticket, kind and actor, then only the fields that are set', () => {
    expect(renderInboxLine(entry({}))).toBe(`${T1}  ticket.claim  impl`);
    expect(
      renderInboxLine(
        entry({ kind: 'ticket.handoff', to: 'reviewer', status: 'review', note: 'done' }),
      ),
    ).toBe(`${T1}  ticket.handoff  impl  to reviewer  status review  note done`);
    expect(renderInboxLine(entry({ kind: 'ticket.move', status: 'tests' }))).toBe(
      `${T1}  ticket.move  impl  status tests`,
    );
    expect(renderInboxLine(entry({ kind: 'board.meta', ticket: null, from: 'orch' }))).toBe(
      '-  board.meta  orch',
    );
  });

  it('keeps user text plain ASCII on one line', () => {
    const line = renderInboxLine(entry({ kind: 'ticket.comment', from: 'r\u00e9v', note: 'a\nb' }));
    expect(line).toBe(`${T1}  ticket.comment  r\\u00E9v  note a\\u000Ab`);
  });
});

describe('agentboard inbox', () => {
  it('shows a handoff to the orchestrator with ticket, from, to, status and note, then nothing new', () => {
    const { root, id } = implementing();
    const handed = written(
      run(
        [
          'handoff',
          id,
          '--as',
          'impl',
          '--to',
          'reviewer',
          '--status',
          'review',
          '--note',
          'done',
          '--json',
        ],
        root,
      ),
    );
    const first = run(['inbox', '--as', 'orchestrator', '--json'], root);
    expect(first.code, first.stderr).toBe(0);
    const doc = inbox(first);
    expect(doc.actor).toBe('orchestrator');
    expect(doc.entries.find((e) => e.kind === 'ticket.handoff')).toMatchObject({
      hash: handed.hash,
      ticket: id,
      from: 'impl',
      to: 'reviewer',
      status: 'review',
      note: 'done',
    });
    expect(doc.cursor).toBe(handed.hash);
    const second = inbox(run(['inbox', '--as', 'orchestrator', '--json'], root));
    expect(second.entries).toEqual([]);
    expect(second.advanced).toBe(false);
  });

  it('prints one human line per entry, and nothing when there is nothing new', () => {
    const { root } = implementing();
    const peek = inbox(run(['inbox', '--as', 'orch', '--peek', '--json'], root));
    const human = run(['inbox', '--as', 'orch'], root);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe(peek.entries.map((e) => `${renderInboxLine(e)}\n`).join(''));
    expect(human.stderr).toBe('');
    const again = run(['inbox', '--as', 'orch'], root);
    expect(again).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('prints exactly one JSON document with --json', () => {
    const { root } = implementing();
    const out = run(['inbox', '--as', 'orch', '--json'], root);
    const doc = inbox(out);
    expect(doc.entries.map((e) => e.kind)).toEqual([
      'ticket.create',
      'ticket.move',
      'ticket.move',
      'ticket.claim',
    ]);
    expect(doc.advanced).toBe(true);
    expect(typeof doc.cursor).toBe('string');
  });

  it('--peek does not advance: two peeks return the same events', () => {
    const { root } = implementing();
    const a = inbox(run(['inbox', '--as', 'orch', '--peek', '--json'], root));
    const b = inbox(run(['inbox', '--as', 'orch', '--peek', '--json'], root));
    expect(a.entries).toHaveLength(4);
    expect(b).toEqual(a);
    expect(inbox(run(['inbox', '--as', 'orch', '--json'], root)).entries).toEqual(a.entries);
  });

  it('--since lists what follows an event without acknowledging', () => {
    const { root } = implementing();
    const all = inbox(run(['inbox', '--as', 'orch', '--peek', '--json'], root)).entries;
    const since = inbox(
      run(['inbox', '--as', 'orch', '--since', String(all[1]?.hash), '--json'], root),
    );
    expect(since.entries.map((e) => e.hash)).toEqual(all.slice(2).map((e) => e.hash));
    expect(inbox(run(['inbox', '--as', 'orch', '--json'], root)).entries).toHaveLength(4);
  });

  it('exits 1 for a malformed or unknown --since', () => {
    const { root } = implementing();
    const bad = run(['inbox', '--as', 'orch', '--since', 'nope', '--json'], root);
    expect(bad.code).toBe(1);
    expect(oneJson(bad)).toMatchObject({ error: { exitCode: 1, reason: 'usage' } });
    const unknown = run(['inbox', '--as', 'orch', '--since', 'e'.repeat(64)], root);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('agentboard: ');
  });

  it('requires an actor, naming both ways to give one, before looking for a board', () => {
    const out = run(['inbox', '--json'], tempDir());
    expect(out.code).toBe(1);
    const doc = oneJson(out) as { error: { reason: string; message: string } };
    expect(doc.error.reason).toBe('missing-actor');
    expect(doc.error.message).toContain('--as');
    expect(doc.error.message).toContain('AGENTBOARD_ACTOR');
  });

  it('takes the actor from AGENTBOARD_ACTOR', () => {
    const { root } = implementing();
    const env = cliEnv({ AGENTBOARD_ACTOR: 'orch' });
    expect(inbox(run(['inbox', '--json'], root, env)).entries).toHaveLength(4);
    expect(inbox(run(['inbox', '--as', 'orch', '--json'], root)).entries).toEqual([]);
  });

  it('writes no event', () => {
    const { root, boardDir } = implementing();
    const before = readdirSync(join(boardDir, 'events')).sort();
    expect(run(['inbox', '--as', 'orch'], root).code).toBe(0);
    expect(readdirSync(join(boardDir, 'events')).sort()).toEqual(before);
  });

  it('exits 2 when there is no board', () => {
    const out = run(['inbox', '--as', 'orch'], tempDir());
    expect(out.code).toBe(2);
  });

  it('keeps the cursor across processes (built CLI)', { timeout: 30_000 }, () => {
    const { root } = implementing();
    const first = spawnCli(['inbox', '--as', 'orch', '--json'], root);
    expect(first.code, first.stderr).toBe(0);
    expect(inbox(first).entries).toHaveLength(4);
    const second = spawnCli(['inbox', '--as', 'orch', '--json'], root);
    expect(second.code, second.stderr).toBe(0);
    expect(inbox(second).entries).toEqual([]);
  });

  it('delivers a late-arriving event with an earlier timestamp', () => {
    const { root, boardDir } = project();
    putEvent(join(boardDir, 'events'), ev(P.create(T1), 'orch', 1000));
    putEvent(join(boardDir, 'events'), ev(P.comment(T1, 'at 2000'), 'impl', 2000));
    expect(inbox(run(['inbox', '--as', 'orch', '--json'], root)).entries).toHaveLength(2);
    const late = putEvent(join(boardDir, 'events'), ev(P.comment(T1, 'at 1500'), 'remote', 1500));
    const next = inbox(run(['inbox', '--as', 'orch', '--json'], root));
    expect(next.entries.map((e) => e.hash)).toEqual([late]);
  });
});

/** Runs `runCliAsync` in process; `signal` is what `stopSignal` returns. */
async function runAsync(
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
  env: RunEnv = cliEnv(),
): Promise<Run & { stops: number }> {
  let stdout = '';
  let stderr = '';
  let stops = 0;
  const io: AsyncCliIo = {
    argv,
    cwd,
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stopSignal: () => {
      stops += 1;
      return signal;
    },
  };
  const code = await runCliAsync(io);
  return { code, stdout, stderr, stops };
}

function stopped(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe('agentboard watch', () => {
  it('refuses to run through the synchronous runCli, with one JSON document', () => {
    const { root } = implementing();
    const out = run(['watch', '--as', 'orch', '--json'], root);
    expect(out.code).toBe(1);
    expect(oneJson(out)).toMatchObject({ error: { exitCode: 1, reason: 'streaming-command' } });
  });

  it('streams pending entries as NDJSON, one entry per line, and exits 0 when stopped', async () => {
    const { root } = implementing();
    const peek = inbox(run(['inbox', '--as', 'orch', '--peek', '--json'], root));
    const out = await runAsync(['watch', '--as', 'orch', '--json'], root, stopped());
    expect(out.code, out.stderr).toBe(0);
    expect(out.stops).toBe(1);
    const lines = out.stdout.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(peek.entries);
    expect(out.stderr).toBe('');
  });

  it('streams human lines without --json', async () => {
    const { root } = implementing();
    const peek = inbox(run(['inbox', '--as', 'orch', '--peek', '--json'], root));
    const out = await runAsync(['watch', '--as', 'orch'], root, stopped());
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(peek.entries.map((e) => `${renderInboxLine(e)}\n`).join(''));
  });

  it('does not advance the cursor', async () => {
    const { root } = implementing();
    await runAsync(['watch', '--as', 'orch'], root, stopped());
    expect(inbox(run(['inbox', '--as', 'orch', '--json'], root)).entries).toHaveLength(4);
  });

  it('requires an actor and exits 1 before streaming', async () => {
    const out = await runAsync(['watch', '--json'], tempDir(), stopped());
    expect(out.code).toBe(1);
    expect(out.stops).toBe(0);
    expect(oneJson(out)).toMatchObject({ error: { reason: 'missing-actor' } });
  });

  it('exits 2 with one error line when there is no board', async () => {
    const out = await runAsync(['watch', '--as', 'orch', '--json'], tempDir(), stopped());
    expect(out.code).toBe(2);
    expect(oneJson(out)).toMatchObject({ error: { exitCode: 2 } });
    expect(out.stderr).toContain('agentboard: ');
  });
});

describe('runCliAsync for other commands', () => {
  it('behaves exactly as runCli and never asks for a stop signal', async () => {
    const { root } = implementing();
    for (const argv of [
      ['version', '--json'],
      ['list', '--json'],
      ['show', 'nope', '--json'],
      ['claim', '--json'],
      ['inbox', '--as', 'orch', '--peek'],
    ]) {
      const sync = run(argv, root);
      const async = await runAsync(argv, root, stopped());
      expect(
        { code: async.code, stdout: async.stdout, stderr: async.stderr },
        argv.join(' '),
      ).toEqual(sync);
      expect(async.stops).toBe(0);
    }
  });
});
