/**
 * Tasks 7.1 to 7.3 through the CLI: `import-change` and `close-merged`
 * (board-cli: "Command surface", "Output conventions", "Exit codes";
 * board-openspec-integration). `close-merged` runs against a fake `gh`
 * placed first on the PATH passed to the CLI, or a PATH with no `gh` at
 * all; the real `gh` is never run.
 */

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { emptyPath, fakeGhOnPath, ghCalls } from '../../board/__tests__/gh-fake.js';
import { SAMPLES, gitRepo, makeBoardDir, tempDir } from '../../board/__tests__/helpers.js';
import { eventNames } from '../../store/__tests__/helpers.js';
import { cliEnv, oneJson, project, run, written, type Run } from './cli-helpers.js';

const FIXTURE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'board',
    '__tests__',
    'fixtures',
    'add-board-core-tasks.md',
  ),
  'utf8',
);

const AS = ['--as', 'orch'];

function writeTasks(root: string, text: string, change = 'add-board-core'): void {
  mkdirSync(join(root, 'openspec', 'changes', change), { recursive: true });
  writeFileSync(join(root, 'openspec', 'changes', change, 'tasks.md'), text);
}

function count(boardDir: string): number {
  return eventNames(join(boardDir, 'events')).length;
}

interface ErrorFields {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
}

function errorOf(out: Run): ErrorFields {
  return (oneJson(out) as { error: ErrorFields }).error;
}

interface ImportDoc {
  source: string;
  ref: string;
  tasksFile: string;
  events: number;
  tickets: { item: string; id: string; action: string; ticket: { status: string } }[];
}

// Each test runs the CLI in process many times; allow for a loaded machine.
const SLOW = { timeout: 30_000 };

describe('agentboard import-change', SLOW, () => {
  it('imports the fixture: nine tickets, fully ticked groups merged, one JSON document', () => {
    const { root, boardDir } = project();
    writeTasks(root, FIXTURE);
    const out = run(['import-change', 'add-board-core', ...AS, '--json'], root);
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as ImportDoc;
    expect(doc).toMatchObject({
      source: 'openspec',
      ref: 'add-board-core',
      tasksFile: 'openspec/changes/add-board-core/tasks.md',
      events: 39,
    });
    expect(doc.tickets.map((t) => [t.item, t.action, t.ticket.status])).toEqual([
      ['1', 'created', 'merged'],
      ['2', 'created', 'merged'],
      ['3', 'created', 'merged'],
      ['4', 'created', 'todo'],
      ['5', 'created', 'todo'],
      ['6', 'created', 'todo'],
      ['7', 'created', 'todo'],
      ['8', 'created', 'todo'],
      ['9', 'created', 'todo'],
    ]);
    expect(count(boardDir)).toBe(39);
    const listed = oneJson(
      run(['list', '--change', 'add-board-core', '--label', 'group:3', '--json'], root),
    ) as { title: string; status: string }[];
    expect(listed).toEqual([
      expect.objectContaining({ title: 'CLI core commands', status: 'merged' }),
    ]);
  });

  it('prints one line per group and a summary, and a re-import writes nothing', () => {
    const { root, boardDir } = project();
    writeTasks(root, FIXTURE);
    const first = run(['import-change', 'add-board-core', ...AS], root);
    expect(first.code, first.stderr).toBe(0);
    const lines = first.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(10);
    expect(lines.slice(0, 9).every((l) => l.startsWith('created '))).toBe(true);
    expect(lines[2]).toContain('CLI core commands');
    expect(lines[9]).toBe(
      'imported openspec:add-board-core: 9 created, 0 updated, 0 unchanged, 39 events',
    );
    const second = run(['import-change', 'add-board-core', ...AS], root);
    expect(second.code, second.stderr).toBe(0);
    const again = second.stdout.trimEnd().split('\n');
    expect(again.slice(0, 9).every((l) => l.startsWith('unchanged '))).toBe(true);
    expect(again[9]).toBe(
      'imported openspec:add-board-core: 0 created, 0 updated, 9 unchanged, 0 events',
    );
    expect(count(boardDir)).toBe(39);
  });

  it('requires an actor, since it writes', () => {
    const { root, boardDir } = project();
    writeTasks(root, FIXTURE);
    const out = run(['import-change', 'add-board-core', '--json'], root);
    expect(out.code).toBe(1);
    expect(errorOf(out).reason).toBe('missing-actor');
    expect(count(boardDir)).toBe(0);
  });

  it('accepts the actor from AGENTBOARD_ACTOR', () => {
    const { root } = project();
    writeTasks(root, '## 1. One\n- [ ] 1.1 a\n');
    const out = run(
      ['import-change', 'add-board-core', '--json'],
      root,
      cliEnv({ AGENTBOARD_ACTOR: 'env-orch' }),
    );
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { tickets: { ticket: { createdBy: string } }[] };
    expect(doc.tickets.map((t) => t.ticket.createdBy)).toEqual(['env-orch']);
  });

  it('exits 1 naming the tasks file path when the change does not exist', () => {
    const { root, boardDir } = project();
    const out = run(['import-change', 'no-such-change', ...AS, '--json'], root);
    expect(out.code).toBe(1);
    expect(errorOf(out).reason).toBe('tasks-not-found');
    expect(out.stderr).toContain('openspec/changes/no-such-change/tasks.md');
    expect(count(boardDir)).toBe(0);
  });

  it('exits 1 naming a source that has no adapter', () => {
    const { root, boardDir } = project();
    const out = run(['import-change', 'speckit:001-photo-albums', ...AS, '--json'], root);
    expect(out.code).toBe(1);
    expect(errorOf(out).reason).toBe('unsupported-source');
    expect(out.stderr).toContain('speckit');
    expect(count(boardDir)).toBe(0);
  });

  it('refuses secret-looking text without suggesting a flag it does not have', () => {
    const { root, boardDir } = project();
    writeTasks(root, `## 1. One\n- [ ] 1.1 uses ${SAMPLES['github-token']}\n`);
    const out = run(['import-change', 'add-board-core', ...AS, '--json'], root);
    expect(out.code).toBe(1);
    expect(errorOf(out).reason).toBe('secret-like');
    const [message, hint, end] = out.stderr.split('\n');
    expect(out.stderr.split('\n')).toHaveLength(3);
    expect(message).toBe(
      'agentboard: refused: the text matches the secret pattern(s) github-token; ' +
        'the board is not a secret store',
    );
    // The hint (add-agent-guidance task 2.2) must not suggest the flag either.
    expect(hint).toMatch(/^hint: \S/);
    expect(hint).not.toContain('--allow-secret-like');
    expect(end).toBe('');
    expect(errorOf(out).hint).toBe(hint?.slice('hint: '.length));
    expect(count(boardDir)).toBe(0);
    // And indeed the flag is unknown to import-change.
    const flagged = run(
      ['import-change', 'add-board-core', '--allow-secret-like', ...AS, '--json'],
      root,
    );
    expect(flagged.code).toBe(1);
    expect(errorOf(flagged).reason).toBe('usage');
  });

  it('reads the tasks file of the host root, not of the directory it runs in', () => {
    const root = gitRepo(join(tempDir(), 'host'));
    const boardDir = makeBoardDir(root);
    writeTasks(root, FIXTURE);
    const deep = join(root, 'packages', 'deep');
    mkdirSync(deep, { recursive: true });
    writeTasks(deep, '## 1. Decoy\n- [ ] 1.1 decoy\n');
    const out = run(['import-change', 'add-board-core', ...AS, '--json'], deep);
    expect(out.code, out.stderr).toBe(0);
    expect((oneJson(out) as ImportDoc).tickets).toHaveLength(9);
    expect(count(boardDir)).toBe(39);
  });
});

describe('agentboard checklist tick on a source with no adapter', () => {
  it('succeeds and says no tasks-file reminder is available for speckit', () => {
    const { root } = project();
    const id = written(
      run(
        [
          'new',
          'Albums',
          '--task',
          'speckit:001-photo-albums#phase-2',
          '--checklist',
          'x',
          ...AS,
          '--json',
        ],
        root,
      ),
    ).id;
    const out = run(['checklist', 'tick', id, '0', ...AS], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain('no tasks-file reminder is available for source speckit');
  });
});

/** A merged ticket with a PR link, made through the CLI; returns its id. */
function mergedTicket(root: string, pr: string): string {
  const id = written(
    run(['new', `PR ${pr}`, '--task', 'openspec:add-board-core#7', ...AS, '--json'], root),
  ).id;
  for (const status of ['tests', 'implementing', 'review', 'merged']) {
    expect(run(['move', id, status, ...AS], root).code).toBe(0);
  }
  expect(run(['link', id, '--pr', pr, ...AS], root).code).toBe(0);
  return id;
}

interface MergedDoc {
  closed: { id: string; pr: string | number; disposition: unknown }[];
  unmerged: { id: string; pr: string | number; state: string }[];
  skipped: { id: string; reason: string }[];
}

describe('agentboard close-merged with a fake gh', SLOW, () => {
  it('closes merged PRs with the right disposition and lists the unmerged', () => {
    const { root, boardDir } = project();
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', '0002.md'), '# adr\n');
    const a = mergedTicket(root, '7');
    const b = mergedTicket(root, '8');
    const c = mergedTicket(root, '9');
    expect(run(['link', c, '--decision', 'docs/adr/0002.md', ...AS], root).code).toBe(0);
    const { dir, log } = fakeGhOnPath({ '7': 'MERGED', '8': 'OPEN', '9': 'MERGED' });
    const env = cliEnv({ PATH: `${dir}:${process.env.PATH ?? ''}` });
    const before = count(boardDir);
    const out = run(['close-merged', ...AS, '--json'], root, env);
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as MergedDoc;
    expect(doc.closed.map((x) => [x.id, x.pr, x.disposition])).toEqual([
      [a, 7, { noDecision: true }],
      [c, 9, { decision: 'docs/adr/0002.md' }],
    ]);
    expect(doc.unmerged.map((x) => [x.id, x.pr, x.state])).toEqual([[b, 8, 'OPEN']]);
    expect(doc.skipped).toEqual([]);
    expect(count(boardDir)).toBe(before + 2);
    expect(ghCalls(log)).toEqual([
      'pr view 7 --json state',
      'pr view 8 --json state',
      'pr view 9 --json state',
    ]);
  });

  it('prints one line per ticket and a summary', () => {
    const { root } = project();
    mergedTicket(root, '7');
    mergedTicket(root, '8');
    const { dir } = fakeGhOnPath({ '7': 'MERGED', '8': 'OPEN' });
    const out = run(['close-merged', ...AS], root, cliEnv({ PATH: dir }));
    expect(out.code, out.stderr).toBe(0);
    const lines = out.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^closed .* \(no decision\)$/);
    expect(lines[1]).toMatch(/^unmerged .* \(PR 8 is OPEN\)$/);
    expect(lines[2]).toBe('close-merged: 1 closed, 1 unmerged, 0 skipped');
  });

  it('leaves a ticket with a DECISION comment open and lists it as skipped', () => {
    const { root } = project();
    const id = mergedTicket(root, '7');
    expect(run(['comment', id, 'DECISION: use RFC 6979', ...AS], root).code).toBe(0);
    const { dir } = fakeGhOnPath({ '7': 'MERGED' });
    const out = run(['close-merged', ...AS], root, cliEnv({ PATH: dir }));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^skipped .* \(unpromoted-decision\)$/m);
    const shown = oneJson(run(['show', id, '--json'], root)) as { ticket: { closed: boolean } };
    expect(shown.ticket.closed).toBe(false);
  });

  it('lists a close refused for one ticket as skipped and still exits 0', () => {
    const { root } = project();
    const id = mergedTicket(root, '7');
    const other = mergedTicket(root, '8');
    expect(run(['link', id, '--decision', 'docs/adr/0002.md', ...AS], root).code).toBe(0);
    const outside = tempDir();
    mkdirSync(join(outside, 'adr'));
    writeFileSync(join(outside, 'adr', '0002.md'), '# elsewhere\n');
    symlinkSync(outside, join(root, 'docs'));
    const { dir } = fakeGhOnPath({ '7': 'MERGED', '8': 'MERGED' });
    const out = run(['close-merged', ...AS, '--json'], root, cliEnv({ PATH: dir }));
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as MergedDoc;
    expect(doc.skipped.map((x) => [x.id, x.reason])).toEqual([[id, 'path-outside-tree']]);
    expect(doc.closed.map((x) => x.id)).toEqual([other]);
  });

  it('exits 1 with a clear message when gh is not on PATH, writing nothing', () => {
    const { root, boardDir } = project();
    mergedTicket(root, '7');
    const before = count(boardDir);
    const out = run(['close-merged', ...AS, '--json'], root, cliEnv({ PATH: emptyPath() }));
    expect(out.code).toBe(1);
    expect(errorOf(out).reason).toBe('gh-missing');
    expect(out.stderr).toMatch(/\bgh\b/);
    expect(count(boardDir)).toBe(before);
  });

  it('exits 0 without gh when no ticket is a candidate', () => {
    const { root } = project();
    const out = run(['close-merged', ...AS, '--json'], root, cliEnv({ PATH: emptyPath() }));
    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toEqual({ closed: [], unmerged: [], skipped: [] });
  });

  it('requires an actor, since it writes', () => {
    const { root } = project();
    const out = run(['close-merged', '--json'], root, cliEnv({ PATH: emptyPath() }));
    expect(out.code).toBe(1);
    expect(errorOf(out).reason).toBe('missing-actor');
  });
});
