// @vitest-environment happy-dom
/**
 * The action controls of the ticket detail (board-web-actions: "Action
 * controls in the web app", scenarios "Refusal shown with its hint" and
 * "Read-only page"; design.md of add-board-web-actions: "The page";
 * add-board-web-actions task 2.1): the request body of every control, the
 * move and hand-off targets from `isTransitionAllowed`, the acting-as
 * banner, a refusal beside its control with message and hint keeping the
 * input, a success applied at once, a `busy` refusal offering a retry, a
 * 401 discarding the token, the bearer header on every action request, and
 * no write control on a read-only session.
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
import { handoffStatuses, moveTargets } from '../views/ActionControls.js';
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
