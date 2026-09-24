import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SAMPLES } from '../../board/__tests__/helpers.js';
import { SECRET_PATTERN_NAMES } from '../../board/secrets.js';
import { version } from '../../index.js';
import { BoardError } from '../../store/errors.js';
import { ev, eventNames, git, gitRepo, putEvent, tempDir } from '../../store/__tests__/helpers.js';
import { renderHint } from '../../guidance/hints.js';
import { errorDocument, exitCodeFor } from '../main.js';
import { CLOSE_RULE, COMMANDS } from '../registry.js';
import { cliEnv, oneJson, project, run, written, type Run } from './cli-helpers.js';

const AS = ['--as', 'orch'];
const TASK3 = ['--task', 'openspec:add-board-core#3'];

/** Creates a ticket through the CLI and returns its id. */
function newTicket(root: string, ...extra: string[]): string {
  return written(run(['new', 'A ticket', ...TASK3, ...AS, '--json', ...extra], root)).id;
}

function count(boardDir: string): number {
  return eventNames(join(boardDir, 'events')).length;
}

function errorOf(out: Run): { exitCode: number; reason: string | null; message: string } {
  return (oneJson(out) as { error: { exitCode: number; reason: string | null; message: string } })
    .error;
}

describe('every command prints exactly one JSON document with --json', () => {
  /** One step per registered command, run in this order against one board. */
  function steps(root: string, state: { id: string }): Record<string, () => Run> {
    const id = (): string => state.id;
    return {
      init: () => run(['init', '--json'], tempDir()),
      new: () => {
        const out = run(['new', 'T', ...TASK3, '--checklist', 'a', ...AS, '--json'], root);
        state.id = written(out).id;
        return out;
      },
      show: () => run(['show', id(), '--json'], root),
      list: () => run(['list', '--json'], root),
      claim: () => run(['claim', id(), '--as', 'impl', '--json'], root),
      release: () => run(['release', id(), '--as', 'impl', '--json'], root),
      move: () => run(['move', id(), 'tests', ...AS, '--json'], root),
      comment: () => run(['comment', id(), 'hello', ...AS, '--json'], root),
      handoff: () =>
        run(
          [
            'handoff',
            id(),
            '--to',
            'impl',
            '--status',
            'implementing',
            '--note',
            'go',
            ...AS,
            '--json',
          ],
          root,
        ),
      link: () => run(['link', id(), '--pr', '7', ...AS, '--json'], root),
      'checklist tick': () => run(['checklist', 'tick', id(), '0', ...AS, '--json'], root),
      'checklist untick': () => run(['checklist', 'untick', id(), '0', ...AS, '--json'], root),
      close: () => {
        run(['move', id(), 'blocked', ...AS], root);
        return run(['close', id(), '--no-decision', ...AS, '--json'], root);
      },
      inbox: () => run(['inbox', '--as', 'watcher', '--json'], root),
      // watch streams; through the synchronous runCli it refuses with one
      // error document (its NDJSON stream is tested in inbox.test.ts).
      watch: () => run(['watch', '--as', 'watcher', '--json'], root),
      // serve runs a server; through the synchronous runCli it refuses
      // with one error document (it is tested in src/web/__tests__).
      serve: () => run(['serve', '--json'], root),
      rebuild: () => run(['rebuild', '--json'], root),
      sync: () => {
        git(join(root, '.board'), 'init', '-q');
        return run(['sync', '--json'], root);
      },
      'import-change': () => {
        mkdirSync(join(root, 'openspec', 'changes', 'c'), { recursive: true });
        writeFileSync(join(root, 'openspec', 'changes', 'c', 'tasks.md'), '## 1. G\n- [ ] 1.1 t\n');
        return run(['import-change', 'c', ...AS, '--json'], root);
      },
      // No ticket is merged with a PR link (the linked one was closed from blocked), so gh never runs.
      'close-merged': () => run(['close-merged', ...AS, '--json'], root),
      mcp: () => run(['mcp', '--json'], root),
      'agents install': () => run(['agents', 'install', '--target', 'agents-md', '--json'], root),
      'agents check': () => run(['agents', 'check', '--json'], root),
      version: () => run(['version', '--json'], root),
      help: () => run(['help', '--json'], root),
    };
  }

  it('has a step for every registered command', () => {
    expect(Object.keys(steps('', { id: '' })).sort()).toEqual(COMMANDS.map((c) => c.name).sort());
  });

  it('parses stdout as one document for each command, in order', () => {
    const { root, boardDir } = project();
    const state = { id: '' };
    const id = (): string => state.id;
    const docs: Record<string, unknown> = {};
    for (const [name, step] of Object.entries(steps(root, state))) {
      const out = step();
      expect(out.code, `${name}: ${out.stderr}`).toBe(
        name === 'mcp' || name === 'watch' || name === 'serve' ? 1 : 0,
      );
      docs[name] = oneJson(out);
    }
    expect(docs.init).toMatchObject({ created: true });
    expect(docs.show).toMatchObject({ ticket: { id: id() }, events: 1, unknown: [] });
    expect(Array.isArray(docs.list)).toBe(true);
    for (const name of ['new', 'claim', 'release', 'move', 'comment', 'handoff', 'link', 'close']) {
      const doc = docs[name] as { hash: unknown; ticket: { id: string } };
      expect(typeof doc.hash, name).toBe('string');
      expect(doc.ticket.id, name).toBe(id());
    }
    expect(docs['checklist tick']).toMatchObject({
      ticket: { id: id() },
      reminder: { source: 'openspec' },
    });
    expect(docs['checklist untick']).toMatchObject({ ticket: { id: id() }, reminder: null });
    expect(docs.close).toMatchObject({ ticket: { closed: true } });
    expect(docs.inbox).toMatchObject({ actor: 'watcher', advanced: true });
    expect((docs.inbox as { entries: unknown[] }).entries).toHaveLength(11);
    expect(docs.watch).toMatchObject({ error: { exitCode: 1, reason: 'streaming-command' } });
    expect(docs.rebuild).toMatchObject({ folded: 11, rejected: 0 });
    expect(docs.sync).toMatchObject({ remote: null, pushed: false, warnings: [] });
    expect(docs['import-change']).toMatchObject({ source: 'openspec', ref: 'c', events: 1 });
    expect(docs['close-merged']).toEqual({ closed: [], unmerged: [], skipped: [] });
    // mcp serves over stdio from the executable only (src/cli.ts dispatches it).
    expect(docs.mcp).toMatchObject({ error: { exitCode: 1, reason: 'streaming-command' } });
    expect(docs['agents install']).toMatchObject({
      root,
      targets: [{ target: 'agents-md', action: 'created' }],
      refused: 0,
    });
    expect(docs['agents check']).toEqual([
      expect.objectContaining({ target: 'agents-md', path: 'AGENTS.md', state: 'current' }),
    ]);
    expect(docs.version).toEqual({ version });
    expect((docs.help as { name: string }[]).map((d) => d.name)).toEqual(
      COMMANDS.map((c) => c.name),
    );
    expect(count(boardDir)).toBe(12);
  });
});

describe('actor', () => {
  it('scenario: a missing actor exits 1 naming --as and AGENTBOARD_ACTOR, writing nothing', () => {
    const { root, boardDir } = project();
    const id = newTicket(root);
    const out = run(['comment', id, 'hi'], root, cliEnv({ USER: 'ben', LOGNAME: 'ben' }));
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--as');
    expect(out.stderr).toContain('AGENTBOARD_ACTOR');
    expect(count(boardDir)).toBe(1);
  });

  it('is checked before the board is looked up', () => {
    const out = run(['comment', '01ARYZ6S41', 'hi'], tempDir());
    expect(out.code).toBe(1);
    expect(errorOf(run(['comment', '01ARYZ6S41', 'hi', '--json'], tempDir())).reason).toBe(
      'missing-actor',
    );
  });

  it('comes from AGENTBOARD_ACTOR and is recorded on the event', () => {
    const { root } = project();
    const out = run(
      ['new', 'x', ...TASK3, '--json'],
      root,
      cliEnv({ AGENTBOARD_ACTOR: 'env-actor' }),
    );
    expect(out.code).toBe(0);
    expect(oneJson(out)).toMatchObject({ ticket: { createdBy: 'env-actor' } });
  });

  it('--as wins over AGENTBOARD_ACTOR', () => {
    const { root } = project();
    const out = run(
      ['new', 'x', ...TASK3, '--as', 'flag', '--json'],
      root,
      cliEnv({ AGENTBOARD_ACTOR: 'env' }),
    );
    expect(oneJson(out)).toMatchObject({ ticket: { createdBy: 'flag' } });
  });
});

describe('exit codes and error output', () => {
  it('a usage error exits 1 before the board is looked up', () => {
    const out = run(['list', '--status'], tempDir());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: .*--status/);
  });

  it('no board exits 2 naming the path; --json prints the error document', () => {
    const dir = tempDir();
    const out = run(['list'], dir);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain(join(dir, '.board'));
    expect(out.stderr).toContain('./.board');
    const json = run(['list', '--json'], dir);
    expect(json.code).toBe(2);
    expect(errorOf(json)).toMatchObject({ exitCode: 2, reason: 'board-not-found' });
    expect(json.stderr).toContain('./.board');
  });

  it('claim on an assigned ticket exits 4 naming the assignee', () => {
    const { root, boardDir } = project();
    const id = newTicket(root);
    run(['claim', id, '--as', 'impl'], root);
    const out = run(['claim', id, '--as', 'reviewer'], root);
    expect(out.code).toBe(4);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('impl');
    const json = run(['claim', id, '--as', 'reviewer', '--json'], root);
    expect(errorOf(json)).toMatchObject({ exitCode: 4, reason: 'already-assigned' });
    expect(errorOf(json).message).toContain('impl');
    expect(count(boardDir)).toBe(2);
  });

  it('a claim retried by the holder exits 0 without an event', () => {
    const { root, boardDir } = project();
    const id = newTicket(root);
    run(['claim', id, '--as', 'impl'], root);
    const out = run(['claim', id, '--as', 'impl', '--json'], root);
    expect(out.code).toBe(0);
    expect(written(out)).toEqual({ hash: null, id });
    expect(count(boardDir)).toBe(2);
    const human = run(['claim', id, '--as', 'impl'], root);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('already claimed by impl');
  });

  it('scenario: unknown ticket exits 4 with unknown-ticket', () => {
    const { root } = project();
    const out = run(['comment', '01NOPE00', '--as', 'a', 'x', '--json'], root);
    expect(out.code).toBe(4);
    expect(errorOf(out).reason).toBe('unknown-ticket');
  });

  it('release by a non-assignee exits 4', () => {
    const { root } = project();
    const id = newTicket(root);
    run(['claim', id, '--as', 'impl'], root);
    expect(run(['release', id, '--as', 'other'], root).code).toBe(4);
  });

  it('scenario: move to the current status exits 4 invalid-transition', () => {
    const { root } = project();
    const id = newTicket(root);
    run(['move', id, 'blocked', ...AS], root);
    const out = run(['move', id, 'blocked', ...AS, '--json'], root);
    expect(out.code).toBe(4);
    expect(errorOf(out).reason).toBe('invalid-transition');
  });

  it('scenario: merged is terminal', () => {
    const { root } = project();
    const id = newTicket(root);
    for (const s of ['tests', 'implementing', 'review', 'merged']) {
      expect(run(['move', id, s, ...AS], root).code).toBe(0);
    }
    for (const s of ['todo', 'tests', 'implementing', 'review', 'merged', 'blocked']) {
      const out = run(['move', id, s, ...AS, '--json'], root);
      expect(out.code, s).toBe(4);
      expect(errorOf(out).reason).toBe('invalid-transition');
    }
  });

  it('refuses an unknown status name with exit 1 listing the statuses', () => {
    const { root } = project();
    const id = newTicket(root);
    for (const argv of [
      ['move', id, 'done', ...AS],
      ['handoff', id, '--to', 'x', '--status', 'done', '--note', 'n', ...AS],
      ['list', '--status', 'done'],
    ]) {
      const out = run(argv, root);
      expect(out.code, argv.join(' ')).toBe(1);
      expect(out.stderr).toContain('implementing');
    }
  });

  it('exitCodeFor and errorDocument map BoardError and anything else', () => {
    const err = new BoardError(4, 'already-assigned', 'held by impl');
    expect(exitCodeFor(err)).toBe(4);
    // The hint (add-agent-guidance task 2.2): CLI context with placeholders by default.
    const cli = { surface: 'cli', command: null } as const;
    expect(errorDocument(err)).toEqual({
      error: {
        exitCode: 4,
        reason: 'already-assigned',
        message: 'held by impl',
        hint: renderHint('already-assigned', cli),
      },
    });
    expect(errorDocument(err).error.hint).toContain("'agentboard inbox --as <actor>'");
    const mcp = { surface: 'mcp', command: 'claim', id: '01J9K3', actor: 'reviewer' } as const;
    expect(errorDocument(err, mcp).error.hint).toBe(renderHint('already-assigned', mcp));
    expect(errorDocument(err, mcp).error.hint).toContain('board_inbox {"as":"reviewer"}');
    expect(exitCodeFor(new Error('disk on fire'))).toBe(5);
    expect(errorDocument(new Error('disk on fire'))).toEqual({
      error: { exitCode: 5, reason: null, message: 'disk on fire', hint: null },
    });
  });
});

describe('new, show and list through the CLI', () => {
  it('scenario: the OpenSpec shorthand is the same task reference', () => {
    const { root } = project();
    const a = oneJson(
      run(['new', 'a', '--change', 'add-board-core', '--group', '3', ...AS, '--json'], root),
    );
    const b = oneJson(
      run(['new', 'b', '--task', 'openspec:add-board-core#3', ...AS, '--json'], root),
    );
    const task = { source: 'openspec', ref: 'add-board-core', item: '3' };
    expect(a).toMatchObject({ ticket: { task } });
    expect(b).toMatchObject({ ticket: { task } });
  });

  it('scenario: a malformed task reference exits 1 showing the form', () => {
    const { root, boardDir } = project();
    const out = run(['new', 'x', '--task', 'add-board-core-3', '--as', 'a'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('<source>:<ref>#<item>');
    expect(count(boardDir)).toBe(0);
  });

  it('scenario: a ticket without a task is refused with the rule', () => {
    const { root } = project();
    const out = run(['new', 'Fix thing', ...AS], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('--adhoc');
    expect(out.stderr).toContain('--task');
  });

  it('new prints the full id; list prints one line per ticket with the adhoc marker', () => {
    const { root } = project();
    const created = run(['new', 'Build the CLI', ...TASK3, ...AS], root);
    expect(created.code).toBe(0);
    const id = /[0-9A-HJKMNP-TV-Z]{26}/.exec(created.stdout)?.[0] ?? '';
    expect(id).not.toBe('');
    const adhoc = written(run(['new', 'Fix thing', '--adhoc', 'hotfix', ...AS, '--json'], root)).id;
    run(['claim', id, '--as', 'impl'], root);
    const out = run(['list'], root);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe(
      `${id}  todo  impl  Build the CLI\n${adhoc}  todo  -  [adhoc] Fix thing\n`,
    );
  });

  it('list shows full ids, so tickets from the same millisecond stay distinct and resolvable', () => {
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    const task = { source: 'openspec', ref: 'add-board-core', item: '3' };
    // Same ULID timestamp (first 10 characters), different randomness.
    const a = '01J9K3AAAAXXXXXXXXXXXXXXXX';
    const b = '01J9K3AAAAYYYYYYYYYYYYYYYY';
    putEvent(
      events,
      ev({ kind: 'ticket.create', ticket: a, body: { title: 'a', task } }, 'orch', 1000),
    );
    putEvent(
      events,
      ev({ kind: 'ticket.create', ticket: b, body: { title: 'b', task } }, 'orch', 1000),
    );
    const out = run(['list'], root);
    expect(out.code).toBe(0);
    const ids = out.stdout
      .trimEnd()
      .split('\n')
      .map((line) => line.split('  ')[0] ?? '');
    expect(ids).toEqual([a, b]);
    const pairs: [string, string][] = [
      [ids[0] ?? '', 'a'],
      [ids[1] ?? '', 'b'],
    ];
    for (const [pasted, title] of pairs) {
      const shown = run(['show', pasted, '--json'], root);
      expect(shown.code, shown.stderr).toBe(0);
      expect(oneJson(shown)).toMatchObject({ ticket: { id: pasted, title } });
    }
  });

  it('list filters and --change equals --task openspec:<name>', () => {
    const { root } = project();
    const g3 = newTicket(root);
    const other = written(
      run(['new', 'o', '--change', 'other', '--group', '1', ...AS, '--json'], root),
    ).id;
    const ids = (...argv: string[]): string[] =>
      (oneJson(run(['list', ...argv, '--json'], root)) as { id: string }[]).map((t) => t.id);
    expect(ids('--change', 'add-board-core')).toEqual([g3]);
    expect(ids('--task', 'openspec:add-board-core')).toEqual([g3]);
    expect(ids('--task', 'openspec:other#1')).toEqual([other]);
    run(['move', other, 'tests', ...AS], root);
    expect(ids('--status', 'tests')).toEqual([other]);
    expect(run(['list', '--task', 'nonsense'], root).code).toBe(1);
  });

  it('closed tickets are listed only with --closed', () => {
    const { root } = project();
    const id = newTicket(root);
    run(['move', id, 'blocked', ...AS], root);
    run(['close', id, '--no-decision', ...AS], root);
    expect(oneJson(run(['list', '--json'], root))).toEqual([]);
    expect(oneJson(run(['list', '--closed', '--json'], root))).toMatchObject([
      { id, closed: true },
    ]);
  });

  it('show prints the record by prefix, with comments in order and the event count', () => {
    const { root } = project();
    const id = newTicket(root);
    run(['comment', id, 'first', '--as', 'a'], root);
    run(['comment', id, 'second', '--as', 'b'], root);
    const out = run(['show', id.slice(0, 8)], root);
    expect(out.code).toBe(0);
    const lines = out.stdout.split('\n');
    expect(lines).toContain(`id: ${id}`);
    expect(lines.indexOf('  a: first')).toBeLessThan(lines.indexOf('  b: second'));
    expect(lines).toContain('events: 3');
  });

  it('show --raw prints the event files, one per line', () => {
    const { root, boardDir } = project();
    const id = newTicket(root);
    run(['comment', id, 'c', ...AS], root);
    const out = run(['show', id, '--raw'], root);
    const lines = out.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const files = readdirSync(join(boardDir, 'events')).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(2);
    for (const line of lines) {
      expect((JSON.parse(line) as { ticket: string }).ticket).toBe(id);
    }
    const raw = oneJson(run(['show', id, '--raw', '--json'], root)) as { hash: string }[];
    expect(raw.map((r) => `${r.hash}.json`).sort()).toEqual(files.sort());
  });

  it('refuses an ambiguous prefix with exit 1 listing both ids', () => {
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    const task = { source: 'openspec', ref: 'add-board-core', item: '3' };
    const a = '01J9K3AAAAAAAAAAAAAAAAAAAA';
    const b = '01J9K3AABBBBBBBBBBBBBBBBBB';
    putEvent(
      events,
      ev({ kind: 'ticket.create', ticket: a, body: { title: 'a', task } }, 'orch', 1000),
    );
    putEvent(
      events,
      ev({ kind: 'ticket.create', ticket: b, body: { title: 'b', task } }, 'orch', 1001),
    );
    const out = run(['show', '01J9K3AA'], root);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain(a);
    expect(out.stderr).toContain(b);
    expect(errorOf(run(['comment', '01j9k3', 'x', ...AS, '--json'], root)).reason).toBe(
      'ambiguous-id',
    );
    expect(oneJson(run(['show', '01J9K3AAB', '--json'], root))).toMatchObject({
      ticket: { id: b },
    });
  });
});

describe('writing commands through the CLI', () => {
  it('move with no target leaves blocked for the origin', () => {
    const { root } = project();
    const id = newTicket(root);
    run(['move', id, 'tests', ...AS], root);
    run(['move', id, 'blocked', ...AS], root);
    const out = run(['move', id, ...AS, '--json'], root);
    expect(out.code).toBe(0);
    expect(oneJson(out)).toMatchObject({ ticket: { status: 'tests', blockedFrom: null } });
  });

  it('link --pr takes a number when all digits, else the string', () => {
    const { root } = project();
    const id = newTicket(root);
    run(['link', id, '--pr', '12', ...AS], root);
    const out = run(['link', id, '--pr', 'https://example.invalid/pull/3', ...AS, '--json'], root);
    expect(oneJson(out)).toMatchObject({
      ticket: {
        links: [
          { type: 'pr', pr: 12 },
          { type: 'pr', pr: 'https://example.invalid/pull/3' },
        ],
      },
    });
  });

  it('link --change --group sets the task reference', () => {
    const { root } = project();
    const id = written(run(['new', 'x', '--adhoc', 'why', ...AS, '--json'], root)).id;
    const out = run(['link', id, '--change', 'c', '--group', '2', ...AS, '--json'], root);
    expect(oneJson(out)).toMatchObject({
      ticket: { task: { source: 'openspec', ref: 'c', item: '2' }, adhoc: null },
    });
  });

  it('scenario: tick prints the tasks file path and line', () => {
    const { root } = project();
    mkdirSync(join(root, 'openspec', 'changes', 'add-board-core'), { recursive: true });
    writeFileSync(
      join(root, 'openspec', 'changes', 'add-board-core', 'tasks.md'),
      '# Tasks\n\n## 3. CLI\n\n- [ ] 3.1 a\n- [ ] 3.2 b\n- [ ] 3.3 c\n',
    );
    const id = newTicket(root, '--checklist', 'a', '--checklist', 'b', '--checklist', 'c');
    const out = run(['checklist', 'tick', id, '2', '--as', 'impl'], root);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('openspec/changes/add-board-core/tasks.md:7');
    const shown = oneJson(run(['show', id, '--json'], root)) as {
      ticket: { checklist: { done: boolean }[] };
    };
    expect(shown.ticket.checklist.map((c) => c.done)).toEqual([false, false, true]);
  });

  it('scenario: close without a disposition exits 1 explaining the rule', () => {
    const { root } = project();
    const id = newTicket(root);
    const out = run(['close', id, '--as', 'orch'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(CLOSE_RULE);
  });

  it('scenario: close with a missing decision path exits 1 naming it; an existing one closes', () => {
    const { root, boardDir } = project();
    const id = newTicket(root);
    run(['move', id, 'blocked', ...AS], root);
    const before = count(boardDir);
    const out = run(['close', id, '--decision-recorded-in', 'docs/adr/0099.md', ...AS], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('docs/adr/0099.md');
    expect(count(boardDir)).toBe(before);
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', '0099.md'), '# x\n');
    const ok = run(
      ['close', id, '--decision-recorded-in', 'docs/adr/0099.md', ...AS, '--json'],
      root,
    );
    expect(ok.code).toBe(0);
    expect(oneJson(ok)).toMatchObject({
      ticket: { closed: true, disposition: { decision: 'docs/adr/0099.md' } },
    });
  });

  it('scenario: a DECISION: comment blocks --no-decision', () => {
    const { root } = project();
    const id = newTicket(root);
    run(['move', id, 'blocked', ...AS], root);
    run(['comment', id, 'DECISION: use RFC 6979 for P-256', '--as', 'impl'], root);
    const out = run(['close', id, '--no-decision', ...AS], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('DECISION: use RFC 6979 for P-256');
  });
});

describe('secret refusal through the CLI', () => {
  const commands = (id: string, secret: string): string[][] => [
    ['new', `t ${secret}`, ...TASK3, ...AS],
    ['comment', id, `c ${secret}`, ...AS],
    ['handoff', id, '--to', 'x', '--status', 'tests', '--note', `n ${secret}`, ...AS],
  ];

  it.each(SECRET_PATTERN_NAMES)(
    'refuses %s on new, comment and handoff without echoing it',
    (name) => {
      const { root, boardDir } = project();
      const id = newTicket(root);
      const secret = SAMPLES[name];
      for (const argv of commands(id, secret)) {
        for (const json of [false, true]) {
          const out = run(json ? [...argv, '--json'] : argv, root);
          expect(out.code, argv[0]).toBe(1);
          expect(out.stderr).toContain(name);
          expect(out.stdout + out.stderr).not.toContain(secret);
          expect(out.stdout + out.stderr).not.toContain(secret.slice(-16));
          if (json) {
            expect(errorOf(out)).toMatchObject({ exitCode: 1, reason: 'secret-like' });
          }
        }
      }
      expect(count(boardDir)).toBe(1);
    },
  );

  it('--allow-secret-like writes it', () => {
    const { root, boardDir } = project();
    const id = newTicket(root);
    const secret = SAMPLES['pem-private-key'];
    for (const argv of commands(id, secret)) {
      expect(run([...argv, '--allow-secret-like'], root).code, argv[0]).toBe(0);
    }
    expect(count(boardDir)).toBe(4);
  });
});

describe('--as on commands that do not write', () => {
  it('is accepted and ignored: same output as without it', () => {
    const { root } = project();
    const id = newTicket(root);
    for (const argv of [
      ['show', id],
      ['list'],
      ['show', id, '--json'],
      ['list', '--json'],
      ['version'],
    ]) {
      const plain = run(argv, root);
      const withActor = run([...argv, '--as', 'impl'], root);
      expect(plain.code, argv.join(' ')).toBe(0);
      expect(withActor, argv.join(' ')).toEqual(plain);
    }
  });
});

describe('decision paths are recorded relative to the working tree root', () => {
  /** A git repository with a board and docs/adr/0002-x.md; returns the root and a blocked ticket. */
  function repo(): { root: string; id: string } {
    const root = gitRepo(join(tempDir(), 'proj'));
    expect(run(['init'], root).code).toBe(0);
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', '0002-x.md'), '# x\n');
    const id = newTicket(root);
    run(['move', id, 'blocked', ...AS], root);
    return { root, id };
  }

  it('close run from a subdirectory records the root-relative path', () => {
    const { root, id } = repo();
    const out = run(
      ['close', id, '--decision-recorded-in', 'adr/0002-x.md', ...AS, '--json'],
      join(root, 'docs'),
    );
    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({
      ticket: { disposition: { decision: 'docs/adr/0002-x.md' } },
    });
  });

  it('close with a path outside the working tree exits 1 and writes nothing', () => {
    const { root, id } = repo();
    writeFileSync(join(root, '..', 'outside.md'), '# outside\n');
    const before = count(join(root, '.board'));
    const out = run(
      ['close', id, '--decision-recorded-in', '../outside.md', ...AS, '--json'],
      root,
    );
    expect(out.code).toBe(1);
    expect(errorOf(out).reason).toBe('path-outside-tree');
    expect(out.stderr).toContain('../outside.md');
    expect(count(join(root, '.board'))).toBe(before);
  });

  it('link --decision records the root-relative path without requiring the file', () => {
    const { root, id } = repo();
    mkdirSync(join(root, 'src'));
    const ok = run(
      ['link', id, '--decision', '../docs/adr/0100-new.md', ...AS, '--json'],
      join(root, 'src'),
    );
    expect(ok.code, ok.stderr).toBe(0);
    expect(oneJson(ok)).toMatchObject({
      ticket: { links: [{ type: 'decision', path: 'docs/adr/0100-new.md' }] },
    });
  });
});

describe('other commands', () => {
  it('mcp through the in-process runCli refuses: it serves only from the executable', () => {
    const out = run(['mcp'], tempDir());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    // Then the hint line (add-agent-guidance task 2.2).
    expect(out.stderr).toMatch(
      /^agentboard: agentboard mcp serves MCP over stdio and runs only from the agentboard executable\nhint: \S[^\n]*\n$/,
    );
  });

  it('version prints the version', () => {
    const out = run(['version'], tempDir());
    expect(out).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' });
  });

  it('init prints what it did and is idempotent', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    const first = run(['init'], repo);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(join(repo, '.board'));
    const second = run(['init', '--json'], repo);
    expect(second.code).toBe(0);
    expect(oneJson(second)).toMatchObject({ created: false, dir: join(repo, '.board') });
  });

  it('reports a reaped stale temporary file on stderr and keeps stdout one document', () => {
    const { root, boardDir } = project();
    const temp = join(boardDir, 'events', '.tmp-0123456789abcdef');
    writeFileSync(temp, 'partial');
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(temp, old, old);
    const out = run(['list', '--json'], root);
    expect(out.code).toBe(0);
    expect(oneJson(out)).toEqual([]);
    expect(out.stderr).toContain(`agentboard: removed stale temporary file ${temp}`);
  });
});

describe('discovery through the CLI', () => {
  it('finds the board when run inside the .board directory itself', () => {
    const repo = gitRepo(join(tempDir(), 'proj'));
    expect(run(['init'], repo).code).toBe(0);
    const id = newTicket(repo);
    for (const cwd of [join(repo, '.board'), join(repo, '.board', 'events')]) {
      const out = run(['list', '--json'], cwd);
      expect(out.code, cwd).toBe(0);
      expect((oneJson(out) as { id: string }[]).map((t) => t.id)).toEqual([id]);
    }
  });
});
