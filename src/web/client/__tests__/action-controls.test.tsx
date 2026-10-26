// @vitest-environment happy-dom
/**
 * The action controls of the ticket detail (board-web-actions: "Action controls
 * in the web app", scenarios "Refusal shown with its hint" and "Read-only
 * page"; add-board-web-actions design.md of add-board-web-actions: "The page"): the request body of
 * every control, the move and hand-off targets from `isTransitionAllowed`, the
 * acting-as banner, a refusal beside its control with message and hint keeping
 * the input, a success applied at once, a `busy` refusal offering a retry, a
 * 401 discarding the token, the bearer header on every action request, and no
 * write control on a read-only session.
 *
 * The app runs against the fake API of `client-helpers.tsx`, whose
 * `onAction` answers `POST /api/actions/<action>` and records each request.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTransitionAllowed, type Ticket } from '../../../events/fold.js';
import { STATUSES, type Status } from '../../../events/schema.js';
import type { BoardModel } from '../../../view/types.js';
import { App } from '../App.js';
import type { Session } from '../api.js';
import { handoffStatuses, moveTargets, needsScopeDisposition } from '../views/ActionControls.js';
import {
  E,
  FakeApi,
  FakeClock,
  SESSION,
  T1,
  T2,
  T3,
  T4,
  T5,
  TASK,
  TOKEN,
  WRITABLE,
  all,
  appendOf,
  errorDoc,
  fakeDeps,
  model,
  renderApp,
  setHash,
  streamOf,
  withDigest,
  type FakeAction,
} from './client-helpers.js';

const WALL = 7_000_000;
const NOW = WALL + 600_000;
const HASH = 'a'.repeat(64);

beforeEach(() => {
  setHash('');
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  setHash('');
  window.sessionStorage.clear();
});

/**
 * T1 in `tests`, unassigned, with a task and two checklist lines, the first
 * done; T2 blocked from `tests`; T3 merged, held by impl-1, with an open
 * decision; T4 in `todo`; T5 in `review`.
 */
function inputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(
      T1,
      { title: 'Write the parser', task: TASK, checklist: ['schema', 'migration'] },
      { actor: 'orch', wall: WALL },
    ),
    E.move(T1, 'tests', { actor: 'orch', wall: WALL + 1 }),
    E.check(T1, 0, true, { actor: 'orch', wall: WALL + 2 }),
    E.create(T2, { title: 'Blocked one', task: TASK }, { actor: 'orch', wall: WALL + 10 }),
    E.move(T2, 'tests', { actor: 'orch', wall: WALL + 11 }),
    E.move(T2, 'blocked', { actor: 'orch', wall: WALL + 12 }),
    E.create(T3, { title: 'Merged one', task: TASK }, { actor: 'orch', wall: WALL + 20 }),
    E.claim(T3, { actor: 'impl-1', wall: WALL + 21 }),
    E.move(T3, 'tests', { actor: 'impl-1', wall: WALL + 22 }),
    E.move(T3, 'implementing', { actor: 'impl-1', wall: WALL + 23 }),
    E.comment(T3, 'DECISION: keep the cache', { actor: 'impl-1', wall: WALL + 24 }),
    E.move(T3, 'review', { actor: 'impl-1', wall: WALL + 25 }),
    E.move(T3, 'merged', { actor: 'impl-1', wall: WALL + 26 }),
    E.create(T4, { title: 'Todo one', task: TASK }, { actor: 'orch', wall: WALL + 30 }),
    E.create(T5, { title: 'Review one', task: TASK }, { actor: 'orch', wall: WALL + 40 }),
    E.move(T5, 'tests', { actor: 'orch', wall: WALL + 41 }),
    E.move(T5, 'implementing', { actor: 'orch', wall: WALL + 42 }),
    E.move(T5, 'review', { actor: 'orch', wall: WALL + 43 }),
  ];
}

interface Opened {
  api: FakeApi;
  snapshot: BoardModel;
  clock: FakeClock;
}

/**
 * Opens the detail of `id` (the route may name a prefix) with `session`,
 * and waits for the article. Unless a test sets its own `onAction`, every
 * action is answered 200 with the ticket unchanged.
 */
async function openTicket(
  id: string,
  session: Session = WRITABLE,
  events = inputs(),
): Promise<Opened> {
  setHash(`#/ticket/${id}`);
  const snapshot = withDigest(model(events), '1');
  const api = new FakeApi(snapshot);
  api.session = session;
  api.onAction = (request) => ({
    status: 200,
    body: { hash: HASH, ticket: ticketOf(snapshot, idOf(request)) },
  });
  const clock = new FakeClock(NOW);
  renderApp(api, clock);
  await waitFor(() => {
    expect(document.querySelector('article.ticket')).not.toBeNull();
  });
  return { api, snapshot, clock };
}

function ticketOf(m: BoardModel, id: string): Ticket {
  const ticket = m.tickets[id];
  if (ticket === undefined) {
    throw new Error(`no ticket ${id}`);
  }
  return ticket;
}

function idOf(request: FakeAction): string {
  const body = request.body as { id?: unknown } | undefined;
  return typeof body?.id === 'string' ? body.id : '';
}

/** The ticket `id` after `extra` events are folded on top of the fixture. */
function after(id: string, ...extra: ReturnType<typeof E.create>[]): Ticket {
  return ticketOf(model([...inputs(), ...extra]), id);
}

function detail(): Element {
  const el = document.querySelector('article.ticket');
  if (el === null) {
    throw new Error('no ticket detail');
  }
  return el;
}

/** The element of the control `name` (its `data-action`) in the detail. */
function control(name: string): Element {
  const el = detail().querySelector(`[data-action="${name}"]`);
  if (el === null) {
    throw new Error(`no control ${name}`);
  }
  return el;
}

/** The element matching `selector` in the document, as `T`; fails the test when missing. */
function el<T extends Element>(selector: string): T {
  const found = document.querySelector(selector);
  if (found === null) {
    throw new Error(`no element ${selector}`);
  }
  return found as T;
}

/**
 * Sets the value of an input, textarea or select and fires `input` and
 * `change`, as a user would, inside `act` so the page has re-rendered
 * before the next step (as it has by the time a user clicks).
 */
function setValue(selector: string, value: string): void {
  const target = el<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
  act(() => {
    target.value = value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Clicks `target` inside `act`. */
function click(target: Element): void {
  act(() => {
    (target as HTMLElement).click();
  });
}

/** Clicks the button of `name` whose text is `text`. */
function press(name: string, text: string): void {
  const button = all(control(name), 'button').find((b) => b.textContent?.trim() === text);
  if (button === undefined) {
    throw new Error(`no button ${text} in ${name}`);
  }
  click(button);
}

/** Clicks the submit button of the form of `name`. */
function submit(name: string): void {
  const button = control(name).querySelector('button[type="submit"]');
  if (button === null) {
    throw new Error(`no submit button in ${name}`);
  }
  click(button);
}

/** Waits until `count` requests of `action` were made; returns the last. */
async function posted(api: FakeApi, action: string, count = 1): Promise<FakeAction> {
  await waitFor(() => {
    expect(api.actionsOf(action)).toHaveLength(count);
  });
  const last = api.actionsOf(action).at(-1);
  if (last === undefined) {
    throw new Error(`no ${action} request`);
  }
  return last;
}

/** The `dd` of the `dt` named `name` in the fields list. */
function field(name: string): string | null {
  const dt = all(detail(), 'dl.fields dt').find((d) => d.textContent?.trim() === name);
  const dd = dt?.nextElementSibling;
  return dd === null || dd === undefined ? null : (dd.textContent?.trim() ?? null);
}

/** The option values of a select. */
function options(selector: string): string[] {
  return all(el(selector), 'option').map((o) => (o as HTMLOptionElement).value);
}

/** The refusal shown beside `name`, or null. */
function refusal(name: string): Element | null {
  return control(name).querySelector('.refusal[role="alert"]');
}

/** A promise with its resolver, for an action answered later. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  if (resolve === undefined) {
    throw new Error('promise did not start');
  }
  return { promise, resolve };
}

/**
 * Lets every pending promise callback, state update and effect run, inside
 * `act` (which flushes Preact's renders and effects when it returns). No
 * timer is involved: used to check that something did not happen, once
 * everything already set in motion has run.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const WRITE_CONTROLS = ['comment', 'move', 'claim', 'release', 'handoff', 'link', 'close'];

describe('read-only page (scenario "Read-only page")', () => {
  it('shows no comment box, button or form that writes, and makes no action request', async () => {
    const { api } = await openTicket(T1, SESSION);
    expect(detail().textContent).toContain('Write the parser');
    for (const selector of ['form', 'input', 'textarea', 'select', 'button', 'section.actions']) {
      expect(all(detail(), selector), selector).toEqual([]);
    }
    expect(all(detail(), '[data-action]')).toEqual([]);
    // The checklist is still shown, as plain lines.
    expect(all(detail(), 'ul.checklist li').map((li) => li.textContent?.trim())).toEqual([
      'schema',
      'migration',
    ]);
    expect(api.actions).toEqual([]);
    for (const request of api.requests) {
      expect(request.init?.method ?? 'GET', request.url).toBe('GET');
      expect(request.url.startsWith('/api/actions')).toBe(false);
    }
  });

  it('shows no acting-as banner', async () => {
    await openTicket(T1, SESSION);
    expect(document.querySelector('.acting-as')).toBeNull();
  });

  it('shows no control when the session is not writable, whatever its actor', async () => {
    await openTicket(T1, { ...SESSION, writable: false, actor: 'ben' });
    expect(all(detail(), 'form, input, textarea, select, button')).toEqual([]);
  });
});

describe('write mode', () => {
  it('shows the actor it acts as', async () => {
    await openTicket(T1);
    const banner = document.querySelectorAll('.acting-as');
    expect(banner).toHaveLength(1);
    expect(banner[0]?.textContent?.trim()).toBe('acting as ben');
  });

  it('renders the actor as text, never as markup', async () => {
    await openTicket(T1, { ...WRITABLE, actor: '<b>x</b>' });
    expect(document.querySelector('.acting-as')?.textContent?.trim()).toBe('acting as <b>x</b>');
    expect(document.querySelector('.acting-as b')).toBeNull();
  });

  it('offers a control for every action inside the ticket detail, in order', async () => {
    await openTicket(T1);
    const section = detail().querySelector('section.actions');
    expect(section?.getAttribute('aria-label')).toBe('Actions');
    expect(
      all(section ?? detail(), '[data-action]').map((e) => e.getAttribute('data-action')),
    ).toEqual(WRITE_CONTROLS);
    expect(detail().querySelector('[data-action="checklist"] ul.checklist')).not.toBeNull();
    expect(all(detail(), 'ul.checklist input[type="checkbox"]')).toHaveLength(2);
  });

  it('labels every input', async () => {
    await openTicket(T1);
    const labelled: [string, string][] = [
      ['action-comment-text', 'Comment'],
      ['action-move-status', 'Move to'],
      ['action-handoff-to', 'To'],
      ['action-handoff-status', 'Status'],
      ['action-handoff-note', 'Note'],
      ['action-link-kind', 'Link to'],
      ['action-link-value', 'Value'],
      ['action-close-decision', 'Decision recorded in'],
      ['action-close-none', 'No decision'],
      ['action-close-path', 'Decision path'],
    ];
    for (const [id, label] of labelled) {
      expect(screen.getByLabelText(label).id, label).toBe(id);
    }
  });

  it('sets no inline style on any element', async () => {
    await openTicket(T1);
    expect(all(document, '[style]')).toEqual([]);
  });
});

describe('request bodies', () => {
  it('comment posts the text with the full id, even when the route names a prefix', async () => {
    const { api } = await openTicket(T1.slice(0, 8));
    setValue('#action-comment-text', 'looks good');
    submit('comment');
    const request = await posted(api, 'comment');
    expect(request.body).toEqual({ id: T1, text: 'looks good' });
  });

  it('comment posts what was entered, an empty text included (the server decides)', async () => {
    const { api } = await openTicket(T1);
    submit('comment');
    expect((await posted(api, 'comment')).body).toEqual({ id: T1, text: '' });
  });

  it('move offers only the permitted targets and posts the chosen one', async () => {
    const { api } = await openTicket(T1);
    expect(options('#action-move-status')).toEqual(['implementing', 'blocked']);
    expect(el<HTMLSelectElement>('#action-move-status').value).toBe('implementing');
    setValue('#action-move-status', 'blocked');
    submit('move');
    expect((await posted(api, 'move')).body).toEqual({ id: T1, status: 'blocked' });
  });

  it('move posts the first target when none is chosen', async () => {
    const { api } = await openTicket(T1);
    submit('move');
    expect((await posted(api, 'move')).body).toEqual({ id: T1, status: 'implementing' });
  });

  it.each<[string, string, Status[]]>([
    ['todo', T4, ['tests', 'blocked']],
    ['review', T5, ['tests', 'implementing', 'merged', 'blocked']],
    ['blocked (only back to its remembered status)', T2, ['tests']],
  ])('move from %s offers the permitted targets', async (_label, id, expected) => {
    await openTicket(id);
    expect(options('#action-move-status')).toEqual(expected);
    expect(control('move').querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('move from merged offers nothing and cannot be submitted', async () => {
    const { api } = await openTicket(T3);
    expect(options('#action-move-status')).toEqual([]);
    const button = control('move').querySelector('button[type="submit"]');
    expect((button as HTMLButtonElement | null)?.disabled).toBe(true);
    submit('move');
    await settle();
    expect(api.actionsOf('move')).toEqual([]);
  });

  it('claim and release post the id', async () => {
    const { api } = await openTicket(T1);
    press('claim', 'Claim');
    expect((await posted(api, 'claim')).body).toEqual({ id: T1 });
    press('release', 'Release');
    expect((await posted(api, 'release')).body).toEqual({ id: T1 });
  });

  it('hand-off posts the recipient, the status and the note', async () => {
    const { api } = await openTicket(T1);
    expect(options('#action-handoff-status')).toEqual(['tests', 'implementing', 'blocked']);
    expect(el<HTMLSelectElement>('#action-handoff-status').value).toBe('tests');
    setValue('#action-handoff-to', 'impl-2');
    setValue('#action-handoff-status', 'implementing');
    setValue('#action-handoff-note', 'tests are red');
    submit('handoff');
    expect((await posted(api, 'handoff')).body).toEqual({
      id: T1,
      to: 'impl-2',
      status: 'implementing',
      note: 'tests are red',
    });
  });

  it('hand-off to the current status (a reassignment) posts that status', async () => {
    const { api } = await openTicket(T3);
    expect(options('#action-handoff-status')).toEqual(['merged']);
    setValue('#action-handoff-to', 'impl-2');
    setValue('#action-handoff-note', 'yours now');
    submit('handoff');
    expect((await posted(api, 'handoff')).body).toEqual({
      id: T3,
      to: 'impl-2',
      status: 'merged',
      note: 'yours now',
    });
  });

  it('the checklist shows a checkbox per line with its state', async () => {
    await openTicket(T1);
    const boxes = all(detail(), 'ul.checklist li input[type="checkbox"]') as HTMLInputElement[];
    expect(boxes.map((b) => b.getAttribute('data-index'))).toEqual(['0', '1']);
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    const lines = all(detail(), 'ul.checklist li');
    expect(lines.map((li) => li.textContent?.trim())).toEqual(['schema', 'migration']);
    expect(lines.map((li) => li.classList.contains('done'))).toEqual([true, false]);
  });

  it('checking a line posts checklist-tick and unchecking one posts checklist-untick', async () => {
    const { api } = await openTicket(T1);
    click(el('ul.checklist input[data-index="1"]'));
    expect((await posted(api, 'checklist-tick')).body).toEqual({ id: T1, index: 1 });
    click(el('ul.checklist input[data-index="0"]'));
    expect((await posted(api, 'checklist-untick')).body).toEqual({ id: T1, index: 0 });
    expect(api.actionsOf('checklist-tick')).toHaveLength(1);
  });

  it.each<[string, string, Record<string, string>]>([
    ['task', 'openspec:add-board-web-actions#2', { task: 'openspec:add-board-web-actions#2' }],
    ['pr', '42', { pr: '42' }],
    ['decision', 'docs/adr/0006.md', { decision: 'docs/adr/0006.md' }],
  ])('link to a %s posts exactly that property', async (kind, value, expected) => {
    const { api } = await openTicket(T1);
    expect(options('#action-link-kind')).toEqual(['task', 'pr', 'decision']);
    expect(all(el('#action-link-kind'), 'option').map((o) => o.textContent?.trim())).toEqual([
      'task reference',
      'pull request',
      'decision path',
    ]);
    setValue('#action-link-kind', kind);
    setValue('#action-link-value', value);
    submit('link');
    expect((await posted(api, 'link')).body).toEqual({ id: T1, ...expected });
  });

  it('link posts a task reference by default', async () => {
    const { api } = await openTicket(T1);
    setValue('#action-link-value', 'openspec:x#1');
    submit('link');
    expect((await posted(api, 'link')).body).toEqual({ id: T1, task: 'openspec:x#1' });
  });

  it('close posts the decision path when that disposition is chosen', async () => {
    const { api } = await openTicket(T3);
    expect(el<HTMLInputElement>('#action-close-decision').checked).toBe(true);
    expect(el<HTMLInputElement>('#action-close-none').checked).toBe(false);
    expect(el<HTMLInputElement>('#action-close-decision').name).toBe('disposition');
    expect(el<HTMLInputElement>('#action-close-none').name).toBe('disposition');
    setValue('#action-close-path', 'docs/adr/0006-web.md');
    submit('close');
    expect((await posted(api, 'close')).body).toEqual({
      id: T3,
      'decision-recorded-in': 'docs/adr/0006-web.md',
    });
  });

  it('close with no decision posts exactly that disposition, not a typed path', async () => {
    const { api } = await openTicket(T3);
    setValue('#action-close-path', 'docs/adr/0006-web.md');
    click(el('#action-close-none'));
    submit('close');
    expect((await posted(api, 'close')).body).toEqual({ id: T3, 'no-decision': true });
  });

  it('close switched back to a decision posts the path only', async () => {
    const { api } = await openTicket(T3);
    click(el('#action-close-none'));
    click(el('#action-close-decision'));
    setValue('#action-close-path', 'docs/x.md');
    submit('close');
    expect((await posted(api, 'close')).body).toEqual({
      id: T3,
      'decision-recorded-in': 'docs/x.md',
    });
  });
});

describe('the bearer header on every action request', () => {
  it('sends every action as a same-origin JSON POST with the bearer header and nothing else', async () => {
    const { api } = await openTicket(T1);
    setValue('#action-comment-text', 'hi');
    submit('comment');
    await posted(api, 'comment');
    submit('move');
    await posted(api, 'move');
    press('claim', 'Claim');
    await posted(api, 'claim');
    press('release', 'Release');
    await posted(api, 'release');
    setValue('#action-handoff-to', 'impl-2');
    setValue('#action-handoff-note', 'n');
    submit('handoff');
    await posted(api, 'handoff');
    click(el('ul.checklist input[data-index="1"]'));
    await posted(api, 'checklist-tick');
    click(el('ul.checklist input[data-index="0"]'));
    await posted(api, 'checklist-untick');
    setValue('#action-link-value', 'openspec:x#1');
    submit('link');
    await posted(api, 'link');
    submit('close');
    await posted(api, 'close');

    expect(api.actions.map((a) => a.action)).toEqual([
      'comment',
      'move',
      'claim',
      'release',
      'handoff',
      'checklist-tick',
      'checklist-untick',
      'link',
      'close',
    ]);
    for (const request of api.actions) {
      expect(request.url, request.action).toBe(`/api/actions/${request.action}`);
      expect(request.url).not.toContain(TOKEN);
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(request.headers.get('cookie')).toBeNull();
      expect([...request.headers.keys()].map((k) => k.toLowerCase()).sort()).toEqual([
        'accept',
        'authorization',
        'content-type',
      ]);
      expect(Object.keys(request.init ?? {}).sort()).toEqual(['body', 'headers', 'method']);
      const body = request.body as Record<string, unknown>;
      expect(typeof body).toBe('object');
      for (const refused of ['as', 'json', 'allow-secret-like']) {
        expect(Object.hasOwn(body, refused), `${request.action} ${refused}`).toBe(false);
      }
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    }
  });
});

describe('refusals (scenario "Refusal shown with its hint")', () => {
  const MESSAGE = `ticket ${T3} has an open decision: "DECISION: keep the cache"`;
  const HINT = `agentboard close ${T3} --as ben --decision-recorded-in <path>`;

  it('shows the unpromoted-decision message and hint beside the close form, keeping its values', async () => {
    const { api } = await openTicket(T3);
    api.onAction = () => ({
      status: 400,
      body: errorDoc('unpromoted-decision', MESSAGE, HINT),
    });
    setValue('#action-close-path', 'docs/adr/typed.md');
    click(el('#action-close-none'));
    submit('close');
    await posted(api, 'close');
    await waitFor(() => {
      expect(refusal('close')).not.toBeNull();
    });
    const shown = refusal('close');
    expect(shown?.querySelector('.refusal-message')?.textContent).toBe(MESSAGE);
    expect(shown?.querySelector('.refusal-hint')?.textContent).toBe(HINT);
    expect(shown?.querySelector('button.retry')).toBeNull();
    // The form keeps its values.
    expect(el<HTMLInputElement>('#action-close-none').checked).toBe(true);
    expect(el<HTMLInputElement>('#action-close-decision').checked).toBe(false);
    expect(el<HTMLInputElement>('#action-close-path').value).toBe('docs/adr/typed.md');
    // Only beside that control; the ticket is unchanged.
    for (const name of WRITE_CONTROLS.filter((n) => n !== 'close')) {
      expect(refusal(name), name).toBeNull();
    }
    expect(detail().querySelector('.disposition')).toBeNull();
  });

  it('keeps the comment text on a refusal and shows no hint element for a null hint', async () => {
    const { api } = await openTicket(T1);
    api.onAction = () => ({
      status: 400,
      body: errorDoc('secret-like', 'the text looks like a secret (pem-private-key)'),
    });
    setValue('#action-comment-text', 'my draft');
    submit('comment');
    await waitFor(() => {
      expect(refusal('comment')).not.toBeNull();
    });
    expect(refusal('comment')?.querySelector('.refusal-message')?.textContent).toBe(
      'the text looks like a secret (pem-private-key)',
    );
    expect(refusal('comment')?.querySelector('.refusal-hint')).toBeNull();
    expect(el<HTMLTextAreaElement>('#action-comment-text').value).toBe('my draft');
  });

  it('keeps the hand-off inputs on a refusal', async () => {
    const { api } = await openTicket(T1);
    api.onAction = () => ({
      status: 409,
      body: errorDoc(
        'invalid-transition',
        'cannot move from tests to blocked',
        'agentboard show x',
      ),
    });
    setValue('#action-handoff-to', 'impl-2');
    setValue('#action-handoff-status', 'blocked');
    setValue('#action-handoff-note', 'my note');
    submit('handoff');
    await waitFor(() => {
      expect(refusal('handoff')).not.toBeNull();
    });
    expect(el<HTMLInputElement>('#action-handoff-to').value).toBe('impl-2');
    expect(el<HTMLSelectElement>('#action-handoff-status').value).toBe('blocked');
    expect(el<HTMLTextAreaElement>('#action-handoff-note').value).toBe('my note');
  });

  it('shows a claim refused already-assigned with the hint the server rendered', async () => {
    const { api } = await openTicket(T1);
    api.onAction = () => ({
      status: 409,
      body: {
        error: {
          exitCode: 4,
          reason: 'already-assigned',
          message: `ticket ${T1} is assigned to impl-1`,
          hint: 'agentboard inbox --as ben',
        },
      },
    });
    press('claim', 'Claim');
    await waitFor(() => {
      expect(refusal('claim')).not.toBeNull();
    });
    expect(refusal('claim')?.textContent).toContain('impl-1');
    expect(refusal('claim')?.querySelector('.refusal-hint')?.textContent).toBe(
      'agentboard inbox --as ben',
    );
    expect(field('Assignee')).toBe('none');
  });

  it('shows a refusal whose body is not an error document', async () => {
    const { api } = await openTicket(T1);
    api.onAction = () => ({ status: 500, body: 'oops' });
    press('release', 'Release');
    await waitFor(() => {
      expect(refusal('release')).not.toBeNull();
    });
    expect(refusal('release')?.querySelector('.refusal-message')?.textContent).not.toBe('');
  });

  it('shows a checklist refusal beside the checklist and keeps the box as the ticket says', async () => {
    const { api } = await openTicket(T1);
    api.onAction = () => ({
      status: 409,
      body: errorDoc('checklist-index', 'no checklist line 1', null),
    });
    click(el('ul.checklist input[data-index="1"]'));
    await waitFor(() => {
      expect(refusal('checklist')).not.toBeNull();
    });
    expect(el<HTMLInputElement>('ul.checklist input[data-index="1"]').checked).toBe(false);
  });

  it('removes the refusal on the next submission of that control', async () => {
    const { api } = await openTicket(T1);
    let refuse = true;
    api.onAction = (request) =>
      refuse
        ? { status: 400, body: errorDoc('usage', 'bad') }
        : { status: 200, body: { hash: HASH, ticket: ticketOf(api.board, idOf(request)) } };
    setValue('#action-comment-text', 'x');
    submit('comment');
    await waitFor(() => {
      expect(refusal('comment')).not.toBeNull();
    });
    refuse = false;
    submit('comment');
    await posted(api, 'comment', 2);
    await waitFor(() => {
      expect(refusal('comment')).toBeNull();
    });
  });
});

describe('busy', () => {
  const BUSY = errorDoc('busy', 'the board is busy', 'retry in a moment');

  it('offers a retry that posts the same body again and applies its success', async () => {
    const { api } = await openTicket(T1);
    const claimed = after(T1, E.claim(T1, { actor: 'ben', wall: WALL + 500 }));
    let calls = 0;
    api.onAction = () => {
      calls += 1;
      return calls === 1
        ? { status: 503, body: BUSY }
        : { status: 200, body: { hash: HASH, ticket: claimed } };
    };
    press('claim', 'Claim');
    await waitFor(() => {
      expect(control('claim').querySelector('.refusal[role="alert"] button.retry')).not.toBeNull();
    });
    const retry = refusal('claim')?.querySelector('button.retry') as HTMLButtonElement;
    expect(retry.textContent?.trim()).toBe('Retry');
    expect(retry.getAttribute('type')).toBe('button');
    expect(refusal('claim')?.querySelector('.refusal-message')?.textContent).toBe(
      'the board is busy',
    );
    expect(refusal('claim')?.querySelector('.refusal-hint')?.textContent).toBe('retry in a moment');
    click(retry);
    const again = await posted(api, 'claim', 2);
    expect(again.body).toEqual({ id: T1 });
    await waitFor(() => {
      expect(field('Assignee')).toBe('ben');
    });
    expect(refusal('claim')).toBeNull();
  });

  it('retries with the body as first submitted, not the current input', async () => {
    const { api } = await openTicket(T1);
    api.onAction = () => ({ status: 503, body: BUSY });
    setValue('#action-comment-text', 'first');
    submit('comment');
    await waitFor(() => {
      expect(
        control('comment').querySelector('.refusal[role="alert"] button.retry'),
      ).not.toBeNull();
    });
    expect(el<HTMLTextAreaElement>('#action-comment-text').value).toBe('first');
    setValue('#action-comment-text', 'second');
    click(refusal('comment')?.querySelector('button.retry') as HTMLButtonElement);
    const again = await posted(api, 'comment', 2);
    expect(again.body).toEqual({ id: T1, text: 'first' });
  });
});

describe('success', () => {
  it('applies a claim at once, without the stream and without reloading the detail', async () => {
    const { api } = await openTicket(T1);
    const claimed = after(T1, E.claim(T1, { actor: 'ben', wall: WALL + 500 }));
    api.onAction = () => ({ status: 200, body: { hash: HASH, ticket: claimed } });
    expect(field('Assignee')).toBe('none');
    press('claim', 'Claim');
    await waitFor(() => {
      expect(field('Assignee')).toBe('ben');
    });
    // The fake board is unchanged and no feed message was sent: the ticket
    // shown is the one the action returned.
    expect(api.count(`/api/tickets/${T1}`)).toBe(1);
    // Once everything set in motion has run, the page still shows it and
    // has not fetched the detail again.
    await settle();
    expect(field('Assignee')).toBe('ben');
    expect(api.count(`/api/tickets/${T1}`)).toBe(1);
  });

  it('applies a move, a link and a close from their documents', async () => {
    const { api } = await openTicket(T1);
    const moved = after(T1, E.move(T1, 'blocked', { actor: 'ben', wall: WALL + 500 }));
    api.onAction = () => ({ status: 200, body: { hash: HASH, ticket: moved } });
    setValue('#action-move-status', 'blocked');
    submit('move');
    await waitFor(() => {
      expect(field('Status')).toBe('blocked');
    });
    expect(field('Blocked from')).toBe('tests');
    // The move targets follow the applied ticket.
    await waitFor(() => {
      expect(options('#action-move-status')).toEqual(['tests']);
    });

    const linked = after(
      T1,
      E.move(T1, 'blocked', { actor: 'ben', wall: WALL + 500 }),
      E.link(T1, { pr: 42 }, { actor: 'ben', wall: WALL + 510 }),
    );
    api.onAction = () => ({ status: 200, body: { hash: HASH, ticket: linked } });
    setValue('#action-link-kind', 'pr');
    setValue('#action-link-value', '42');
    submit('link');
    await waitFor(() => {
      expect(all(detail(), 'ul.links li').map((li) => li.textContent?.trim())).toEqual(['pr 42']);
    });
    expect(el<HTMLInputElement>('#action-link-value').value).toBe('');

    const closed = after(
      T1,
      E.move(T1, 'blocked', { actor: 'ben', wall: WALL + 500 }),
      E.link(T1, { pr: 42 }, { actor: 'ben', wall: WALL + 510 }),
      E.close(T1, { noDecision: true }, { actor: 'ben', wall: WALL + 520 }),
    );
    api.onAction = () => ({ status: 200, body: { hash: HASH, ticket: closed } });
    click(el('#action-close-none'));
    submit('close');
    await waitFor(() => {
      expect(detail().querySelector('.disposition')?.textContent).toContain('closed (no decision)');
    });
    expect(api.count(`/api/tickets/${T1}`)).toBe(1);
  });

  it('applies a tick at once and shows its tasks-file reminder', async () => {
    const { api } = await openTicket(T1);
    const ticked = after(T1, E.check(T1, 1, true, { actor: 'ben', wall: WALL + 500 }));
    const reminder = 'Remember to tick task 1 in openspec/changes/add-board-web/tasks.md';
    api.onAction = () => ({
      status: 200,
      body: { hash: HASH, ticket: ticked, reminder: { message: reminder } },
    });
    click(el('ul.checklist input[data-index="1"]'));
    await waitFor(() => {
      expect(all(detail(), 'ul.checklist li').map((li) => li.classList.contains('done'))).toEqual([
        true,
        true,
      ]);
    });
    expect(el<HTMLInputElement>('ul.checklist input[data-index="1"]').checked).toBe(true);
    expect(control('checklist').querySelector('.action-note')?.textContent).toBe(reminder);
  });

  it('empties the comment box after a successful comment', async () => {
    const { api } = await openTicket(T1);
    setValue('#action-comment-text', 'done here');
    submit('comment');
    await posted(api, 'comment');
    await waitFor(() => {
      expect(el<HTMLTextAreaElement>('#action-comment-text').value).toBe('');
    });
    expect(refusal('comment')).toBeNull();
  });

  it('empties the recipient and the note after a successful hand-off', async () => {
    const { api } = await openTicket(T1);
    setValue('#action-handoff-to', 'impl-2');
    setValue('#action-handoff-note', 'over to you');
    submit('handoff');
    await posted(api, 'handoff');
    await waitFor(() => {
      expect(el<HTMLInputElement>('#action-handoff-to').value).toBe('');
    });
    expect(el<HTMLTextAreaElement>('#action-handoff-note').value).toBe('');
  });

  it('disables a control while its request is in flight', async () => {
    const { api } = await openTicket(T1);
    const answer = deferred<{ status: number; body: unknown }>();
    api.onAction = () => answer.promise;
    const button = (): HTMLButtonElement =>
      control('claim').querySelector('button') as HTMLButtonElement;
    press('claim', 'Claim');
    await posted(api, 'claim');
    await waitFor(() => {
      expect(button().disabled).toBe(true);
    });
    answer.resolve({ status: 200, body: { hash: HASH, ticket: after(T1) } });
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
  });

  it('keeps what the user entered when the stream reloads the detail', async () => {
    const events = inputs();
    const { api, snapshot } = await openTicket(T1, WRITABLE, events);
    setValue('#action-comment-text', 'half written');
    setValue('#action-handoff-to', 'impl-3');
    const extra = E.comment(T1, 'someone else', { actor: 'impl-1', wall: WALL + 900 });
    const next = withDigest(model([...events, extra]), '2');
    api.board = next;
    (await streamOf(api)).append(appendOf(next, snapshot.events.length));
    await waitFor(() => {
      expect(detail().querySelector(`li.message[data-hash="${extra.hash}"]`)).not.toBeNull();
    });
    expect(el<HTMLTextAreaElement>('#action-comment-text').value).toBe('half written');
    expect(el<HTMLInputElement>('#action-handoff-to').value).toBe('impl-3');
  });
});

describe('checklist requests per line', () => {
  interface Answer {
    status: number;
    body: unknown;
  }

  /** The checkbox of line `index`. */
  function box(index: number): HTMLInputElement {
    return el<HTMLInputElement>(`ul.checklist input[data-index="${String(index)}"]`);
  }

  /** The `index` of a checklist request's body. */
  function indexOf(request: FakeAction): number {
    const body = request.body as { index?: unknown } | undefined;
    return typeof body?.index === 'number' ? body.index : -1;
  }

  /** Every checklist request made so far, tick or untick. */
  function checklistRequests(api: FakeApi): FakeAction[] {
    return [...api.actionsOf('checklist-tick'), ...api.actionsOf('checklist-untick')];
  }

  it('posts one request for a line clicked twice while its request is pending, and disables its box until the answer', async () => {
    const { api } = await openTicket(T1);
    const answer = deferred<Answer>();
    api.onAction = () => answer.promise;
    click(box(1));
    await posted(api, 'checklist-tick');
    await waitFor(() => {
      expect(box(1).disabled).toBe(true);
    });
    click(box(1));
    await settle();
    expect(checklistRequests(api)).toHaveLength(1);
    const ticked = after(T1, E.check(T1, 1, true, { actor: 'ben', wall: WALL + 500 }));
    answer.resolve({ status: 200, body: { hash: HASH, ticket: ticked } });
    await waitFor(() => {
      expect(box(1).disabled).toBe(false);
    });
    await settle();
    expect(checklistRequests(api)).toHaveLength(1);
    expect(box(1).checked).toBe(true);
  });

  it('keeps another line usable while one line is pending', async () => {
    const { api } = await openTicket(T1);
    const first = deferred<Answer>();
    api.onAction = (request) =>
      indexOf(request) === 1
        ? first.promise
        : { status: 200, body: { hash: HASH, ticket: ticketOf(api.board, idOf(request)) } };
    click(box(1));
    await posted(api, 'checklist-tick');
    await waitFor(() => {
      expect(box(1).disabled).toBe(true);
    });
    expect(box(0).disabled).toBe(false);
    click(box(0));
    expect((await posted(api, 'checklist-untick')).body).toEqual({ id: T1, index: 0 });
    expect(box(1).disabled).toBe(true);
    first.resolve({ status: 200, body: { hash: HASH, ticket: after(T1) } });
    await waitFor(() => {
      expect(box(1).disabled).toBe(false);
    });
  });

  it("keeps one line's refusal when another line's request resolves", async () => {
    const { api } = await openTicket(T1);
    const second = deferred<Answer>();
    api.onAction = (request) =>
      indexOf(request) === 1
        ? { status: 409, body: errorDoc('checklist-index', 'no checklist line 1', null) }
        : second.promise;
    click(box(1));
    await waitFor(() => {
      expect(refusal('checklist')).not.toBeNull();
    });
    click(box(0));
    await posted(api, 'checklist-untick');
    await settle();
    expect(refusal('checklist')?.querySelector('.refusal-message')?.textContent).toBe(
      'no checklist line 1',
    );
    const unticked = after(T1, E.check(T1, 0, false, { actor: 'ben', wall: WALL + 500 }));
    second.resolve({ status: 200, body: { hash: HASH, ticket: unticked } });
    await waitFor(() => {
      expect(box(0).checked).toBe(false);
    });
    await settle();
    expect(refusal('checklist')?.querySelector('.refusal-message')?.textContent).toBe(
      'no checklist line 1',
    );
  });

  it("keeps one line's reminder when another line's request resolves", async () => {
    const { api } = await openTicket(T1);
    const reminder = 'Remember to tick task 1 in openspec/changes/add-board-web/tasks.md';
    const ticked = after(T1, E.check(T1, 1, true, { actor: 'ben', wall: WALL + 500 }));
    const second = deferred<Answer>();
    api.onAction = (request) =>
      indexOf(request) === 1
        ? { status: 200, body: { hash: HASH, ticket: ticked, reminder: { message: reminder } } }
        : second.promise;
    click(box(1));
    await waitFor(() => {
      expect(control('checklist').querySelector('.action-note')?.textContent).toBe(reminder);
    });
    click(box(0));
    await posted(api, 'checklist-untick');
    await settle();
    expect(control('checklist').querySelector('.action-note')?.textContent).toBe(reminder);
    const both = after(
      T1,
      E.check(T1, 1, true, { actor: 'ben', wall: WALL + 500 }),
      E.check(T1, 0, false, { actor: 'ben', wall: WALL + 501 }),
    );
    second.resolve({ status: 200, body: { hash: HASH, ticket: both, reminder: null } });
    await waitFor(() => {
      expect(box(0).checked).toBe(false);
    });
    await settle();
    expect(control('checklist').querySelector('.action-note')?.textContent).toBe(reminder);
  });

  it('makes a refused line usable again, and a new click posts again', async () => {
    const { api } = await openTicket(T1);
    const answer = deferred<Answer>();
    api.onAction = () => answer.promise;
    click(box(1));
    await posted(api, 'checklist-tick');
    await waitFor(() => {
      expect(box(1).disabled).toBe(true);
    });
    answer.resolve({ status: 409, body: errorDoc('checklist-index', 'no checklist line 1', null) });
    await waitFor(() => {
      expect(refusal('checklist')).not.toBeNull();
    });
    expect(box(1).disabled).toBe(false);
    expect(box(1).checked).toBe(false);
    api.onAction = (request) => ({
      status: 200,
      body: { hash: HASH, ticket: ticketOf(api.board, idOf(request)) },
    });
    click(box(1));
    await posted(api, 'checklist-tick', 2);
    expect(api.actionsOf('checklist-tick').map((a) => a.body)).toEqual([
      { id: T1, index: 1 },
      { id: T1, index: 1 },
    ]);
  });
});

describe('401 from an action', () => {
  it('discards the token and shows how to open the board', async () => {
    setHash(`#/ticket/${T1}`);
    const snapshot = withDigest(model(inputs()), '1');
    const api = new FakeApi(snapshot);
    api.session = WRITABLE;
    api.onAction = () => ({
      status: 401,
      body: errorDoc('unauthorized', 'missing or invalid access token'),
    });
    const onUnauthorized = vi.fn();
    render(
      <App
        token={TOKEN}
        deps={fakeDeps(api, new FakeClock(NOW))}
        onUnauthorized={onUnauthorized}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector('article.ticket [data-action="claim"]')).not.toBeNull();
    });
    const stream = await streamOf(api);
    press('claim', 'Claim');
    await waitFor(() => {
      expect(document.querySelector('.no-token[role="alert"]')).not.toBeNull();
    });
    expect(document.querySelector('.no-token')?.textContent).toContain(
      'Open the URL printed by agentboard serve',
    );
    expect(document.querySelector('article.ticket')).toBeNull();
    // The client is stopped: its stream is closed.
    await waitFor(() => {
      expect(stream.aborted).toBe(true);
    });
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalled();
    });
    // Reported once only, once everything set in motion has run.
    await settle();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(api.actionsOf('claim')).toHaveLength(1);
  });
});

describe('moveTargets and handoffStatuses', () => {
  /** A ticket in `status` (blocked from `from` when blocked). */
  function ticketIn(status: Status, from: Status | null = null): Ticket {
    return { ...after(T4), status, blockedFrom: status === 'blocked' ? from : null };
  }

  it('lists exactly the statuses isTransitionAllowed permits, in STATUSES order', () => {
    for (const status of STATUSES) {
      const origins: (Status | null)[] =
        status === 'blocked' ? ['todo', 'tests', 'implementing', 'review'] : [null];
      for (const origin of origins) {
        const ticket = ticketIn(status, origin);
        const expected = STATUSES.filter((to) => isTransitionAllowed(status, to, origin));
        expect(moveTargets(ticket), `${status} ${String(origin)}`).toEqual(expected);
      }
    }
  });

  it('pins the state machine for the common cases', () => {
    expect(moveTargets(ticketIn('todo'))).toEqual(['tests', 'blocked']);
    expect(moveTargets(ticketIn('implementing'))).toEqual(['review', 'blocked']);
    expect(moveTargets(ticketIn('merged'))).toEqual([]);
    expect(moveTargets(ticketIn('blocked', 'review'))).toEqual(['review']);
  });

  it('puts the current status first for a hand-off, then the move targets', () => {
    expect(handoffStatuses(ticketIn('tests'))).toEqual(['tests', 'implementing', 'blocked']);
    expect(handoffStatuses(ticketIn('merged'))).toEqual(['merged']);
    expect(handoffStatuses(ticketIn('blocked', 'implementing'))).toEqual([
      'blocked',
      'implementing',
    ]);
  });
});

/*
 * The scope disposition (board-web-actions: "Action controls in the web
 * app", scenario "Merge an ad hoc ticket from the browser"; ADR 0013): the
 * move control asks for it when `merged` is chosen for an undisposed ticket,
 * the close form asks for it for an undisposed ticket, the body carries
 * `task` or `unplanned`, a refusal keeps the entries, and a disposed ticket
 * is never asked.
 */

/** Ad hoc (`found in prod`), in review, no disposition. */
const ADHOC_REVIEW = '01G0000000ACTAV9WEVGEMMVRZ';
/** Ad hoc (`spike`), blocked from tests, no disposition. */
const ADHOC_BLOCKED = '01H0000000ACTAV9WEVGEMMVRZ';
/** Ad hoc, blocked from tests, with the unplanned disposition `parked`. */
const UNPLANNED_BLOCKED = '01J0000000ACTAV9WEVGEMMVRZ';

/** The fixture plus the three ad hoc tickets above. */
function scopeInputs(): ReturnType<typeof E.create>[] {
  return [
    ...inputs(),
    E.create(ADHOC_REVIEW, { title: 'Hotfix one', adhoc: 'found in prod' }, { actor: 'orch', wall: WALL + 60 }),
    E.move(ADHOC_REVIEW, 'tests', { actor: 'impl-1', wall: WALL + 61 }),
    E.move(ADHOC_REVIEW, 'implementing', { actor: 'impl-1', wall: WALL + 62 }),
    E.move(ADHOC_REVIEW, 'review', { actor: 'impl-1', wall: WALL + 63 }),
    E.create(ADHOC_BLOCKED, { title: 'Spike', adhoc: 'spike' }, { actor: 'orch', wall: WALL + 70 }),
    E.move(ADHOC_BLOCKED, 'tests', { actor: 'orch', wall: WALL + 71 }),
    E.move(ADHOC_BLOCKED, 'blocked', { actor: 'orch', wall: WALL + 72 }),
    E.create(UNPLANNED_BLOCKED, { title: 'Parked', adhoc: 'spike' }, { actor: 'orch', wall: WALL + 80 }),
    E.move(UNPLANNED_BLOCKED, 'tests', { actor: 'orch', wall: WALL + 81 }),
    E.move(UNPLANNED_BLOCKED, 'blocked', { actor: 'orch', wall: WALL + 82 }),
    E.unplanned(UNPLANNED_BLOCKED, 'parked', { actor: 'orch', wall: WALL + 83 }),
  ];
}

/** The ticket `id` after `extra` events are folded on top of the scope fixture. */
function afterScope(id: string, ...extra: ReturnType<typeof E.create>[]): Ticket {
  return ticketOf(model([...scopeInputs(), ...extra]), id);
}

/** The scope `select` and value `input` of the control `name`, or null for each when absent. */
function scopeFields(name: 'move' | 'close'): {
  scope: HTMLSelectElement | null;
  value: HTMLInputElement | null;
} {
  return {
    scope: control(name).querySelector<HTMLSelectElement>(`#action-${name}-scope`),
    value: control(name).querySelector<HTMLInputElement>(`#action-${name}-scope-value`),
  };
}

/** The label text of the element `id`, or null. */
function labelOf(id: string): string | null {
  return document.querySelector(`label[for="${id}"]`)?.textContent?.trim() ?? null;
}

describe('needsScopeDisposition', () => {
  const m = model(scopeInputs());

  it('is true for a ticket with neither a task reference nor an unplanned disposition', () => {
    expect(needsScopeDisposition(ticketOf(m, ADHOC_REVIEW))).toBe(true);
    expect(needsScopeDisposition(ticketOf(m, ADHOC_BLOCKED))).toBe(true);
    const bare = model([E.create(T1, { title: 'neither' }, { wall: WALL })]);
    expect(needsScopeDisposition(ticketOf(bare, T1))).toBe(true);
  });

  it('is false for a linked ticket, a disposed one, and an ad hoc ticket linked later', () => {
    expect(needsScopeDisposition(ticketOf(m, T1))).toBe(false);
    expect(needsScopeDisposition(ticketOf(m, T3))).toBe(false);
    expect(needsScopeDisposition(ticketOf(m, UNPLANNED_BLOCKED))).toBe(false);
    const linked = model([
      E.create(T1, { title: 'x', adhoc: 'spike' }, { wall: WALL }),
      E.link(T1, { task: TASK }, { wall: WALL + 1 }),
    ]);
    expect(needsScopeDisposition(ticketOf(linked, T1))).toBe(false);
  });
});

describe('the move control and the scope disposition', () => {
  it('offers no scope field until merged is chosen, then the scope select and the value input, labelled', async () => {
    await openTicket(ADHOC_REVIEW, WRITABLE, scopeInputs());
    expect(options('#action-move-status')).toEqual(['tests', 'implementing', 'merged', 'blocked']);
    expect(el<HTMLSelectElement>('#action-move-status').value).toBe('tests');
    expect(scopeFields('move')).toEqual({ scope: null, value: null });

    setValue('#action-move-status', 'merged');
    const { scope, value } = scopeFields('move');
    expect(scope).not.toBeNull();
    expect(value).not.toBeNull();
    expect(options('#action-move-scope')).toEqual(['unplanned', 'task']);
    expect(all(el('#action-move-scope'), 'option').map((o) => o.textContent)).toEqual([
      'unplanned reason',
      'task reference',
    ]);
    expect(scope?.value).toBe('unplanned');
    expect(value?.type).toBe('text');
    expect(value?.value).toBe('');
    expect(labelOf('action-move-scope')).toBe('Scope');
    expect(labelOf('action-move-scope-value')).toBe('Value');
    expect(all(control('move'), '[style]')).toEqual([]);

    setValue('#action-move-status', 'implementing');
    expect(scopeFields('move')).toEqual({ scope: null, value: null });
  });

  it('scenario Merge an ad hoc ticket from the browser: posts status merged with the unplanned reason, and shows the merged ticket', async () => {
    const { api } = await openTicket(ADHOC_REVIEW, WRITABLE, scopeInputs());
    const merged = afterScope(
      ADHOC_REVIEW,
      E.unplanned(ADHOC_REVIEW, 'hotfix', { actor: 'ben', wall: WALL + 500 }),
      E.move(ADHOC_REVIEW, 'merged', { actor: 'ben', wall: WALL + 501 }),
    );
    api.onAction = () => ({ status: 200, body: { hash: HASH, events: [HASH, HASH], ticket: merged } });
    setValue('#action-move-status', 'merged');
    setValue('#action-move-scope-value', 'hotfix');
    submit('move');
    const request = await posted(api, 'move');
    expect(request.body).toEqual({ id: ADHOC_REVIEW, status: 'merged', unplanned: 'hotfix' });
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get('content-type')).toBe('application/json');
    await waitFor(() => {
      expect(field('Status')).toBe('merged');
    });
    expect(field('Unplanned')).toBe('hotfix (by ben)');
    expect(field('Task')).toBe('ad hoc: found in prod');
    expect(refusal('move')).toBeNull();
    // Merged offers nothing more, and the disposed ticket is never asked again.
    expect(options('#action-move-status')).toEqual([]);
    expect(scopeFields('move')).toEqual({ scope: null, value: null });
    expect(scopeFields('close')).toEqual({ scope: null, value: null });
  });

  it('posts a task reference when that scope is chosen', async () => {
    const { api } = await openTicket(ADHOC_REVIEW, WRITABLE, scopeInputs());
    setValue('#action-move-status', 'merged');
    setValue('#action-move-scope', 'task');
    setValue('#action-move-scope-value', 'openspec:add-board-web#2');
    submit('move');
    expect((await posted(api, 'move')).body).toEqual({
      id: ADHOC_REVIEW,
      status: 'merged',
      task: 'openspec:add-board-web#2',
    });
  });

  it('posts the value as entered, an empty reason included (the server decides)', async () => {
    const { api } = await openTicket(ADHOC_REVIEW, WRITABLE, scopeInputs());
    setValue('#action-move-status', 'merged');
    submit('move');
    expect((await posted(api, 'move')).body).toEqual({ id: ADHOC_REVIEW, status: 'merged', unplanned: '' });
  });

  it('posts only the status for another target, whatever was typed for merged', async () => {
    const { api } = await openTicket(ADHOC_REVIEW, WRITABLE, scopeInputs());
    setValue('#action-move-status', 'merged');
    setValue('#action-move-scope-value', 'hotfix');
    setValue('#action-move-status', 'blocked');
    submit('move');
    expect((await posted(api, 'move')).body).toEqual({ id: ADHOC_REVIEW, status: 'blocked' });
  });

  it('never asks a linked ticket, and posts only the status for its merge', async () => {
    const { api } = await openTicket(T5, WRITABLE, scopeInputs());
    setValue('#action-move-status', 'merged');
    expect(scopeFields('move')).toEqual({ scope: null, value: null });
    submit('move');
    expect((await posted(api, 'move')).body).toEqual({ id: T5, status: 'merged' });
  });

  it('keeps the chosen scope and the value beside the refusal, with its message and hint', async () => {
    const { api } = await openTicket(ADHOC_REVIEW, WRITABLE, scopeInputs());
    const MESSAGE = 'the unplanned reason looks like a secret (pem-private-key)';
    const HINT = `agentboard move ${ADHOC_REVIEW} merged --unplanned <reason> --allow-secret-like --as ben`;
    api.onAction = () => ({ status: 400, body: errorDoc('secret-like', MESSAGE, HINT) });
    setValue('#action-move-status', 'merged');
    setValue('#action-move-scope', 'task');
    setValue('#action-move-scope-value', 'typed value');
    submit('move');
    await posted(api, 'move');
    await waitFor(() => {
      expect(refusal('move')).not.toBeNull();
    });
    expect(refusal('move')?.querySelector('.refusal-message')?.textContent).toBe(MESSAGE);
    expect(refusal('move')?.querySelector('.refusal-hint')?.textContent).toBe(HINT);
    expect(el<HTMLSelectElement>('#action-move-status').value).toBe('merged');
    expect(el<HTMLSelectElement>('#action-move-scope').value).toBe('task');
    expect(el<HTMLInputElement>('#action-move-scope-value').value).toBe('typed value');
    expect(field('Status')).toBe('review');
    for (const name of WRITE_CONTROLS.filter((n) => n !== 'move')) {
      expect(refusal(name), name).toBeNull();
    }
  });

  it('shows the needs-scope-disposition refusal of a stale page beside the move control', async () => {
    const { api } = await openTicket(ADHOC_REVIEW, WRITABLE, scopeInputs());
    const HINT = `agentboard move ${ADHOC_REVIEW} merged --unplanned "<reason>" --as ben`;
    api.onAction = () => ({
      status: 409,
      body: { error: { exitCode: 4, reason: 'needs-scope-disposition', message: 'no disposition', hint: HINT } },
    });
    setValue('#action-move-status', 'merged');
    setValue('#action-move-scope-value', 'hotfix');
    submit('move');
    await posted(api, 'move');
    await waitFor(() => {
      expect(refusal('move')?.querySelector('.refusal-hint')?.textContent).toBe(HINT);
    });
    expect(el<HTMLInputElement>('#action-move-scope-value').value).toBe('hotfix');
  });

  it('keeps the scope entries when the stream reloads the detail', async () => {
    const { api, snapshot } = await openTicket(ADHOC_REVIEW, WRITABLE, scopeInputs());
    setValue('#action-move-status', 'merged');
    setValue('#action-move-scope-value', 'half typed');
    const extra = E.comment(ADHOC_REVIEW, 'still here', { actor: 'impl-1', wall: WALL + 900 });
    const after = withDigest(model([...scopeInputs(), extra]), '2');
    api.board = after;
    (await streamOf(api)).append(appendOf(after, snapshot.events.length));
    await waitFor(() => {
      expect(detail().querySelector(`li.message[data-hash="${extra.hash}"]`)).not.toBeNull();
    });
    expect(el<HTMLSelectElement>('#action-move-status').value).toBe('merged');
    expect(el<HTMLInputElement>('#action-move-scope-value').value).toBe('half typed');
  });
});

describe('the close form and the scope disposition', () => {
  it('asks an undisposed ticket for the scope beside the decision disposition, labelled', async () => {
    await openTicket(ADHOC_BLOCKED, WRITABLE, scopeInputs());
    const { scope, value } = scopeFields('close');
    expect(scope).not.toBeNull();
    expect(value).not.toBeNull();
    expect(options('#action-close-scope')).toEqual(['unplanned', 'task']);
    expect(all(el('#action-close-scope'), 'option').map((o) => o.textContent)).toEqual([
      'unplanned reason',
      'task reference',
    ]);
    expect(scope?.value).toBe('unplanned');
    expect(value?.type).toBe('text');
    expect(labelOf('action-close-scope')).toBe('Scope');
    expect(labelOf('action-close-scope-value')).toBe('Value');
    expect(el<HTMLInputElement>('#action-close-decision').checked).toBe(true);
    expect(all(control('close'), '[style]')).toEqual([]);
  });

  it('posts no-decision with the unplanned reason, and applies the closed ticket', async () => {
    const { api } = await openTicket(ADHOC_BLOCKED, WRITABLE, scopeInputs());
    const closed = afterScope(
      ADHOC_BLOCKED,
      E.unplanned(ADHOC_BLOCKED, 'abandoned: superseded', { actor: 'ben', wall: WALL + 500 }),
      E.close(ADHOC_BLOCKED, { noDecision: true }, { actor: 'ben', wall: WALL + 501 }),
    );
    api.onAction = () => ({ status: 200, body: { hash: HASH, events: [HASH, HASH], ticket: closed } });
    click(el('#action-close-none'));
    setValue('#action-close-scope-value', 'abandoned: superseded');
    submit('close');
    expect((await posted(api, 'close')).body).toEqual({
      id: ADHOC_BLOCKED,
      'no-decision': true,
      unplanned: 'abandoned: superseded',
    });
    await waitFor(() => {
      expect(detail().querySelector('.disposition')?.textContent).toContain('closed (no decision)');
    });
    expect(field('Unplanned')).toBe('abandoned: superseded (by ben)');
    expect(scopeFields('close')).toEqual({ scope: null, value: null });
  });

  it('posts the decision path with a task reference when that scope is chosen', async () => {
    const { api } = await openTicket(ADHOC_BLOCKED, WRITABLE, scopeInputs());
    setValue('#action-close-path', 'docs/adr/0013.md');
    setValue('#action-close-scope', 'task');
    setValue('#action-close-scope-value', 'openspec:add-board-web#2');
    submit('close');
    expect((await posted(api, 'close')).body).toEqual({
      id: ADHOC_BLOCKED,
      'decision-recorded-in': 'docs/adr/0013.md',
      task: 'openspec:add-board-web#2',
    });
  });

  it('never asks a linked ticket or a disposed one, and adds nothing to their bodies', async () => {
    const { api } = await openTicket(T2, WRITABLE, scopeInputs());
    expect(scopeFields('close')).toEqual({ scope: null, value: null });
    click(el('#action-close-none'));
    submit('close');
    expect((await posted(api, 'close')).body).toEqual({ id: T2, 'no-decision': true });
    cleanup();
    const second = await openTicket(UNPLANNED_BLOCKED, WRITABLE, scopeInputs());
    expect(field('Unplanned')).toBe('parked (by orch)');
    expect(scopeFields('close')).toEqual({ scope: null, value: null });
    click(el('#action-close-none'));
    submit('close');
    expect((await posted(second.api, 'close')).body).toEqual({
      id: UNPLANNED_BLOCKED,
      'no-decision': true,
    });
  });

  it('keeps the scope entries and the decision entries beside a refusal', async () => {
    const { api } = await openTicket(ADHOC_BLOCKED, WRITABLE, scopeInputs());
    const HINT = `agentboard close ${ADHOC_BLOCKED} --no-decision --unplanned "<reason>" --as ben`;
    api.onAction = () => ({
      status: 409,
      body: { error: { exitCode: 4, reason: 'needs-scope-disposition', message: 'no disposition', hint: HINT } },
    });
    click(el('#action-close-none'));
    setValue('#action-close-scope', 'task');
    setValue('#action-close-scope-value', 'openspec:x#1');
    submit('close');
    await posted(api, 'close');
    await waitFor(() => {
      expect(refusal('close')?.querySelector('.refusal-hint')?.textContent).toBe(HINT);
    });
    expect(el<HTMLInputElement>('#action-close-none').checked).toBe(true);
    expect(el<HTMLSelectElement>('#action-close-scope').value).toBe('task');
    expect(el<HTMLInputElement>('#action-close-scope-value').value).toBe('openspec:x#1');
    expect(detail().querySelector('.disposition')).toBeNull();
  });
});

describe('the scope fields on a read-only page', () => {
  it('shows no scope select or input for an undisposed ticket', async () => {
    await openTicket(ADHOC_REVIEW, SESSION, scopeInputs());
    expect(all(detail(), 'form, input, textarea, select, button')).toEqual([]);
    expect(document.querySelector('#action-move-scope')).toBeNull();
    expect(document.querySelector('#action-close-scope')).toBeNull();
    cleanup();
    await openTicket(ADHOC_BLOCKED, SESSION, scopeInputs());
    expect(all(detail(), 'form, input, textarea, select, button')).toEqual([]);
  });
});
