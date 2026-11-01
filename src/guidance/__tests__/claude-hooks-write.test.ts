/**
 * How `.claude/settings.json` is replaced (design.md "Rulings from task
 * group 3 (test author)", file handling, and "Rulings from review round 1
 * of task group 3", R4 and R5), observed through a wrapper around
 * `node:fs`: the temporary file is opened with `openSync` and flushed
 * with `fsyncSync` on that descriptor before `renameSync` moves it over
 * the settings file, and a failure after the temporary file exists
 * removes it and leaves the settings file as it was.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installGuidance } from '../install.js';
import { ENV, plainProject, readRel, writeRel } from './guidance-helpers.js';

const fsLog = vi.hoisted(() => ({
  calls: [] as string[],
  fds: new Map<number, string>(),
  renameError: null as Error | null,
  fsyncError: null as Error | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...args);
      fsLog.fds.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      fsLog.calls.push(`fsync ${fsLog.fds.get(fd) ?? '?'}`);
      if (fsLog.fsyncError !== null) {
        throw fsLog.fsyncError;
      }
      real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      fsLog.calls.push(`rename ${from} ${to}`);
      if (fsLog.renameError !== null) {
        throw fsLog.renameError;
      }
      real.renameSync(from, to);
    },
  };
});

afterEach(() => {
  fsLog.calls.length = 0;
  fsLog.fds.clear();
  fsLog.renameError = null;
  fsLog.fsyncError = null;
});

const SETTINGS = '.claude/settings.json';

function ioError(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code });
}

function settingsProject(): string {
  const root = plainProject();
  writeRel(root, SETTINGS, '{\n  "model": "opus"\n}\n');
  return root;
}

function installHooks(root: string): unknown {
  return installGuidance({ cwd: root, env: ENV, targets: ['claude-hooks'] });
}

describe('replacing settings.json', () => {
  it('flushes the temporary file with fsync before renaming it over the settings file', () => {
    const root = settingsProject();
    installHooks(root);
    const renames = fsLog.calls.filter((c) => c.startsWith('rename '));
    expect(renames).toHaveLength(1);
    const [, temp, target] = (renames[0] ?? '').split(' ');
    expect(target).toBe(join(root, SETTINGS));
    expect(temp?.startsWith(join(root, '.claude'))).toBe(true);
    const renameAt = fsLog.calls.indexOf(renames[0] ?? '');
    const fsyncAt = fsLog.calls.indexOf(`fsync ${temp ?? ''}`);
    expect(fsyncAt).toBeGreaterThanOrEqual(0);
    expect(fsyncAt).toBeLessThan(renameAt);
  });

  it.each([
    ['the rename fails', 'rename'],
    ['the fsync fails', 'fsync'],
  ])('removes the temporary file and keeps the settings file when %s', (_label, step) => {
    const root = settingsProject();
    if (step === 'rename') {
      fsLog.renameError = ioError('EIO');
    } else {
      fsLog.fsyncError = ioError('EIO');
    }
    expect(() => installHooks(root)).toThrow(/EIO/);
    expect(readdirSync(join(root, '.claude'))).toEqual(['settings.json']);
    expect(readRel(root, SETTINGS)).toBe('{\n  "model": "opus"\n}\n');
  });
});
