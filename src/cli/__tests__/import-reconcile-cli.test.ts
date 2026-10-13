/**
 * `import-change --dry-run` and `--force`, the refusals and the superseded
 * marker through the CLI (add-claim-leases tasks 8.2 and 8.3;
 * board-openspec-integration: "Reconcile on re-import", scenario "Dry run";
 * board-cli: "Command surface" `import-change <name> [--dry-run]
 * [--force]`). Goldens are written out by hand; ticket ids are taken from
 * the first import's JSON document.
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cliEnv, oneJson, project, run, type Run } from './cli-helpers.js';

const CHANGE = 'add-x';
const PATH = `openspec/changes/${CHANGE}/tasks.md`;
const AS = ['--as', 'orch'];
const SLOW = { timeout: 30_000 };

function writeTasks(root: string, text: string): void {
  mkdirSync(join(root, 'openspec', 'changes', CHANGE), { recursive: true });
  writeFileSync(join(root, PATH), text);
}

const V1 = [
  '# Tasks',
  '',
  '## 1. Old title',
  '',
  '- [ ] 1.1 Add A',
  '- [ ] 1.2 Add B',
  '- [ ] 1.3 Add C',
  '',
  '## 2. Docs',
  '',
  '- [ ] 2.1 Write the README',
  '',
].join('\n');

const V2 = [
  '# Tasks',
  '',
  '## 1. Inserted',
  '',
  '- [ ] 1.1 Brand new',
  '',
  '## 2. New title',
  '',
  '- [ ] 2.1 Add A',
  '- [ ] 2.2 Add B',
  '- [ ] 2.4 Add D',
  '',
].join('\n');

interface Doc {
  tickets: { item: string | null; id: string | null }[];
}

/** A project with V1 imported; returns the ticket ids of groups 1 and 2. */
function importedV1(): { root: string; boardDir: string; one: string; two: string } {
  const { root, boardDir } = project();
  writeTasks(root, V1);
  const out = run(['import-change', CHANGE, ...AS, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  const doc = oneJson(out) as Doc;
  const id = (item: string): string => doc.tickets.find((t) => t.item === item)?.id ?? '';
  return { root, boardDir, one: id('1'), two: id('2') };
}

function eventFiles(boardDir: string): string[] {
  return readdirSync(join(boardDir, 'events')).sort();
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

describe('agentboard import-change --dry-run', SLOW, () => {
  it("scenario: --json prints one document with each ticket's changes and creates no event file", () => {
    const { root, boardDir, one, two } = importedV1();
    writeTasks(root, V2);
    const before = eventFiles(boardDir);
    const out = run(['import-change', CHANGE, '--dry-run', ...AS, '--json'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(eventFiles(boardDir)).toEqual(before);
    const doc = oneJson(out) as Record<string, unknown> & {
      tickets: Record<string, unknown>[];
    };
    expect({
      ...doc,
      tickets: doc.tickets.map((t) =>
        Object.fromEntries(Object.entries(t).filter(([key]) => key !== 'ticket')),
      ),
    }).toEqual({
      source: 'openspec',
      ref: CHANGE,
      tasksFile: PATH,
      dryRun: true,
      ambiguous: [],
      events: 0,
      tickets: [
        {
          item: '1',
          title: 'Inserted',
          id: null,
          action: 'created',
          pairing: null,
          renumber: null,
          diff: null,
          blocked: [],
          forced: false,
          supersede: null,
          events: [],
        },
        {
          item: '2',
          title: 'New title',
          id: one,
          action: 'updated',
          pairing: { pass: 'content', score: 0.5 },
          renumber: { from: '1', to: '2' },
          diff: {
            title: 'New title',
            updated: [
              { index: 0, text: '2.1 Add A', done: false },
              { index: 1, text: '2.2 Add B', done: false },
            ],
            removed: [2],
            added: [{ text: '2.4 Add D', done: false }],
          },
          blocked: [],
          forced: false,
          supersede: null,
          events: [],
        },
        {
          item: null,
          title: 'Docs',
          id: two,
          action: 'superseded',
          pairing: null,
          renumber: null,
          diff: null,
          blocked: [],
          forced: false,
          supersede: `group removed from ${PATH}`,
          events: [],
        },
      ],
    });
    expect(
      doc.tickets.map((t) => (t.ticket === null ? null : (t.ticket as { id: string }).id)),
    ).toEqual([null, one, two]);
  });

  it('golden: the human report', () => {
    const { root, boardDir, one, two } = importedV1();
    writeTasks(root, V2);
    const before = eventFiles(boardDir);
    const out = run(['import-change', CHANGE, '--dry-run', ...AS], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe(
      [
        'created group 1: Inserted',
        `updated ${one}  todo  -  Old title`,
        '  paired by content (score 0.50)',
        '  renumbered from group 1 to 2',
        '  title: New title',
        '  updated [ ] 0 2.1 Add A',
        '  updated [ ] 1 2.2 Add B',
        '  removed [ ] 2 1.3 Add C',
        '  added [ ] 2.4 Add D',
        `superseded ${two}  todo  -  Docs`,
        `  superseded: group removed from ${PATH}`,
        `dry run openspec:${CHANGE}: 1 created, 1 updated, 0 unchanged, 1 superseded, nothing written`,
        '',
      ].join('\n'),
    );
    expect(eventFiles(boardDir)).toEqual(before);
  });

  it('exits 0 and writes nothing for a blocked or an ambiguous change', () => {
    const { root, boardDir, one } = importedV1();
    expect(run(['checklist', 'tick', one, '2', '--as', 'impl'], root).code).toBe(0);
    writeTasks(root, V1.replace('- [ ] 1.3 Add C\n', ''));
    const before = eventFiles(boardDir);
    const blocked = run(['import-change', CHANGE, '--dry-run', ...AS], root);
    expect(blocked.code, blocked.stderr).toBe(0);
    expect(blocked.stdout).toContain(`blocked ${one}`);
    expect(blocked.stdout).toContain('  blocked 2 1.3 Add C (done)');
    expect(eventFiles(boardDir)).toEqual(before);
  });
});

describe('agentboard import-change refusals and --force', SLOW, () => {
  it('scenario: a blocked reconcile exits 4 reconcile-blocked naming the line, with a hint', () => {
    const { root, boardDir, one } = importedV1();
    expect(run(['checklist', 'tick', one, '2', '--as', 'impl'], root).code).toBe(0);
    writeTasks(
      root,
      V1.replace('- [ ] 1.3 Add C\n', '').replace(
        '2.1 Write the README',
        '2.1 Write the README\n- [ ] 2.2 Add an ADR',
      ),
    );
    const before = eventFiles(boardDir).length;
    const out = run(['import-change', CHANGE, ...AS], root);
    expect(out.code).toBe(4);
    const lines = out.stderr.split('\n');
    expect(lines[0]).toBe(
      'agentboard: reconcile blocked for 1 ticket(s); every other group was imported',
    );
    expect(lines).toContain(`  ${one} group 1 Old title`);
    expect(lines).toContain('    blocked 2 1.3 Add C (done)');
    const hint = lines.find((l) => l.startsWith('hint: ')) ?? '';
    expect(hint).toContain(`'agentboard import-change <change> --dry-run --as orch'`);
    expect(hint).toContain(`'agentboard import-change <change> --force --as orch'`);
    // Group 2 was still reconciled.
    expect(eventFiles(boardDir).length).toBe(before + 1);
    const json = run(['import-change', CHANGE, ...AS, '--json'], root);
    expect(errorOf(json)).toMatchObject({ exitCode: 4, reason: 'reconcile-blocked' });
    const forced = run(['import-change', CHANGE, '--force', ...AS], root);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stdout).toContain('  forced');
    expect(eventFiles(boardDir).length).toBe(before + 2);
  });

  it('scenario: an ambiguous pairing exits 4 reconcile-ambiguous and writes nothing', () => {
    const { root, boardDir } = project();
    writeTasks(
      root,
      '## 2. Store\n\n- [ ] 2.1 reads\n- [ ] 2.2 writes\n- [ ] 2.3 locks\n- [ ] 2.4 files\n',
    );
    expect(run(['import-change', CHANGE, ...AS], root).code).toBe(0);
    writeTasks(
      root,
      '## 2. Store reads\n\n- [ ] 2.1 reads\n- [ ] 2.2 writes\n\n## 3. Store writes\n\n- [ ] 3.1 locks\n- [ ] 3.2 files\n',
    );
    const before = eventFiles(boardDir);
    const out = run(['import-change', CHANGE, ...AS, '--json'], root);
    expect(out.code).toBe(4);
    const error = errorOf(out);
    expect(error.reason).toBe('reconcile-ambiguous');
    expect(error.message).toContain('is ambiguous; nothing was written');
    expect(error.message).toMatch(/group 2 score 0\.50/);
    expect(error.message).toMatch(/group 3 score 0\.50/);
    expect(error.hint).toContain(`'agentboard import-change <change> --dry-run --as orch'`);
    expect(error.hint).toContain('title');
    expect(eventFiles(boardDir)).toEqual(before);
  });

  it('shows a superseded ticket with its marker in list and show', () => {
    const { root, two } = importedV1();
    writeTasks(root, V1.slice(0, V1.indexOf('## 2. Docs')));
    expect(run(['import-change', CHANGE, ...AS], root).code).toBe(0);
    const list = run(['list', '--change', CHANGE], root);
    expect(list.stdout.split('\n')).toContain(`${two}  todo  -  [superseded] Docs`);
    const show = run(['show', two], root);
    expect(show.stdout.split('\n')).toContain(`superseded: group removed from ${PATH}`);
    const json = oneJson(run(['show', two, '--json'], root)) as { ticket: { superseded: string } };
    expect(json.ticket.superseded).toBe(`group removed from ${PATH}`);
  });

  it('accepts the actor from AGENTBOARD_ACTOR for a dry run, which still writes nothing', () => {
    const { root, boardDir } = importedV1();
    const before = eventFiles(boardDir);
    const out = run(
      ['import-change', CHANGE, '--dry-run'],
      root,
      cliEnv({ AGENTBOARD_ACTOR: 'orch' }),
    );
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout.trimEnd().split('\n').at(-1)).toBe(
      `dry run openspec:${CHANGE}: 0 created, 0 updated, 2 unchanged, nothing written`,
    );
    expect(eventFiles(boardDir)).toEqual(before);
  });
});
