/**
 * Shared fixtures for the store tests: temporary directories, a clean git
 * environment, event builders, simple operations and an independent fold of
 * an events directory (built on the group 1 layer only, never on the store
 * code under test).
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach } from 'vitest';

import { canonicalDecode, canonicalEncode, sha256Hex } from '../../events/canonical.js';
import { fold, type FoldInput, type FoldResult } from '../../events/fold.js';
import type { Hlc } from '../../events/hlc.js';
import { validateEvent, type BoardEvent, type Status, type TaskRef } from '../../events/schema.js';
import type { Decision, Operation, ProposedEvent } from '../transaction.js';

export type Env = Record<string, string | undefined>;

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** A fresh temporary directory (realpath), removed after the current test. */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentboard-store-')));
  created.push(dir);
  return dir;
}

/** Creates `<parent>/.board/events` and returns the `.board` path. */
export function makeBoardDir(parent: string, name = '.board'): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, 'events'), { recursive: true });
  return dir;
}

/** A fresh temporary board directory (with `events`). */
export function tempBoard(): string {
  return makeBoardDir(tempDir());
}

/**
 * The process environment without any GIT_* variable or AGENTBOARD_DIR, and
 * with git discovery stopped at the temporary directory, so tests never see
 * the repository they run in.
 */
export function cleanEnv(extra: Env = {}): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && key !== 'AGENTBOARD_DIR') {
      env[key] = value;
    }
  }
  const tmp = tmpdir();
  env.GIT_CEILING_DIRECTORIES = [tmp, realpathSync(tmp)].join(':');
  env.GIT_CONFIG_NOSYSTEM = '1';
  return { ...env, ...extra };
}

/** Runs git in `cwd` with a clean environment and a fixed identity. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Creates a git repository with one empty commit at `dir`. */
export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

// Fixed ticket ids (valid ULIDs).
export const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
export const T2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const T3 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
export const MISSING = '01CAAAAAAAAAAAAAAAAAAAAAAA';

export const TASK: TaskRef = { source: 'openspec', ref: 'add-board-core', item: '2' };

/** Builds a complete event from a proposal, an actor and a timestamp. */
export function ev(proposed: ProposedEvent, actor: string, wall: number, counter = 0): BoardEvent {
  const ts: Hlc = { wall, counter, actor };
  return { v: 1, ...proposed, actor, ts } as BoardEvent;
}

export const P = {
  create(ticket: string, title = 'A ticket', extra: Record<string, unknown> = {}): ProposedEvent {
    return {
      kind: 'ticket.create',
      ticket,
      body: { title, task: TASK, checklist: ['one', 'two'], labels: ['store'], ...extra },
    } as ProposedEvent;
  },
  comment(ticket: string, text: string): ProposedEvent {
    return { kind: 'ticket.comment', ticket, body: { text } };
  },
  move(ticket: string, to: Status): ProposedEvent {
    return { kind: 'ticket.move', ticket, body: { to } };
  },
  claim(ticket: string): ProposedEvent {
    return { kind: 'ticket.claim', ticket, body: {} };
  },
  handoff(ticket: string, to: string, status: Status, note: string): ProposedEvent {
    return { kind: 'ticket.handoff', ticket, body: { to, status, note } };
  },
  pr(ticket: string, pr: string | number): ProposedEvent {
    return { kind: 'ticket.link', ticket, body: { pr } };
  },
  decision(ticket: string, decision: string): ProposedEvent {
    return { kind: 'ticket.link', ticket, body: { decision } };
  },
  tick(ticket: string, index: number, done = true): ProposedEvent {
    return { kind: 'ticket.checklist', ticket, body: { index, done } };
  },
  close(ticket: string, decision?: string): ProposedEvent {
    return {
      kind: 'ticket.close',
      ticket,
      body: decision === undefined ? { noDecision: true } : { decision },
    };
  },
  meta(key: string, value: unknown): ProposedEvent {
    return { kind: 'board.meta', body: { key, value } } as ProposedEvent;
  },
};

/** An operation that always proposes `event`, without looking at state. */
export function propose(event: ProposedEvent): Operation {
  return (): Decision => ({ ok: true, event });
}

/** A fixed clock starting at `start` and advancing 1000 ms per call. */
export function clock(start = 1_700_000_000_000): () => number {
  let t = start - 1000;
  return () => {
    t += 1000;
    return t;
  };
}

/** Names of the event files (not temporaries) in an events directory. */
export function eventNames(eventsDir: string): string[] {
  return readdirSync(eventsDir)
    .filter((name) => !name.startsWith('.tmp-'))
    .sort();
}

/** Every entry of an events directory, temporaries included. */
export function allNames(eventsDir: string): string[] {
  return readdirSync(eventsDir).sort();
}

/**
 * Independent fold of an events directory: every correctly named,
 * well-formed file, folded with the group 1 `fold`.
 */
export function foldDir(eventsDir: string): FoldResult {
  const inputs: FoldInput[] = [];
  for (const name of eventNames(eventsDir)) {
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    const bytes = readFileSync(join(eventsDir, name));
    if (match?.[1] === undefined || sha256Hex(bytes) !== match[1]) {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = canonicalDecode(bytes);
    } catch {
      continue;
    }
    const result = validateEvent(decoded);
    if (result.ok) {
      inputs.push({ hash: match[1], event: result.event });
    }
  }
  return fold(inputs);
}

/** Canonical text of any JSON-compatible value. */
export function canon(value: unknown): string {
  return new TextDecoder().decode(canonicalEncode(value));
}

/**
 * Writes `event` directly as an event file (canonical bytes under their
 * hash), bypassing the store: how a crashed command, another process or a
 * sync leaves a file behind. Returns the hash.
 */
export function putEvent(eventsDir: string, event: unknown): string {
  const bytes = canonicalEncode(event);
  const hash = sha256Hex(bytes);
  writeFileSync(join(eventsDir, `${hash}.json`), bytes);
  return hash;
}

/** A second board holding a copy of `eventsDir`'s files. Returns its dir. */
export function copyBoard(eventsDir: string): string {
  const dir = tempBoard();
  cpSync(eventsDir, join(dir, 'events'), { recursive: true });
  return dir;
}

/**
 * A rich, fixed event set exercising every column of the cache: two tickets
 * with task and ad hoc references, labels, description, checklist ticks,
 * comments, a handoff, pr links (number and string), a decision link, a
 * blocked origin, closes with and without a decision, a task link replacing
 * ad hoc, board meta, one rejected event, one unknown-kind event and two
 * events sharing a wall. Returns the hashes in write order.
 */
export function seedRich(eventsDir: string): string[] {
  const events: unknown[] = [
    ev(P.create(T1, 'First', { description: 'desc' }), 'orch', 1000),
    ev(
      { kind: 'ticket.create', ticket: T2, body: { title: 'Adhoc', adhoc: 'hotfix' } },
      'orch',
      1100,
    ),
    ev(P.claim(T1), 'impl', 1200),
    ev(P.move(T1, 'tests'), 'impl', 1300),
    ev(P.comment(T1, 'first comment'), 'impl', 1400),
    ev(P.handoff(T1, 'rev', 'implementing', 'over to you'), 'impl', 1500),
    ev(P.pr(T1, 42), 'rev', 1600),
    ev(P.pr(T1, 'https://example.invalid/pr/1'), 'rev', 1700),
    ev(P.decision(T1, 'docs/adr/0002-x.md'), 'rev', 1800),
    ev(P.tick(T1, 1), 'rev', 1900),
    ev(P.move(T1, 'blocked'), 'rev', 2000),
    ev(P.meta('columns', ['todo', 'doing']), 'orch', 2100),
    ev(P.move(T2, 'blocked'), 'orch', 2200),
    ev(P.close(T2), 'orch', 2300),
    ev(P.claim(T1), 'intruder', 2400),
    {
      v: 1,
      kind: 'ticket.estimate',
      ticket: T1,
      actor: 'orch',
      ts: { wall: 2500, counter: 0, actor: 'orch' },
      body: { points: 3 },
    },
    ev(P.comment(T1, 'same wall'), 'zed', 2500, 1),
    ev(P.comment(T1, 'same wall, other actor'), 'amy', 2500, 1),
    ev(P.close(T1, 'docs/adr/0002-x.md'), 'rev', 2600),
    ev({ kind: 'ticket.link', ticket: T2, body: { task: TASK } }, 'orch', 2700),
    ev(P.create(T3, 'Third'), 'orch', 2800),
  ];
  return events.map((e) => putEvent(eventsDir, e));
}
