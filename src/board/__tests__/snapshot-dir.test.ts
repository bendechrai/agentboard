/**
 * The `snapshotDir` test helper waits for git's transient files to go
 * before it snapshots, and still reports anything that stays or changes.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tempDir } from './helpers.js';
import { isGitTransient, snapshotDir } from './sharing-helpers.js';

/** A directory shaped like a standalone board: an event file and a ref under `.git`. */
function boardLike(): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'events'));
  mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, 'events', 'a.json'), '{}');
  writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'abc\n');
  return dir;
}

describe('snapshotDir', () => {
  it('names git lock files and gc.pid as transient, and nothing else', () => {
    expect(isGitTransient('maintenance.lock')).toBe(true);
    expect(isGitTransient('index.lock')).toBe(true);
    expect(isGitTransient('gc.pid')).toBe(true);
    expect(isGitTransient('index')).toBe(false);
    expect(isGitTransient('main')).toBe(false);
    expect(isGitTransient('a.json')).toBe(false);
  });

  it('waits for a lock released after it is called (a detached git maintenance) and snapshots without it', async () => {
    const dir = boardLike();
    const before = snapshotDir(dir);
    const lock = join(dir, '.git', 'objects', 'maintenance.lock');
    writeFileSync(lock, '');
    const child = spawn('sh', ['-c', 'sleep 0.3; rm -f "$1"', 'sh', lock], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', resolve));

    expect(snapshotDir(dir)).toEqual(before);
    await exited;
  });

  it('reports a lock that is still there at the deadline', () => {
    const dir = boardLike();
    const before = snapshotDir(dir);
    writeFileSync(join(dir, '.git', 'index.lock'), '');

    const after = snapshotDir(dir, 100);

    expect(after).not.toEqual(before);
    expect(after.some((line) => line.startsWith(join('.git', 'index.lock')))).toBe(true);
  });

  it('reports a changed ref and a new event file', () => {
    const dir = boardLike();
    const before = snapshotDir(dir);
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'def\n');
    expect(snapshotDir(dir)).not.toEqual(before);
    writeFileSync(join(dir, 'events', 'b.json'), '{}');
    expect(snapshotDir(dir)).toHaveLength(before.length + 1);
  });

  it('leaves the SQLite cache and its companions out', () => {
    const dir = boardLike();
    const before = snapshotDir(dir);
    writeFileSync(join(dir, 'cache.sqlite'), 'x');
    writeFileSync(join(dir, 'cache.sqlite-journal'), 'x');
    expect(snapshotDir(dir)).toEqual(before);
  });
});
