/**
 * Event parity between the browser and the CLI (board-web-actions: "Action
 * endpoints": "validation, refusals and the resulting event are identical to
 * the CLI's"; add-board-web-actions design.md: "A browser write is
 * indistinguishable from the same CLI command by the same actor").
 *
 * For each action (and each form of `link` and `close`), a board is set up
 * through the CLI, its event files are copied to a second project, the
 * action is posted to a server `--as ben` on the first board, and the same
 * command is run by the CLI `--as ben` on the copy. The one new event on
 * each side must have the same kind, ticket and actor, and a body whose
 * canonical encoding is byte for byte the same; the response must be the
 * CLI's `--json` document except for the hash and the clock readings.
 *
 * Both projects are plain directories (not git repositories), so each
 * working tree root is the project root, and a decision record exists at
 * the same relative path in both.
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run } from '../../cli/__tests__/cli-helpers.js';
import {
  actionServer,
  cliOk,
  env,
  eventFiles,
  newEvents,
  newTicket,
  post,
} from './action-helpers.js';
import { json, project } from './web-helpers.js';

/** One parity case: CLI set-up on the board, then the action body and the CLI arguments. */
interface ParityCase {
  readonly name: string;
  readonly action: string;
  /** CLI commands (without `--json`) run on the first board before copying, with `<id>`. */
  readonly setup: readonly (readonly string[])[];
  readonly body: Record<string, unknown>;
  /** The CLI command (without `--as` and `--json`), with `<id>`. */
  readonly argv: readonly string[];
}

const CASES: readonly ParityCase[] = [
  { name: 'claim', action: 'claim', setup: [], body: {}, argv: ['claim', '<id>'] },
  {
    name: 'release',
    action: 'release',
    setup: [['claim', '<id>', '--as', 'ben']],
    body: {},
    argv: ['release', '<id>'],
  },
  {
    name: 'move',
    action: 'move',
    setup: [],
    body: { status: 'tests' },
    argv: ['move', '<id>', 'tests'],
  },
  {
    name: 'move out of blocked to the remembered status',
    action: 'move',
    setup: [
      ['move', '<id>', 'tests', '--as', 'orch'],
      ['move', '<id>', 'blocked', '--as', 'orch'],
    ],
    body: {},
    argv: ['move', '<id>'],
  },
  {
    name: 'comment',
    action: 'comment',
    setup: [],
    body: { text: 'a comment from the page: 96%, "quoted", and more' },
    argv: ['comment', '<id>', 'a comment from the page: 96%, "quoted", and more'],
  },
  {
    name: 'handoff',
    action: 'handoff',
    setup: [['claim', '<id>', '--as', 'ben']],
    body: { to: 'impl-1', status: 'tests', note: 'over to you, 96%' },
    argv: ['handoff', '<id>', '--to', 'impl-1', '--status', 'tests', '--note', 'over to you, 96%'],
  },
  {
    name: 'link a pull request',
    action: 'link',
    setup: [],
    body: { pr: '42' },
    argv: ['link', '<id>', '--pr', '42'],
  },
  {
    name: 'link a pull request URL',
    action: 'link',
    setup: [],
    body: { pr: 'https://example.invalid/pr/7' },
    argv: ['link', '<id>', '--pr', 'https://example.invalid/pr/7'],
  },
  {
    name: 'link a decision',
    action: 'link',
    setup: [],
    body: { decision: 'docs/adr/0001-parity.md' },
    argv: ['link', '<id>', '--decision', 'docs/adr/0001-parity.md'],
  },
  {
    name: 'link a task by change and group',
    action: 'link',
    setup: [],
    body: { change: 'add-other', group: '2' },
    argv: ['link', '<id>', '--change', 'add-other', '--group', '2'],
  },
  {
    name: 'checklist tick',
    action: 'checklist-tick',
    setup: [],
    body: { index: 1 },
    argv: ['checklist', 'tick', '<id>', '1'],
  },
  {
    name: 'checklist untick',
    action: 'checklist-untick',
    setup: [['checklist', 'tick', '<id>', '0', '--as', 'orch']],
    body: { index: 0 },
    argv: ['checklist', 'untick', '<id>', '0'],
  },
  {
    name: 'close without a decision',
    action: 'close',
    setup: [['move', '<id>', 'blocked', '--as', 'orch']],
    body: { 'no-decision': true },
    argv: ['close', '<id>', '--no-decision'],
  },
  {
    name: 'close with a decision record',
    action: 'close',
    setup: [['move', '<id>', 'blocked', '--as', 'orch']],
    body: { 'decision-recorded-in': 'docs/adr/0001-parity.md' },
    argv: ['close', '<id>', '--decision-recorded-in', 'docs/adr/0001-parity.md'],
  },
];

/** `argv` with `<id>` replaced. */
function withId(argv: readonly string[], id: string): string[] {
  return argv.map((arg) => (arg === '<id>' ? id : arg));
}

/** Writes the decision record every project carries. */
function decisionRecord(root: string): void {
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(root, 'docs', 'adr', '0001-parity.md'), '# Parity\n');
}

/**
 * `value` with every clock reading (an object with `wall`, `counter` and
 * `actor`) reduced to its actor, and every `hash` property replaced, so
 * two documents of the same write made at different times compare equal.
 */
function timeless(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(timeless);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if ('wall' in record && 'counter' in record && 'actor' in record) {
      return { actor: record.actor };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        key === 'hash' ? '<hash>' : timeless(item),
      ]),
    );
  }
  return value;
}

describe('the event written through the server is the one the CLI writes', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s',
    async (_name, parity) => {
      // The first board, set up through the CLI, with the server on it.
      const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
      decisionRecord(root);
      const id = newTicket(root);
      for (const argv of parity.setup) {
        cliOk(root, withId(argv, id));
      }
      // The copy: the same event files in a second project.
      const copy = project();
      decisionRecord(copy.root);
      for (const name of eventFiles(eventsDir)) {
        copyFileSync(join(eventsDir, name), join(copy.eventsDir, name));
      }
      const beforeServer = eventFiles(eventsDir);
      const beforeCli = eventFiles(copy.eventsDir);
      expect(beforeCli).toEqual(beforeServer);

      const result = await post(server, parity.action, { id, ...parity.body });
      expect(result.status, result.body).toBe(200);
      const out = run([...withId(parity.argv, id), '--as', 'ben', '--json'], copy.root, env());
      expect(out.code, out.stderr).toBe(0);

      const viaServer = newEvents(eventsDir, beforeServer);
      const viaCli = newEvents(copy.eventsDir, beforeCli);
      expect(viaServer).toHaveLength(1);
      expect(viaCli).toHaveLength(1);
      const [a, b] = [viaServer[0], viaCli[0]];
      expect(a?.event.v).toBe(b?.event.v);
      expect(a?.event.kind).toBe(b?.event.kind);
      expect(a?.event.ticket).toBe(id);
      expect(b?.event.ticket).toBe(id);
      expect(a?.event.actor).toBe('ben');
      expect(b?.event.actor).toBe('ben');
      expect(a?.event.ts.actor).toBe('ben');
      expect(Object.keys(a?.event ?? {}).sort()).toEqual(Object.keys(b?.event ?? {}).sort());
      expect(a?.bodyBytes.equals(b?.bodyBytes ?? Buffer.alloc(0))).toBe(true);

      const served = json(result) as { hash: string };
      expect(served.hash).toBe(a?.hash);
      const printed = JSON.parse(out.stdout) as { hash: string };
      expect(printed.hash).toBe(b?.hash);
      expect(timeless(served)).toEqual(timeless(printed));
    },
    30_000,
  );
});
