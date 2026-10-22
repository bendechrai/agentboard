// @vitest-environment happy-dom
/**
 * The health view (board-insights: "Health report", "Durations", "Health in the
 * web app"), driven through the real app on a fake API and a fake clock: every
 * section rendered from `healthReport`, the threshold inputs (kept in the URL
 * hash, invalid values flagged without changing the report), re-evaluation on
 * model and clock changes, the late arrivals of `/api/health`, the cache check
 * run only by its button, the close-merged note, text never rendered as markup
 * and no inline style.
 */

import { act, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FoldInput } from '../../../events/fold.js';
import { DEFAULT_THRESHOLDS, healthReport, type LateArrival } from '../../../view/health.js';
import { relativeTime } from '../../../view/time.js';
import type { BoardModel } from '../../../view/types.js';
import { parseHash } from '../hash.js';
import {
  E,
  FakeApi,
  T1,
  T2,
  T3,
  T4,
  T5,
  TASK,
  all,
  appendOf,
  errorDoc,
  model,
  setHash,
  streamOf,
} from './client-helpers.js';
import {
  TimedClock,
  advance,
  button,
  field,
  one,
  renderTimed,
  serveCheck,
  serveHealth,
  styled,
} from './insight-helpers.js';

const T6 = '01E0000000ACTAV9WEVGEMMVRZ';
const T7 = '01F0000000ACTAV9WEVGEMMVRZ';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 400_000_000;
const W0 = NOW - 30 * HOUR;

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  cleanup();
  setHash('');
});

/** Moves `ticket` from `todo` to `merged`, one wall apart from `wall`. */
function toMerged(ticket: string, wall: number): FoldInput[] {
  return [
    E.move(ticket, 'tests', { wall }),
    E.move(ticket, 'implementing', { wall: wall + 1 }),
    E.move(ticket, 'review', { wall: wall + 2 }),
    E.move(ticket, 'merged', { wall: wall + 3 }),
  ];
}

/**
 * T1: claimed by impl-1 3 hours ago, a reviewer commented 10 minutes ago
 * (stale). T2: claimed by impl-2 30 minutes ago (stale only below 30m).
 * T3: blocked from implementing 25 hours ago, with a latest comment
 * (stuck). T4: an open decision (unpromoted). T5, T6, T7 in merged: with a
 * PR (ready), with a PR and an open decision (held), without a PR
 * (missing).
 */
function inputs(): FoldInput[] {
  return [
    E.create(T1, { title: 'Parser', task: TASK }, { wall: W0 }),
    E.create(T2, { title: 'Docs', task: TASK }, { wall: W0 + 10 }),
    E.create(T3, { title: 'Keys', task: TASK }, { wall: W0 + 20 }),
    E.create(T4, { title: 'Sessions', task: TASK }, { wall: W0 + 30 }),
    E.create(T5, { title: 'Ready one', task: TASK }, { wall: W0 + 40 }),
    E.create(T6, { title: 'Held one', task: TASK }, { wall: W0 + 50 }),
    E.create(T7, { title: 'No PR one', task: TASK }, { wall: W0 + 60 }),
    E.move(T3, 'tests', { wall: W0 + 70 }),
    E.move(T3, 'implementing', { wall: W0 + 80 }),
    ...toMerged(T5, W0 + 100),
    ...toMerged(T6, W0 + 200),
    ...toMerged(T7, W0 + 300),
    E.link(T5, { pr: 12 }, { wall: W0 + 400 }),
    E.link(T6, { pr: 34 }, { wall: W0 + 410 }),
    E.comment(T6, 'DECISION: keep sqlite', { actor: 'impl-6', wall: W0 + 420 }),
    E.comment(T4, 'DECISION: use sessions', { actor: 'impl-4', wall: W0 + 430 }),
    E.move(T3, 'blocked', { actor: 'impl-3', wall: NOW - 25 * HOUR }),
    E.comment(T3, 'waiting on API keys', { actor: 'impl-3', wall: NOW - 24 * HOUR }),
    E.claim(T1, { actor: 'impl-1', wall: NOW - 3 * HOUR }),
    E.claim(T2, { actor: 'impl-2', wall: NOW - 30 * MIN }),
    E.comment(T1, 'looks good so far', { actor: 'reviewer', wall: NOW - 10 * MIN }),
  ];
}

/** The `data-section` values in document order. */
function sectionNames(): string[] {
  return all(document, 'section.health-section').map((s) => s.getAttribute('data-section') ?? '');
}

function section(name: string): Element {
  return one(document, `section.health-section[data-section="${name}"]`);
}

/** The `data-ticket` values of the findings of a section. */
function findings(name: string): string[] {
  return all(section(name), 'li.finding').map((li) => li.getAttribute('data-ticket') ?? '');
}

function finding(name: string, id: string): Element {
  return one(section(name), `li.finding[data-ticket="${id}"]`);
}

function count(name: string): string {
  return one(section(name), '.count').textContent?.trim() ?? '';
}

/** Opens `hash` on `m` and waits for the health view. */
async function openHealth(
  hash = '#/health',
  m: BoardModel = model(inputs()),
  clock = new TimedClock(NOW),
  prepare: (api: FakeApi) => void = (api) => {
    serveHealth(api);
  },
): Promise<{ api: FakeApi; clock: TimedClock }> {
  setHash(hash);
  const api = new FakeApi(m);
  prepare(api);
  renderTimed(api, clock);
  await waitFor(() => {
    expect(
      document.querySelector('section.health-section[data-section="stale-claims"]'),
    ).not.toBeNull();
  });
  return { api, clock };
}

describe('fixture', () => {
  it('gives the report the tests expect (checked with the view-model itself)', () => {
    const report = healthReport({
      model: model(inputs()),
      now: NOW,
      thresholds: { ...DEFAULT_THRESHOLDS },
    });
    expect(report.staleClaims.map((s) => s.ticket.id)).toEqual([T1]);
    expect(report.stuckBlocked.map((s) => s.ticket.id)).toEqual([T3]);
    expect(report.unpromotedDecisions.map((s) => s.ticket.id)).toEqual([T4, T6]);
    expect(report.closeMerged.ready.map((s) => s.ticket.id)).toEqual([T5]);
    expect(report.closeMerged.heldByDecision.map((s) => s.ticket.id)).toEqual([T6]);
    expect(report.closeMerged.missingPr.map((s) => s.ticket.id)).toEqual([T7]);
  });
});

describe('sections', () => {
  it('renders every section of the report, in order, with counts', async () => {
    await openHealth();
    expect(sectionNames()).toEqual([
      'stale-claims',
      'stuck-blocked',
      'unpromoted-decisions',
      'close-merged-ready',
      'close-merged-held',
      'close-merged-missing-pr',
      'unplanned-scope',
      'late',
      'check',
    ]);
    expect(findings('stale-claims')).toEqual([T1]);
    expect(count('stale-claims')).toBe('1');
    expect(findings('stuck-blocked')).toEqual([T3]);
    expect(findings('unpromoted-decisions')).toEqual([T4, T6]);
    expect(count('unpromoted-decisions')).toBe('2');
    expect(findings('close-merged-ready')).toEqual([T5]);
    expect(findings('close-merged-held')).toEqual([T6]);
    expect(findings('close-merged-missing-pr')).toEqual([T7]);
    expect(count('late')).toBe('0');
  });

  it('shows a stale claim with its title, link, assignee and idle time (a reviewer comment does not reset it)', async () => {
    await openHealth();
    const item = finding('stale-claims', T1);
    expect(item.textContent).toContain('Parser');
    expect(item.textContent).toContain('impl-1');
    expect(item.textContent).toContain(`last active ${relativeTime(3 * HOUR)}`);
    expect(one(item, 'a').getAttribute('href')).toBe(`#/ticket/${T1}`);
  });

  it('shows a stuck ticket with the status it was blocked from and its latest comment', async () => {
    await openHealth();
    const item = finding('stuck-blocked', T3);
    expect(item.textContent).toContain('from implementing');
    expect(item.textContent).toContain('waiting on API keys');
    expect(item.textContent).toContain('impl-3');
  });

  it('shows the open decisions of unpromoted and held tickets', async () => {
    await openHealth();
    expect(finding('unpromoted-decisions', T4).textContent).toContain('DECISION: use sessions');
    expect(finding('unpromoted-decisions', T6).textContent).toContain('DECISION: keep sqlite');
    expect(finding('close-merged-held', T6).textContent).toContain('DECISION: keep sqlite');
  });

  it('shows the PR links of ready and held candidates, and marks missing ones', async () => {
    await openHealth();
    expect(finding('close-merged-ready', T5).textContent).toContain('PR 12');
    expect(finding('close-merged-held', T6).textContent).toContain('PR 34');
    expect(finding('close-merged-missing-pr', T7).textContent).toContain('no PR link');
  });

  it('states that only close-merged knows whether a pull request is merged, before its sections', async () => {
    await openHealth();
    const note = one(document, 'p.close-merged-note');
    expect(note.textContent).toContain(
      'Whether a pull request is merged is known only to close-merged',
    );
    const ready = section('close-merged-ready');
    expect(note.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows an empty marker in each ticket section without findings', async () => {
    await openHealth(
      '#/health',
      model([E.create(T1, { title: 'Quiet', task: TASK }, { wall: NOW })]),
    );
    for (const name of [
      'stale-claims',
      'stuck-blocked',
      'unpromoted-decisions',
      'close-merged-ready',
      'close-merged-held',
      'close-merged-missing-pr',
      'unplanned-scope',
    ]) {
      expect(findings(name), name).toEqual([]);
      expect(count(name), name).toBe('0');
      expect(section(name).querySelector('p.empty'), name).not.toBeNull();
    }
  });
});

/**
 * Ad hoc ticket T1 (`Hotfix one`, ad hoc `found in prod`) in `review` with
 * no disposition, created and moved 30 hours ago.
 */
function adhocInReview(): FoldInput[] {
  return [
    E.create(T1, { title: 'Hotfix one', adhoc: 'found in prod' }, { wall: W0 }),
    E.move(T1, 'tests', { wall: W0 + 1, actor: 'impl-1' }),
    E.move(T1, 'implementing', { wall: W0 + 2, actor: 'impl-1' }),
    E.move(T1, 'review', { wall: W0 + 3, actor: 'impl-1' }),
  ];
}

/** `agentboard move T1 merged --unplanned "hotfix" --as orch` at `wall`: the disposition, then the move. */
function mergeUnplanned(wall: number, reason = 'hotfix'): FoldInput[] {
  return [
    E.unplanned(T1, reason, { wall, actor: 'orch' }),
    E.move(T1, 'merged', { wall: wall + 1, actor: 'orch' }),
  ];
}

/** The text of the `.total` span of the unplanned scope heading. */
function total(): string {
  return one(section('unplanned-scope'), '.total').textContent?.trim() ?? '';
}

describe('unplanned scope (board-insights: "Unplanned scope in the Health view")', () => {
  it('scenario: lists a ticket merged as unplanned from the CLI within 10 seconds, and a 1m window after a minute drops it from the list but not the total', async () => {
    const base = adhocInReview();
    const before = model(base);
    const { api, clock } = await openHealth('#/health', before);
    expect(findings('unplanned-scope')).toEqual([]);
    expect(count('unplanned-scope')).toBe('0');
    expect(total()).toBe('0 in all');
    expect(section('unplanned-scope').querySelector('p.empty')).not.toBeNull();

    // The CLI writes the two events; the stream delivers them.
    const after = model([...base, ...mergeUnplanned(NOW)]);
    const stream = await streamOf(api);
    stream.append(appendOf(after, before.events.length));
    await waitFor(() => {
      expect(findings('unplanned-scope')).toEqual([T1]);
    });
    expect(count('unplanned-scope')).toBe('1');
    expect(total()).toBe('1 in all');
    const item = finding('unplanned-scope', T1);
    expect(item.textContent).toContain('Hotfix one');
    expect(one(item, '.reason').textContent).toBe('hotfix');
    expect(item.textContent).toContain(`merged ${relativeTime(0)}`);
    expect(one(item, 'a').getAttribute('href')).toBe(`#/ticket/${T1}`);
    expect(section('unplanned-scope').querySelector('p.empty')).toBeNull();

    // A minute later (the client refreshes `now` every 10 seconds).
    await advance(clock, 70_000);
    await waitFor(() => {
      expect(finding('unplanned-scope', T1).textContent).toContain(`merged ${relativeTime(70_000)}`);
    });
    fireEvent.input(field('health-unplanned'), { target: { value: '1m' } });
    await waitFor(() => {
      expect(findings('unplanned-scope')).toEqual([]);
    });
    expect(count('unplanned-scope')).toBe('0');
    expect(total()).toBe('1 in all');
    expect(parseHash(window.location.hash)).toEqual({
      view: 'health',
      stale: null,
      blocked: null,
      unplanned: '1m',
    });
  });

  it('shows a ticket closed before this change with no reason recorded and its ad hoc reason', async () => {
    const m = model([
      E.create(T2, { title: 'Old spike', adhoc: 'try the parser' }, { wall: W0 }),
      E.move(T2, 'blocked', { wall: W0 + 1 }),
      E.close(T2, { noDecision: true }, { wall: NOW - 3 * HOUR }),
    ]);
    await openHealth('#/health', m);
    expect(findings('unplanned-scope')).toEqual([T2]);
    expect(total()).toBe('1 in all');
    const item = finding('unplanned-scope', T2);
    expect(item.querySelector('.reason')).toBeNull();
    expect(one(item, '.no-reason').textContent).toContain('no reason recorded');
    expect(one(item, '.adhoc-reason').textContent).toBe('try the parser');
    expect(item.textContent).toContain(`closed ${relativeTime(3 * HOUR)}`);
    // Closed, so in no other section.
    for (const name of ['stale-claims', 'stuck-blocked', 'unpromoted-decisions']) {
      expect(findings(name), name).toEqual([]);
    }
  });

  it('lists the most recent disposition first and counts the ones outside the window in the total', async () => {
    const m = model([
      ...adhocInReview(),
      ...mergeUnplanned(NOW - 2 * HOUR, 'two hours'),
      E.create(T2, { title: 'Newer', adhoc: 'x' }, { wall: W0 + 10 }),
      E.move(T2, 'blocked', { wall: W0 + 11 }),
      E.unplanned(T2, 'abandoned', { wall: NOW - 5 * MIN, actor: 'orch' }),
      E.close(T2, { noDecision: true }, { wall: NOW - 5 * MIN + 1, actor: 'orch' }),
      // Created and blocked before its disposition 10 days ago, so every
      // event of T6 applies and it counts in the total outside the window.
      E.create(T6, { title: 'Old', adhoc: 'y' }, { wall: NOW - 11 * 24 * HOUR }),
      E.move(T6, 'blocked', { wall: NOW - 11 * 24 * HOUR + 1 }),
      E.unplanned(T6, 'long ago', { wall: NOW - 10 * 24 * HOUR, actor: 'orch' }),
      E.close(T6, { noDecision: true }, { wall: NOW - 10 * 24 * HOUR + 1, actor: 'orch' }),
    ]);
    expect(m.events.filter((e) => e.outcome !== 'applied')).toEqual([]);
    await openHealth('#/health', m);
    expect(findings('unplanned-scope')).toEqual([T2, T1]);
    expect(count('unplanned-scope')).toBe('2');
    expect(total()).toBe('3 in all');
    expect(finding('unplanned-scope', T2).textContent).toContain(`closed ${relativeTime(5 * MIN)}`);
    expect(finding('unplanned-scope', T1).textContent).toContain(`merged ${relativeTime(2 * HOUR)}`);
  });

  it('scenario "Information, not a failure": the section carries the info class and not the warning class of stale claims and stuck tickets', async () => {
    await openHealth('#/health', model([...adhocInReview(), ...mergeUnplanned(NOW - HOUR)]));
    expect(findings('unplanned-scope')).toEqual([T1]);
    const unplanned = section('unplanned-scope');
    expect(unplanned.classList.contains('health-section')).toBe(true);
    expect(unplanned.classList.contains('info')).toBe(true);
    expect(unplanned.classList.contains('warning')).toBe(false);
    expect(one(unplanned, '.unplanned-note').textContent).toContain('not a failure');
    // Those two are findings to act on, so they carry the warning styling.
    cleanup();
    await openHealth('#/health', model(inputs()));
    for (const name of ['stale-claims', 'stuck-blocked']) {
      expect(section(name).classList.contains('warning'), name).toBe(true);
      expect(section(name).classList.contains('info'), name).toBe(false);
    }
    expect(section('unplanned-scope').classList.contains('warning')).toBe(false);
  });

  it('starts the third input from 7d, labelled, and restores it from the hash', async () => {
    await openHealth();
    expect(field('health-unplanned').value).toBe('7d');
    expect(one(document, 'label[for="health-unplanned"]').textContent).toContain(
      'Unplanned within',
    );
    expect(field('health-unplanned').getAttribute('aria-describedby')).toBe(
      'health-duration-help',
    );
    cleanup();
    await openHealth('#/health?unplanned=2d&stale=20m');
    expect(field('health-unplanned').value).toBe('2d');
    expect(field('health-stale').value).toBe('20m');
    cleanup();
    await openHealth('#/health?unplanned=bogus');
    expect(field('health-unplanned').value).toBe('7d');
  });

  it('re-evaluates the report when the window changes, and keeps it in the URL hash', async () => {
    await openHealth('#/health', model([...adhocInReview(), ...mergeUnplanned(NOW - 3 * HOUR)]));
    expect(findings('unplanned-scope')).toEqual([T1]);
    fireEvent.input(field('health-unplanned'), { target: { value: '2h' } });
    await waitFor(() => {
      expect(findings('unplanned-scope')).toEqual([]);
    });
    expect(total()).toBe('1 in all');
    expect(parseHash(window.location.hash)).toEqual({
      view: 'health',
      stale: null,
      blocked: null,
      unplanned: '2h',
    });
    fireEvent.input(field('health-unplanned'), { target: { value: '4h' } });
    await waitFor(() => {
      expect(findings('unplanned-scope')).toEqual([T1]);
    });
    expect(parseHash(window.location.hash)).toMatchObject({ unplanned: '4h' });
  });

  it.each(['7days', '0d', '100000m', 'd', '-7d', '', '1.5d'])(
    'flags the window %j as invalid and leaves the report and the hash unchanged',
    async (text) => {
      await openHealth(
        '#/health?unplanned=2h',
        model([...adhocInReview(), ...mergeUnplanned(NOW - HOUR)]),
      );
      expect(findings('unplanned-scope')).toEqual([T1]);
      const before = window.location.hash;
      fireEvent.input(field('health-unplanned'), { target: { value: text } });
      await waitFor(() => {
        expect(field('health-unplanned').getAttribute('aria-invalid')).toBe('true');
      });
      expect(field('health-unplanned').classList.contains('invalid')).toBe(true);
      expect(findings('unplanned-scope')).toEqual([T1]);
      expect(total()).toBe('1 in all');
      expect(window.location.hash).toBe(before);
      expect(field('health-stale').getAttribute('aria-invalid')).not.toBe('true');
    },
  );

  it('keeps a merge outside the window out of the list on invalid input, rather than falling back to 7d', async () => {
    // Merged 3 hours ago: outside a 2h window, inside the 7d default. A
    // silent fallback to the default on bad input would list it.
    await openHealth(
      '#/health?unplanned=2h',
      model([...adhocInReview(), ...mergeUnplanned(NOW - 3 * HOUR)]),
    );
    expect(findings('unplanned-scope')).toEqual([]);
    expect(count('unplanned-scope')).toBe('0');
    expect(total()).toBe('1 in all');
    const before = window.location.hash;
    for (const text of ['7days', '', '1.5d']) {
      fireEvent.input(field('health-unplanned'), { target: { value: text } });
      await waitFor(() => {
        expect(field('health-unplanned').getAttribute('aria-invalid')).toBe('true');
      });
      expect(findings('unplanned-scope')).toEqual([]);
      expect(count('unplanned-scope')).toBe('0');
      expect(total()).toBe('1 in all');
      expect(window.location.hash).toBe(before);
    }
    // Valid again, and wide enough: listed.
    fireEvent.input(field('health-unplanned'), { target: { value: '4h' } });
    await waitFor(() => {
      expect(findings('unplanned-scope')).toEqual([T1]);
    });
    expect(field('health-unplanned').getAttribute('aria-invalid')).not.toBe('true');
    expect(parseHash(window.location.hash)).toMatchObject({ unplanned: '4h' });
  });

  it('renders the reasons as text, never as markup', async () => {
    const REASON = '<b>hot</b><img src=x onerror=alert(3)>';
    const ADHOC = '<i>spike</i>';
    const m = model([
      ...adhocInReview(),
      ...mergeUnplanned(NOW - HOUR, REASON),
      E.create(T2, { title: 'Old', adhoc: ADHOC }, { wall: W0 + 10 }),
      E.move(T2, 'blocked', { wall: W0 + 11 }),
      E.close(T2, { noDecision: true }, { wall: NOW - 2 * HOUR }),
    ]);
    await openHealth('#/health', m);
    expect(one(finding('unplanned-scope', T1), '.reason').textContent).toBe(REASON);
    expect(one(finding('unplanned-scope', T2), '.adhoc-reason').textContent).toBe(ADHOC);
    for (const tag of ['img', 'b', 'i']) {
      expect(section('unplanned-scope').querySelector(tag), tag).toBeNull();
    }
    expect(styled(document.body)).toEqual([]);
  });
});

describe('thresholds', () => {
  it('starts from the defaults 2h and 24h, with the accepted forms named', async () => {
    await openHealth();
    expect(field('health-stale').value).toBe('2h');
    expect(field('health-blocked').value).toBe('24h');
    expect(one(document, 'label[for="health-stale"]').textContent).toContain('Stale after');
    expect(one(document, 'label[for="health-blocked"]').textContent).toContain('Blocked after');
    const help = one(document, '.duration-help').textContent ?? '';
    for (const form of ['<n>m', '<n>h', '<n>d']) {
      expect(help).toContain(form);
    }
  });

  it('re-evaluates the report when a threshold changes, and keeps it in the URL hash', async () => {
    await openHealth();
    fireEvent.input(field('health-stale'), { target: { value: '20m' } });
    await waitFor(() => {
      expect(findings('stale-claims')).toEqual([T1, T2]);
    });
    expect(parseHash(window.location.hash)).toEqual({
      view: 'health',
      stale: '20m',
      blocked: null,
      unplanned: null,
    });
    fireEvent.input(field('health-blocked'), { target: { value: '26h' } });
    await waitFor(() => {
      expect(findings('stuck-blocked')).toEqual([]);
    });
    expect(parseHash(window.location.hash)).toEqual({
      view: 'health',
      stale: '20m',
      blocked: '26h',
      unplanned: null,
    });
  });

  it.each(['2hours', '0h', '100000m', 'h', '-1h', '', '1.5h'])(
    'flags %j as invalid and leaves the report and the hash unchanged',
    async (text) => {
      await openHealth('#/health?blocked=26h');
      expect(findings('stuck-blocked')).toEqual([]);
      const before = window.location.hash;
      fireEvent.input(field('health-stale'), { target: { value: text } });
      await waitFor(() => {
        expect(field('health-stale').getAttribute('aria-invalid')).toBe('true');
      });
      expect(field('health-stale').classList.contains('invalid')).toBe(true);
      expect(findings('stale-claims')).toEqual([T1]);
      expect(findings('stuck-blocked')).toEqual([]);
      expect(window.location.hash).toBe(before);
    },
  );

  it('clears the invalid flag once the text is valid again', async () => {
    await openHealth();
    const input = field('health-blocked');
    fireEvent.input(input, { target: { value: '2days' } });
    await waitFor(() => {
      expect(field('health-blocked').getAttribute('aria-invalid')).toBe('true');
    });
    expect(findings('stuck-blocked')).toEqual([T3]);
    fireEvent.input(field('health-blocked'), { target: { value: '2d' } });
    await waitFor(() => {
      expect(findings('stuck-blocked')).toEqual([]);
    });
    expect(field('health-blocked').getAttribute('aria-invalid')).not.toBe('true');
    expect(field('health-blocked').classList.contains('invalid')).toBe(false);
  });

  it('restores the thresholds from the URL hash on load, ignoring invalid ones', async () => {
    await openHealth('#/health?stale=20m&blocked=bogus');
    expect(field('health-stale').value).toBe('20m');
    expect(field('health-blocked').value).toBe('24h');
    expect(findings('stale-claims')).toEqual([T1, T2]);
    expect(findings('stuck-blocked')).toEqual([T3]);
  });
});

describe('re-evaluation', () => {
  it('re-evaluates when the client refreshes now (every 10 seconds)', async () => {
    const edge = [
      E.create(T1, { title: 'Almost', task: TASK }, { wall: NOW - 3 * HOUR }),
      E.claim(T1, { actor: 'impl-1', wall: NOW - 2 * HOUR + 5000 }),
    ];
    const { clock } = await openHealth('#/health', model(edge));
    expect(findings('stale-claims')).toEqual([]);
    await advance(clock, 10_000);
    await waitFor(() => {
      expect(findings('stale-claims')).toEqual([T1]);
    });
  });

  it('re-evaluates on a model change from the stream, and reloads /api/health for the new model', async () => {
    const base = inputs();
    const before = model(base);
    const after = model([
      ...base,
      E.comment(T1, 'still on it', { actor: 'impl-1', wall: NOW - MIN }),
    ]);
    const { api } = await openHealth('#/health', before);
    expect(findings('stale-claims')).toEqual([T1]);
    await waitFor(() => {
      expect(api.count('/api/health')).toBe(1);
    });
    const stream = await streamOf(api);
    stream.append(appendOf(after, before.events.length));
    await waitFor(() => {
      expect(findings('stale-claims')).toEqual([]);
    });
    await waitFor(() => {
      expect(api.count('/api/health')).toBe(2);
    });
  });
});

describe('late arrivals', () => {
  const LATE: LateArrival[] = [
    {
      hash: 'b'.repeat(64),
      kind: 'ticket.claim',
      ticket: T2,
      type: 'removed',
      observedAt: NOW - 1000,
    },
    {
      hash: 'a'.repeat(64),
      kind: 'ticket.comment',
      ticket: T1,
      type: 'late',
      observedAt: NOW - 1000,
    },
    {
      hash: 'c'.repeat(64),
      kind: 'board.meta',
      ticket: null,
      type: 'late',
      observedAt: NOW - 5000,
    },
  ];

  it('lists what /api/health observed, in the order given, with kind, type, ticket and time', async () => {
    await openHealth('#/health', model(inputs()), new TimedClock(NOW), (api) => {
      serveHealth(api, LATE);
    });
    await waitFor(() => {
      expect(all(section('late'), 'li.late-item')).toHaveLength(3);
    });
    expect(count('late')).toBe('3');
    const items = all(section('late'), 'li.late-item');
    expect(items.map((li) => li.getAttribute('data-hash'))).toEqual(LATE.map((l) => l.hash));
    expect(items.map((li) => li.classList.contains('removed'))).toEqual([true, false, false]);
    expect(items[0]?.textContent).toContain('ticket.claim');
    expect(items[0]?.textContent).toContain('removed');
    expect(items[0]?.textContent).toContain(T2);
    expect(items[1]?.textContent).toContain('late');
    expect(items[1]?.textContent).toContain(T1);
    expect(items[2]?.textContent).toContain('board.meta');
    expect(items[0]?.querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(NOW - 1000).toISOString(),
    );
  });

  it('shows a failed /api/health as an alert in the late section, and the rest of the report', async () => {
    await openHealth('#/health', model(inputs()), new TimedClock(NOW), (api) => {
      api.failures.set('/api/health', {
        status: 500,
        body: errorDoc('internal', 'health is unavailable'),
      });
    });
    await waitFor(() => {
      expect(section('late').querySelector('[role="alert"]')?.textContent).toContain(
        'health is unavailable',
      );
    });
    expect(findings('stale-claims')).toEqual([T1]);
  });
});

describe('the cache check', () => {
  it('is never requested without the button, and shows that none has run', async () => {
    const { api } = await openHealth();
    await waitFor(() => {
      expect(api.count('/api/health')).toBe(1);
    });
    expect(api.count('/api/health/check')).toBe(0);
    expect(section('check').textContent).toContain('No cache check has run');
    expect(one(section('check'), '.check-note').textContent).toContain('pauses writers');
    expect(button('Run cache check', section('check')).getAttribute('type')).toBe('button');
  });

  it('shows the result after the button is pressed', async () => {
    const { api } = await openHealth('#/health', model(inputs()), new TimedClock(NOW), (a) => {
      serveHealth(a);
      serveCheck(a, { ranAt: NOW - 2000, matches: true, differingRows: 0 });
    });
    fireEvent.click(button('Run cache check'));
    await waitFor(() => {
      expect(section('check').querySelector('.check-result')).not.toBeNull();
    });
    expect(api.count('/api/health/check')).toBe(1);
    const result = one(section('check'), '.check-result');
    expect(result.getAttribute('data-matches')).toBe('true');
    expect(result.textContent).toContain('The cache matches the event log');
    expect(section('check').querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(NOW - 2000).toISOString(),
    );
    expect(section('check').textContent).not.toContain('No cache check has run');
  });

  it.each([
    [1, '1 differing row'],
    [3, '3 differing rows'],
  ])('shows %i differing rows as %j', async (rows, text) => {
    await openHealth('#/health', model(inputs()), new TimedClock(NOW), (a) => {
      serveHealth(a);
      serveCheck(a, { ranAt: NOW, matches: false, differingRows: rows });
    });
    fireEvent.click(button('Run cache check'));
    await waitFor(() => {
      expect(section('check').querySelector('.check-result')).not.toBeNull();
    });
    const result = one(section('check'), '.check-result');
    expect(result.getAttribute('data-matches')).toBe('false');
    expect(result.textContent).toContain(text);
  });

  it('shows the last check /api/health reports before any press', async () => {
    const { api } = await openHealth('#/health', model(inputs()), new TimedClock(NOW), (a) => {
      serveHealth(a, [], { ranAt: NOW - 9000, matches: false, differingRows: 2 });
    });
    await waitFor(() => {
      expect(section('check').querySelector('.check-result')?.textContent).toContain(
        '2 differing rows',
      );
    });
    expect(api.count('/api/health/check')).toBe(0);
  });

  it('disables the button and says Checking... while the request is in flight', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    setHash('#/health');
    const api = new FakeApi(model(inputs()));
    serveHealth(api);
    serveCheck(api, { ranAt: NOW, matches: true, differingRows: 0 });
    const fetch = (input: string, init?: RequestInit): Promise<Response> => {
      if (String(input).startsWith('/api/health/check')) {
        return new Promise<Response>((resolve) => {
          gate.release = () => {
            void api.fetch(input, init).then(resolve);
          };
        });
      }
      return api.fetch(input, init);
    };
    renderTimed(api, new TimedClock(NOW), fetch);
    await waitFor(() => {
      expect(document.querySelector('section.health-section[data-section="check"]')).not.toBeNull();
    });
    fireEvent.click(button('Run cache check'));
    await waitFor(() => {
      expect(button('Checking...', section('check')).disabled).toBe(true);
    });
    await act(() => {
      gate.release?.();
    });
    await waitFor(() => {
      expect(section('check').querySelector('.check-result')?.textContent).toContain(
        'The cache matches the event log',
      );
    });
    expect(button('Run cache check', section('check')).disabled).toBe(false);
  });

  it('shows a failed check as an alert and keeps the previous result', async () => {
    const { api } = await openHealth('#/health', model(inputs()), new TimedClock(NOW), (a) => {
      serveHealth(a, [], { ranAt: NOW - 9000, matches: true, differingRows: 0 });
      a.failures.set('/api/health/check', {
        status: 500,
        body: { error: { exitCode: 5, reason: 'busy', message: 'the board is busy', hint: null } },
      });
    });
    await waitFor(() => {
      expect(section('check').querySelector('.check-result')).not.toBeNull();
    });
    fireEvent.click(button('Run cache check'));
    await waitFor(() => {
      expect(section('check').querySelector('[role="alert"]')?.textContent).toContain(
        'the board is busy',
      );
    });
    expect(api.count('/api/health/check')).toBe(1);
    expect(one(section('check'), '.check-result').textContent).toContain(
      'The cache matches the event log',
    );
  });
});

describe('text is never markup, and no inline style', () => {
  it('renders titles, actors, comments and late kinds holding markup as text', async () => {
    const TITLE = '<img src=x onerror=alert(1)>';
    const ACTOR = 'impl<i>1</i>';
    const DECISION = 'DECISION: <script>alert(2)</script>';
    const m = model([
      E.create(T1, { title: TITLE, task: TASK }, { wall: W0 }),
      E.claim(T1, { actor: ACTOR, wall: NOW - 3 * HOUR }),
      E.comment(T1, DECISION, { actor: ACTOR, wall: NOW - 3 * HOUR + 1 }),
    ]);
    await openHealth('#/health', m, new TimedClock(NOW), (api) => {
      serveHealth(api, [
        { hash: 'd'.repeat(64), kind: '<b>kind</b>', ticket: T1, type: 'late', observedAt: NOW },
      ]);
    });
    await waitFor(() => {
      expect(all(section('late'), 'li.late-item')).toHaveLength(1);
    });
    expect(finding('stale-claims', T1).textContent).toContain(TITLE);
    expect(finding('stale-claims', T1).textContent).toContain(ACTOR);
    expect(finding('unpromoted-decisions', T1).textContent).toContain(DECISION);
    expect(section('late').textContent).toContain('<b>kind</b>');
    for (const tag of ['img', 'script']) {
      expect(document.querySelector(tag), tag).toBeNull();
    }
    const made = all(document, 'b, i').filter(
      (el) => el.textContent === 'kind' || el.textContent === '1',
    );
    expect(made).toEqual([]);
  });

  it('puts no style attribute on any element', async () => {
    await openHealth('#/health', model(inputs()), new TimedClock(NOW), (api) => {
      serveHealth(api, [
        { hash: 'a'.repeat(64), kind: 'ticket.comment', ticket: T1, type: 'late', observedAt: NOW },
      ]);
      serveCheck(api, { ranAt: NOW, matches: false, differingRows: 1 });
    });
    fireEvent.click(button('Run cache check'));
    await waitFor(() => {
      expect(section('check').querySelector('.check-result')).not.toBeNull();
    });
    fireEvent.input(field('health-stale'), { target: { value: 'bad' } });
    expect(styled(document.body)).toEqual([]);
  });
});
