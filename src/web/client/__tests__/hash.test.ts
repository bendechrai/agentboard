/**
 * The URL hash routes of the web client (board-web: "Board views": the view and
 * its filters are kept in the URL hash).
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ROUTE, formatHash, parseHash, type Route } from '../hash.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';

describe('parseHash', () => {
  it.each<[string, Route]>([
    ['', DEFAULT_ROUTE],
    ['#', DEFAULT_ROUTE],
    ['#/', DEFAULT_ROUTE],
    ['#/nope', DEFAULT_ROUTE],
    ['#/ticket/', DEFAULT_ROUTE],
    ['#/board', DEFAULT_ROUTE],
    ['/board', DEFAULT_ROUTE],
    [
      '#/board?change=openspec:add-board-web&assignee=impl-1&closed=1',
      { view: 'board', change: 'openspec:add-board-web', assignee: 'impl-1', closed: true },
    ],
    [
      '#/board?change=openspec%3Aadd-board-web%231&closed=yes',
      { view: 'board', change: 'openspec:add-board-web#1', assignee: null, closed: false },
    ],
    ['#/board?assignee=&x=1', DEFAULT_ROUTE],
    [
      '#/board?assignee=a&assignee=b',
      { view: 'board', change: null, assignee: 'a', closed: false },
    ],
    ['#/feed', { view: 'feed', change: null, actor: null, kinds: null }],
    [
      '#/feed?actor=impl-1&kind=ticket.handoff&kind=ticket.comment',
      { view: 'feed', change: null, actor: 'impl-1', kinds: ['ticket.handoff', 'ticket.comment'] },
    ],
    [
      '#/feed?change=openspec:x&actor=a+b',
      { view: 'feed', change: 'openspec:x', actor: 'a b', kinds: null },
    ],
    [`#/ticket/${T1}`, { view: 'ticket', id: T1 }],
    ['#/ticket/01ARYZ', { view: 'ticket', id: '01ARYZ' }],
    ['#/ticket/a%2Fb', { view: 'ticket', id: 'a/b' }],
    ['#/lanes', { view: 'lanes' }],
    ['#/health', { view: 'health', stale: null, blocked: null }],
    ['#/health?stale=30m&blocked=2d', { view: 'health', stale: '30m', blocked: '2d' }],
    ['#/health?stale=2hours&blocked=0h', { view: 'health', stale: null, blocked: null }],
    ['#/health?stale=&blocked=99999d', { view: 'health', stale: null, blocked: '99999d' }],
    ['#/health?stale=1m&stale=2h', { view: 'health', stale: '1m', blocked: null }],
    ['#/replay', { view: 'replay' }],
    ['#/replay?at=5', { view: 'replay' }],
    ['#/graph', { view: 'graph', change: null, since: null }],
    [
      '#/graph?change=openspec%3Aadd-login&since=7d',
      { view: 'graph', change: 'openspec:add-login', since: '7d' },
    ],
    ['#/graph?since=-1h', { view: 'graph', change: null, since: null }],
    ['#/graph?change=&since=1h', { view: 'graph', change: null, since: '1h' }],
  ])('parses %j', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });

  it('returns a new object for the default route', () => {
    const route = parseHash('');
    expect(route).toEqual(DEFAULT_ROUTE);
    expect(route).not.toBe(DEFAULT_ROUTE);
  });
});

describe('formatHash', () => {
  it.each<[Route, string]>([
    [DEFAULT_ROUTE, '#/board'],
    [
      { view: 'board', change: 'openspec:add-board-web', assignee: 'impl-1', closed: true },
      '#/board?change=openspec%3Aadd-board-web&assignee=impl-1&closed=1',
    ],
    [{ view: 'board', change: null, assignee: null, closed: true }, '#/board?closed=1'],
    [{ view: 'feed', change: null, actor: null, kinds: null }, '#/feed'],
    [{ view: 'feed', change: null, actor: null, kinds: [] }, '#/feed'],
    [
      {
        view: 'feed',
        change: 'openspec:x',
        actor: 'impl-1',
        kinds: ['ticket.handoff', 'ticket.move'],
      },
      '#/feed?change=openspec%3Ax&actor=impl-1&kind=ticket.handoff&kind=ticket.move',
    ],
    [{ view: 'ticket', id: T1 }, `#/ticket/${T1}`],
    [{ view: 'ticket', id: 'a/b c' }, '#/ticket/a%2Fb%20c'],
    [{ view: 'lanes' }, '#/lanes'],
    [{ view: 'health', stale: null, blocked: null }, '#/health'],
    [{ view: 'health', stale: '30m', blocked: '2d' }, '#/health?stale=30m&blocked=2d'],
    [{ view: 'health', stale: null, blocked: '26h' }, '#/health?blocked=26h'],
    [{ view: 'replay' }, '#/replay'],
    [{ view: 'graph', change: null, since: null }, '#/graph'],
    [
      { view: 'graph', change: 'openspec:add-login', since: '1d' },
      '#/graph?change=openspec%3Aadd-login&since=1d',
    ],
    [{ view: 'graph', change: null, since: '1h' }, '#/graph?since=1h'],
  ])('formats %j', (route, hash) => {
    expect(formatHash(route)).toBe(hash);
  });

  it.each<Route>([
    DEFAULT_ROUTE,
    { view: 'board', change: 'openspec:add-board-web#2', assignee: 'a b&c', closed: true },
    { view: 'feed', change: 'x:y', actor: 'impl=1', kinds: ['ticket.create'] },
    { view: 'feed', change: null, actor: null, kinds: null },
    { view: 'ticket', id: 'x?y#z' },
    { view: 'lanes' },
    { view: 'health', stale: '45m', blocked: '3d' },
    { view: 'health', stale: null, blocked: null },
    { view: 'replay' },
    { view: 'graph', change: 'openspec:add-login', since: '30d' },
    { view: 'graph', change: null, since: null },
  ])('round-trips %j', (route) => {
    expect(parseHash(formatHash(route))).toEqual(route);
  });
});
