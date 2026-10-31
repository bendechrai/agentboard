/**
 * Web action refusals repeat no refused input (no-echo-refusals task 1.4;
 * board-cli "Refusals never repeat the refused input", scenario "Web
 * action"; "Ticket ids in refusals"). A writable server in process, as
 * `orch`, with its stderr captured; every refused action is checked for
 * its status, reason and message, and the response body and the server's
 * output for every token fixture in the request.
 */

import { describe, expect, it, vi } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { actionServer, eventFiles, newTicket, post, refusal } from './action-helpers.js';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const STATUS_LIST = 'todo, tests, implementing, review, merged, blocked';

const NOT_AN_ID =
  'no ticket matches the id given, which is not a ticket id: an id is 26 characters of ' +
  'Crockford base32 (digits and letters other than I, L, O and U) starting with 0, or a ' +
  'unique prefix of at least 6 of them';

async function writable(): Promise<{
  server: Awaited<ReturnType<typeof actionServer>>['server'];
  root: string;
  eventsDir: string;
  output: () => string;
}> {
  let output = '';
  const { server, root, eventsDir } = await actionServer({
    actor: 'orch',
    stderr: (text) => {
      output += text;
    },
  });
  return { server, root, eventsDir, output: () => output };
}

describe('Web action', () => {
  it('POST /api/actions/move with a token status: 400 usage listing the statuses', async () => {
    const s = await writable();
    const id = newTicket(s.root);
    const before = eventFiles(s.eventsDir);
    for (const f of TOKEN_FIXTURES) {
      const result = await post(s.server, 'move', { id, status: f.value });
      expectNoLeak(`${f.name} body`, [result.body, s.output()], [f]);
      const error = refusal(result, 400, 1, 'usage');
      expect(error.message).toBe(`move takes <status> as one of ${STATUS_LIST}`);
    }
    expect(eventFiles(s.eventsDir)).toEqual(before);
  });

  it('an id that is not an id: 409 unknown-ticket naming the id form', async () => {
    const s = await writable();
    newTicket(s.root);
    const before = eventFiles(s.eventsDir);
    for (const f of TOKEN_FIXTURES) {
      for (const [action, body] of [
        ['move', { id: f.value, status: 'review' }],
        ['comment', { id: f.value, text: 'hello' }],
        ['claim', { id: f.value }],
      ] as const) {
        const result = await post(s.server, action, body);
        expectNoLeak(`${f.name} ${action}`, [result.body, s.output()], [f]);
        expect(refusal(result, 409, 4, 'unknown-ticket').message).toBe(NOT_AN_ID);
      }
    }
    expect(eventFiles(s.eventsDir)).toEqual(before);
  });

  it('a missing decision record for an id that is not an id: the hint writes <id>', async () => {
    const s = await writable();
    newTicket(s.root);
    for (const f of TOKEN_FIXTURES) {
      const result = await post(s.server, 'close', {
        id: f.value,
        'decision-recorded-in': 'docs/adr/0099.md',
      });
      expectNoLeak(f.name, [result.body, s.output()], [f]);
      const error = refusal(result, 400, 1, 'decision-path-missing');
      expect(error.message).toBe(
        'the decision record given with --decision-recorded-in does not exist',
      );
      expect(error.hint).toContain("'agentboard close <id> --decision-recorded-in <path>");
      expect(result.body).not.toContain('0099');
    }
  });

  it('other refused values and an unknown property name repeat nothing', async () => {
    const s = await writable();
    const id = newTicket(s.root);
    const before = eventFiles(s.eventsDir);
    for (const f of TOKEN_FIXTURES) {
      const cases: readonly [string, Record<string, unknown>, number, string][] = [
        ['link', { id, decision: `../${f.value}` }, 400, 'path-outside-tree'],
        ['link', { id, task: f.value }, 400, 'malformed-task-ref'],
        ['link', { id, change: 'c', group: f.value }, 400, 'malformed-task-ref'],
        ['handoff', { id, to: 'b', status: f.value, note: 'n' }, 400, 'usage'],
        ['move', { id, status: 'review', [f.value]: true }, 400, 'usage'],
        ['checklist-tick', { id, index: f.value }, 400, 'usage'],
      ];
      for (const [action, body, status, reason] of cases) {
        const result = await post(s.server, action, body);
        expectNoLeak(`${f.name} ${action}`, [result.body, s.output()], [f]);
        refusal(result, status, status === 409 ? 4 : 1, reason);
      }
    }
    expect(eventFiles(s.eventsDir)).toEqual(before);
  });
});
