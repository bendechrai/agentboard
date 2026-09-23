import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CanonicalError, canonicalEncode, sha256Hex } from '../../events/canonical.js';
import { fold } from '../../events/fold.js';
import {
  STALE_TEMP_MS,
  TEMP_PREFIX,
  listEventFiles,
  readEventFile,
  readEventLog,
  reapStaleTemps,
  writeEventFile,
} from '../eventfile.js';
import { BoardError } from '../errors.js';
import { P, T1, T2, allNames, ev, tempBoard } from './helpers.js';

const eventsOf = (board: string): string => join(board, 'events');

const CREATE = ev(P.create(T1), 'orch', 1000);
const COMMENT = ev(P.comment(T1, 'hello'), 'impl', 2000);

/** Writes raw bytes under `name` and returns the path. */
function raw(eventsDir: string, name: string, bytes: Uint8Array | string): string {
  const path = join(eventsDir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('constants', () => {
  it('uses the .tmp- prefix and a one minute staleness threshold', () => {
    expect(TEMP_PREFIX).toBe('.tmp-');
    expect(STALE_TEMP_MS).toBe(60_000);
  });
});

describe('writeEventFile', () => {
  it('writes the canonical bytes under their SHA-256 name', () => {
    const dir = eventsOf(tempBoard());
    const bytes = canonicalEncode(CREATE);
    const result = writeEventFile(dir, CREATE);
    const hash = sha256Hex(bytes);
    expect(result).toEqual({ hash, path: join(dir, `${hash}.json`), existed: false });
    const onDisk = readFileSync(result.path);
    expect(Buffer.compare(onDisk, Buffer.from(bytes))).toBe(0);
    expect(onDisk.at(-1)).not.toBe(0x0a);
    expect(allNames(dir)).toEqual([`${hash}.json`]);
  });

  it('dedupes: the same event written twice leaves one file and reports it as present', () => {
    const dir = eventsOf(tempBoard());
    const first = writeEventFile(dir, CREATE);
    // Same value with a different key insertion order: same canonical bytes.
    const reordered = {
      body: CREATE.body,
      ts: CREATE.ts,
      actor: 'orch',
      ticket: T1,
      kind: 'ticket.create',
      v: 1,
    };
    let hookCalls = 0;
    const second = writeEventFile(dir, reordered, {
      afterTempWrite: () => (hookCalls += 1),
      afterRename: () => (hookCalls += 1),
    });
    expect(second).toEqual({ hash: first.hash, path: first.path, existed: true });
    expect(hookCalls).toBe(0);
    expect(allNames(dir)).toEqual([basename(first.path)]);
  });

  it('refuses with exit 5 when an existing file of the same name holds other bytes, touching nothing', () => {
    const dir = eventsOf(tempBoard());
    const hash = sha256Hex(canonicalEncode(CREATE));
    const path = raw(dir, `${hash}.json`, 'not the event');
    let hookCalls = 0;
    try {
      writeEventFile(dir, CREATE, {
        afterTempWrite: () => (hookCalls += 1),
        afterRename: () => (hookCalls += 1),
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      const err = error as BoardError;
      expect({ exitCode: err.exitCode, reason: err.reason }).toEqual({
        exitCode: 5,
        reason: 'integrity',
      });
      expect(err.message).toContain(path);
    }
    expect(hookCalls).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('not the event');
    expect(allNames(dir)).toEqual([`${hash}.json`]);
  });

  it('refuses with exit 5 when the existing file is another valid event under the wrong name', () => {
    const dir = eventsOf(tempBoard());
    const hash = sha256Hex(canonicalEncode(CREATE));
    const other = canonicalEncode(COMMENT);
    const path = raw(dir, `${hash}.json`, other);
    expect(() => writeEventFile(dir, CREATE)).toThrow(BoardError);
    expect(Buffer.compare(readFileSync(path), Buffer.from(other))).toBe(0);
  });

  it('writes the temporary file in the events directory and renames it', () => {
    const dir = eventsOf(tempBoard());
    const bytes = Buffer.from(canonicalEncode(COMMENT));
    const final = join(dir, `${sha256Hex(bytes)}.json`);
    const seen: string[] = [];
    let tempPath = '';
    writeEventFile(dir, COMMENT, {
      afterTempWrite: (temp) => {
        tempPath = temp;
        seen.push('temp');
        expect(dirname(temp)).toBe(dir);
        expect(basename(temp)).toMatch(/^\.tmp-[0-9a-f]{16,}$/);
        expect(Buffer.compare(readFileSync(temp), bytes)).toBe(0);
        expect(existsSync(final)).toBe(false);
      },
      afterRename: (path) => {
        seen.push('rename');
        expect(path).toBe(final);
        expect(existsSync(final)).toBe(true);
        expect(existsSync(tempPath)).toBe(false);
      },
    });
    expect(seen).toEqual(['temp', 'rename']);
    expect(allNames(dir)).toEqual([basename(final)]);
  });

  it('uses a different temporary name for each write', () => {
    const dir = eventsOf(tempBoard());
    const temps: string[] = [];
    const hooks = { afterTempWrite: (t: string) => temps.push(basename(t)) };
    writeEventFile(dir, CREATE, hooks);
    writeEventFile(dir, COMMENT, hooks);
    expect(temps).toHaveLength(2);
    expect(temps[0]).not.toBe(temps[1]);
  });

  it('leaves the temporary file and no hash-named file when it dies after the temp write', () => {
    const dir = eventsOf(tempBoard());
    const final = join(dir, `${sha256Hex(canonicalEncode(CREATE))}.json`);
    expect(() =>
      writeEventFile(dir, CREATE, {
        afterTempWrite: () => {
          throw new Error('killed');
        },
      }),
    ).toThrow('killed');
    expect(existsSync(final)).toBe(false);
    const names = allNames(dir);
    expect(names).toHaveLength(1);
    expect(names[0]?.startsWith(TEMP_PREFIX)).toBe(true);
    expect(listEventFiles(dir)).toEqual([]);
  });

  it('leaves the complete event file when it dies after the rename', () => {
    const dir = eventsOf(tempBoard());
    expect(() =>
      writeEventFile(dir, CREATE, {
        afterRename: () => {
          throw new Error('killed');
        },
      }),
    ).toThrow('killed');
    const hash = sha256Hex(canonicalEncode(CREATE));
    expect(allNames(dir)).toEqual([`${hash}.json`]);
    const outcome = readEventFile(dir, `${hash}.json`);
    expect(outcome.status).toBe('ok');
  });

  it('rejects a value that cannot be canonically encoded and writes nothing', () => {
    const dir = eventsOf(tempBoard());
    expect(() => writeEventFile(dir, { ...CREATE, extra: 1.5 })).toThrow(CanonicalError);
    expect(allNames(dir)).toEqual([]);
  });

  it('writes malformed but encodable values (validation is not its job)', () => {
    const dir = eventsOf(tempBoard());
    const result = writeEventFile(dir, { hello: 'world' });
    expect(result.existed).toBe(false);
    expect(readEventFile(dir, basename(result.path)).status).toBe('malformed');
  });
});

describe('listEventFiles', () => {
  it('lists regular files sorted, ignoring every dot-named entry and subdirectories', () => {
    const dir = eventsOf(tempBoard());
    const a = writeEventFile(dir, CREATE);
    const b = writeEventFile(dir, COMMENT);
    raw(dir, '.tmp-0123456789abcdef', 'partial');
    raw(dir, '.tmp-x', '');
    raw(dir, '.gitkeep', '');
    raw(dir, '.DS_Store', 'junk');
    raw(dir, 'garbage.json', '{}');
    raw(dir, 'notes.txt', 'hello');
    mkdirSync(join(dir, 'subdir'));
    const expected = [basename(a.path), basename(b.path), 'garbage.json', 'notes.txt'].sort();
    expect(listEventFiles(dir)).toEqual(expected);
  });

  it('is empty for an events directory holding only .gitkeep', () => {
    const dir = eventsOf(tempBoard());
    raw(dir, '.gitkeep', '');
    expect(listEventFiles(dir)).toEqual([]);
  });

  it('is empty for an empty events directory', () => {
    expect(listEventFiles(eventsOf(tempBoard()))).toEqual([]);
  });
});

describe('readEventFile', () => {
  it('reads a well-formed known event', () => {
    const dir = eventsOf(tempBoard());
    const { hash, path } = writeEventFile(dir, CREATE);
    expect(readEventFile(dir, basename(path))).toEqual({
      status: 'ok',
      input: { hash, event: CREATE },
    });
  });

  it('reads a well-formed event of an unknown kind without a ticket as ok', () => {
    const dir = eventsOf(tempBoard());
    const unknown = {
      v: 1,
      kind: 'board.archive',
      actor: 'a',
      ts: { wall: 5, counter: 0, actor: 'a' },
      body: {},
    };
    const { hash, path } = writeEventFile(dir, unknown);
    expect(readEventFile(dir, basename(path))).toEqual({
      status: 'ok',
      input: { hash, event: unknown },
    });
  });

  it('reports a file whose name is the hash of other bytes as corrupt with its path', () => {
    const dir = eventsOf(tempBoard());
    const otherHash = sha256Hex(canonicalEncode(COMMENT));
    const path = raw(dir, `${otherHash}.json`, canonicalEncode(CREATE));
    const outcome = readEventFile(dir, `${otherHash}.json`);
    expect(outcome.status).toBe('corrupt');
    if (outcome.status === 'corrupt') {
      expect(outcome.file.path).toBe(path);
      expect(outcome.file.name).toBe(`${otherHash}.json`);
      expect(outcome.file.message.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['a name that is not a hash', 'garbage.json'],
    ['an uppercase hash', 'UPPER'],
    ['a hash without .json', 'NOEXT'],
    ['a hash with a trailing newline in the file', 'NEWLINE'],
  ])('reports %s as corrupt', (_label, kind) => {
    const dir = eventsOf(tempBoard());
    const bytes = canonicalEncode(CREATE);
    const hash = sha256Hex(bytes);
    let name: string;
    if (kind === 'UPPER') {
      name = `${hash.toUpperCase()}.json`;
      raw(dir, name, bytes);
    } else if (kind === 'NOEXT') {
      name = hash;
      raw(dir, name, bytes);
    } else if (kind === 'NEWLINE') {
      name = `${hash}.json`;
      raw(dir, name, Buffer.concat([Buffer.from(bytes), Buffer.from('\n')]));
    } else {
      name = kind;
      raw(dir, name, bytes);
    }
    expect(readEventFile(dir, name).status).toBe('corrupt');
  });

  it('reports a correctly named non-canonical file as malformed', () => {
    const dir = eventsOf(tempBoard());
    const text = JSON.stringify(CREATE, null, 2);
    const hash = sha256Hex(Buffer.from(text));
    const path = raw(dir, `${hash}.json`, text);
    const outcome = readEventFile(dir, `${hash}.json`);
    expect(outcome.status).toBe('malformed');
    if (outcome.status === 'malformed') {
      expect(outcome.file.path).toBe(path);
      expect(outcome.file.hash).toBe(hash);
      expect(outcome.file.reasons).toHaveLength(1);
      expect(outcome.file.reasons[0]?.field).toBe('');
    }
  });

  it('reports a correctly named event without an actor as malformed naming actor', () => {
    const dir = eventsOf(tempBoard());
    const noActor: Record<string, unknown> = { ...CREATE };
    delete noActor.actor;
    const { hash, path } = writeEventFile(dir, noActor);
    const outcome = readEventFile(dir, basename(path));
    expect(outcome.status).toBe('malformed');
    if (outcome.status === 'malformed') {
      expect(outcome.file.hash).toBe(hash);
      expect(outcome.file.reasons.map((r) => r.field)).toContain('actor');
    }
  });
});

describe('readEventLog', () => {
  it('folds the rest of the log when one file is corrupt and one malformed', () => {
    const dir = eventsOf(tempBoard());
    const a = writeEventFile(dir, CREATE);
    const b = writeEventFile(dir, COMMENT);
    const corruptName = `${'0'.repeat(64)}.json`;
    const corruptPath = raw(dir, corruptName, canonicalEncode(ev(P.create(T2), 'x', 1)));
    const bad = writeEventFile(dir, { v: 1, kind: 'ticket.comment' });
    raw(dir, '.tmp-deadbeefdeadbeef', 'partial');
    raw(dir, '.gitkeep', '');

    const log = readEventLog(dir);
    expect(log.inputs.map((i) => i.hash)).toEqual([a.hash, b.hash].sort());
    expect(log.corrupt.map((c) => c.path)).toEqual([corruptPath]);
    expect(log.malformed.map((m) => m.hash)).toEqual([bad.hash]);

    const result = fold(log.inputs);
    expect(Object.keys(result.state.tickets)).toEqual([T1]);
    expect(result.state.tickets[T1]?.comments.map((c) => c.text)).toEqual(['hello']);
  });

  it('reports no corrupt file for .gitkeep alongside valid events (placeholder is not corrupt)', () => {
    const dir = eventsOf(tempBoard());
    raw(dir, '.gitkeep', '');
    const a = writeEventFile(dir, CREATE);
    const b = writeEventFile(dir, COMMENT);
    const log = readEventLog(dir);
    expect(log.corrupt).toEqual([]);
    expect(log.malformed).toEqual([]);
    expect(log.inputs.map((i) => i.hash)).toEqual([a.hash, b.hash].sort());
  });

  it('still reports a non-dot junk name such as notes.txt as corrupt', () => {
    const dir = eventsOf(tempBoard());
    raw(dir, '.gitkeep', '');
    writeEventFile(dir, CREATE);
    const notes = raw(dir, 'notes.txt', 'hello');
    const log = readEventLog(dir);
    expect(log.corrupt.map((c) => [c.path, c.name])).toEqual([[notes, 'notes.txt']]);
    expect(log.inputs).toHaveLength(1);
  });

  it('sorts every partition by file name', () => {
    const dir = eventsOf(tempBoard());
    const written = [CREATE, COMMENT, ev(P.comment(T1, 'again'), 'impl', 3000)].map((e) =>
      writeEventFile(dir, e),
    );
    raw(dir, 'z.json', 'z');
    raw(dir, 'a.json', 'a');
    const log = readEventLog(dir);
    expect(log.inputs.map((i) => i.hash)).toEqual(written.map((w) => w.hash).sort());
    expect(log.corrupt.map((c) => c.name)).toEqual(['a.json', 'z.json']);
  });

  it('skips hashes in the skip set', () => {
    const dir = eventsOf(tempBoard());
    const a = writeEventFile(dir, CREATE);
    const b = writeEventFile(dir, COMMENT);
    const log = readEventLog(dir, new Set([a.hash]));
    expect(log.inputs.map((i) => i.hash)).toEqual([b.hash]);
  });
});

describe('reapStaleTemps', () => {
  const NOW = 1_700_000_000_000;
  const secondsAgo = (ms: number): number => (NOW - ms) / 1000;

  it('removes temporary files older than one minute and reports them', () => {
    const dir = eventsOf(tempBoard());
    const old1 = raw(dir, '.tmp-bbbbbbbbbbbbbbbb', 'x');
    const old2 = raw(dir, '.tmp-aaaaaaaaaaaaaaaa', 'y');
    const young = raw(dir, '.tmp-cccccccccccccccc', 'z');
    utimesSync(old1, secondsAgo(120_000), secondsAgo(120_000));
    utimesSync(old2, secondsAgo(61_000), secondsAgo(61_000));
    utimesSync(young, secondsAgo(10_000), secondsAgo(10_000));

    expect(reapStaleTemps(dir, { now: NOW })).toEqual([old2, old1]);
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });

  it('keeps a temporary file exactly one minute old', () => {
    const dir = eventsOf(tempBoard());
    const edge = raw(dir, '.tmp-eeeeeeeeeeeeeeee', 'x');
    utimesSync(edge, secondsAgo(60_000), secondsAgo(60_000));
    expect(reapStaleTemps(dir, { now: NOW })).toEqual([]);
    expect(existsSync(edge)).toBe(true);
  });

  it('never removes event files, .gitkeep or other non-temporary files, however old', () => {
    const dir = eventsOf(tempBoard());
    const event = writeEventFile(dir, CREATE).path;
    const other = raw(dir, 'garbage.json', 'x');
    const keep = raw(dir, '.gitkeep', '');
    const dot = raw(dir, '.other', 'x');
    for (const p of [event, other, keep, dot]) {
      utimesSync(p, secondsAgo(3_600_000), secondsAgo(3_600_000));
    }
    expect(reapStaleTemps(dir, { now: NOW })).toEqual([]);
    for (const p of [event, other, keep, dot]) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it('honours a custom threshold', () => {
    const dir = eventsOf(tempBoard());
    const t = raw(dir, '.tmp-ffffffffffffffff', 'x');
    utimesSync(t, secondsAgo(5_000), secondsAgo(5_000));
    expect(reapStaleTemps(dir, { now: NOW, maxAgeMs: 10_000 })).toEqual([]);
    expect(reapStaleTemps(dir, { now: NOW, maxAgeMs: 1_000 })).toEqual([t]);
  });

  it('defaults to the real clock: a fresh temp is kept, an old one is removed', () => {
    const dir = eventsOf(tempBoard());
    const fresh = raw(dir, '.tmp-1111111111111111', 'x');
    const stale = raw(dir, '.tmp-2222222222222222', 'y');
    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(stale, old, old);
    expect(reapStaleTemps(dir)).toEqual([stale]);
    expect(existsSync(fresh)).toBe(true);
  });
});
