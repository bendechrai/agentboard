/**
 * The `events` key of a writing command's `--json` document
 * (add-adhoc-ticket-lifecycle task 1.3; board-cli: "Output conventions";
 * board-cache: "One command, one transaction"): every hash the command
 * wrote, in write order, with `hash` the last. Single-event commands carry
 * one entry; a retried claim that writes nothing carries none. The
 * two-event commands (`move merged --unplanned`, `close --task`) are
 * group 2's and have a placeholder below.
 */

import { describe, expect, it } from 'vitest';

import { eventNames } from '../../store/__tests__/helpers.js';
import { oneJson, project, run } from './cli-helpers.js';

const TASK = ['--task', 'openspec:add-adhoc-ticket-lifecycle#1'];

interface Written {
  hash: string | null;
  events: string[];
  ticket: { id: string; status: string };
}

function doc(out: ReturnType<typeof run>): Written {
  expect(out.code, out.stderr).toBe(0);
  return oneJson(out) as Written;
}

describe('writing commands list the events they wrote', () => {
  it('new, move, claim, comment, link and close each carry one hash, equal to hash', () => {
    const { root, boardDir } = project();
    const created = doc(run(['new', 'A ticket', ...TASK, '--as', 'orch', '--json'], root));
    expect(created.events).toEqual([created.hash]);
    const id = created.ticket.id;
    const outs = [
      run(['claim', id, '--as', 'impl', '--json'], root),
      run(['move', id, 'tests', '--as', 'impl', '--json'], root),
      run(['comment', id, 'note', '--as', 'impl', '--json'], root),
      run(['link', id, '--pr', '7', '--as', 'impl', '--json'], root),
      run(['move', id, 'implementing', '--as', 'impl', '--json'], root),
      run(['move', id, 'review', '--as', 'impl', '--json'], root),
      run(['move', id, 'merged', '--as', 'impl', '--json'], root),
      run(['close', id, '--no-decision', '--as', 'orch', '--json'], root),
    ].map(doc);
    for (const out of outs) {
      expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(out.events).toEqual([out.hash]);
    }
    const hashes = [created, ...outs].map((o) => o.hash);
    expect(eventNames(`${boardDir}/events`)).toEqual(hashes.map((h) => `${String(h)}.json`).sort());
  });

  it('a claim retried by the holder carries no events and a null hash', () => {
    const { root } = project();
    const id = doc(run(['new', 'A ticket', ...TASK, '--as', 'orch', '--json'], root)).ticket.id;
    doc(run(['claim', id, '--as', 'impl', '--json'], root));
    const again = doc(run(['claim', id, '--as', 'impl', '--json'], root));
    expect(again).toMatchObject({ hash: null, events: [] });
  });

  it('a handoff carries one hash: no assign, move or comment event is synthesized', () => {
    const { root } = project();
    const id = doc(run(['new', 'A ticket', ...TASK, '--as', 'orch', '--json'], root)).ticket.id;
    doc(run(['move', id, 'tests', '--as', 'orch', '--json'], root));
    const out = doc(
      run(
        ['handoff', id, '--to', 'impl', '--status', 'implementing', '--note', 'go', '--as', 'orch', '--json'],
        root,
      ),
    );
    expect(out.events).toEqual([out.hash]);
  });

  it.todo(
    'group 2 (board/scope-disposition): move <id> merged --unplanned "<reason>" --json carries two hashes, the ticket.unplanned then the ticket.move, with hash the second',
  );

  it.todo(
    'group 2 (board/scope-disposition): close <id> --no-decision --task <ref> --json carries the ticket.link then the ticket.close',
  );
});
