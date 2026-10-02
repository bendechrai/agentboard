/**
 * Crash recovery (board-concurrency: "Crash consistency"; board-cache:
 * "Crash between file and commit"): a writing CLI process is paused with
 * `AGENTBOARD_TEST_PAUSE` at a point of its event write and killed there
 * with SIGKILL; the next command must recover without human action.
 *
 * - `after-rename`: the event file is in place under its hash name but the
 *   cache transaction never committed. The next command folds it exactly
 *   as if the killed command had completed.
 * - `after-temp-write`: only a temporary file exists. No hash-named file is
 *   created, the ticket is unchanged, every command ignores the temporary
 *   file, and the first command that runs once it is older than one minute
 *   removes it and reports it. Age is controlled by setting the file's
 *   mtime (`utimesSync`), never by waiting.
 */

import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { Ticket } from '../events/fold.js';
import { canon, eventNames, foldDir } from '../store/__tests__/helpers.js';
import {
  boardProject,
  cliEnv,
  oneDocument,
  runCliAsync,
  startCli,
  waitForPause,
  type PausePoint,
} from './harness/processes.js';

const TASK = ['--task', 'openspec:add-board-core#4'];

async function newTicket(root: string): Promise<string> {
  const out = await runCliAsync(['new', 'Fragile', ...TASK, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: { id: string } }).ticket.id;
}

async function show(root: string, id: string): Promise<{ ticket: Ticket; events: number }> {
  const out = await runCliAsync(['show', id, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return oneDocument(out) as { ticket: Ticket; events: number };
}

/** Starts `argv` paused at `point`, waits for the pause, kills it; returns the printed path. */
async function killAt(root: string, argv: string[], point: PausePoint): Promise<string> {
  const proc = startCli({ argv, env: cliEnv({ AGENTBOARD_TEST_PAUSE: point }) }, root);
  const path = await waitForPause(proc, point);
  const result = await proc.kill();
  expect(result.signal).toBe('SIGKILL');
  expect(result.stdout).toBe('');
  return path;
}

/** Entries of the events directory whose name starts with `.tmp-`. */
function temps(eventsDir: string): string[] {
  return readdirSync(eventsDir).filter((name) => name.startsWith('.tmp-'));
}

// The tests run the built CLI as child processes (several for some), which
// on a loaded machine can come close to vitest's 5 second default.
const PROCESSES = { timeout: 30_000 };

describe('scenario: killed after rename, before commit', PROCESSES, () => {
  let root = '';
  let eventsDir = '';
  let id = '';
  let path = '';

  beforeAll(async () => {
    ({ root, eventsDir } = boardProject());
    id = await newTicket(root);
    path = await killAt(root, ['claim', id, '--as', 'crasher', '--json'], 'after-rename');
  }, 30_000);

  it('leaves the complete event file under its hash name and no temporary file', () => {
    expect(dirname(path)).toBe(eventsDir);
    expect(basename(path)).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(existsSync(path)).toBe(true);
    expect(eventNames(eventsDir)).toHaveLength(2);
    expect(temps(eventsDir)).toEqual([]);
    // The file is complete: the independent fold applies it.
    expect(foldDir(eventsDir).state.tickets[id]?.assignee).toBe('crasher');
  });

  it('rebuild --check, which never catches up, sees the unfolded event as divergence', async () => {
    const out = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(out.code, out.stderr).toBe(1);
    const doc = oneDocument(out) as { ok: boolean; differences: { ticket: string | null }[] };
    expect(doc.ok).toBe(false);
    expect(doc.differences.some((d) => d.ticket === id)).toBe(true);
  });

  it('the next command folds the event: show reflects it', async () => {
    const { ticket, events } = await show(root, id);
    expect(ticket.assignee).toBe('crasher');
    expect(events).toBe(2);
    expect(canon(ticket)).toBe(canon(foldDir(eventsDir).state.tickets[id]));
  });

  it('the recovered claim holds exactly as if the command had completed', async () => {
    const out = await runCliAsync(['claim', id, '--as', 'latecomer', '--json'], root);
    expect(out.code).toBe(4);
    expect(oneDocument(out)).toMatchObject({ error: { reason: 'already-assigned' } });
    expect(out.stderr).toContain('crasher');
    const again = await runCliAsync(['comment', id, 'after the crash', '--as', 'crasher'], root);
    expect(again.code, again.stderr).toBe(0);
    expect(eventNames(eventsDir)).toHaveLength(3);
  });

  it('rebuild --check then reports no divergence', async () => {
    const out = await runCliAsync(['rebuild', '--check'], root);
    expect(out.code, out.stderr).toBe(0);
  });
});

describe('scenario: killed during temporary write', PROCESSES, () => {
  let root = '';
  let eventsDir = '';
  let id = '';
  let temp = '';
  let before: { ticket: Ticket; events: number } | null = null;
  let namesBefore: string[] = [];

  beforeAll(async () => {
    ({ root, eventsDir } = boardProject());
    id = await newTicket(root);
    before = await show(root, id);
    namesBefore = eventNames(eventsDir);
    temp = await killAt(root, ['comment', id, 'lost', '--as', 'crasher'], 'after-temp-write');
  }, 30_000);

  it('created no file with a hash name, only the temporary file', () => {
    expect(eventNames(eventsDir)).toEqual(namesBefore);
    expect(dirname(temp)).toBe(eventsDir);
    expect(basename(temp)).toMatch(/^\.tmp-/);
    expect(temps(eventsDir)).toEqual([basename(temp)]);
  });

  it('leaves the ticket unchanged', async () => {
    expect(canon(await show(root, id))).toBe(canon(before));
  });

  it('every command ignores a temporary file younger than one minute', async () => {
    const listed = await runCliAsync(['list', '--json'], root);
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe('');
    expect(oneDocument(listed)).toMatchObject([{ id }]);

    const raw = await runCliAsync(['show', id, '--raw', '--json'], root);
    expect(raw.code).toBe(0);
    expect(raw.stderr).toBe('');
    expect(oneDocument(raw)).toHaveLength(1);

    // Just under a minute old: still ignored, not reaped.
    const recent = (Date.now() - 50_000) / 1000;
    utimesSync(temp, recent, recent);
    const shown = await runCliAsync(['show', id], root);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toBe('');
    expect(existsSync(temp)).toBe(true);
  });

  it('rebuild --check ignores it and reports no divergence', async () => {
    const check = await runCliAsync(['rebuild', '--check'], root);
    expect(check.code, check.stderr).toBe(0);
    expect(check.stderr).toBe('');
    expect(existsSync(temp)).toBe(true);
  });

  it('a writing command succeeds alongside it and does not touch it', async () => {
    const out = await runCliAsync(['comment', id, 'still works', '--as', 'other'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(existsSync(temp)).toBe(true);
    const { ticket } = await show(root, id);
    expect(ticket.comments.map((c) => c.text)).toEqual(['still works']);
  });

  it('the first command once it is older than one minute removes and reports it', async () => {
    const old = (Date.now() - 61_000) / 1000;
    utimesSync(temp, old, old);
    const out = await runCliAsync(['show', id, '--json'], root);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe(`agentboard: removed stale temporary file ${temp}\n`);
    expect(existsSync(temp)).toBe(false);
    expect(temps(eventsDir)).toEqual([]);
    // Reported once: the next command has nothing to say.
    const next = await runCliAsync(['list'], root);
    expect(next.stderr).toBe('');
  });

  it('rebuild --check reports no divergence afterwards', async () => {
    const out = await runCliAsync(['rebuild', '--check'], root);
    expect(out.code, out.stderr).toBe(0);
  });
});
