import { describe, expect, it } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import { asciiText, renderListLine, renderShow } from '../render.js';

// Non-ASCII characters are built from code points: sources stay plain ASCII.
const E = String.fromCharCode(0xe9);
const ID = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const TS = { wall: 1000, counter: 0, actor: 'orch' };

function ticket(extra: Partial<Ticket> = {}): Ticket {
  return {
    id: ID,
    title: 'Build the CLI',
    description: null,
    status: 'todo',
    blockedFrom: null,
    assignee: null,
    labels: [],
    task: { source: 'openspec', ref: 'add-board-core', item: '3' },
    adhoc: null,
    checklist: [],
    comments: [],
    links: [],
    closed: false,
    disposition: null,
    createdBy: 'orch',
    createdAt: TS,
    version: 1,
    updatedAt: TS,
    ...extra,
  };
}

describe('asciiText', () => {
  it('keeps printable ASCII', () => {
    expect(asciiText('plain text, 96% ~ok')).toBe('plain text, 96% ~ok');
  });

  it('escapes non-ASCII, control characters and backslashes', () => {
    expect(asciiText(`caf${E}`)).toBe('caf\\u00E9');
    expect(asciiText('a\nb\tc')).toBe('a\\u000Ab\\u0009c');
    expect(asciiText('\u{1F600}')).toBe('\\uD83D\\uDE00');
    expect(asciiText('back\\slash')).toBe('back\\\\slash');
    expect(asciiText('\u007f')).toBe('\\u007F');
  });
});

describe('renderListLine', () => {
  it('prints the full id, status, assignee or -, title', () => {
    expect(renderListLine(ticket())).toBe('01ARYZ6S41TSV4RRFFQ69G5FAV  todo  -  Build the CLI');
    expect(renderListLine(ticket({ status: 'review', assignee: 'rev' }))).toBe(
      '01ARYZ6S41TSV4RRFFQ69G5FAV  review  rev  Build the CLI',
    );
  });

  it('marks ad hoc and closed tickets', () => {
    expect(renderListLine(ticket({ task: null, adhoc: 'hotfix', title: 'Fix thing' }))).toBe(
      '01ARYZ6S41TSV4RRFFQ69G5FAV  todo  -  [adhoc] Fix thing',
    );
    expect(
      renderListLine(ticket({ status: 'merged', closed: true, disposition: { noDecision: true } })),
    ).toBe('01ARYZ6S41TSV4RRFFQ69G5FAV  merged  -  [closed] Build the CLI');
    expect(
      renderListLine(ticket({ task: null, adhoc: 'x', closed: true, status: 'blocked' })),
    ).toBe('01ARYZ6S41TSV4RRFFQ69G5FAV  blocked  -  [adhoc] [closed] Build the CLI');
  });

  it('is plain ASCII even for non-ASCII titles', () => {
    expect(renderListLine(ticket({ title: `caf${E}`, assignee: E }))).toBe(
      '01ARYZ6S41TSV4RRFFQ69G5FAV  todo  \\u00E9  caf\\u00E9',
    );
  });
});

describe('renderShow', () => {
  const full = ticket({
    status: 'blocked',
    blockedFrom: 'implementing',
    assignee: 'impl',
    labels: ['cli', 'group:3'],
    description: 'all of it',
    checklist: [
      { text: 'registry', done: true },
      { text: 'parser', done: false },
    ],
    links: [
      { type: 'pr', pr: 12, actor: 'a', ts: TS, hash: 'h1' },
      { type: 'decision', path: 'docs/adr/0002-x.md', actor: 'a', ts: TS, hash: 'h2' },
    ],
    comments: [
      { actor: 'a', ts: TS, text: 'first', hash: 'h3' },
      { actor: 'b', ts: TS, text: 'second', hash: 'h4' },
    ],
    version: 7,
  });

  it('prints the full record, ordered comments and the event count', () => {
    const text = renderShow({ ticket: full, events: 7, unknown: [] });
    const lines = text.split('\n');
    expect(text.endsWith('\n')).toBe(true);
    expect(lines).toContain(`id: ${ID}`);
    expect(lines).toContain('title: Build the CLI');
    expect(lines).toContain('status: blocked (from implementing)');
    expect(lines).toContain('assignee: impl');
    expect(lines).toContain('task: openspec:add-board-core#3');
    expect(lines).toContain('labels: cli, group:3');
    expect(lines).toContain('description: all of it');
    expect(lines).toContain('  [x] 0 registry');
    expect(lines).toContain('  [ ] 1 parser');
    expect(lines).toContain('  pr 12');
    expect(lines).toContain('  decision docs/adr/0002-x.md');
    expect(lines.indexOf('  a: first')).toBeGreaterThan(lines.indexOf('comments:'));
    expect(lines.indexOf('  b: second')).toBeGreaterThan(lines.indexOf('  a: first'));
    expect(lines).toContain('closed: no');
    expect(lines).toContain('events: 7');
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('prints absent values as -, the ad hoc reason, the disposition and unknown events', () => {
    const bare = ticket({
      task: null,
      adhoc: 'hotfix',
      closed: true,
      status: 'merged',
      disposition: { noDecision: true },
    });
    const lines = renderShow({
      ticket: bare,
      events: 1,
      unknown: [{ hash: 'abc', kind: 'ticket.estimate' }],
    }).split('\n');
    expect(lines).toContain('assignee: -');
    expect(lines).toContain('adhoc: hotfix');
    expect(lines).toContain('labels: -');
    expect(lines).toContain('description: -');
    expect(lines).toContain('closed: yes (no decision)');
    expect(lines).toContain('unknown: ticket.estimate abc');
    const decided = ticket({
      closed: true,
      status: 'merged',
      disposition: { decision: 'docs/adr/1.md' },
    });
    expect(renderShow({ ticket: decided, events: 1, unknown: [] }).split('\n')).toContain(
      'closed: yes (decision: docs/adr/1.md)',
    );
  });

  it('escapes user text', () => {
    const text = renderShow({
      ticket: ticket({ comments: [{ actor: 'a', ts: TS, text: `line1\nline2 ${E}`, hash: 'h' }] }),
      events: 2,
      unknown: [],
    });
    expect(text.split('\n')).toContain('  a: line1\\u000Aline2 \\u00E9');
  });
});
