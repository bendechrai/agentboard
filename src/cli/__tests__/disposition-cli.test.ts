/**
 * The scope disposition through the CLI (add-adhoc-ticket-lifecycle tasks
 * 2.1 and 2.2; board-cli: "Scope disposition on the command line", "Exit
 * codes", "No secrets on the board"; board-openspec-integration: "Scope
 * disposition at merge and close", "Tickets reference tasks or are ad
 * hoc", "Close merged"; board-agent-guidance: "Error hints"): `move <id>
 * merged` and `close` with `--task`, `--change --group` and `--unplanned`,
 * the usage checks before the board is opened, the refusals writing no
 * event and no temporary file, the hints with every quoted command
 * parsing against the registry, and `close-merged` on an undisposed
 * merged ticket. The library forms are in
 * src/board/__tests__/disposition.test.ts.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { fakeGhOnPath } from '../../board/__tests__/gh-fake.js';
import { B64, makeBoardDir } from '../../board/__tests__/helpers.js';
import { canonicalDecode } from '../../events/canonical.js';
import type { Ticket } from '../../events/fold.js';
import type { BoardEvent } from '../../events/schema.js';
import { renderHint, type HintContext } from '../../guidance/hints.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { CACHE_FILE } from '../../store/cache.js';
import { allNames, eventNames, tempDir } from '../../store/__tests__/helpers.js';
import { ADHOC, LINKED, writePreDispositionBoard } from '../../store/__tests__/pre-disposition.js';
import { parseArgs } from '../parse.js';
import { cliEnv, oneJson, project, run, written, type Run } from './cli-helpers.js';

const AS = ['--as', 'orch'];
const LOGIN = 'openspec:add-login#2';
const WARNING = 'do not create an issue or task only to satisfy this';

interface Written {
  hash: string | null;
  events: string[];
  ticket: Ticket;
}

interface ErrorDoc {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
}

function ok(out: Run): Run {
  expect(out.code, out.stderr).toBe(0);
  return out;
}

function errorOf(out: Run): ErrorDoc {
  return (oneJson(out) as { error: ErrorDoc }).error;
}

/** The `hint: ` line of a failed run, which is the last stderr line. */
function hintOf(out: Run): string {
  expect(out.code).not.toBe(0);
  const lines = out.stderr.trimEnd().split('\n');
  const last = lines.at(-1) ?? '';
  expect(last, out.stderr).toMatch(/^hint: \S/);
  expect(lines.filter((line) => line.startsWith('hint: '))).toHaveLength(1);
  return last.slice('hint: '.length);
}

/** Every `'agentboard ...'` step of a hint, without the quotes. */
function steps(hint: string): string[] {
  return [...hint.matchAll(/'(agentboard [^']*)'/g)].map((m) => m[1] ?? '');
}

/** Parses a step with the real parser; returns the command name and values. */
function parsed(step: string): { command: string; values: Record<string, unknown> } {
  const words = splitCommandLine(step);
  expect(words[0]).toBe('agentboard');
  const result = parseArgs(words.slice(1));
  return { command: result.command.name, values: { ...result.values } };
}

/** A fresh board with an ad hoc ticket (reason `seen in production`) in `status`. */
function adhocIn(
  status: 'todo' | 'tests' | 'review' | 'blocked',
  title = 'Login redirect loops',
): { root: string; boardDir: string; eventsDir: string; id: string } {
  const { root, boardDir } = project();
  const id = written(
    ok(run(['new', title, '--adhoc', 'seen in production', ...AS, '--json'], root)),
  ).id;
  const path = {
    todo: [],
    tests: ['tests'],
    review: ['tests', 'implementing', 'review'],
    blocked: ['tests', 'implementing', 'blocked'],
  }[status];
  for (const to of path) {
    ok(run(['move', id, to, ...AS], root));
  }
  return { root, boardDir, eventsDir: join(boardDir, 'events'), id };
}

/** A fresh board with a planned ticket (task `LOGIN`) in review. */
function plannedInReview(): { root: string; eventsDir: string; id: string } {
  const { root, boardDir } = project();
  const id = written(ok(run(['new', 'Login form', '--task', LOGIN, ...AS, '--json'], root))).id;
  for (const to of ['tests', 'implementing', 'review']) {
    ok(run(['move', id, to, ...AS], root));
  }
  return { root, eventsDir: join(boardDir, 'events'), id };
}

function show(root: string, id: string): Ticket {
  return (oneJson(ok(run(['show', id, '--json'], root))) as { ticket: Ticket }).ticket;
}

function eventOf(eventsDir: string, hash: string): BoardEvent {
  return canonicalDecode(
    new Uint8Array(readFileSync(join(eventsDir, `${hash}.json`))),
  ) as unknown as BoardEvent;
}

describe('scenario: merge with a task link', () => {
  it('writes a ticket.link then a ticket.move and T1 is merged with the task', () => {
    const { root, eventsDir, id } = adhocIn('review');
    const before = eventNames(eventsDir);
    const out = ok(run(['move', id, 'merged', '--task', LOGIN, ...AS, '--json'], root));
    const doc = oneJson(out) as Written;
    expect(doc.events).toHaveLength(2);
    expect(doc.hash).toBe(doc.events[1]);
    expect(eventNames(eventsDir)).toEqual(
      [...before, ...doc.events.map((h) => `${h}.json`)].sort(),
    );
    const [link, move] = doc.events.map((h) => eventOf(eventsDir, h));
    expect(link).toMatchObject({
      kind: 'ticket.link',
      ticket: id,
      actor: 'orch',
      body: { task: { source: 'openspec', ref: 'add-login', item: '2' } },
    });
    expect(move).toMatchObject({ kind: 'ticket.move', ticket: id, body: { to: 'merged' } });
    expect(doc.ticket).toMatchObject({
      status: 'merged',
      task: { source: 'openspec', ref: 'add-login', item: '2' },
      adhoc: null,
      unplanned: null,
    });
    expect(show(root, id)).toEqual(doc.ticket);
    expect(out.stderr).toBe('');
  });

  it('--change --group is the same disposition, and the human output is the list line', () => {
    const { root, id } = adhocIn('review');
    const out = ok(run(['move', id, 'merged', '--change', 'add-login', '--group', '2', ...AS], root));
    expect(out.stdout).toBe(`${id}  merged  -  Login redirect loops\n`);
    expect(show(root, id).task).toEqual({ source: 'openspec', ref: 'add-login', item: '2' });
  });
});

describe('scenario: merge as unplanned', () => {
  it('writes a ticket.unplanned then a ticket.move, and show, show --json and list --json carry it', () => {
    const { root, eventsDir, id } = adhocIn('review');
    const out = ok(
      run(['move', id, 'merged', '--unplanned', 'production hotfix, no plan', ...AS, '--json'], root),
    );
    const doc = oneJson(out) as Written;
    expect(doc.events).toHaveLength(2);
    const [unplanned, move] = doc.events.map((h) => eventOf(eventsDir, h));
    expect(unplanned).toMatchObject({
      kind: 'ticket.unplanned',
      ticket: id,
      actor: 'orch',
      body: { reason: 'production hotfix, no plan' },
    });
    expect(move).toMatchObject({ kind: 'ticket.move', body: { to: 'merged' } });
    const expected = {
      reason: 'production hotfix, no plan',
      actor: 'orch',
      ts: (unplanned as BoardEvent).ts,
    };
    expect(doc.ticket).toMatchObject({ status: 'merged', adhoc: 'seen in production' });
    expect(doc.ticket.unplanned).toEqual(expected);

    const shown = ok(run(['show', id], root)).stdout.split('\n');
    const adhocLine = shown.indexOf('adhoc: seen in production');
    expect(adhocLine).toBeGreaterThan(0);
    expect(shown[adhocLine + 1]).toBe('unplanned: production hotfix, no plan (by orch)');
    expect(show(root, id).unplanned).toEqual(expected);
    const listed = oneJson(ok(run(['list', '--json'], root))) as Ticket[];
    expect(listed.map((t) => t.unplanned)).toEqual([expected]);
    expect(ok(run(['list'], root)).stdout).toBe(`${id}  merged  -  [unplanned] Login redirect loops\n`);
  });
});

describe('scenario: close with each disposition', () => {
  it('A is closed with the task reference and B with the unplanned disposition', () => {
    const { root, boardDir } = project();
    const eventsDir = join(boardDir, 'events');
    const ids: string[] = [];
    for (const title of ['A', 'B']) {
      const id = written(ok(run(['new', title, '--adhoc', 'spike', ...AS, '--json'], root))).id;
      for (const to of ['tests', 'implementing', 'blocked']) {
        ok(run(['move', id, to, ...AS], root));
      }
      ids.push(id);
    }
    const [a = '', b = ''] = ids;
    const closedA = oneJson(
      ok(run(['close', a, '--no-decision', '--task', 'openspec:add-login#3', ...AS, '--json'], root)),
    ) as Written;
    expect(closedA.events).toHaveLength(2);
    expect(closedA.ticket).toMatchObject({
      closed: true,
      disposition: { noDecision: true },
      task: { source: 'openspec', ref: 'add-login', item: '3' },
      adhoc: null,
    });
    const [link, close] = closedA.events.map((h) => eventOf(eventsDir, h));
    expect(link).toMatchObject({ kind: 'ticket.link', ticket: a });
    expect(close).toMatchObject({ kind: 'ticket.close', ticket: a, body: { noDecision: true } });

    const closedB = oneJson(
      ok(
        run(
          ['close', b, '--no-decision', '--unplanned', 'abandoned, duplicate of A', ...AS, '--json'],
          root,
        ),
      ),
    ) as Written;
    expect(closedB.events).toHaveLength(2);
    expect(closedB.ticket).toMatchObject({
      closed: true,
      adhoc: 'spike',
      unplanned: { reason: 'abandoned, duplicate of A', actor: 'orch' },
    });
    expect(ok(run(['list', '--closed'], root)).stdout).toBe(
      `${a}  blocked  -  [closed] A\n${b}  blocked  -  [unplanned] [closed] B\n`,
    );
  });

  it('close --decision-recorded-in keeps its path checks and takes a disposition too', () => {
    const { root, id } = adhocIn('blocked');
    ok(run(['comment', id, 'DECISION: drop the parser', ...AS], root));
    const missing = run(
      ['close', id, '--decision-recorded-in', 'docs/adr/0099.md', '--unplanned', 'x', ...AS],
      root,
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('decision-path-missing');
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', '0099.md'), '# adr\n');
    const closed = oneJson(
      ok(
        run(
          [
            'close',
            id,
            '--decision-recorded-in',
            'docs/adr/0099.md',
            '--unplanned',
            'abandoned',
            ...AS,
            '--json',
          ],
          root,
        ),
      ),
    ) as Written;
    expect(closed.ticket).toMatchObject({
      closed: true,
      disposition: { decision: 'docs/adr/0099.md' },
      unplanned: { reason: 'abandoned' },
    });
  });
});

describe('scenario: close without a disposition', () => {
  it('exits 4 needs-scope-disposition, hints close with --task and --unplanned, creates no file', () => {
    const { root, eventsDir, id } = adhocIn('blocked');
    const names = allNames(eventsDir);
    const out = run(['close', id, '--no-decision', ...AS], root);
    expect(out.code).toBe(4);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: .*needs-scope-disposition/m);
    const hint = hintOf(out);
    expect(hint).toContain(`'agentboard close ${id} --no-decision --task <source>:<ref>#<item> --as orch'`);
    expect(hint).toContain(`'agentboard close ${id} --no-decision --unplanned "<reason>" --as orch'`);
    expect(hint).toContain(WARNING);
    for (const step of steps(hint)) {
      expect(parsed(step).command, step).toBe('close');
    }
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id)).toMatchObject({ closed: false, status: 'blocked' });
    const json = run(['close', id, '--no-decision', ...AS, '--json'], root);
    expect(json.code).toBe(4);
    expect(errorOf(json)).toMatchObject({ exitCode: 4, reason: 'needs-scope-disposition', hint });
    expect(allNames(eventsDir)).toEqual(names);
  });

  it('scenario: missing scope disposition is a state rejection (the Exit codes requirement)', () => {
    const { root, eventsDir, id } = adhocIn('blocked');
    const names = allNames(eventsDir);
    const out = run(['close', id, '--no-decision', ...AS], root);
    expect(out.code).toBe(4);
    expect(allNames(eventsDir)).toEqual(names);
  });

  it('with --decision-recorded-in the hint repeats that flag and its path', () => {
    const { root, id } = adhocIn('blocked');
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', '0001.md'), '# adr\n');
    const out = run(['close', id, '--decision-recorded-in', 'docs/adr/0001.md', ...AS], root);
    expect(out.code).toBe(4);
    const hint = hintOf(out);
    expect(hint).toContain(
      `'agentboard close ${id} --decision-recorded-in docs/adr/0001.md --task <source>:<ref>#<item> --as orch'`,
    );
    expect(hint).toContain(
      `'agentboard close ${id} --decision-recorded-in docs/adr/0001.md --unplanned "<reason>" --as orch'`,
    );
    for (const step of steps(hint)) {
      expect(parsed(step).values['decision-recorded-in'], step).toBe('docs/adr/0001.md');
    }
  });
});

describe('scenario: both dispositions are a usage error', () => {
  it('exits 1 usage naming both flags before the board is opened, and writes nothing', () => {
    const noBoard = tempDir();
    for (const argv of [
      ['move', '01J9K3', 'merged', '--task', 'openspec:x#1', '--unplanned', 'y', ...AS],
      ['move', '01J9K3', 'merged', '--change', 'x', '--group', '1', '--unplanned', 'y', ...AS],
      ['close', '01J9K3', '--no-decision', '--task', 'openspec:x#1', '--unplanned', 'y', ...AS],
    ]) {
      const out = run(argv, noBoard);
      expect(out.code, argv.join(' ')).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain('--unplanned');
      expect(out.stderr).toMatch(/--task|--change/);
      expect(errorOf(run([...argv, '--json'], noBoard))).toMatchObject({
        exitCode: 1,
        reason: 'usage',
      });
    }
    const { root, eventsDir, id } = adhocIn('review');
    const names = allNames(eventsDir);
    const out = run(['move', id, 'merged', '--task', 'openspec:x#1', '--unplanned', 'y', ...AS], root);
    expect(out.code).toBe(1);
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id).status).toBe('review');
  });
});

describe('scenario: disposition on another move is a usage error', () => {
  it.each([
    ['implementing', ['move', '01J9K3', 'implementing', '--unplanned', 'y', ...AS]],
    ['review', ['move', '01J9K3', 'review', '--task', 'openspec:x#1', ...AS]],
    ['blocked', ['move', '01J9K3', 'blocked', '--change', 'x', '--group', '1', ...AS]],
    ['no target', ['move', '01J9K3', '--unplanned', 'y', ...AS]],
  ])('%s: exits 1 usage saying only a move to merged, before the board is opened', (_name, argv) => {
    const out = run(argv, tempDir());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: .*merged/m);
    expect(errorOf(run([...argv, '--json'], tempDir()))).toMatchObject({
      exitCode: 1,
      reason: 'usage',
    });
  });

  it('writes nothing on a real board, the target-less return from blocked included', () => {
    const { root, eventsDir, id } = adhocIn('blocked');
    const names = allNames(eventsDir);
    expect(run(['move', id, '--unplanned', 'y', ...AS], root).code).toBe(1);
    expect(run(['move', id, 'implementing', '--unplanned', 'y', ...AS], root).code).toBe(1);
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id).status).toBe('blocked');
  });
});

describe('scenario: invalid task reference refused as link does', () => {
  it('move --task add-login-2 shows the form exactly as link does; --unplanned "" is usage', () => {
    const { root, eventsDir, id } = adhocIn('review');
    const names = allNames(eventsDir);
    const move = run(['move', id, 'merged', '--task', 'add-login-2', ...AS], root);
    expect(move.code).toBe(1);
    expect(move.stderr).toContain('<source>:<ref>#<item>');
    const link = run(['link', id, '--task', 'add-login-2', ...AS], root);
    expect(link.code).toBe(1);
    expect(move.stderr).toBe(link.stderr);
    expect(errorOf(run(['move', id, 'merged', '--task', 'add-login-2', ...AS, '--json'], root))).toEqual(
      errorOf(run(['link', id, '--task', 'add-login-2', ...AS, '--json'], root)),
    );
    const close = run(['close', id, '--no-decision', '--task', 'add-login-2', ...AS, '--json'], root);
    expect(close.code).toBe(1);
    expect(errorOf(close)).toMatchObject({ reason: 'malformed-task-ref' });

    const empty = run(['move', id, 'merged', '--unplanned', '', ...AS, '--json'], root);
    expect(empty.code).toBe(1);
    expect(errorOf(empty)).toMatchObject({ exitCode: 1, reason: 'usage' });
    const emptyClose = run(['close', id, '--no-decision', '--unplanned', '', ...AS, '--json'], root);
    expect(emptyClose.code).toBe(1);
    expect(errorOf(emptyClose)).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(allNames(eventsDir)).toEqual(names);
  });

  it('both are refused before the board is opened', () => {
    const noBoard = tempDir();
    expect(run(['move', '01J9K3', 'merged', '--task', 'add-login-2', ...AS], noBoard).code).toBe(1);
    expect(run(['move', '01J9K3', 'merged', '--unplanned', '', ...AS], noBoard).code).toBe(1);
    expect(run(['close', '01J9K3', '--no-decision', '--task', 'add-login-2', ...AS], noBoard).code).toBe(1);
    expect(run(['close', '01J9K3', '--no-decision', '--unplanned', '', ...AS], noBoard).code).toBe(1);
    expect(run(['move', '01J9K3', 'merged', '--change', 'x', ...AS], noBoard).code).toBe(1);
  });
});

describe('scenario: unplanned on a linked ticket', () => {
  it('exits 4 already-linked naming the task reference, hints the command without --unplanned, writes nothing', () => {
    const { root, eventsDir, id } = plannedInReview();
    const names = allNames(eventsDir);
    const out = run(['move', id, 'merged', '--unplanned', 'y', ...AS], root);
    expect(out.code).toBe(4);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: .*already-linked/m);
    expect(out.stderr).toContain(LOGIN);
    const hint = hintOf(out);
    expect(hint).toContain(`'agentboard move ${id} merged --as orch'`);
    expect(hint).not.toContain('--unplanned "<reason>"');
    expect(parsed(`agentboard move ${id} merged --as orch`).command).toBe('move');
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id).status).toBe('review');
    expect(errorOf(run(['move', id, 'merged', '--unplanned', 'y', ...AS, '--json'], root))).toMatchObject(
      { exitCode: 4, reason: 'already-linked', hint },
    );
    expect(allNames(eventsDir)).toEqual(names);
  });

  it('on close, the hint keeps the decision flag', () => {
    const { root, id } = plannedInReview();
    ok(run(['move', id, 'blocked', ...AS], root));
    const out = run(['close', id, '--no-decision', '--unplanned', 'y', ...AS], root);
    expect(out.code).toBe(4);
    const hint = hintOf(out);
    expect(hint).toContain(`'agentboard close ${id} --no-decision --as orch'`);
    expect(show(root, id).closed).toBe(false);
  });
});

describe('scenario: disposition with an invalid move writes nothing', () => {
  it('exits 4 invalid-transition and creates no ticket.unplanned or ticket.move file', () => {
    const { root, eventsDir, id } = adhocIn('todo');
    const names = allNames(eventsDir);
    const out = run(['move', id, 'merged', '--unplanned', 'y', ...AS, '--json'], root);
    expect(out.code).toBe(4);
    expect(errorOf(out)).toMatchObject({ exitCode: 4, reason: 'invalid-transition' });
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id)).toMatchObject({ status: 'todo', unplanned: null });
  });
});

describe('scenario: close check order', () => {
  it('needs-scope-disposition first, then unpromoted-decision once --unplanned is given', () => {
    const { root, eventsDir, id } = adhocIn('blocked');
    ok(run(['comment', id, 'DECISION: drop the parser', ...AS], root));
    const names = allNames(eventsDir);
    const first = run(['close', id, '--no-decision', ...AS, '--json'], root);
    expect(first.code).toBe(4);
    expect(errorOf(first)).toMatchObject({ reason: 'needs-scope-disposition' });
    const second = run(['close', id, '--no-decision', '--unplanned', 'spike', ...AS, '--json'], root);
    expect(second.code).toBe(1);
    expect(errorOf(second)).toMatchObject({ reason: 'unpromoted-decision' });
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id)).toMatchObject({ closed: false, unplanned: null });
  });
});

describe('scenario: hand-off into merged needs a disposition first', () => {
  it('exits 4 and the hint names move <id> merged with --task and with --unplanned', () => {
    const { root, eventsDir, id } = adhocIn('review');
    const names = allNames(eventsDir);
    const out = run(
      ['handoff', id, '--to', 'orch', '--status', 'merged', '--note', 'done', '--as', 'rev'],
      root,
    );
    expect(out.code).toBe(4);
    expect(out.stderr).toMatch(/^agentboard: .*needs-scope-disposition/m);
    const hint = hintOf(out);
    expect(hint).toContain(`'agentboard move ${id} merged --task <source>:<ref>#<item> --as rev'`);
    expect(hint).toContain(`'agentboard move ${id} merged --unplanned "<reason>" --as rev'`);
    expect(hint).toContain(WARNING);
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id)).toMatchObject({ status: 'review', assignee: null });
  });
});

describe('scenario: merge without a disposition is refused', () => {
  it('exits 4 with a hint naming both flags, no event file, T1 still in review', () => {
    const { root, eventsDir, id } = adhocIn('review');
    const names = allNames(eventsDir);
    const out = run(['move', id, 'merged', ...AS], root);
    expect(out.code).toBe(4);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: .*needs-scope-disposition/m);
    const hint = hintOf(out);
    expect(hint).toContain('--task');
    expect(hint).toContain('--unplanned');
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id).status).toBe('review');
  });

  it('scenario: missing disposition hint (the two steps parse against the registry)', () => {
    const { root, id } = adhocIn('review');
    const out = run(['move', id, 'merged', ...AS], root);
    expect(out.code).toBe(4);
    const hint = hintOf(out);
    const task = `agentboard move ${id} merged --task <source>:<ref>#<item> --as orch`;
    const unplanned = `agentboard move ${id} merged --unplanned "<reason>" --as orch`;
    expect(hint).toContain(`'${task}'`);
    expect(hint).toContain(`'${unplanned}'`);
    expect(hint).toContain(WARNING);
    expect(hint).toContain('--change <name> --group <n>');
    expect(parsed(task)).toEqual({
      command: 'move',
      values: { id, status: 'merged', task: '<source>:<ref>#<item>', as: 'orch' },
    });
    expect(parsed(unplanned)).toEqual({
      command: 'move',
      values: { id, status: 'merged', unplanned: '<reason>', as: 'orch' },
    });
    for (const step of steps(hint)) {
      expect(() => parsed(step), step).not.toThrow();
    }
    const context: HintContext = { surface: 'cli', command: 'move', id, actor: 'orch' };
    expect(hint).toBe(renderHint('needs-scope-disposition', context));
    expect(errorOf(run(['move', id, 'merged', ...AS, '--json'], root))).toMatchObject({
      exitCode: 4,
      reason: 'needs-scope-disposition',
      hint,
    });
  });

  it('uses the id prefix as given and the actor from AGENTBOARD_ACTOR', () => {
    const { root, id } = adhocIn('review');
    const prefix = id.slice(0, 8);
    const out = run(['move', prefix, 'merged'], root, cliEnv({ AGENTBOARD_ACTOR: 'merger' }));
    expect(out.code).toBe(4);
    expect(hintOf(out)).toContain(`'agentboard move ${prefix} merged --unplanned "<reason>" --as merger'`);
  });
});

describe('scenario: ticket linked earlier needs no disposition', () => {
  it('link while implementing, then move merged from review with no flag', () => {
    const { root, id } = adhocIn('tests');
    ok(run(['move', id, 'implementing', ...AS], root));
    ok(run(['link', id, '--task', LOGIN, ...AS], root));
    ok(run(['move', id, 'review', ...AS], root));
    const out = oneJson(ok(run(['move', id, 'merged', ...AS, '--json'], root))) as Written;
    expect(out.events).toHaveLength(1);
    expect(out.ticket).toMatchObject({
      status: 'merged',
      task: { source: 'openspec', ref: 'add-login', item: '2' },
    });
    expect(ok(run(['close', id, '--no-decision', ...AS, '--json'], root)).stderr).toBe('');
  });
});

describe('scenario: planned ticket is unaffected', () => {
  it('a ticket created with --change --group is merged and closed with no disposition flag', () => {
    const { root, boardDir } = project();
    const id = written(
      ok(run(['new', 'Login form', '--change', 'add-login', '--group', '2', ...AS, '--json'], root)),
    ).id;
    for (const to of ['tests', 'implementing', 'review']) {
      ok(run(['move', id, to, ...AS], root));
    }
    const merged = ok(run(['move', id, 'merged', ...AS, '--json'], root));
    expect(merged.stderr).toBe('');
    expect((oneJson(merged) as Written).events).toHaveLength(1);
    const closed = ok(run(['close', id, '--no-decision', ...AS, '--json'], root));
    expect(closed.stderr).toBe('');
    expect((oneJson(closed) as Written).events).toHaveLength(1);
    expect(eventNames(join(boardDir, 'events'))).toHaveLength(6);
  });
});

describe('scenario: ad hoc tickets are worked like any other ticket', () => {
  it('moves through the work statuses, is blocked, returned and handed off', () => {
    const { root, id } = adhocIn('todo');
    ok(run(['claim', id, '--as', 'impl-1'], root));
    for (const to of ['tests', 'implementing', 'review']) {
      const out = ok(run(['move', id, to, '--as', 'impl-1'], root));
      expect(out.stderr).toBe('');
    }
    expect(show(root, id)).toMatchObject({ status: 'review', adhoc: 'seen in production', task: null });
    ok(run(['move', id, 'implementing', '--as', 'impl-1'], root));
    ok(run(['move', id, 'blocked', '--as', 'impl-1'], root));
    ok(run(['move', id, '--as', 'impl-1'], root));
    expect(show(root, id).status).toBe('implementing');
    ok(
      run(
        ['handoff', id, '--to', 'reviewer', '--status', 'review', '--note', 'ready', '--as', 'impl-1'],
        root,
      ),
    );
    expect(show(root, id)).toMatchObject({ status: 'review', assignee: 'reviewer' });
  });

  it('scenario: a mutex ticket is never refused with needs-scope-disposition', () => {
    const { root, id } = adhocIn('todo', 'deploy lock');
    for (let round = 0; round < 3; round += 1) {
      const holder = `agent-${String(round)}`;
      expect(ok(run(['claim', id, '--as', holder], root)).stderr).toBe('');
      expect(ok(run(['release', id, '--as', holder], root)).stderr).toBe('');
    }
  });
});

describe('scenario: a board written before this change', () => {
  function olderBoard(): string {
    const root = tempDir();
    writePreDispositionBoard(makeBoardDir(root));
    return root;
  }

  it('an ad hoc ticket in todo gains the ability to move, and no other ticket changes', () => {
    const root = olderBoard();
    const before = oneJson(ok(run(['list', '--closed', '--json'], root))) as Ticket[];
    const changed = (): Ticket[] =>
      (oneJson(ok(run(['list', '--closed', '--json'], root))) as Ticket[]).filter(
        (t) => t.id !== ADHOC.todo,
      );
    ok(run(['move', ADHOC.todo, 'tests', '--as', 'agent-a'], root));
    ok(run(['move', ADHOC.todo, 'implementing', '--as', 'agent-a'], root));
    expect(show(root, ADHOC.todo).status).toBe('implementing');
    expect(changed()).toEqual(before.filter((t) => t.id !== ADHOC.todo));
  });

  it('linked tickets move on and close with no disposition flag', () => {
    const root = olderBoard();
    expect(ok(run(['move', LINKED.review, 'merged', ...AS], root)).stderr).toBe('');
    expect(ok(run(['close', LINKED.merged, '--no-decision', ...AS], root)).stderr).toBe('');
    expect(show(root, LINKED.merged).closed).toBe(true);
  });

  it('an ad hoc ticket in blocked closes only with a disposition', () => {
    const root = olderBoard();
    expect(run(['close', ADHOC.blocked, '--no-decision', ...AS], root).code).toBe(4);
    ok(run(['close', ADHOC.blocked, '--no-decision', '--unplanned', 'abandoned', ...AS], root));
    expect(show(root, ADHOC.blocked)).toMatchObject({
      closed: true,
      unplanned: { reason: 'abandoned', actor: 'orch' },
    });
  });
});

describe('scenario: secret-like unplanned reason refused (No secrets on the board)', () => {
  const reason = `token: ${B64}`;

  it('move exits 1 naming the pattern, not the text, and writes no event', () => {
    const { root, eventsDir, id } = adhocIn('review');
    const names = allNames(eventsDir);
    const out = run(['move', id, 'merged', '--unplanned', reason, ...AS], root);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('generic-secret-assignment');
    expect(out.stderr).not.toContain(B64);
    expect(hintOf(out)).toContain('--allow-secret-like');
    expect(allNames(eventsDir)).toEqual(names);
    expect(show(root, id).status).toBe('review');
    expect(errorOf(run(['move', id, 'merged', '--unplanned', reason, ...AS, '--json'], root))).toMatchObject(
      { exitCode: 1, reason: 'secret-like' },
    );
  });

  it('close exits 1 the same way', () => {
    const { root, eventsDir, id } = adhocIn('blocked');
    const names = allNames(eventsDir);
    const out = run(['close', id, '--no-decision', '--unplanned', reason, ...AS], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('generic-secret-assignment');
    expect(out.stderr).not.toContain(B64);
    expect(allNames(eventsDir)).toEqual(names);
  });

  it('is refused before the board is opened', () => {
    const out = run(['move', '01J9K3', 'merged', '--unplanned', reason, ...AS], tempDir());
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('generic-secret-assignment');
  });

  it('--allow-secret-like writes it', () => {
    const { root, id } = adhocIn('review');
    const out = ok(
      run(['move', id, 'merged', '--unplanned', reason, '--allow-secret-like', ...AS, '--json'], root),
    );
    expect((oneJson(out) as Written).ticket.unplanned).toMatchObject({ reason });
    const { root: root2, id: id2 } = adhocIn('blocked');
    ok(run(['close', id2, '--no-decision', '--unplanned', reason, '--allow-secret-like', ...AS], root2));
    expect(show(root2, id2)).toMatchObject({ closed: true, unplanned: { reason } });
  });
});

describe('close-merged through the CLI (the modified Close merged requirement)', () => {
  /** A planned merged ticket linked to PR `pr`. */
  function mergedTicket(root: string, pr: string): string {
    const id = written(ok(run(['new', `PR ${pr}`, '--task', LOGIN, ...AS, '--json'], root))).id;
    for (const to of ['tests', 'implementing', 'review', 'merged']) {
      ok(run(['move', id, to, ...AS], root));
    }
    ok(run(['link', id, '--pr', pr, ...AS], root));
    return id;
  }

  it('scenario: an unplanned merged ticket closes normally, its disposition unchanged', () => {
    const { root, id } = adhocIn('review');
    ok(run(['move', id, 'merged', '--unplanned', 'hotfix', ...AS], root));
    ok(run(['link', id, '--pr', '7', ...AS], root));
    const before = show(root, id);
    const { dir } = fakeGhOnPath({ '7': 'MERGED' });
    const out = ok(run(['close-merged', ...AS], root, cliEnv({ PATH: dir })));
    expect(out.stdout).toBe(
      `closed ${id}  merged  -  [unplanned] Login redirect loops (no decision)\n` +
        'close-merged: 1 closed, 0 unmerged, 0 skipped\n',
    );
    expect(show(root, id)).toMatchObject({
      closed: true,
      disposition: { noDecision: true },
      unplanned: before.unplanned,
    });
  });

  it('scenario: a merged ticket with no disposition is skipped and listed, the others processed', () => {
    const { root, boardDir } = project();
    const undisposed = mergedTicket(root, '7');
    const planned = mergedTicket(root, '8');
    // The fold never lets an undisposed ticket into merged: the state is
    // made the only way it can arise, outside agentboard, by editing the
    // cache row.
    const db = new DatabaseSync(join(boardDir, CACHE_FILE));
    db.prepare(
      'UPDATE tickets SET task_source = NULL, task_ref = NULL, task_item = NULL WHERE id = ?',
    ).run(undisposed);
    db.close();
    expect(show(root, undisposed)).toMatchObject({ task: null, unplanned: null, status: 'merged' });
    const { dir } = fakeGhOnPath({ '7': 'MERGED', '8': 'MERGED' });
    const out = ok(run(['close-merged', ...AS, '--json'], root, cliEnv({ PATH: dir })));
    const doc = oneJson(out) as {
      closed: { id: string }[];
      unmerged: unknown[];
      skipped: { id: string; pr: unknown; reason: string; message: string }[];
    };
    expect(doc.closed.map((c) => c.id)).toEqual([planned]);
    expect(doc.unmerged).toEqual([]);
    expect(doc.skipped.map((s) => [s.id, s.pr, s.reason])).toEqual([
      [undisposed, 7, 'needs-scope-disposition'],
    ]);
    expect(show(root, undisposed).closed).toBe(false);
    expect(show(root, planned).closed).toBe(true);
    const text = run(['close-merged', ...AS], root, cliEnv({ PATH: dir }));
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(
      `skipped ${undisposed}  merged  -  PR 7 (needs-scope-disposition)\n` +
        'close-merged: 0 closed, 0 unmerged, 1 skipped\n',
    );
  });
});
