/**
 * Task 7.2: the source adapter registry and the `openspec` adapter,
 * including its tasks.md parser (board-openspec-integration: "Task sources
 * are adapters", "Import a change").
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPENSPEC_SOURCE, openspecAdapter, parseOpenSpecTasks } from '../openspec.js';
import { SOURCE_ADAPTERS, sourceAdapter, type TaskUnit } from '../sources.js';
import { expectBoardError, tempDir } from './helpers.js';

/** The layout the group 3 reminder tests use (line numbers noted). */
const TASKS_MD = [
  '# Tasks', //                                    1
  '', //                                           2
  '## 1. Events', //                               3
  '', //                                           4
  '- [x] 1.1 Implement canonical', //              5
  '- [x] 1.2 Implement ulid', //                   6
  '', //                                           7
  '## 3. CLI core commands', //                    8
  '', //                                           9
  '- [ ] 3.1 Implement the registry', //          10
  '  continuation of 3.1', //                     11
  '- [X] 3.2 Implement init', //                  12
  '- [ ] 3.3 Implement claim', //                 13
  '', //                                          14
  '## 4. Concurrency', //                         15
  '- [ ] 4.1 Harness', //                         16
  '',
].join('\n');

const EXPECTED: TaskUnit[] = [
  {
    item: '1',
    title: 'Events',
    line: 3,
    lines: [
      { text: '1.1 Implement canonical', done: true, line: 5 },
      { text: '1.2 Implement ulid', done: true, line: 6 },
    ],
  },
  {
    item: '3',
    title: 'CLI core commands',
    line: 8,
    lines: [
      { text: '3.1 Implement the registry', done: false, line: 10 },
      { text: '3.2 Implement init', done: true, line: 12 },
      { text: '3.3 Implement claim', done: false, line: 13 },
    ],
  },
  {
    item: '4',
    title: 'Concurrency',
    line: 15,
    lines: [{ text: '4.1 Harness', done: false, line: 16 }],
  },
];

const PATH = 'openspec/changes/add-board-core/tasks.md';

function hostWith(text: string, ref = 'add-board-core'): string {
  const root = tempDir();
  mkdirSync(join(root, 'openspec', 'changes', ref), { recursive: true });
  writeFileSync(join(root, 'openspec', 'changes', ref, 'tasks.md'), text);
  return root;
}

describe('source adapter registry', () => {
  it('ships exactly the openspec adapter', () => {
    expect(SOURCE_ADAPTERS.map((a) => a.source)).toEqual(['openspec']);
    expect(OPENSPEC_SOURCE).toBe('openspec');
    expect(openspecAdapter.source).toBe('openspec');
  });

  it('finds an adapter by exact source name only', () => {
    expect(sourceAdapter('openspec')).toBe(openspecAdapter);
    expect(sourceAdapter('speckit')).toBeUndefined();
    expect(sourceAdapter('OpenSpec')).toBeUndefined();
    expect(sourceAdapter('')).toBeUndefined();
  });
});

describe('parseOpenSpecTasks', () => {
  it('reads numbered groups, their task lines, done flags and 1-based line numbers', () => {
    expect(parseOpenSpecTasks(TASKS_MD)).toEqual(EXPECTED);
  });

  it('parses a CRLF file exactly like the LF file', () => {
    expect(parseOpenSpecTasks(TASKS_MD.split('\n').join('\r\n'))).toEqual(EXPECTED);
  });

  it('ignores prose, sub-headings, indented and malformed list lines', () => {
    const text = [
      '# Tasks', //                                  1
      '- [ ] 0.1 before any group', //               2
      '## 1. First  ', //                            3
      'Some prose about the group.', //              4
      '### Sub-heading', //                          5
      '- [ ] 1.1 kept   ', //                        6
      '  - [ ] nested item', //                      7
      '-[ ] no space', //                            8
      '* [ ] star bullet', //                        9
      '- [x]1.2 no space after box', //             10
      '- [y] 1.3 unknown mark', //                  11
      '- [x] 1.4 kept too', //                      12
    ].join('\n');
    expect(parseOpenSpecTasks(text)).toEqual([
      {
        item: '1',
        title: 'First',
        line: 3,
        lines: [
          { text: '1.1 kept', done: false, line: 6 },
          { text: '1.4 kept too', done: true, line: 12 },
        ],
      },
    ]);
  });

  it('ends a group at any "## " heading, numbered or not', () => {
    const text = [
      '## 1. One', //              1
      '- [ ] 1.1 a', //            2
      '## Notes', //               3
      '- [ ] not a task', //       4
      '## 2. Two', //              5
      '- [x] 2.1 b', //            6
    ].join('\n');
    expect(parseOpenSpecTasks(text)).toEqual([
      { item: '1', title: 'One', line: 1, lines: [{ text: '1.1 a', done: false, line: 2 }] },
      { item: '2', title: 'Two', line: 5, lines: [{ text: '2.1 b', done: true, line: 6 }] },
    ]);
  });

  it('returns a group without task lines with an empty list', () => {
    expect(parseOpenSpecTasks('## 1. Empty\n\nprose only\n')).toEqual([
      { item: '1', title: 'Empty', line: 1, lines: [] },
    ]);
  });

  it('returns no groups for a file without numbered headings', () => {
    expect(parseOpenSpecTasks('# Tasks\n\n- [ ] loose\n')).toEqual([]);
  });

  it('refuses a group number used twice, naming it and the line', () => {
    const err = expectBoardError(
      () => parseOpenSpecTasks('## 1. A\n- [ ] 1.1 a\n## 1. Again\n', PATH),
      1,
      'malformed-tasks',
    );
    expect(err.message).toContain(PATH);
    expect(err.message).toMatch(/\b3\b/);
  });

  it('refuses a task line with no text, naming its line', () => {
    const err = expectBoardError(
      () => parseOpenSpecTasks('## 1. A\n- [ ] 1.1 a\n- [ ]    \n', PATH),
      1,
      'malformed-tasks',
    );
    expect(err.message).toContain(PATH);
    expect(err.message).toMatch(/\b3\b/);
  });
});

describe('openspecAdapter', () => {
  it('roots OpenSpec at <host>/openspec and names the tasks file root-relative', () => {
    expect(openspecAdapter.root('/host')).toBe(join('/host', 'openspec'));
    expect(openspecAdapter.tasksPath('add-board-core')).toBe(PATH);
  });

  it.each(['', '.', '..', 'a/b', '../x', 'a\\b', 'a\0b'])(
    'refuses the ref %j as a usage error',
    (ref) => {
      expectBoardError(() => openspecAdapter.tasksPath(ref), 1, 'usage');
      expectBoardError(() => openspecAdapter.listUnits(tempDir(), ref), 1, 'usage');
    },
  );

  it('lists the units of a change from its tasks file', () => {
    expect(openspecAdapter.listUnits(hostWith(TASKS_MD), 'add-board-core')).toEqual(EXPECTED);
  });

  it('reports a missing change as tasks-not-found naming the path', () => {
    const err = expectBoardError(
      () => openspecAdapter.listUnits(hostWith(TASKS_MD), 'no-such-change'),
      1,
      'tasks-not-found',
    );
    expect(err.message).toContain('openspec/changes/no-such-change/tasks.md');
  });

  it('passes the tasks file path to parse errors', () => {
    const err = expectBoardError(
      () => openspecAdapter.listUnits(hostWith('## 2. A\n## 2. B\n'), 'add-board-core'),
      1,
      'malformed-tasks',
    );
    expect(err.message).toContain(PATH);
  });

  it.each([
    ['3', 0, 10],
    ['3', 1, 12],
    ['3', 2, 13],
    ['1', 1, 6],
    ['4', 0, 16],
  ])('locates group %s index %i at line %i', (item, index, line) => {
    expect(openspecAdapter.locate(hostWith(TASKS_MD), 'add-board-core', item, index)).toEqual({
      path: PATH,
      line,
    });
  });

  it.each([
    ['3', 3],
    ['3', -1],
    ['9', 0],
  ])('gives no line for group %s index %i', (item, index) => {
    expect(openspecAdapter.locate(hostWith(TASKS_MD), 'add-board-core', item, index)).toEqual({
      path: PATH,
      line: null,
    });
  });

  it('gives the path without a line when the file is missing or malformed', () => {
    expect(openspecAdapter.locate(tempDir(), 'add-board-core', '3', 0)).toEqual({
      path: PATH,
      line: null,
    });
    expect(
      openspecAdapter.locate(hostWith('## 3. A\n- [ ] a\n## 3. B\n'), 'add-board-core', '3', 0),
    ).toEqual({ path: PATH, line: null });
  });

  it('labels a unit change:<ref> then group:<item>', () => {
    const unit = EXPECTED[1];
    if (unit === undefined) {
      throw new Error('fixture');
    }
    expect(openspecAdapter.labels('add-board-core', unit)).toEqual([
      'change:add-board-core',
      'group:3',
    ]);
  });
});
