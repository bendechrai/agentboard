// @vitest-environment happy-dom
/**
 * The description in the ticket detail view (add-description-markdown task
 * 1.2; board-web: "Description rendered as Markdown", scenarios "Structure
 * is rendered", "Task list items" and "No description"; "Description links
 * and images", scenarios "Allowed link", "Script link", "Relative link" and
 * "Image is not loaded"): a `section.description` after the fields `dl`,
 * headed by an `h3` "Description", holding the rendered Markdown, absent
 * without a description; the parse memoised on the description text; the
 * plain-text fallback when the parser throws.
 *
 * `fromMarkdown` is wrapped in a spy that calls the real parser, so the
 * tests can count the parses of each description text and make one parse
 * throw; `parseMarkdown` calls it exactly once per parse (its contract).
 */

import { act, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  E,
  FakeApi,
  FakeClock,
  SESSION,
  T1,
  T2,
  TASK,
  WRITABLE,
  all,
  appendOf,
  model,
  renderApp,
  setHash,
  streamOf,
  withDigest,
} from './client-helpers.js';

vi.mock('mdast-util-from-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mdast-util-from-markdown')>();
  return { ...actual, fromMarkdown: vi.fn(actual.fromMarkdown) };
});

const parser = vi.mocked(fromMarkdown);

const WALL = 5_000_000;
const NOW = WALL + 600_000;

const STRUCTURE = [
  '## Plan',
  '',
  '- write the tests',
  '- make them pass',
  '',
  '```sh',
  'npm test -- <filter>',
  '```',
  '',
  '| step | owner |',
  '|------|-------|',
  '| 1    | test  |',
  '| 2    | impl  |',
].join('\n');

const TASKS = '- [x] done\n- [ ] open';

const LINKS = [
  '[spec](https://example.com/spec)',
  '[click](javascript:alert(1))',
  '[api](/api/session)',
  '![diagram](https://example.com/d.png)',
].join('\n\n');

beforeEach(() => {
  setHash('');
  parser.mockClear();
});

afterEach(() => {
  cleanup();
  setHash('');
});

/** The parses so far of exactly `text`. */
function parsesOf(text: string): number {
  return parser.mock.calls.filter((call) => call[0] === text).length;
}

function detail(): Element {
  const el = document.querySelector('article.ticket');
  if (el === null) {
    throw new Error('no ticket detail');
  }
  return el;
}

/** The description section; fails the test when missing. */
function section(): Element {
  const el = detail().querySelector('section.description');
  if (el === null) {
    throw new Error('no description section');
  }
  return el;
}

/** A board of T1 (open, described by `description`) and T2 (another description, or none). */
function inputs(
  description: string | null,
  other: string | null = null,
): ReturnType<typeof E.create>[] {
  return [
    E.create(
      T1,
      description === null
        ? { title: 'Described', task: TASK }
        : { title: 'Described', task: TASK, description },
      { actor: 'orch', wall: WALL },
    ),
    E.create(T2, other === null ? { title: 'Other' } : { title: 'Other', description: other }, {
      actor: 'orch',
      wall: WALL + 5,
    }),
  ];
}

async function open(
  id: string,
  events: ReturnType<typeof E.create>[],
  session = SESSION,
): Promise<FakeApi> {
  setHash(`#/ticket/${id}`);
  const api = new FakeApi(withDigest(model(events), '1'));
  api.session = session;
  renderApp(api, new FakeClock(NOW));
  await waitFor(() => {
    expect(document.querySelector(`article.ticket[data-ticket="${id}"]`)).not.toBeNull();
  });
  return api;
}

describe('the description section', () => {
  it('follows the fields list, headed by an h3 "Description", and is not a field', async () => {
    await open(T1, inputs('Plain words'));
    const fields = detail().querySelector('dl.fields');
    expect(fields).not.toBeNull();
    expect(section().parentElement).toBe(detail());
    expect(section().previousElementSibling).toBe(fields);
    const heading = section().firstElementChild;
    expect(heading?.tagName.toLowerCase()).toBe('h3');
    expect(heading?.textContent).toBe('Description');
    expect(all(section(), 'h3')).toHaveLength(1);
    expect(all(detail(), 'dl.fields dt').map((dt) => dt.textContent?.trim())).not.toContain(
      'Description',
    );
    expect(section().querySelector('p')?.textContent).toBe('Plain words');
    expect(all(detail(), 'section.description')).toHaveLength(1);
  });

  it('shows the heading, list, code block and table (scenario "Structure is rendered")', async () => {
    await open(T1, inputs(STRUCTURE));
    const s = section();
    expect(s.querySelector('h5')?.textContent).toBe('Plan');
    expect(all(s, 'h1, h2, h4, h6')).toEqual([]);
    expect(all(s, 'h3').map((h) => h.textContent)).toEqual(['Description']);
    expect(all(s, 'ul > li').map((li) => li.textContent)).toEqual([
      'write the tests',
      'make them pass',
    ]);
    const code = s.querySelector('pre > code');
    expect(code?.textContent).toBe('npm test -- <filter>');
    expect(code?.getAttribute('data-lang')).toBe('sh');
    expect(code?.children).toHaveLength(0);
    const table = s.querySelector('table');
    expect(all(table ?? s, 'thead th').map((th) => th.textContent?.trim())).toEqual([
      'step',
      'owner',
    ]);
    expect(all(table ?? s, 'tbody tr').map((tr) => tr.children.length)).toEqual([2, 2]);
    expect(all(table ?? s, 'tbody td').map((td) => td.textContent?.trim())).toEqual([
      '1',
      'test',
      '2',
      'impl',
    ]);
  });

  it('shows a checked and an unchecked checkbox that cannot be changed (scenario "Task list items")', async () => {
    await open(T1, inputs(TASKS));
    const items = all(section(), 'li');
    expect(items.map((li) => li.textContent?.trim())).toEqual(['done', 'open']);
    const boxes = items.map((li) => li.querySelector('input'));
    expect(boxes.map((b) => b?.type)).toEqual(['checkbox', 'checkbox']);
    expect(boxes.map((b) => b?.checked)).toEqual([true, false]);
    expect(boxes.map((b) => b?.disabled)).toEqual([true, true]);
  });

  it('adds no control to a read-only page beyond the disabled description checkboxes', async () => {
    const api = await open(T1, inputs(TASKS));
    const inputsOutside = all(detail(), 'input, form, textarea, select, button').filter(
      (el) => !section().contains(el),
    );
    expect(inputsOutside).toEqual([]);
    for (const box of all(section(), 'input')) {
      expect(box instanceof HTMLInputElement && box.disabled).toBe(true);
    }
    expect(api.requests.every((r) => (r.init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('keeps the description checkboxes inert on a writable page', async () => {
    const api = await open(T1, inputs(TASKS), WRITABLE);
    const boxes = all(section(), 'input');
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box instanceof HTMLInputElement && box.disabled).toBe(true);
      expect(box.hasAttribute('data-action')).toBe(false);
      expect(box.hasAttribute('name')).toBe(false);
      expect(box.hasAttribute('id')).toBe(false);
      fireEvent.click(box);
    }
    expect(boxes.map((b) => b instanceof HTMLInputElement && b.checked)).toEqual([true, false]);
    expect(api.actions).toEqual([]);
  });

  it('links only allowed URLs and shows an image as a link (description links and images scenarios)', async () => {
    const api = await open(T1, inputs(LINKS));
    const s = section();
    const links = all(s, 'a');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['spec', 'https://example.com/spec'],
      ['diagram', 'https://example.com/d.png'],
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(links[1]?.classList.contains('image-link')).toBe(true);
    expect(s.textContent).toContain('click');
    expect(s.textContent).toContain('api');
    expect(document.querySelector('[href^="javascript:" i]')).toBeNull();
    expect(document.querySelector('[href="/api/session"]')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(api.requests.some((r) => r.url.includes('d.png'))).toBe(false);
  });
});

describe('no description (scenario "No description")', () => {
  it('shows no description section for a ticket created without one', async () => {
    await open(T1, inputs(null));
    expect(detail().querySelector('section.description')).toBeNull();
    expect(all(detail(), 'h3').map((h) => h.textContent)).not.toContain('Description');
  });

  it('shows no description section for an empty description', async () => {
    await open(T1, inputs(''));
    expect(detail().querySelector('section.description')).toBeNull();
    expect(all(detail(), 'h3').map((h) => h.textContent)).not.toContain('Description');
  });
});

describe('parsing', () => {
  it('parses the description once and not again when the view re-renders with the same text', async () => {
    const events = inputs(STRUCTURE);
    const api = await open(T1, events);
    await waitFor(() => {
      expect(section().querySelector('table')).not.toBeNull();
    });
    expect(parsesOf(STRUCTURE)).toBe(1);

    const snapshot = api.board;
    const extra = E.comment(T1, 'a new comment', { actor: 'impl-1', wall: WALL + 100 });
    const after = withDigest(model([...events, extra]), '2');
    api.board = after;
    (await streamOf(api)).append(appendOf(after, snapshot.events.length));
    await waitFor(() => {
      expect(detail().querySelector(`li.message[data-hash="${extra.hash}"]`)).not.toBeNull();
    });
    expect(api.requests.filter((r) => r.url.startsWith('/api/tickets/'))).toHaveLength(2);
    expect(section().querySelector('table')).not.toBeNull();
    expect(parsesOf(STRUCTURE)).toBe(1);
  });

  it('parses a different description text when another ticket is shown', async () => {
    const other = '# Other plan';
    await open(T1, inputs(STRUCTURE, other));
    expect(parsesOf(STRUCTURE)).toBe(1);
    expect(parsesOf(other)).toBe(0);
    act(() => {
      setHash(`#/ticket/${T2}`);
    });
    await waitFor(() => {
      expect(document.querySelector(`article.ticket[data-ticket="${T2}"]`)).not.toBeNull();
    });
    expect(section().querySelector('h4')?.textContent).toBe('Other plan');
    expect(parsesOf(other)).toBe(1);
    expect(parsesOf(STRUCTURE)).toBe(1);
  });

  it('parses nothing for a ticket without a description', async () => {
    await open(T1, inputs(null));
    expect(parser).not.toHaveBeenCalled();
  });

  it('shows the description as plain text when the parser throws', async () => {
    const text = '# Not a heading <b>x</b>';
    parser.mockImplementationOnce(() => {
      throw new Error('parser failure');
    });
    await open(T1, inputs(text));
    const s = section();
    expect(s.firstElementChild?.textContent).toBe('Description');
    expect(s.textContent).toContain(text);
    expect(all(s, '*').map((el) => el.tagName.toLowerCase())).toEqual(['h3']);
    expect(document.querySelector('b')).toBeNull();
  });
});
