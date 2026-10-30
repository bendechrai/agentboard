/**
 * Child-process helpers for the keep-cursors-on-upgrade tests
 * (`keep-cursors-processes.test.ts`, `keep-cursors-boundary.test.ts`), on
 * top of the multi-process harness (`processes.ts`):
 *
 * - `fixtureProject`: a project holding a copy of a 0.2.0 fixture
 *   (`src/store/__tests__/v020-cache.ts`).
 * - `oldAdvance`: a child that advances alice's cursor as an `inbox` of the
 *   old version writes it, optionally behind a start gate of its own.
 * - `startHeld`: the built CLI held at a chosen SQL statement (the
 *   statement gate), so a test can act at an exact point of another
 *   process's open without relying on timing.
 *
 * Every wait is on a condition (a file, a line on stderr, an exit), never
 * a fixed sleep. Children are killed after `CHILD_TIMEOUT_MS`.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect } from 'vitest';

import {
  V020_FIXTURES,
  fixtureEvents,
  minuteOf,
  readOldRows,
  type FixtureEvent,
  type FixtureName,
  type OldRows,
} from '../../store/__tests__/v020-cache.js';
import {
  CHILD_TIMEOUT_MS,
  boardProject,
  cliEnv,
  oneDocument,
  scratchDir,
  startCli,
  type ProcessResult,
} from './processes.js';

/** A project holding a copy of a 0.2.0 fixture. */
export interface FixtureProject {
  root: string;
  boardDir: string;
  /** The cache file, `<boardDir>/cache.sqlite`. */
  cache: string;
  /** The fixture's cursor rows and applied hashes, as 0.2.0 left them. */
  old: OldRows;
  events: FixtureEvent[];
}

/** A fresh project (removed after the test file) holding fixture `name`. */
export function fixtureProject(name: FixtureName): FixtureProject {
  const { root, boardDir, eventsDir } = boardProject();
  const source = join(V020_FIXTURES, name);
  cpSync(join(source, 'events'), eventsDir, { recursive: true });
  const cache = join(boardDir, 'cache.sqlite');
  cpSync(join(source, 'cache.sqlite'), cache);
  return { root, boardDir, cache, old: readOldRows(cache), events: fixtureEvents(eventsDir) };
}

/** The `inbox --json` document. */
export interface InboxDoc {
  actor: string;
  entries: { hash: string; ts: { wall: number } }[];
  cursor: string | null;
  advanced: boolean;
}

/** Expects exit 0 and returns the `inbox --json` document. */
export function inboxDoc(result: ProcessResult): InboxDoc {
  expect(result.code, result.stderr).toBe(0);
  return oneDocument(result) as InboxDoc;
}

/** The fixture minutes of an inbox's entries, in order. */
export function minutesOf(doc: InboxDoc): number[] {
  return doc.entries.map((e) => minuteOf(e.ts.wall));
}

/** Where `oldAdvance` moves alice's cursor, and her seen set after it. */
export interface AdvanceTarget {
  hash: string;
  wall: number;
  counter: number;
  actor: string;
  seen: { hash: string; wall: number }[];
}

/**
 * The cursor `advanceCursor` leaves after delivering every event up to the
 * last one of `events`: positioned on it, with every event within the
 * hour before it in the seen set.
 */
export function advanceTarget(events: readonly FixtureEvent[]): AdvanceTarget {
  const last = events.at(-1);
  if (last === undefined) {
    throw new Error('no events to advance over');
  }
  const { wall, counter, actor } = last.event.ts;
  return {
    hash: last.hash,
    wall,
    counter,
    actor,
    seen: events
      .filter((e) => e.event.ts.wall >= wall - 3_600_000)
      .map((e) => ({ hash: e.hash, wall: e.event.ts.wall })),
  };
}

const ADVANCE_SCRIPT = `import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [cache, gate, hash, wall, counter, actor, seen] = process.argv.slice(1);
const db = new DatabaseSync(cache);
db.exec('PRAGMA busy_timeout = 30000');
if (gate !== '') {
  writeFileSync(gate + '/ready-old', '');
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(gate + '/go')) { Atomics.wait(cell, 0, 0, 1); }
}
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

/**
 * A child that advances alice's cursor as an `inbox` of the old version
 * would: in one BEGIN IMMEDIATE transaction (retried while busy), alice's
 * position moves to `target` and her seen set becomes `target.seen`. The
 * cursor tables have the same shape before and after the recreate, so the
 * advance lands in whichever cache is current when it gets the lock.
 * Prints `advanced <schema_version it saw>`, which `exited` resolves with.
 *
 * With `gateDir`, the child opens the cache, creates `ready-old` there and
 * waits for a `go` file before starting its transaction (`ready` resolves
 * once it waits); without it, it starts at once (`ready` is resolved).
 */
export function oldAdvance(
  cache: string,
  target: AdvanceTarget,
  gateDir?: string,
): { ready: Promise<void>; exited: Promise<string> } {
  const gate = gateDir ?? '';
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      ADVANCE_SCRIPT,
      cache,
      gate,
      target.hash,
      String(target.wall),
      String(target.counter),
      target.actor,
      JSON.stringify(target.seen),
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  let done = false;
  const exited = new Promise<string>((resolve, reject) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      done = true;
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`old advance failed (${String(code)}): ${err}`));
      }
    });
  });
  const ready =
    gate === ''
      ? Promise.resolve()
      : (async (): Promise<void> => {
          while (!existsSync(join(gate, 'ready-old'))) {
            if (done) {
              throw new Error(`the old advance exited before it was ready: ${err}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })();
  return { ready, exited };
}

/** Where the statement gate holds a child (see `startHeld`). */
export interface StatementGate {
  /** Regular expression matched against the SQL text given to `exec`. */
  sql: string;
  /** Hold before running the matching statement, or right after it. */
  when: 'before' | 'after';
  /** Hold at the `nth` matching statement (1-based); defaults to 1. */
  nth?: number;
}

/** Environment variables read by the statement gate preload only. */
const GATE_DIR_ENV = 'AGENTBOARD_HARNESS_HOLD_DIR';
const GATE_SQL_ENV = 'AGENTBOARD_HARNESS_HOLD_SQL';
const GATE_WHEN_ENV = 'AGENTBOARD_HARNESS_HOLD_WHEN';
const GATE_NTH_ENV = 'AGENTBOARD_HARNESS_HOLD_NTH';

const HOLD_MODULE = `import { existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = process.env.${GATE_DIR_ENV} ?? '';
const pattern = new RegExp(process.env.${GATE_SQL_ENV} ?? '$^');
const when = process.env.${GATE_WHEN_ENV};
const nth = Number(process.env.${GATE_NTH_ENV} ?? '1');
const exec = DatabaseSync.prototype.exec;
const cell = new Int32Array(new SharedArrayBuffer(4));
let seen = 0;
let fired = false;
function hold() {
  writeSync(2, 'agentboard-harness: held\\n');
  while (!existsSync(join(dir, 'release'))) {
    Atomics.wait(cell, 0, 0, 1);
  }
}
DatabaseSync.prototype.exec = function (sql) {
  const hit = !fired && pattern.test(sql) && ++seen === nth;
  if (hit) {
    fired = true;
  }
  if (hit && when === 'before') {
    hold();
  }
  const result = exec.call(this, sql);
  if (hit && when === 'after') {
    hold();
  }
  return result;
};
`;

/** A CLI child held by the statement gate. */
export interface Held {
  /** Lets the child go on and resolves with its result. */
  release(): Promise<ProcessResult>;
}

/**
 * Starts the built CLI with `argv` in `root` under the statement gate: a
 * preload (`node --import`) that wraps `DatabaseSync.prototype.exec` and,
 * at the `gate.nth` statement whose SQL matches `gate.sql`, prints
 * `agentboard-harness: held` on stderr and blocks (before or after running
 * it) until `release` is called. Resolves once the child is held; rejects
 * when it exits first or is not held within `CHILD_TIMEOUT_MS`. Only
 * statements run through `exec` are matched (`BEGIN IMMEDIATE`, `COMMIT`,
 * `ROLLBACK` and the schema text), not prepared statements.
 */
export async function startHeld(
  argv: readonly string[],
  root: string,
  gate: StatementGate,
): Promise<Held> {
  const dir = scratchDir();
  const module = join(dir, 'hold.mjs');
  writeFileSync(module, HOLD_MODULE);
  const proc = startCli(
    {
      argv,
      env: cliEnv({
        [GATE_DIR_ENV]: dir,
        [GATE_SQL_ENV]: gate.sql,
        [GATE_WHEN_ENV]: gate.when,
        [GATE_NTH_ENV]: String(gate.nth ?? 1),
      }),
    },
    root,
    ['--import', pathToFileURL(module).href],
  );
  await proc.waitForStderr(/^agentboard-harness: held$/m, CHILD_TIMEOUT_MS);
  return {
    release: () => {
      writeFileSync(join(dir, 'release'), '');
      return proc.exited;
    },
  };
}
