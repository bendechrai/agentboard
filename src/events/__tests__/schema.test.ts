import { describe, expect, it } from 'vitest';

import {
  KNOWN_KINDS,
  SCHEMA_VERSION,
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

  it('lists the eleven known kinds', () => {
    expect([...KNOWN_KINDS].sort()).toEqual(
      [
        'board.meta',
        'ticket.assign',
        'ticket.checklist',
        'ticket.claim',
        'ticket.close',
        'ticket.comment',
        'ticket.create',
        'ticket.handoff',
        'ticket.link',
        'ticket.move',
        'ticket.release',
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
    ['ticket.checklist', ev('ticket.checklist', { index: 0, done: true })],
    ['ticket.checklist negative index', ev('ticket.checklist', { index: -1, done: false })],
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

  it('still checks the envelope of an unknown kind', () => {
    expectOnlyField(without(ev('ticket.estimate', {}), 'ticket'), 'ticket');
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
      expectOnlyField(ev(kind, null), 'body');
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
