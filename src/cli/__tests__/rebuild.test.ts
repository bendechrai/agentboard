/**
 * `agentboard rebuild` and `rebuild --check` through the CLI driver
 * (board-cache: "Rebuild", "Check detects divergence"; board-cli: "Output
 * conventions", "Exit codes"). The library functions are tested in
 * src/store/__tests__/rebuild.test.ts; these tests pin the command's
 * output, exit codes and the rule that `--check` leaves the live cache
 * exactly as it was (no catch-up, no reaping, no row change).
 */

import { existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { dumpCache } from '../../store/cache.js';
import { canon, ev, putEvent, tempDir } from '../../store/__tests__/helpers.js';
import { findCommand } from '../registry.js';
import { oneJson, project, run, spawnCli, written, type Run } from './cli-helpers.js';

const TASK4 = ['--task', 'openspec:add-board-core#4'];

/** A board with two tickets, one claimed and commented. Returns the root and ids. */
function seeded(): { root: string; boardDir: string; a: string; b: string } {
  const { root, boardDir } = project();
  const a = written(run(['new', 'Alpha', ...TASK4, '--as', 'orch', '--json'], root)).id;
  const b = written(run(['new', 'Beta', ...TASK4, '--as', 'orch', '--json'], root)).id;
  expect(run(['claim', a, '--as', 'impl'], root).code).toBe(0);
  expect(run(['comment', a, 'hello', '--as', 'impl'], root).code).toBe(0);
  return { root, boardDir, a, b };
}

/** The canonical dump of the live cache, read through a separate connection. */
function liveDump(boardDir: string): string {
  const db = new DatabaseSync(join(boardDir, 'cache.sqlite'));
  try {
    return dumpCache(db);
  } finally {
    db.close();
  }
}

/** Runs one SQL statement on the live cache, as a human editing it by hand would. */
function handEdit(boardDir: string, sql: string, ...params: string[]): void {
  const db = new DatabaseSync(join(boardDir, 'cache.sqlite'));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

interface CheckDoc {
  ok: boolean;
  noCache: boolean;
  differences: {
    table: string;
    key: string;
    ticket: string | null;
    live: Record<string, unknown> | null;
    rebuilt: Record<string, unknown> | null;
  }[];
  report: { folded: number; rejected: number } | null;
}

function checkDoc(out: Run): CheckDoc {
  return oneJson(out) as CheckDoc;
}

describe('rebuild in the registry', () => {
  it('is a non-writing command with one boolean --check flag', () => {
    const command = findCommand('rebuild');
    expect(command).toMatchObject({
      name: 'rebuild',
      writes: false,
      operation: 'rebuild',
      positionals: [],
      exclusive: [],
    });
    expect(command?.flags.map((f) => [f.name, f.type, f.required, f.repeatable])).toEqual([
      ['check', 'boolean', false, false],
    ]);
  });
});

describe('agentboard rebuild', () => {
  it('refolds and prints the counts line', () => {
    const { root } = seeded();
    const out = run(['rebuild'], root);
    expect(out).toEqual({
      code: 0,
      stdout: 'rebuilt: 4 folded, 0 rejected, 0 malformed, 0 corrupt, 0 unknown\n',
      stderr: '',
    });
  });

  it('prints the RebuildReport as one JSON document with --json', () => {
    const { root } = seeded();
    const out = run(['rebuild', '--json'], root);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(oneJson(out)).toMatchObject({
      folded: 4,
      rejected: 0,
      malformed: 0,
      corrupt: 0,
      unknown: 0,
      rejectedEvents: [],
      unknownEvents: [],
      malformedFiles: [],
      corruptFiles: [],
    });
  });

  it('counts rejected events, and a rebuild is byte-identical to the one before', () => {
    const { root, boardDir, a } = seeded();
    // A claim by another actor that sorts after the real one: rejected.
    putEvent(
      join(boardDir, 'events'),
      ev({ kind: 'ticket.claim', ticket: a, body: {} }, 'late', 9_999_999_999_999),
    );
    const first = run(['rebuild', '--json'], root);
    expect(first.code, first.stderr).toBe(0);
    expect(oneJson(first)).toMatchObject({
      folded: 4,
      rejected: 1,
      rejectedEvents: [{ kind: 'ticket.claim', ticket: a, reason: 'already-assigned' }],
    });
    const dump = liveDump(boardDir);
    expect(run(['rebuild'], root).stdout).toBe(
      'rebuilt: 4 folded, 1 rejected, 0 malformed, 0 corrupt, 0 unknown\n',
    );
    expect(liveDump(boardDir)).toBe(dump);
  });

  it('repairs a hand-edited cache', () => {
    const { root, boardDir, a } = seeded();
    handEdit(boardDir, "UPDATE tickets SET title = 'hacked' WHERE id = ?", a);
    expect(run(['rebuild'], root).code).toBe(0);
    expect(oneJson(run(['show', a, '--json'], root))).toMatchObject({ ticket: { title: 'Alpha' } });
    expect(run(['rebuild', '--check'], root).code).toBe(0);
  });

  it('does not catch up first: it folds and counts an unfolded event file itself', () => {
    const { root, boardDir, b } = seeded();
    putEvent(
      join(boardDir, 'events'),
      ev({ kind: 'ticket.comment', ticket: b, body: { text: 'late' } }, 'sync', 9_999_999_999_999),
    );
    // A stale temporary file: an open with catch-up would reap and report it.
    const temp = join(boardDir, 'events', '.tmp-00112233445566778899aabbccddeeff');
    writeFileSync(temp, '{"partial":');
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(temp, old, old);

    const out = run(['rebuild', '--json'], root);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(oneJson(out)).toMatchObject({ folded: 5, rejected: 0 });
    expect(existsSync(temp)).toBe(true);
    expect(oneJson(run(['show', b, '--json'], root))).toMatchObject({
      ticket: { comments: [{ text: 'late' }] },
    });
    expect(run(['rebuild', '--check'], root).code).toBe(0);
  });

  it('lists corrupt and malformed files after the counts line', () => {
    const { root, boardDir } = seeded();
    const eventsDir = join(boardDir, 'events');
    const corrupt = `${'0'.repeat(64)}.json`;
    writeFileSync(join(eventsDir, corrupt), 'not the content of this name');
    const malformed = putEvent(eventsDir, { v: 1, kind: 'ticket.comment' });
    const out = run(['rebuild'], root);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(
      'rebuilt: 4 folded, 0 rejected, 1 malformed, 1 corrupt, 0 unknown\n' +
        `  corrupt ${corrupt}\n` +
        `  malformed ${malformed}.json\n`,
    );
    expect(out.stderr).toBe('');
  });

  it('needs no actor and ignores --as', () => {
    const { root } = seeded();
    expect(run(['rebuild', '--as', 'someone'], root)).toEqual(run(['rebuild'], root));
  });

  it('exits 2 when there is no board', () => {
    const out = run(['rebuild'], tempDir());
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    const json = run(['rebuild', '--check', '--json'], tempDir());
    expect(json.code).toBe(2);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 2, reason: 'board-not-found' } });
  });
});

describe('agentboard rebuild --check', () => {
  it('exits 0 with the no-divergence line on a consistent cache', () => {
    const { root } = seeded();
    expect(run(['rebuild', '--check'], root)).toEqual({
      code: 0,
      stdout: 'no divergence: 4 folded, 0 rejected, 0 malformed, 0 corrupt, 0 unknown\n',
      stderr: '',
    });
  });

  it('prints the CheckResult as one JSON document with --json', () => {
    const { root } = seeded();
    const out = run(['rebuild', '--check', '--json'], root);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(checkDoc(out)).toMatchObject({
      ok: true,
      noCache: false,
      differences: [],
      report: { folded: 4 },
    });
  });

  it('scenario: a hand-edited title is reported by ticket, exits 1, and the cache is unchanged', () => {
    const { root, boardDir, a } = seeded();
    handEdit(boardDir, "UPDATE tickets SET title = 'hacked' WHERE id = ?", a);
    const before = liveDump(boardDir);

    const out = run(['rebuild', '--check'], root);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe(`divergence: 1 differing row(s)\n  tickets ${a} changed\n`);
    expect(out.stderr).toBe(
      'agentboard: the cache differs from the event log in 1 row(s); run agentboard rebuild to replace it\n',
    );
    expect(liveDump(boardDir)).toBe(before);
    expect(oneJson(run(['show', a, '--json'], root))).toMatchObject({
      ticket: { title: 'hacked' },
    });
  });

  it('with --json prints one CheckResult document carrying both rows, and exits 1', () => {
    const { root, boardDir, a } = seeded();
    handEdit(boardDir, "UPDATE tickets SET title = 'hacked' WHERE id = ?", a);
    const before = liveDump(boardDir);
    const out = run(['rebuild', '--check', '--json'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/^agentboard: the cache differs from the event log in 1 row\(s\)/);
    const doc = checkDoc(out);
    expect(doc.ok).toBe(false);
    expect(doc.noCache).toBe(false);
    expect(doc.differences).toHaveLength(1);
    expect(doc.differences[0]).toMatchObject({
      table: 'tickets',
      key: a,
      ticket: a,
      live: { title: 'hacked' },
      rebuilt: { title: 'Alpha' },
    });
    expect(liveDump(boardDir)).toBe(before);
  });

  it('names every state of a difference: changed, only-in-cache and only-in-rebuild', () => {
    const { root, boardDir, a, b } = seeded();
    handEdit(boardDir, "UPDATE tickets SET title = 'x' WHERE id = ?", b);
    handEdit(boardDir, 'DELETE FROM comments WHERE ticket = ?', a);
    handEdit(
      boardDir,
      "INSERT INTO links (ticket, seq, kind, value, actor, ts, hash) VALUES (?, 99, 'pr', '1', 'x', 'x', 'x')",
      b,
    );
    const out = run(['rebuild', '--check'], root);
    expect(out.code).toBe(1);
    const lines = out.stdout.split('\n');
    expect(lines[0]).toBe('divergence: 3 differing row(s)');
    expect(lines).toContain(`  comments ${a}#0 only-in-rebuild`);
    expect(lines).toContain(`  links ${b}#99 only-in-cache`);
    expect(lines).toContain(`  tickets ${b} changed`);
    expect(out.stdout.endsWith('\n')).toBe(true);
  });

  it('does not catch up: an unfolded event file is a divergence and stays unfolded', () => {
    const { root, boardDir, b } = seeded();
    // An event file a crashed command left behind (renamed, never committed).
    const hash = putEvent(
      join(boardDir, 'events'),
      ev(
        { kind: 'ticket.comment', ticket: b, body: { text: 'orphan' } },
        'crasher',
        9_999_999_999_999,
      ),
    );
    const before = liveDump(boardDir);
    const out = run(['rebuild', '--check', '--json'], root);
    expect(out.code).toBe(1);
    const doc = checkDoc(out);
    expect(doc.differences.some((d) => d.table === 'folded' && d.key === hash)).toBe(true);
    expect(doc.differences.some((d) => d.ticket === b)).toBe(true);
    expect(liveDump(boardDir)).toBe(before);
    // Running it again gives the same answer: nothing was folded.
    expect(canon(checkDoc(run(['rebuild', '--check', '--json'], root)))).toBe(canon(doc));
    // Any ordinary command then folds it, after which --check is clean.
    expect(oneJson(run(['show', b, '--json'], root))).toMatchObject({
      ticket: { comments: [{ text: 'orphan' }] },
    });
    expect(run(['rebuild', '--check'], root).code).toBe(0);
  });

  it('exits 1 reporting no-cache when there is no cache file, and does not create one', () => {
    const { root, boardDir } = seeded();
    const cache = join(boardDir, 'cache.sqlite');
    for (const name of ['cache.sqlite', 'cache.sqlite-wal', 'cache.sqlite-shm']) {
      rmSync(join(boardDir, name), { force: true });
    }
    const out = run(['rebuild', '--check'], root);
    expect(out).toEqual({
      code: 1,
      stdout: 'no-cache: there is no cache file\n',
      stderr: `agentboard: there is no cache file at ${cache}; run agentboard rebuild to create it\n`,
    });
    expect(existsSync(cache)).toBe(false);

    const json = run(['rebuild', '--check', '--json'], root);
    expect(json.code).toBe(1);
    expect(oneJson(json)).toEqual({ ok: false, noCache: true, differences: [], report: null });
    expect(existsSync(cache)).toBe(false);

    // rebuild creates it, after which the check is clean.
    expect(run(['rebuild'], root).code).toBe(0);
    expect(existsSync(cache)).toBe(true);
    expect(run(['rebuild', '--check'], root).code).toBe(0);
  });

  it('does not reap a stale temporary file', () => {
    const { root, boardDir } = seeded();
    const temp = join(boardDir, 'events', '.tmp-0123456789abcdef0123456789abcdef');
    writeFileSync(temp, '{"partial":');
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(temp, old, old);
    const out = run(['rebuild', '--check'], root);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(run(['list'], root).stderr).toBe(`agentboard: removed stale temporary file ${temp}\n`);
  });

  it('the built CLI exits 1 on divergence and 0 once rebuilt', () => {
    const { root, boardDir, a } = seeded();
    handEdit(boardDir, "UPDATE tickets SET title = 'hacked' WHERE id = ?", a);
    const out = spawnCli(['rebuild', '--check'], root);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(a);
    expect(spawnCli(['rebuild'], root).code).toBe(0);
    expect(spawnCli(['rebuild', '--check'], root)).toMatchObject({ code: 0, stderr: '' });
  });
});
