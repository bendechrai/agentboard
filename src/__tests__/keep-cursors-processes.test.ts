/**
 * keep-cursors-on-upgrade task 1.3: the carry across processes and the
 * read-only paths (board-cache: "Cache is derived and disposable",
 * scenarios "Cache of a later schema version is recreated as before" and
 * "Inspecting an earlier cache changes nothing"; design.md: "Carry the
 * cursor tables inside the recreate's transaction", "Read-only paths").
 *
 * Every child runs the built CLI (or, to stop a process between the
 * recreate and its first catch-up, a small script importing the built
 * library) on a copy of a 0.2.0 fixture (`src/store/__tests__/v020-cache.ts`).
 * Races start behind the harness's start gate and every wait is on a
 * condition (a ready file, a line on stderr, an exit), never a fixed
 * sleep, so a loaded host only makes them slower. Each scenario runs
 * `ROUNDS` times.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BoardError } from '../store/errors.js';
import { openCache } from '../store/cache.js';
import {
  V020_FIXTURES,
  cacheHashes,
  carriedApplied,
  cursorRows,
  fixtureEvents,
  hasTable,
  minuteOf,
  readOldRows,
  withDb,
  type FixtureName,
  type OldRows,
} from '../store/__tests__/v020-cache.js';
import {
  boardProject,
  cliEnv,
  oneDocument,
  requireBuiltCli,
  runCliAsync,
  scratchDir,
  startGated,
  type ProcessResult,
} from './harness/processes.js';

/** How many times each scenario runs. */
const ROUNDS = 20;

/** Generous: twenty rounds of up to ten processes on a loaded host. */
const SLOW = { timeout: 900_000 };

interface InboxDoc {
  actor: string;
  entries: { hash: string; ts: { wall: number } }[];
  cursor: string | null;
  advanced: boolean;
}

/** A project holding a copy of fixture `name` (events and 0.2.0 cache). */
function project(name: FixtureName): {
  root: string;
  boardDir: string;
  cache: string;
  old: OldRows;
  events: ReturnType<typeof fixtureEvents>;
} {
  const { root, boardDir, eventsDir } = boardProject();
  const source = join(V020_FIXTURES, name);
  cpSync(join(source, 'events'), eventsDir, { recursive: true });
  const cache = join(boardDir, 'cache.sqlite');
  cpSync(join(source, 'cache.sqlite'), cache);
  return { root, boardDir, cache, old: readOldRows(cache), events: fixtureEvents(eventsDir) };
}

function inboxDoc(result: ProcessResult): InboxDoc {
  expect(result.code, result.stderr).toBe(0);
  return oneDocument(result) as InboxDoc;
}

function minutesOf(doc: InboxDoc): number[] {
  return doc.entries.map((e) => minuteOf(e.ts.wall));
}

function seenOf(old: OldRows, actor: string): Set<string> {
  return new Set(old.seen.filter((r) => r.actor === actor).map((r) => String(r.hash)));
}

/**
 * The minutes each actor's first `inbox --peek` returns after the upgrade
 * (the in-process scenarios of keep-cursors.test.ts pin how they arise).
 */
function expectedMinutes(
  name: FixtureName,
  actor: string,
  old: OldRows,
  events: ReturnType<typeof fixtureEvents>,
): number[] {
  const all = events.map((e) => e.minute);
  if (!old.cursors.some((r) => r.actor === actor)) {
    return all;
  }
  if (name === 'plain') {
    return actor === 'alice' ? [45, 60, 75, 90, 105, 120, 140, 160, 180, 190] : [190];
  }
  if (actor === 'carol') {
    return [10, 15, 70, 90, 110, 130, 150, 160, 170, 180, 190];
  }
  // alice and bob: moved back to the minute 0 event by the supersede.
  const seen = seenOf(old, actor);
  return events.filter((e) => e.minute > 0 && !seen.has(e.hash)).map((e) => e.minute);
}

/** The `cursors` row of each actor after the first fold. */
function expectedCursors(
  name: FixtureName,
  old: OldRows,
  events: ReturnType<typeof fixtureEvents>,
): OldRows['cursors'] {
  if (name === 'plain') {
    return old.cursors;
  }
  const first = events.find((e) => e.minute === 0);
  return old.cursors.map((row) =>
    row.actor === 'carol'
      ? row
      : {
          actor: row.actor ?? null,
          last_wall: first?.event.ts.wall ?? null,
          last_counter: first?.event.ts.counter ?? null,
          last_actor: first?.event.ts.actor ?? null,
          last_hash: first?.hash ?? null,
        },
  );
}

const TEN = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hal', 'ivy', 'jo'];

describe('ten processes open a 0.2.0 cache at once (1.3)', () => {
  it(
    'all succeed, one recreate carries the cursors, every process sees them, and carried_applied is consumed once',
    SLOW,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const name: FixtureName = round % 2 === 0 ? 'unknown' : 'plain';
        const { root, cache, old, events } = project(name);
        const gated = await startGated(
          TEN.map((actor) => ({ argv: ['inbox', '--peek', '--as', actor, '--json'] })),
          root,
        );
        expect(gated.readyAtGate).toBe(TEN.length);
        gated.open();
        const results = await Promise.all(gated.procs.map((p) => p.exited));
        results.forEach((result, i) => {
          const actor = TEN[i] ?? '';
          const doc = inboxDoc(result);
          expect(doc.actor).toBe(actor);
          expect(minutesOf(doc), `round ${String(round)} ${name} ${actor}`).toEqual(
            expectedMinutes(name, actor, old, events),
          );
        });
        withDb(cache, (db: DatabaseSync) => {
          const now = cursorRows(db);
          expect(now.cursors).toEqual(expectedCursors(name, old, events));
          expect(now.seen).toEqual(old.seen);
          expect(hasTable(db, 'carried_applied')).toBe(false);
          expect(
            db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
          ).toBe('5');
        });
      }
    },
  );
});

/**
 * Starts a node child that opens the cache at `cache` with the built
 * library's `openCache` (the recreate, with no catch-up), prints `opened`
 * on stderr, and then blocks until killed.
 */
function openAndBlock(cache: string): { opened: Promise<void>; kill: () => Promise<void> } {
  const lib = pathToFileURL(join(dirname(requireBuiltCli()), 'index.js')).href;
  const script = `import { openCache } from ${JSON.stringify(lib)};
openCache(process.argv[1]);
process.stderr.write('opened\\n');
const cell = new Int32Array(new SharedArrayBuffer(4));
for (;;) { Atomics.wait(cell, 0, 0); }
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, cache], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  let err = '';
  const exited = new Promise<void>((resolve) => {
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const opened = new Promise<void>((resolve, reject) => {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
      if (err.includes('opened\n')) {
        resolve();
      }
    });
    void exited.then(() => {
      reject(new Error(`the opener exited before opening: ${err}`));
    });
  });
  return {
    opened,
    kill: () => {
      child.kill('SIGKILL');
      return exited;
    },
  };
}

describe('a process killed between the recreate and its first catch-up (1.3)', () => {
  it(
    "leaves the carried cursors and carried_applied, and the next command's catch-up uses them",
    SLOW,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const name: FixtureName = 'unknown';
        const { root, cache, old, events } = project(name);
        const opener = openAndBlock(cache);
        await opener.opened;
        await opener.kill();
        withDb(cache, (db) => {
          expect(cursorRows(db).cursors).toEqual(old.cursors);
          expect(cursorRows(db).seen).toEqual(old.seen);
          expect(carriedApplied(db)).toEqual(old.applied);
          expect(Number(db.prepare('SELECT count(*) AS n FROM folded').get()?.n)).toBe(0);
        });
        for (const actor of ['alice', 'carol', 'dave']) {
          const doc = inboxDoc(
            await runCliAsync(['inbox', '--peek', '--as', actor, '--json'], root, cliEnv()),
          );
          expect(minutesOf(doc), `round ${String(round)} ${actor}`).toEqual(
            expectedMinutes(name, actor, old, events),
          );
        }
        withDb(cache, (db) => {
          expect(cursorRows(db).cursors).toEqual(expectedCursors(name, old, events));
          expect(hasTable(db, 'carried_applied')).toBe(false);
        });
      }
    },
  );
});

/**
 * A child that, once `go` exists, advances alice's cursor as an `inbox` of
 * the old version would: in one BEGIN IMMEDIATE transaction (waiting on
 * the busy timeout), alice's position moves to `target` and her seen set
 * becomes `target.seen`, as `advanceCursor` leaves them after delivering
 * every event up to the target. The tables it writes have the same shape before
 * and after the recreate, so the advance lands in whichever cache is
 * current when it gets the lock. Prints `advanced <schema_version>`.
 */
function oldAdvance(
  cache: string,
  gateDir: string,
  target: {
    hash: string;
    wall: number;
    counter: number;
    actor: string;
    seen: { hash: string; wall: number }[];
  },
): { ready: Promise<void>; exited: Promise<string> } {
  const script = `import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [cache, gate, hash, wall, counter, actor, seen] = process.argv.slice(1);
const db = new DatabaseSync(cache);
db.exec('PRAGMA busy_timeout = 30000');
writeFileSync(gate + '/ready-old', '');
const cell = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(gate + '/go')) { Atomics.wait(cell, 0, 0, 1); }
for (;;) {
  try {
    db.exec('BEGIN IMMEDIATE');
    break;
  } catch (error) {
    if (!/busy|locked/i.test(String(error))) { throw error; }
  }
}
const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
db.prepare('UPDATE cursors SET last_wall = ?, last_counter = ?, last_actor = ?, last_hash = ? WHERE actor = ?')
  .run(Number(wall), Number(counter), actor, hash, 'alice');
db.prepare("DELETE FROM cursor_seen WHERE actor = 'alice'").run();
for (const s of JSON.parse(seen)) {
  db.prepare("INSERT INTO cursor_seen (actor, hash, wall) VALUES ('alice', ?, ?)").run(s.hash, s.wall);
}
db.exec('COMMIT');
db.close();
process.stdout.write('advanced ' + version + '\\n');
`;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      cache,
      gateDir,
      target.hash,
      String(target.wall),
      String(target.counter),
      target.actor,
      JSON.stringify(target.seen),
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (out += c));
  child.stderr.on('data', (c: string) => (err += c));
  const exited = new Promise<string>((resolve, reject) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`old advance failed (${String(code)}): ${err}`));
      }
    });
  });
  const ready = (async (): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(gateDir, 'ready-old'))) {
      if (Date.now() > deadline) {
        throw new Error(`the old advance never got ready: ${err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return { ready, exited };
}

describe('an inbox advance racing the recreate (1.3)', () => {
  it(
    'an old-version advance is either carried or applied after the recreate, never lost',
    SLOW,
    async () => {
      const outcomes = new Set<string>();
      for (let round = 0; round < ROUNDS; round++) {
        const { root, cache, events } = project('plain');
        const last = events.at(-1);
        expect(last?.minute).toBe(190);
        const target = {
          hash: last?.hash ?? '',
          wall: last?.event.ts.wall ?? 0,
          counter: last?.event.ts.counter ?? 0,
          actor: last?.event.ts.actor ?? '',
          seen: events
            .filter((e) => e.event.ts.wall >= (last?.event.ts.wall ?? 0) - 3_600_000)
            .map((e) => ({ hash: e.hash, wall: e.event.ts.wall })),
        };
        const gateDir = scratchDir();
        const advance = oldAdvance(cache, gateDir, target);
        await advance.ready;
        const gated = await startGated(
          ['bob', 'carol', 'dave'].map((actor) => ({
            argv: ['inbox', '--peek', '--as', actor, '--json'],
          })),
          root,
        );
        writeFileSync(join(gateDir, 'go'), '');
        gated.open();
        const [said, ...results] = await Promise.all([
          advance.exited,
          ...gated.procs.map((p) => p.exited),
        ]);
        outcomes.add(String(said).trim());
        for (const result of results) {
          expect(result.code, result.stderr).toBe(0);
        }
        // A later command sees alice at the advanced position, whichever won.
        const doc = inboxDoc(
          await runCliAsync(['inbox', '--peek', '--as', 'alice', '--json'], root, cliEnv()),
        );
        expect(doc.cursor, `round ${String(round)}: ${String(said)}`).toBe(target.hash);
        expect(doc.entries).toEqual([]);
        withDb(cache, (db) => {
          const alice = cursorRows(db).cursors.find((r) => r.actor === 'alice');
          expect(alice?.last_hash).toBe(target.hash);
          expect(alice?.last_wall).toBe(target.wall);
        });
      }
      // Both orders are legal; record which happened for the PR.
      expect([...outcomes].every((o) => o === 'advanced 4' || o === 'advanced 5')).toBe(true);
    },
  );

  it(
    'an inbox of this version advancing while others open the 0.2.0 cache keeps its advance',
    SLOW,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { root, cache, events } = project('plain');
        const gated = await startGated(
          [
            { argv: ['inbox', '--as', 'alice', '--json'] },
            ...['bob', 'carol', 'dave'].map((actor) => ({
              argv: ['inbox', '--peek', '--as', actor, '--json'],
            })),
          ],
          root,
        );
        gated.open();
        const [alice, ...others] = await Promise.all(gated.procs.map((p) => p.exited));
        for (const result of others) {
          expect(result.code, result.stderr).toBe(0);
        }
        const doc = inboxDoc(alice as ProcessResult);
        expect(minutesOf(doc)).toEqual([45, 60, 75, 90, 105, 120, 140, 160, 180, 190]);
        expect(doc.advanced).toBe(true);
        const last = events.at(-1);
        withDb(cache, (db) => {
          expect(cursorRows(db).cursors.find((r) => r.actor === 'alice')?.last_hash).toBe(
            last?.hash,
          );
        });
        const again = inboxDoc(
          await runCliAsync(['inbox', '--peek', '--as', 'alice', '--json'], root, cliEnv()),
        );
        expect(again.entries).toEqual([]);
      }
    },
  );
});

describe('read-only paths and later versions (1.3)', () => {
  it('scenario: cache of a later schema version is recreated as before', SLOW, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { root, cache, events } = project('plain');
      withDb(cache, (db) => {
        db.exec("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
      });
      const doc = inboxDoc(
        await runCliAsync(['inbox', '--peek', '--as', 'alice', '--json'], root, cliEnv()),
      );
      expect(minutesOf(doc)).toEqual(events.map((e) => e.minute));
      withDb(cache, (db) => {
        expect(cursorRows(db).cursors).toEqual([]);
        expect(cursorRows(db).seen).toEqual([]);
        expect(hasTable(db, 'carried_applied')).toBe(false);
        expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value).toBe(
          '5',
        );
      });
    }
  });

  it(
    'scenario: inspecting an earlier cache changes nothing (rebuild --check on the 0.2.0 cache)',
    SLOW,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { root, cache, old } = project('plain');
        const before = cacheHashes(cache);
        const result = await runCliAsync(['rebuild', '--check', '--json'], root, cliEnv());
        expect(result.code).toBe(1);
        expect(oneDocument(result)).toMatchObject({ ok: false, schemaMismatch: true });
        expect(result.stderr).toMatch(/schema/);
        expect(cacheHashes(cache)).toEqual(before);
        const after = readOldRows(cache);
        expect(after).toEqual(old);
        expect(
          withDb(
            cache,
            (db) => db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
          ),
        ).toBe('4');
      }
    },
  );

  it(
    'rebuild --check on a schema 5 cache holding carried_applied exits 0 and leaves the table',
    SLOW,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { root, cache } = project('plain');
        // The first command upgrades and folds.
        expect((await runCliAsync(['list', '--json'], root, cliEnv())).code).toBe(0);
        withDb(cache, (db) => {
          db.exec(
            "CREATE TABLE carried_applied (hash TEXT PRIMARY KEY); INSERT INTO carried_applied VALUES ('x')",
          );
        });
        const result = await runCliAsync(['rebuild', '--check'], root, cliEnv());
        expect(result.code, result.stderr).toBe(0);
        withDb(cache, (db) => {
          expect(carriedApplied(db)).toEqual(['x']);
        });
      }
    },
  );

  it('openCache(path, { prepare: false }) on the 0.2.0 cache throws schema-mismatch and leaves the file unchanged', () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { cache, old } = project(round % 2 === 0 ? 'plain' : 'unknown');
      const before = cacheHashes(cache);
      let thrown: unknown = null;
      try {
        openCache(cache, { prepare: false }).close();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BoardError);
      expect((thrown as BoardError).reason).toBe('schema-mismatch');
      expect(cacheHashes(cache)).toEqual(before);
      expect(readOldRows(cache)).toEqual(old);
    }
  });
});
