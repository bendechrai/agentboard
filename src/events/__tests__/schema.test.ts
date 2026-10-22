import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canonicalDecode, canonicalEncode, sha256Hex } from '../canonical.js';
import {
  EVENT_HASH_PATTERN,
  GRACE_DEFAULT_MS,
  KNOWN_KINDS,
  LEASE_GRACE_KEY,
  LEASE_SKEW_MS,
  QUEUE_WINDOW_KEY,
  SCHEMA_VERSION,
  SETTING_MAX_MS,
  SETTING_MIN_MS,
  SYSTEM_ACTOR,
  TTL_MAX_MS,
  TTL_MIN_MS,
  WINDOW_DEFAULT_MS,
  STATUSES,
  TASK_SOURCE_PATTERN,
  formatTaskRef,
  isKnownEvent,
  isKnownKind,
  parseTaskRef,
  validateEvent,
  type TaskRef,
  type ValidationResult,
} from '../schema.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const TASK: TaskRef = { source: 'openspec', ref: 'add-board-core', item: '1' };

type Obj = Record<string, unknown>;

/** A well-formed envelope for `kind` with `body`, as a plain decoded object. */
function ev(kind: string, body: unknown): Obj {
  const base: Obj = {
    v: 1,
    kind,
    actor: 'impl',
    ts: { wall: 1000, counter: 0, actor: 'impl' },
    body,
  };
  if (kind !== 'board.meta') {
    base.ticket = T1;
  }
  return base;
}

/** The same event written by `actor` (envelope and timestamp). */
function asActor(value: Obj, actor: string): Obj {
  const ts = value.ts as Obj;
  return { ...value, actor, ts: { ...ts, actor } };
}

/** The actor that may write `kind`: the reserved actor for grants, else `impl`. */
function actorFor(kind: string): string {
  return kind === 'ticket.grant' ? 'agentboard' : 'impl';
}

const HASH_A = 'a'.repeat(64);
const HASH_B = '0123456789abcdef'.repeat(4);

const GRANT_BODY: Obj = { to: 'a', ttl: 1_800_000, window: 120_000, after: { released: HASH_A } };

function without(obj: Obj, key: string): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

function withBody(kind: string, body: Obj, patch: Obj, remove: string[] = []): Obj {
  const merged: Obj = { ...body, ...patch };
  return ev(kind, Object.fromEntries(Object.entries(merged).filter(([k]) => !remove.includes(k))));
}

function fields(result: ValidationResult): string[] {
  if (result.ok) {
    throw new Error(`expected malformed, got well-formed ${JSON.stringify(result.event)}`);
  }
  return result.reasons.map((r) => r.field).sort();
}

function expectOnlyField(value: unknown, field: string): void {
  const result = validateEvent(value);
  expect(fields(result)).toEqual([field]);
  if (!result.ok) {
    for (const reason of result.reasons) {
      expect(typeof reason.message).toBe('string');
      expect(reason.message.length).toBeGreaterThan(0);
    }
  }
}

describe('constants', () => {
  it('schema version is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('lists the six statuses', () => {
    expect([...STATUSES]).toEqual(['todo', 'tests', 'implementing', 'review', 'merged', 'blocked']);
  });

  it('lists the eighteen known kinds', () => {
    expect([...KNOWN_KINDS].sort()).toEqual(
      [
        'board.meta',
        'ticket.assign',
        'ticket.checklist',
        'ticket.checklist.add',
        'ticket.claim',
        'ticket.close',
        'ticket.comment',
        'ticket.create',
        'ticket.grant',
        'ticket.handoff',
        'ticket.link',
        'ticket.move',
        'ticket.queue.join',
        'ticket.queue.leave',
        'ticket.release',
        'ticket.release.force',
        'ticket.renew',
        'ticket.unplanned',
      ].sort(),
    );
  });

  it('isKnownKind separates known from unknown kinds', () => {
    for (const kind of KNOWN_KINDS) {
      expect(isKnownKind(kind)).toBe(true);
    }
    expect(isKnownKind('ticket.estimate')).toBe(false);
    expect(isKnownKind('')).toBe(false);
    expect(isKnownKind('TICKET.CREATE')).toBe(false);
  });

  it('source pattern matches the spec', () => {
    expect(TASK_SOURCE_PATTERN.test('openspec')).toBe(true);
    expect(TASK_SOURCE_PATTERN.test('spec-kit2')).toBe(true);
    expect(TASK_SOURCE_PATTERN.test('Open Spec')).toBe(false);
  });
});

describe('parseTaskRef and formatTaskRef', () => {
  it.each([
    ['openspec:add-board-core#3', { source: 'openspec', ref: 'add-board-core', item: '3' }],
    [
      'speckit:001-photo-albums#phase-2',
      { source: 'speckit', ref: '001-photo-albums', item: 'phase-2' },
    ],
    ['openspec:a:b#1', { source: 'openspec', ref: 'a:b', item: '1' }],
    ['openspec:a#b#c', { source: 'openspec', ref: 'a#b', item: 'c' }],
    ['x-1:r#i', { source: 'x-1', ref: 'r', item: 'i' }],
  ])('parses %s', (input, expected) => {
    expect(parseTaskRef(input)).toEqual(expected);
  });

  it.each([
    ['no colon or hash', 'add-board-core-3'],
    ['no hash', 'openspec:add-board-core'],
    ['hash only before the colon', 'open#spec:add'],
    ['an uppercase source', 'OpenSpec:add-board-core#3'],
    ['a source with a space', 'Open Spec:add-board-core#3'],
    ['a source starting with a digit', '1spec:add#3'],
    ['an empty source', ':add-board-core#3'],
    ['an empty ref', 'openspec:#3'],
    ['an empty item', 'openspec:add-board-core#'],
    ['empty input', ''],
  ])('returns null for %s', (_name, input) => {
    expect(parseTaskRef(input)).toBeNull();
  });

  it('formats as <source>:<ref>#<item>', () => {
    expect(formatTaskRef({ source: 'openspec', ref: 'add-board-core', item: '3' })).toBe(
      'openspec:add-board-core#3',
    );
    expect(formatTaskRef({ source: 'speckit', ref: '001-photo-albums', item: 'phase-2' })).toBe(
      'speckit:001-photo-albums#phase-2',
    );
  });

  it('round-trips', () => {
    for (const ref of [
      TASK,
      { source: 'speckit', ref: '001-photo-albums', item: 'phase-2' },
      { source: 'openspec', ref: 'a:b#c', item: '12' },
    ]) {
      expect(parseTaskRef(formatTaskRef(ref))).toEqual(ref);
    }
  });
});

describe('validateEvent: well-formed events of every kind', () => {
  const cases: [string, Obj][] = [
    ['ticket.create minimal', ev('ticket.create', { title: 'x' })],
    [
      'ticket.create full with task',
      ev('ticket.create', {
        title: 'Canonical fold',
        description: '',
        labels: ['change:add-board-core', 'group:1'],
        task: TASK,
        checklist: ['1.1 canonical', '1.2 ulid'],
      }),
    ],
    ['ticket.create ad hoc', ev('ticket.create', { title: 'x', adhoc: 'hotfix for broken build' })],
    [
      'ticket.create with empty arrays',
      ev('ticket.create', { title: 'x', labels: [], checklist: [] }),
    ],
    ['ticket.comment', ev('ticket.comment', { text: 'hi' })],
    ...STATUSES.map((s): [string, Obj] => [`ticket.move to ${s}`, ev('ticket.move', { to: s })]),
    ['ticket.assign', ev('ticket.assign', { to: 'reviewer' })],
    ['ticket.claim', ev('ticket.claim', {})],
    ['ticket.release', ev('ticket.release', {})],
    [
      'ticket.handoff',
      ev('ticket.handoff', { to: 'reviewer', status: 'review', note: 'green, 96%' }),
    ],
    ['ticket.link task', ev('ticket.link', { task: TASK })],
    ['ticket.link pr url', ev('ticket.link', { pr: 'https://github.com/o/r/pull/7' })],
    ['ticket.link pr number', ev('ticket.link', { pr: 7 })],
    ['ticket.link decision', ev('ticket.link', { decision: 'docs/adr/0002-x.md' })],
    ['ticket.close decision', ev('ticket.close', { decision: 'docs/adr/0002-x.md' })],
    ['ticket.close noDecision', ev('ticket.close', { noDecision: true })],
    ['ticket.unplanned', ev('ticket.unplanned', { reason: 'production hotfix, no plan' })],
    ['ticket.checklist', ev('ticket.checklist', { index: 0, done: true })],
    ['ticket.checklist negative index', ev('ticket.checklist', { index: -1, done: false })],
    [
      'ticket.checklist.add one item',
      ev('ticket.checklist.add', { items: [{ text: '7.4 A new task', done: false }] }),
    ],
    [
      'ticket.checklist.add several items',
      ev('ticket.checklist.add', {
        items: [
          { text: 'a', done: true },
          { text: 'b', done: false },
          { text: 'a', done: true },
        ],
      }),
    ],
    ['board.meta', ev('board.meta', { key: 'columns', value: ['todo', 'doing'] })],
    ['board.meta null value', ev('board.meta', { key: 'x', value: null })],
  ];

  it.each(cases)('accepts %s as a known event, unchanged', (_name, value) => {
    const result = validateEvent(value);
    expect(result).toEqual({ ok: true, known: true, event: value });
  });

  it('isKnownEvent is true for a validated known event', () => {
    const result = validateEvent(ev('ticket.comment', { text: 'hi' }));
    if (!result.ok) throw new Error('expected ok');
    expect(isKnownEvent(result.event)).toBe(true);
  });

  it('accepts a task reference from a source other than openspec (spec scenario)', () => {
    const task = { source: 'speckit', ref: '001-photo-albums', item: 'phase-2' };
    const value = ev('ticket.create', { title: 'Albums', task });
    const result = validateEvent(value);
    expect(result.ok).toBe(true);
    if (result.ok && result.known && result.event.kind === 'ticket.create') {
      expect(result.event.body.task).toEqual(task);
    } else {
      throw new Error('expected a known ticket.create');
    }
  });

  it('accepts a create with neither task nor adhoc', () => {
    expect(validateEvent(ev('ticket.create', { title: 'x' })).ok).toBe(true);
  });
});

describe('validateEvent: unknown kinds', () => {
  it('accepts a well-formed event of an unknown kind as unknown (spec scenario)', () => {
    const value = ev('ticket.estimate', { points: 3, anything: { goes: ['here'] } });
    const result = validateEvent(value);
    expect(result).toEqual({ ok: true, known: false, event: value });
    if (result.ok) {
      expect(isKnownEvent(result.event)).toBe(false);
    }
  });

  it('accepts an unknown kind with an empty body', () => {
    expect(validateEvent(ev('ticket.estimate', {}))).toMatchObject({ ok: true, known: false });
  });

  it('accepts an unknown kind without a ticket as unknown, not malformed (spec scenario)', () => {
    const value = without(ev('board.archive', { before: 1000 }), 'ticket');
    expect('ticket' in value).toBe(false);
    expect(validateEvent(value)).toEqual({ ok: true, known: false, event: value });
  });

  it('still requires a ULID ticket on an unknown kind when one is present', () => {
    expectOnlyField({ ...ev('board.archive', {}), ticket: 'T1' }, 'ticket');
    expectOnlyField({ ...ev('ticket.estimate', {}), ticket: T1.toLowerCase() }, 'ticket');
    expectOnlyField({ ...ev('ticket.estimate', {}), ticket: 5 }, 'ticket');
  });

  it('still requires a ticket on every known kind except board.meta', () => {
    const validBodies: [string, Obj][] = [
      ['ticket.create', { title: 'x' }],
      ['ticket.comment', { text: 'x' }],
      ['ticket.move', { to: 'tests' }],
      ['ticket.assign', { to: 'a' }],
      ['ticket.claim', {}],
      ['ticket.release', {}],
      ['ticket.handoff', { to: 'a', status: 'tests', note: 'n' }],
      ['ticket.link', { pr: 1 }],
      ['ticket.close', { noDecision: true }],
      ['ticket.unplanned', { reason: 'hotfix' }],
      ['ticket.checklist', { index: 0, done: true }],
      ['ticket.checklist.add', { items: [{ text: 'a', done: false }] }],
      ['ticket.renew', { ttl: 60_000, expiresAt: 61_000 }],
      ['ticket.release.force', { holder: 'h', reason: 'gone' }],
      ['ticket.queue.join', { ttl: 60_000 }],
      ['ticket.queue.leave', {}],
      ['ticket.grant', GRANT_BODY],
    ];
    expect(validBodies.map(([k]) => k).sort()).toEqual(
      KNOWN_KINDS.filter((k) => k !== 'board.meta').sort(),
    );
    for (const [kind, body] of validBodies) {
      const value = asActor(ev(kind, body), actorFor(kind));
      expect(validateEvent(value).ok).toBe(true);
      expectOnlyField(without(value, 'ticket'), 'ticket');
    }
  });

  it('still checks the envelope of an unknown kind', () => {
    expectOnlyField(without(ev('ticket.estimate', {}), 'actor'), 'actor');
    expectOnlyField({ ...ev('ticket.estimate', {}), extra: 1 }, 'extra');
  });

  it('requires an object body for an unknown kind', () => {
    expectOnlyField(ev('ticket.estimate', 'x'), 'body');
    expectOnlyField(ev('ticket.estimate', [1]), 'body');
  });
});

describe('validateEvent: malformed envelopes', () => {
  const comment = ev('ticket.comment', { text: 'hi' });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 42],
    ['an array', [comment]],
  ])('rejects %s as a whole with field ""', (_name, value) => {
    expectOnlyField(value, '');
  });

  it('reports a missing actor (spec scenario) as exactly one reason', () => {
    expectOnlyField(without(comment, 'actor'), 'actor');
  });

  const envelopeCases: [string, Obj, string][] = [
    ['missing v', without(comment, 'v'), 'v'],
    ['v = 2', { ...comment, v: 2 }, 'v'],
    ['v as a string', { ...comment, v: '1' }, 'v'],
    ['missing kind', without(comment, 'kind'), 'kind'],
    ['empty kind', { ...comment, kind: '' }, 'kind'],
    ['kind not a string', { ...comment, kind: 5 }, 'kind'],
    ['missing ticket', without(comment, 'ticket'), 'ticket'],
    ['ticket not a ULID', { ...comment, ticket: 'T1' }, 'ticket'],
    ['lowercase ticket', { ...comment, ticket: T1.toLowerCase() }, 'ticket'],
    ['ticket not a string', { ...comment, ticket: 1 }, 'ticket'],
    ['ticket on board.meta', { ...ev('board.meta', { key: 'k', value: 1 }), ticket: T1 }, 'ticket'],
    ['empty actor', { ...comment, actor: '' }, 'actor'],
    ['actor not a string', { ...comment, actor: 7 }, 'actor'],
    ['missing ts', without(comment, 'ts'), 'ts'],
    ['ts not an object', { ...comment, ts: 'x' }, 'ts'],
    ['missing ts.wall', { ...comment, ts: { counter: 0, actor: 'impl' } }, 'ts.wall'],
    ['negative ts.wall', { ...comment, ts: { wall: -1, counter: 0, actor: 'impl' } }, 'ts.wall'],
    ['fractional ts.wall', { ...comment, ts: { wall: 1.5, counter: 0, actor: 'impl' } }, 'ts.wall'],
    ['string ts.wall', { ...comment, ts: { wall: '1000', counter: 0, actor: 'impl' } }, 'ts.wall'],
    ['missing ts.counter', { ...comment, ts: { wall: 1000, actor: 'impl' } }, 'ts.counter'],
    [
      'negative ts.counter',
      { ...comment, ts: { wall: 1000, counter: -1, actor: 'impl' } },
      'ts.counter',
    ],
    ['missing ts.actor', { ...comment, ts: { wall: 1000, counter: 0 } }, 'ts.actor'],
    [
      'ts.actor differs from actor',
      { ...comment, ts: { wall: 1000, counter: 0, actor: 'other' } },
      'ts.actor',
    ],
    [
      'extra field in ts',
      { ...comment, ts: { wall: 1000, counter: 0, actor: 'impl', x: 1 } },
      'ts.x',
    ],
    ['missing body', without(comment, 'body'), 'body'],
    ['body not an object', { ...comment, body: 'hi' }, 'body'],
    ['body an array', { ...comment, body: ['hi'] }, 'body'],
    ['extra top-level field', { ...comment, extra: 1 }, 'extra'],
    ['extra top-level hash field', { ...comment, hash: 'abc' }, 'hash'],
  ];

  it.each(envelopeCases)('rejects %s', (_name, value, field) => {
    expectOnlyField(value, field);
  });

  it('reports every problem, not only the first', () => {
    const value = { ...without(comment, 'actor'), extra: true, v: 3 };
    expect(fields(validateEvent(value))).toEqual(['actor', 'extra', 'v']);
  });
});

describe('validateEvent: malformed bodies, one per required field and rule', () => {
  const create = { title: 'x' };
  const handoff = { to: 'reviewer', status: 'review', note: 'n' };
  const checklist = { index: 0, done: true };
  const meta = { key: 'columns', value: [] };

  const bodyCases: [string, Obj, string][] = [
    // ticket.create
    ['create: missing title', withBody('ticket.create', create, {}, ['title']), 'body.title'],
    ['create: empty title', withBody('ticket.create', create, { title: '' }), 'body.title'],
    ['create: title not a string', withBody('ticket.create', create, { title: 5 }), 'body.title'],
    [
      'create: description not a string',
      withBody('ticket.create', create, { description: 5 }),
      'body.description',
    ],
    [
      'create: labels not an array',
      withBody('ticket.create', create, { labels: 'a' }),
      'body.labels',
    ],
    [
      'create: empty label',
      withBody('ticket.create', create, { labels: ['a', ''] }),
      'body.labels.1',
    ],
    [
      'create: label not a string',
      withBody('ticket.create', create, { labels: [1] }),
      'body.labels.0',
    ],
    [
      'create: checklist not an array',
      withBody('ticket.create', create, { checklist: 'x' }),
      'body.checklist',
    ],
    [
      'create: checklist line not a string',
      withBody('ticket.create', create, { checklist: ['ok', 3] }),
      'body.checklist.1',
    ],
    [
      'create: empty checklist line',
      withBody('ticket.create', create, { checklist: [''] }),
      'body.checklist.0',
    ],
    [
      'create: task as text',
      withBody('ticket.create', create, { task: 'openspec:x#1' }),
      'body.task',
    ],
    [
      'create: task missing source',
      withBody('ticket.create', create, { task: { ref: 'r', item: '1' } }),
      'body.task.source',
    ],
    [
      'create: task missing ref',
      withBody('ticket.create', create, { task: { source: 's', item: '1' } }),
      'body.task.ref',
    ],
    [
      'create: task missing item',
      withBody('ticket.create', create, { task: { source: 's', ref: 'r' } }),
      'body.task.item',
    ],
    [
      'create: malformed source "Open Spec" (spec scenario)',
      withBody('ticket.create', create, { task: { ...TASK, source: 'Open Spec' } }),
      'body.task.source',
    ],
    [
      'create: uppercase source',
      withBody('ticket.create', create, { task: { ...TASK, source: 'OpenSpec' } }),
      'body.task.source',
    ],
    [
      'create: source starting with a digit',
      withBody('ticket.create', create, { task: { ...TASK, source: '1spec' } }),
      'body.task.source',
    ],
    [
      'create: empty source',
      withBody('ticket.create', create, { task: { ...TASK, source: '' } }),
      'body.task.source',
    ],
    [
      'create: empty ref',
      withBody('ticket.create', create, { task: { ...TASK, ref: '' } }),
      'body.task.ref',
    ],
    [
      'create: empty item',
      withBody('ticket.create', create, { task: { ...TASK, item: '' } }),
      'body.task.item',
    ],
    [
      'create: numeric item',
      withBody('ticket.create', create, { task: { ...TASK, item: 3 } }),
      'body.task.item',
    ],
    [
      'create: extra field in task',
      withBody('ticket.create', create, { task: { ...TASK, line: 4 } }),
      'body.task.line',
    ],
    ['create: empty adhoc', withBody('ticket.create', create, { adhoc: '' }), 'body.adhoc'],
    [
      'create: task and adhoc both present',
      withBody('ticket.create', create, { task: TASK, adhoc: 'why' }),
      'body.adhoc',
    ],
    [
      'create: extra body field',
      withBody('ticket.create', create, { status: 'todo' }),
      'body.status',
    ],
    // ticket.comment
    ['comment: missing text', ev('ticket.comment', {}), 'body.text'],
    ['comment: empty text', ev('ticket.comment', { text: '' }), 'body.text'],
    ['comment: extra body field', ev('ticket.comment', { text: 'hi', mood: 'ok' }), 'body.mood'],
    // ticket.move
    ['move: missing to', ev('ticket.move', {}), 'body.to'],
    ['move: unknown status', ev('ticket.move', { to: 'done' }), 'body.to'],
    ['move: wrong-case status', ev('ticket.move', { to: 'Todo' }), 'body.to'],
    ['move: extra body field', ev('ticket.move', { to: 'tests', from: 'todo' }), 'body.from'],
    // ticket.assign
    ['assign: missing to', ev('ticket.assign', {}), 'body.to'],
    ['assign: empty to', ev('ticket.assign', { to: '' }), 'body.to'],
    ['assign: extra body field', ev('ticket.assign', { to: 'a', by: 'b' }), 'body.by'],
    // ticket.claim / ticket.release
    ['claim: extra body field', ev('ticket.claim', { as: 'impl' }), 'body.as'],
    ['release: extra body field', ev('ticket.release', { as: 'impl' }), 'body.as'],
    // ticket.handoff
    ['handoff: missing to', withBody('ticket.handoff', handoff, {}, ['to']), 'body.to'],
    ['handoff: missing status', withBody('ticket.handoff', handoff, {}, ['status']), 'body.status'],
    ['handoff: missing note', withBody('ticket.handoff', handoff, {}, ['note']), 'body.note'],
    ['handoff: empty to', withBody('ticket.handoff', handoff, { to: '' }), 'body.to'],
    [
      'handoff: unknown status',
      withBody('ticket.handoff', handoff, { status: 'done' }),
      'body.status',
    ],
    ['handoff: empty note', withBody('ticket.handoff', handoff, { note: '' }), 'body.note'],
    ['handoff: extra body field', withBody('ticket.handoff', handoff, { cc: 'x' }), 'body.cc'],
    // ticket.link
    ['link: no target', ev('ticket.link', {}), 'body'],
    ['link: two targets', ev('ticket.link', { pr: 1, decision: 'docs/adr/1.md' }), 'body'],
    ['link: three targets', ev('ticket.link', { task: TASK, pr: 1, decision: 'd' }), 'body'],
    ['link: pr zero', ev('ticket.link', { pr: 0 }), 'body.pr'],
    ['link: negative pr', ev('ticket.link', { pr: -1 }), 'body.pr'],
    ['link: empty pr string', ev('ticket.link', { pr: '' }), 'body.pr'],
    ['link: pr as boolean', ev('ticket.link', { pr: true }), 'body.pr'],
    ['link: empty decision', ev('ticket.link', { decision: '' }), 'body.decision'],
    [
      'link: malformed task source',
      ev('ticket.link', { task: { ...TASK, source: 'Open Spec' } }),
      'body.task.source',
    ],
    ['link: extra body field', ev('ticket.link', { pr: 1, note: 'x' }), 'body.note'],
    // ticket.close
    ['close: no disposition', ev('ticket.close', {}), 'body'],
    ['close: both dispositions', ev('ticket.close', { decision: 'd', noDecision: true }), 'body'],
    ['close: noDecision false', ev('ticket.close', { noDecision: false }), 'body.noDecision'],
    ['close: empty decision', ev('ticket.close', { decision: '' }), 'body.decision'],
    ['close: extra body field', ev('ticket.close', { noDecision: true, why: 'x' }), 'body.why'],
    // ticket.checklist
    [
      'checklist: missing index',
      withBody('ticket.checklist', checklist, {}, ['index']),
      'body.index',
    ],
    [
      'checklist: fractional index',
      withBody('ticket.checklist', checklist, { index: 1.5 }),
      'body.index',
    ],
    [
      'checklist: string index',
      withBody('ticket.checklist', checklist, { index: '1' }),
      'body.index',
    ],
    ['checklist: missing done', withBody('ticket.checklist', checklist, {}, ['done']), 'body.done'],
    [
      'checklist: done not boolean',
      withBody('ticket.checklist', checklist, { done: 'yes' }),
      'body.done',
    ],
    [
      'checklist: extra body field',
      withBody('ticket.checklist', checklist, { text: 'x' }),
      'body.text',
    ],
    // ticket.checklist.add
    ['checklist.add: missing items', ev('ticket.checklist.add', {}), 'body.items'],
    ['checklist.add: items not an array', ev('ticket.checklist.add', { items: 'a' }), 'body.items'],
    ['checklist.add: items an object', ev('ticket.checklist.add', { items: {} }), 'body.items'],
    ['checklist.add: empty items', ev('ticket.checklist.add', { items: [] }), 'body.items'],
    ['checklist.add: item a string', ev('ticket.checklist.add', { items: ['a'] }), 'body.items.0'],
    ['checklist.add: item null', ev('ticket.checklist.add', { items: [null] }), 'body.items.0'],
    [
      'checklist.add: item missing text',
      ev('ticket.checklist.add', { items: [{ done: false }] }),
      'body.items.0.text',
    ],
    [
      'checklist.add: item empty text',
      ev('ticket.checklist.add', { items: [{ text: '', done: false }] }),
      'body.items.0.text',
    ],
    [
      'checklist.add: item text not a string',
      ev('ticket.checklist.add', { items: [{ text: 1, done: false }] }),
      'body.items.0.text',
    ],
    [
      'checklist.add: item missing done',
      ev('ticket.checklist.add', { items: [{ text: 'a', done: true }, { text: 'b' }] }),
      'body.items.1.done',
    ],
    [
      'checklist.add: item done not boolean',
      ev('ticket.checklist.add', { items: [{ text: 'a', done: 'yes' }] }),
      'body.items.0.done',
    ],
    [
      'checklist.add: extra item field',
      ev('ticket.checklist.add', { items: [{ text: 'a', done: false, index: 3 }] }),
      'body.items.0.index',
    ],
    [
      'checklist.add: extra body field',
      ev('ticket.checklist.add', { items: [{ text: 'a', done: false }], at: 0 }),
      'body.at',
    ],
    // ticket.unplanned (board-events: "Unplanned body is checked")
    ['unplanned: missing reason', ev('ticket.unplanned', {}), 'body.reason'],
    ['unplanned: empty reason', ev('ticket.unplanned', { reason: '' }), 'body.reason'],
    ['unplanned: reason not a string', ev('ticket.unplanned', { reason: 7 }), 'body.reason'],
    ['unplanned: reason null', ev('ticket.unplanned', { reason: null }), 'body.reason'],
    [
      'unplanned: extra body field',
      ev('ticket.unplanned', { reason: 'hotfix', task: TASK }),
      'body.task',
    ],
    [
      'unplanned: a second unknown field',
      ev('ticket.unplanned', { reason: 'hotfix', actor: 'orch' }),
      'body.actor',
    ],
    // board.meta
    ['meta: missing key', withBody('board.meta', meta, {}, ['key']), 'body.key'],
    ['meta: empty key', withBody('board.meta', meta, { key: '' }), 'body.key'],
    ['meta: missing value', withBody('board.meta', meta, {}, ['value']), 'body.value'],
    ['meta: extra body field', withBody('board.meta', meta, { scope: 'x' }), 'body.scope'],
  ];

  it.each(bodyCases)('rejects %s', (_name, value, field) => {
    expectOnlyField(value, field);
  });

  it('rejects a non-object body for every known kind', () => {
    for (const kind of KNOWN_KINDS) {
      expectOnlyField(asActor(ev(kind, null), actorFor(kind)), 'body');
    }
  });

  it('reports several body problems together', () => {
    const value = ev('ticket.handoff', { status: 'done', note: '', extra: 1 });
    expect(fields(validateEvent(value))).toEqual([
      'body.extra',
      'body.note',
      'body.status',
      'body.to',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Leases, the queue, grants and the reserved actor (add-claim-leases,
// board-events: "Event kinds", "Reserved system actor").

const WALL = 1_000_000;

/** A ticket event of `kind` written by `actor` at `wall`. */
function at(kind: string, body: unknown, actor = 'impl', wall = WALL): Obj {
  return { v: 1, kind, ticket: T1, actor, ts: { wall, counter: 0, actor }, body };
}

/** A well-formed claim lease at `WALL`: ttl 30m, grace 2m. */
const LEASE: Obj = { ttl: 1_800_000, grace: 120_000, expiresAt: WALL + 120_000 };
const SUPERSEDES: Obj = { holder: 'h', expiresAt: 900_000, event: HASH_A };

const claimWith = (body: Obj): Obj => at('ticket.claim', body);
const leaseWith = (patch: Obj, remove: string[] = []): Obj =>
  claimWith({
    lease: Object.fromEntries(
      Object.entries({ ...LEASE, ...patch }).filter(([k]) => !remove.includes(k)),
    ),
  });
const supersedesWith = (patch: Obj, remove: string[] = []): Obj =>
  claimWith({
    supersedes: Object.fromEntries(
      Object.entries({ ...SUPERSEDES, ...patch }).filter(([k]) => !remove.includes(k)),
    ),
  });
const renew = (body: Obj): Obj => at('ticket.renew', body);
const grant = (body: Obj, actor = 'agentboard'): Obj => at('ticket.grant', body, actor);
const grantWith = (patch: Obj, remove: string[] = []): Obj =>
  grant(
    Object.fromEntries(
      Object.entries({ ...GRANT_BODY, ...patch }).filter(([k]) => !remove.includes(k)),
    ),
  );
const afterLease = (patch: Obj, remove: string[] = []): Obj =>
  grantWith({
    after: {
      lease: Object.fromEntries(
        Object.entries({ ...SUPERSEDES, ...patch }).filter(([k]) => !remove.includes(k)),
      ),
    },
  });

describe('lease constants', () => {
  it('match board-events and design.md', () => {
    expect({
      LEASE_SKEW_MS,
      TTL_MIN_MS,
      TTL_MAX_MS,
      SETTING_MIN_MS,
      SETTING_MAX_MS,
      GRACE_DEFAULT_MS,
      WINDOW_DEFAULT_MS,
      LEASE_GRACE_KEY,
      QUEUE_WINDOW_KEY,
      SYSTEM_ACTOR,
    }).toEqual({
      LEASE_SKEW_MS: 60_000,
      TTL_MIN_MS: 30_000,
      TTL_MAX_MS: 604_800_000,
      SETTING_MIN_MS: 30_000,
      SETTING_MAX_MS: 600_000,
      GRACE_DEFAULT_MS: 120_000,
      WINDOW_DEFAULT_MS: 120_000,
      LEASE_GRACE_KEY: 'lease.grace',
      QUEUE_WINDOW_KEY: 'queue.window',
      SYSTEM_ACTOR: 'agentboard',
    });
  });

  it('EVENT_HASH_PATTERN accepts exactly 64 lowercase hex characters', () => {
    expect(EVENT_HASH_PATTERN.test(HASH_A)).toBe(true);
    expect(EVENT_HASH_PATTERN.test(HASH_B)).toBe(true);
    expect(EVENT_HASH_PATTERN.test(HASH_A.toUpperCase())).toBe(false);
    expect(EVENT_HASH_PATTERN.test('a'.repeat(63))).toBe(false);
    expect(EVENT_HASH_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(EVENT_HASH_PATTERN.test(`${'a'.repeat(63)}g`)).toBe(false);
  });
});

describe('validateEvent: well-formed lease, queue and grant events', () => {
  const cases: [string, Obj][] = [
    ['a leased claim, ttl above grace (expiresAt = wall + grace)', claimWith({ lease: LEASE })],
    [
      'a leased claim, ttl below grace (expiresAt = wall + ttl)',
      claimWith({ lease: { ttl: 60_000, grace: 120_000, expiresAt: WALL + 60_000 } }),
    ],
    [
      'a leased claim at the lower bounds',
      claimWith({ lease: { ttl: 30_000, grace: 30_000, expiresAt: WALL + 30_000 } }),
    ],
    [
      'a leased claim at the upper bounds',
      claimWith({ lease: { ttl: 604_800_000, grace: 600_000, expiresAt: WALL + 600_000 } }),
    ],
    ['a claim with supersedes only', claimWith({ supersedes: SUPERSEDES })],
    ['a takeover with its own lease', claimWith({ lease: LEASE, supersedes: SUPERSEDES })],
    ['a renew', renew({ ttl: 1_800_000, expiresAt: WALL + 1_800_000 })],
    ['a renew at the lowest ttl', renew({ ttl: 30_000, expiresAt: WALL + 30_000 })],
    ['a renew at the highest ttl', renew({ ttl: 604_800_000, expiresAt: WALL + 604_800_000 })],
    ['a forced release', at('ticket.release.force', { holder: 'h', reason: 'h crashed' })],
    ['a queue join', at('ticket.queue.join', { ttl: 1_800_000 })],
    ['a queue join at the lowest ttl', at('ticket.queue.join', { ttl: 30_000 })],
    ['a queue join at the highest ttl', at('ticket.queue.join', { ttl: 604_800_000 })],
    ['a queue leave', at('ticket.queue.leave', {})],
    ['a grant after a release', grant(GRANT_BODY)],
    ['a grant after a lapse', grantWith({ after: { lease: SUPERSEDES } })],
    ['a grant at the lowest window', grantWith({ window: 30_000 })],
    ['a grant at the highest window', grantWith({ window: 600_000 })],
  ];

  it.each(cases)('accepts %s as a known event, unchanged', (_name, value) => {
    expect(validateEvent(value)).toEqual({ ok: true, known: true, event: value });
  });

  it('accepts a renew and a join whatever the ticket state (state is the fold job)', () => {
    expect(validateEvent(at('ticket.renew', { ttl: 60_000, expiresAt: 60_000 }, 'x', 0)).ok).toBe(
      true,
    );
  });
});

describe('validateEvent: malformed lease, queue and grant events', () => {
  it('reports an inconsistent lease expiry naming lease.expiresAt (spec scenario)', () => {
    // ts.wall 1000000, lease {ttl: 600000, grace: 120000, expiresAt: 1600000}.
    expectOnlyField(
      claimWith({ lease: { ttl: 600_000, grace: 120_000, expiresAt: 1_600_000 } }),
      'body.lease.expiresAt',
    );
  });

  it('reports a renew with ttl 1000 naming ttl (spec scenario)', () => {
    expectOnlyField(renew({ ttl: 1000, expiresAt: WALL + 1000 }), 'body.ttl');
  });

  const cases: [string, Obj, string][] = [
    // ticket.claim lease
    ['claim: lease a string', claimWith({ lease: 'x' }), 'body.lease'],
    ['claim: lease null', claimWith({ lease: null }), 'body.lease'],
    ['claim: lease an array', claimWith({ lease: [LEASE] }), 'body.lease'],
    ['claim: lease ttl missing (no cascade)', leaseWith({}, ['ttl']), 'body.lease.ttl'],
    [
      'claim: lease ttl 29999',
      leaseWith({ ttl: 29_999, expiresAt: WALL + 29_999 }),
      'body.lease.ttl',
    ],
    ['claim: lease ttl 604800001', leaseWith({ ttl: 604_800_001 }), 'body.lease.ttl'],
    ['claim: lease ttl a string', leaseWith({ ttl: '1800000' }), 'body.lease.ttl'],
    ['claim: lease ttl fractional', leaseWith({ ttl: 1_800_000.5 }), 'body.lease.ttl'],
    ['claim: lease grace missing (no cascade)', leaseWith({}, ['grace']), 'body.lease.grace'],
    [
      'claim: lease grace 29999',
      leaseWith({ grace: 29_999, expiresAt: WALL + 29_999 }),
      'body.lease.grace',
    ],
    ['claim: lease grace 600001', leaseWith({ grace: 600_001 }), 'body.lease.grace'],
    ['claim: lease expiresAt missing', leaseWith({}, ['expiresAt']), 'body.lease.expiresAt'],
    [
      'claim: lease expiresAt one ms late',
      leaseWith({ expiresAt: WALL + 120_001 }),
      'body.lease.expiresAt',
    ],
    [
      'claim: lease expiresAt one ms early',
      leaseWith({ expiresAt: WALL + 119_999 }),
      'body.lease.expiresAt',
    ],
    [
      'claim: lease expiresAt from ttl when grace is smaller',
      leaseWith({ expiresAt: WALL + 1_800_000 }),
      'body.lease.expiresAt',
    ],
    ['claim: lease expiresAt negative', leaseWith({ expiresAt: -1 }), 'body.lease.expiresAt'],
    ['claim: lease expiresAt a string', leaseWith({ expiresAt: 'soon' }), 'body.lease.expiresAt'],
    ['claim: extra field in lease', leaseWith({ confirmed: true }), 'body.lease.confirmed'],
    // ticket.claim supersedes
    ['claim: supersedes a string', claimWith({ supersedes: 'h' }), 'body.supersedes'],
    ['claim: supersedes null', claimWith({ supersedes: null }), 'body.supersedes'],
    ['claim: supersedes.holder missing', supersedesWith({}, ['holder']), 'body.supersedes.holder'],
    ['claim: supersedes.holder empty', supersedesWith({ holder: '' }), 'body.supersedes.holder'],
    [
      'claim: supersedes.expiresAt missing',
      supersedesWith({}, ['expiresAt']),
      'body.supersedes.expiresAt',
    ],
    [
      'claim: supersedes.expiresAt negative',
      supersedesWith({ expiresAt: -1 }),
      'body.supersedes.expiresAt',
    ],
    [
      'claim: supersedes.expiresAt a string',
      supersedesWith({ expiresAt: '900000' }),
      'body.supersedes.expiresAt',
    ],
    ['claim: supersedes.event missing', supersedesWith({}, ['event']), 'body.supersedes.event'],
    [
      'claim: supersedes.event uppercase hex',
      supersedesWith({ event: HASH_A.toUpperCase() }),
      'body.supersedes.event',
    ],
    [
      'claim: supersedes.event 63 characters',
      supersedesWith({ event: 'a'.repeat(63) }),
      'body.supersedes.event',
    ],
    [
      'claim: supersedes.event 65 characters',
      supersedesWith({ event: 'a'.repeat(65) }),
      'body.supersedes.event',
    ],
    [
      'claim: supersedes.event not hex',
      supersedesWith({ event: `${'a'.repeat(63)}g` }),
      'body.supersedes.event',
    ],
    [
      'claim: supersedes.event a file name',
      supersedesWith({ event: `${HASH_A}.json` }),
      'body.supersedes.event',
    ],
    ['claim: extra field in supersedes', supersedesWith({ ttl: 1 }), 'body.supersedes.ttl'],
    [
      'claim: extra body field next to a lease',
      claimWith({ lease: LEASE, wait: true }),
      'body.wait',
    ],
    // ticket.renew
    ['renew: ttl missing (no cascade)', renew({ expiresAt: WALL + 60_000 }), 'body.ttl'],
    ['renew: ttl 29999', renew({ ttl: 29_999, expiresAt: WALL + 29_999 }), 'body.ttl'],
    [
      'renew: ttl 604800001',
      renew({ ttl: 604_800_001, expiresAt: WALL + 604_800_001 }),
      'body.ttl',
    ],
    ['renew: ttl a string', renew({ ttl: '60000', expiresAt: WALL + 60_000 }), 'body.ttl'],
    ['renew: expiresAt missing', renew({ ttl: 60_000 }), 'body.expiresAt'],
    [
      'renew: expiresAt one ms late',
      renew({ ttl: 60_000, expiresAt: WALL + 60_001 }),
      'body.expiresAt',
    ],
    [
      'renew: expiresAt one ms early',
      renew({ ttl: 60_000, expiresAt: WALL + 59_999 }),
      'body.expiresAt',
    ],
    [
      'renew: extra body field',
      renew({ ttl: 60_000, expiresAt: WALL + 60_000, grace: 1 }),
      'body.grace',
    ],
    // ticket.release.force
    ['force: holder missing', at('ticket.release.force', { reason: 'r' }), 'body.holder'],
    ['force: holder empty', at('ticket.release.force', { holder: '', reason: 'r' }), 'body.holder'],
    ['force: reason missing', at('ticket.release.force', { holder: 'h' }), 'body.reason'],
    ['force: reason empty', at('ticket.release.force', { holder: 'h', reason: '' }), 'body.reason'],
    [
      'force: reason not a string',
      at('ticket.release.force', { holder: 'h', reason: 5 }),
      'body.reason',
    ],
    [
      'force: extra body field',
      at('ticket.release.force', { holder: 'h', reason: 'r', at: 1 }),
      'body.at',
    ],
    // ticket.queue.join and ticket.queue.leave
    ['join: ttl missing', at('ticket.queue.join', {}), 'body.ttl'],
    ['join: ttl 29999', at('ticket.queue.join', { ttl: 29_999 }), 'body.ttl'],
    ['join: ttl 604800001', at('ticket.queue.join', { ttl: 604_800_001 }), 'body.ttl'],
    ['join: ttl a string', at('ticket.queue.join', { ttl: '30m' }), 'body.ttl'],
    [
      'join: extra body field',
      at('ticket.queue.join', { ttl: 60_000, timeout: 1 }),
      'body.timeout',
    ],
    ['leave: extra body field', at('ticket.queue.leave', { ttl: 60_000 }), 'body.ttl'],
    // ticket.grant
    ['grant: to missing', grantWith({}, ['to']), 'body.to'],
    ['grant: to empty', grantWith({ to: '' }), 'body.to'],
    ['grant: ttl missing', grantWith({}, ['ttl']), 'body.ttl'],
    ['grant: ttl 29999', grantWith({ ttl: 29_999 }), 'body.ttl'],
    ['grant: ttl 604800001', grantWith({ ttl: 604_800_001 }), 'body.ttl'],
    ['grant: window missing', grantWith({}, ['window']), 'body.window'],
    ['grant: window 29999', grantWith({ window: 29_999 }), 'body.window'],
    ['grant: window 600001', grantWith({ window: 600_001 }), 'body.window'],
    ['grant: after missing', grantWith({}, ['after']), 'body.after'],
    ['grant: after a string', grantWith({ after: HASH_A }), 'body.after'],
    ['grant: after empty (neither)', grantWith({ after: {} }), 'body.after'],
    [
      'grant: after with both released and lease',
      grantWith({ after: { released: HASH_A, lease: SUPERSEDES } }),
      'body.after',
    ],
    [
      'grant: after.released uppercase',
      grantWith({ after: { released: HASH_A.toUpperCase() } }),
      'body.after.released',
    ],
    [
      'grant: after.released too short',
      grantWith({ after: { released: 'a'.repeat(63) } }),
      'body.after.released',
    ],
    ['grant: after.lease a string', grantWith({ after: { lease: HASH_A } }), 'body.after.lease'],
    ['grant: after.lease.holder missing', afterLease({}, ['holder']), 'body.after.lease.holder'],
    ['grant: after.lease.holder empty', afterLease({ holder: '' }), 'body.after.lease.holder'],
    [
      'grant: after.lease.expiresAt negative',
      afterLease({ expiresAt: -5 }),
      'body.after.lease.expiresAt',
    ],
    [
      'grant: after.lease.expiresAt missing',
      afterLease({}, ['expiresAt']),
      'body.after.lease.expiresAt',
    ],
    ['grant: after.lease.event bad', afterLease({ event: 'abc' }), 'body.after.lease.event'],
    ['grant: after.lease.event missing', afterLease({}, ['event']), 'body.after.lease.event'],
    ['grant: extra field in after.lease', afterLease({ ttl: 1 }), 'body.after.lease.ttl'],
    [
      'grant: extra field in after',
      grantWith({ after: { released: HASH_A, by: 'h' } }),
      'body.after.by',
    ],
    ['grant: extra body field', grantWith({ confirmed: false }), 'body.confirmed'],
  ];

  it.each(cases)('rejects %s', (_name, value, field) => {
    expectOnlyField(value, field);
  });

  it('reports several lease problems together', () => {
    const value = claimWith({
      lease: { ttl: 1, grace: 1, expiresAt: 'x', extra: 1 },
      supersedes: { holder: '', expiresAt: -1, event: 'x' },
    });
    expect(fields(validateEvent(value))).toEqual([
      'body.lease.expiresAt',
      'body.lease.extra',
      'body.lease.grace',
      'body.lease.ttl',
      'body.supersedes.event',
      'body.supersedes.expiresAt',
      'body.supersedes.holder',
    ]);
  });

  it('checks the lease expiry against the wall of this event, not another', () => {
    const value = leaseWith({});
    expect(validateEvent(value).ok).toBe(true);
    const later = { ...value, ts: { wall: WALL + 1, counter: 0, actor: 'impl' } };
    expectOnlyField(later, 'body.lease.expiresAt');
    const counted = { ...value, ts: { wall: WALL, counter: 7, actor: 'impl' } };
    expect(validateEvent(counted).ok).toBe(true);
  });

  it('does not check the lease expiry when ts.wall is itself invalid (no cascade)', () => {
    const value = { ...leaseWith({}), ts: { wall: -1, counter: 0, actor: 'impl' } };
    expectOnlyField(value, 'ts.wall');
    const renewed = {
      ...renew({ ttl: 60_000, expiresAt: WALL + 60_000 }),
      ts: { counter: 0, actor: 'impl' },
    };
    expectOnlyField(renewed, 'ts.wall');
  });
});

describe('validateEvent: the reserved actor', () => {
  it('reports a grant forged by an agent as malformed naming actor (spec scenario)', () => {
    expectOnlyField(grant(GRANT_BODY, 'impl'), 'actor');
  });

  it('accepts a grant written by agentboard', () => {
    expect(validateEvent(grant(GRANT_BODY)).ok).toBe(true);
  });

  it.each([
    ['ticket.comment', { text: 'hi' }],
    ['ticket.claim', {}],
    ['ticket.release', {}],
    ['ticket.renew', { ttl: 60_000, expiresAt: WALL + 60_000 }],
    ['ticket.release.force', { holder: 'h', reason: 'r' }],
    ['ticket.queue.join', { ttl: 60_000 }],
    ['ticket.queue.leave', {}],
    ['ticket.estimate', { points: 3 }],
  ])('reports %s written by agentboard as malformed naming actor', (kind, body) => {
    expectOnlyField(at(kind, body, 'agentboard'), 'actor');
  });

  it('reports board.meta written by agentboard as malformed naming actor', () => {
    const value = without(
      at('board.meta', { key: 'queue.window', value: 300_000 }, 'agentboard'),
      'ticket',
    );
    expectOnlyField(value, 'actor');
  });

  it('reports an unknown board-level kind written by agentboard as malformed naming actor', () => {
    expectOnlyField(without(at('board.archive', {}, 'agentboard'), 'ticket'), 'actor');
  });

  it('is exact: a similar actor name is an ordinary actor', () => {
    expect(validateEvent(at('ticket.comment', { text: 'hi' }, 'Agentboard')).ok).toBe(true);
    expect(validateEvent(at('ticket.comment', { text: 'hi' }, 'agentboard-1')).ok).toBe(true);
    expectOnlyField(grant(GRANT_BODY, 'agentboard-1'), 'actor');
  });
});

// The golden plain claim (board-events: "Plain claim bytes are unchanged").
// `fixtures/plain-claim.json` was written before leases existed, by the code
// at commit ce7766d: `claimTicket(board, 'merger-1', { id: T1 }, { now: () =>
// 1700000060000 })` on a temporary board whose only event was a
// `ticket.create` of T1 by `orch` at wall 1700000000000; the file is the
// claim's event file, copied byte for byte (no trailing newline).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PLAIN_CLAIM_HASH = 'fcee29059bbe23f90d5b51a2544714af61b8d1b0d985cbb105ab6f50f94aec64';

describe('golden: a plain claim is unchanged by leases', () => {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'plain-claim.json')));

  it('the fixture is the claim file named by its hash', () => {
    expect(sha256Hex(bytes)).toBe(PLAIN_CLAIM_HASH);
  });

  it('decodes to a well-formed known claim with the empty body', () => {
    const result = validateEvent(canonicalDecode(bytes));
    expect(result.ok && result.known).toBe(true);
    if (result.ok) {
      expect(result.event.kind).toBe('ticket.claim');
      expect(result.event.body).toEqual({});
    }
  });

  it('the same envelope built today encodes to the same bytes', () => {
    const event = {
      v: 1,
      kind: 'ticket.claim',
      ticket: T1,
      actor: 'merger-1',
      ts: { wall: 1_700_000_060_000, counter: 0, actor: 'merger-1' },
      body: {},
    };
    expect(validateEvent(event)).toEqual({ ok: true, known: true, event });
    expect(canonicalEncode(event)).toEqual(bytes);
  });
});
