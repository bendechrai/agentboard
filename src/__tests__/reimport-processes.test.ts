/**
 * Two CLI processes re-importing the same revised change at once
 * (add-claim-leases task 8.3; board-concurrency: "Re-import is idempotent",
 * scenario "Concurrent re-imports of a revised change"). Each import
 * validates its events against the caught-up state inside its own
 * transaction, so the second finds nothing left to change: every ticket
 * gets exactly one applied reconcile, the inserted group exactly one
 * ticket, every moved ticket exactly one applied renumber, and `rebuild
 * --check` reports no divergence. Checked against an independent fold of
 * the event files built on the events layer only.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BoardEvent } from '../events/schema.js';
import { eventNames, foldDir } from '../store/__tests__/helpers.js';
import { boardProject, oneDocument, runCliAsync, runTogether } from './harness/processes.js';

const CHANGE = 'add-x';
const AS = ['--as', 'orch'];
const ROUNDS = 3;

function writeTasks(root: string, text: string): void {
  mkdirSync(join(root, 'openspec', 'changes', CHANGE), { recursive: true });
  writeFileSync(join(root, 'openspec', 'changes', CHANGE, 'tasks.md'), text);
}

const V1 = [
  '## 1. Schema',
  '- [ ] 1.1 Add the schema',
  '- [ ] 1.2 Add migrations',
  '## 2. API',
  '- [ ] 2.1 List',
  '- [ ] 2.2 Delete',
  '## 3. UI',
  '- [ ] 3.1 Page',
  '## 4. Docs',
  '- [ ] 4.1 README',
  '',
].join('\n');

/** Inserts Search at 2 (API and UI move to 3 and 4), rewords API, renames Schema, removes Docs. */
const V2 = [
  '## 1. Schema and migrations',
  '- [ ] 1.1 Add the schema',
  '- [ ] 1.2 Add migrations',
  '- [ ] 1.3 Add rollback',
  '## 2. Search',
  '- [ ] 2.1 Index',
  '## 3. API',
  '- [ ] 3.1 List',
  '- [ ] 3.2 Archive',
  '## 4. UI',
  '- [ ] 4.1 Page',
  '',
].join('\n');

/** Every event file of `eventsDir`, decoded, with its hash. */
function events(eventsDir: string): { hash: string; event: BoardEvent }[] {
  return eventNames(eventsDir).map((name) => ({
    hash: name.slice(0, -'.json'.length),
    event: JSON.parse(readFileSync(join(eventsDir, name), 'utf8')) as BoardEvent,
  }));
}

describe('scenario: concurrent re-imports of a revised change', () => {
  it(
    'apply one reconcile per ticket, one renumber per moved ticket and one new ticket',
    { timeout: 180_000 },
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const { root, eventsDir } = boardProject();
        writeTasks(root, V1);
        const first = await runCliAsync(['import-change', CHANGE, ...AS, '--json'], root);
        expect(first.code, first.stderr).toBe(0);
        const ids = (oneDocument(first) as { tickets: { id: string }[] }).tickets.map((t) => t.id);
        const [schema = '', api = '', ui = '', docs = ''] = ids;
        writeTasks(root, V2);

        const { results } = await runTogether(
          [
            { argv: ['import-change', CHANGE, '--as', 'orch-a', '--json'] },
            { argv: ['import-change', CHANGE, '--as', 'orch-b', '--json'] },
          ],
          root,
        );
        for (const result of results) {
          expect(result.code, result.stderr).toBe(0);
          expect(result.stderr).not.toMatch(/database is locked|SQLITE_BUSY/i);
        }

        const folded = foldDir(eventsDir);
        const rejected = new Set(folded.rejected.map((r) => r.hash));
        const applied = events(eventsDir).filter((e) => !rejected.has(e.hash));
        const count = (kind: string, ticket: string): number =>
          applied.filter(
            (e) => e.event.kind === kind && 'ticket' in e.event && e.event.ticket === ticket,
          ).length;
        expect([schema, api].map((id) => count('ticket.reconcile', id))).toEqual([1, 1]);
        expect([api, ui].map((id) => count('ticket.renumber', id))).toEqual([1, 1]);
        // UI only changed its numbers: its lines are renumbered by one reconcile too.
        expect(count('ticket.reconcile', ui)).toBe(1);
        expect(count('ticket.supersede', docs)).toBe(1);
        const tickets = Object.values(folded.state.tickets);
        expect(tickets.filter((t) => t.title === 'Search')).toHaveLength(1);
        expect(tickets).toHaveLength(5);
        expect(
          tickets
            .filter((t) => t.superseded === null)
            .map((t) => [t.task?.item, t.title])
            .sort(),
        ).toEqual([
          ['1', 'Schema and migrations'],
          ['2', 'Search'],
          ['3', 'API'],
          ['4', 'UI'],
        ]);

        const check = await runCliAsync(['rebuild', '--check', '--json'], root);
        expect(check.code, check.stdout).toBe(0);
        expect(oneDocument(check)).toMatchObject({ ok: true });

        const again = await runCliAsync(['import-change', CHANGE, ...AS, '--json'], root);
        expect(again.code, again.stderr).toBe(0);
        expect(oneDocument(again)).toMatchObject({ events: 0 });
      }
    },
  );
});
