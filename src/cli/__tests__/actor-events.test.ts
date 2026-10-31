/**
 * Events from before the actor check (actor-secret-check task 1.4;
 * board-events "Event actors have no form", scenarios "Event with a token
 * as its actor" and "Hand-off to a name outside the form"; board-cli
 * scenario "Events from before the check"). The event files are written
 * directly into a test board, as an older version or a sync leaves them:
 * they are valid, folded and shown whatever their actor, and every command
 * that reads them succeeds. `list --assignee` finds their tickets.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GITHUB_TOKEN, HEX_40 } from '../../__tests__/harness/secret-fixtures.js';
import { validateEvent } from '../../events/schema.js';
import { P, T1, T2, ev, foldDir, putEvent } from '../../store/__tests__/helpers.js';
import { cliEnv, oneJson, project, run } from './cli-helpers.js';

/** A board holding events written before the check, by actors outside the form. */
function oldBoard(): { root: string; eventsDir: string } {
  const { root, boardDir } = project();
  const eventsDir = join(boardDir, 'events');
  putEvent(eventsDir, ev(P.create(T1, 'Old ticket'), 'orch', 1_700_000_000_000));
  putEvent(eventsDir, ev(P.comment(T1, 'from a token'), GITHUB_TOKEN, 1_700_000_001_000));
  putEvent(eventsDir, ev(P.comment(T1, 'from hex'), HEX_40, 1_700_000_002_000));
  putEvent(eventsDir, ev(P.create(T2, 'Handed to a name with a space'), 'orch', 1_700_000_003_000));
  putEvent(
    eventsDir,
    ev(P.handoff(T2, 'Ben Dechrai', 'todo', 'yours'), 'Ben Dechrai', 1_700_000_004_000),
  );
  return { root, eventsDir };
}

interface Shown {
  assignee: string | null;
  comments: { actor: string; text: string }[];
}

/** The ticket of `show <id> --json`. */
function shown(root: string, id: string): Shown {
  const out = run(['show', id, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneJson(out) as { ticket: Shown }).ticket;
}

describe('scenario: Event with a token as its actor', () => {
  it('a ticket.comment whose actor and ts.actor are a 40-character token is valid', () => {
    const event = ev(P.comment(T1, 'hi'), GITHUB_TOKEN, 1_700_000_001_000);
    expect(validateEvent(event).ok).toBe(true);
    expect(validateEvent(ev(P.handoff(T1, 'Ben Dechrai', 'todo', 'n'), 'orch', 1)).ok).toBe(true);
  });

  it('it is folded and attributed to that actor, and rebuild --check reports no divergence', () => {
    const { root, eventsDir } = oldBoard();
    const folded = foldDir(eventsDir);
    expect(folded.rejected).toEqual([]);
    const ticket = shown(root, T1);
    expect(ticket.comments.map((c) => c.actor)).toEqual([GITHUB_TOKEN, HEX_40]);
    const rebuilt = run(['rebuild'], root);
    expect(rebuilt.code, rebuilt.stderr).toBe(0);
    const check = run(['rebuild', '--check'], root);
    expect(check.code, check.stderr).toBe(0);
  });
});

describe('scenario: Hand-off to a name outside the form', () => {
  it('a ticket.handoff whose to is "Ben Dechrai" is folded and the ticket is assigned to it', () => {
    const { root } = oldBoard();
    const ticket = shown(root, T2);
    expect(ticket.assignee).toBe('Ben Dechrai');
  });
});

describe('scenario: Events from before the check', () => {
  it('show, list, inbox --as orch and rebuild --check all succeed', () => {
    const { root } = oldBoard();
    for (const argv of [
      ['show', T1],
      ['show', T2],
      ['list'],
      ['list', '--json'],
      ['inbox', '--as', 'orch'],
      ['inbox', '--as', 'orch', '--json'],
      ['rebuild', '--check'],
      ['health'],
    ]) {
      const out = run(argv, root);
      expect(out.code, `${argv.join(' ')}: ${out.stderr}`).toBe(0);
    }
  });

  it('list --assignee finds the tickets of a name that can no longer be passed', () => {
    const { root } = oldBoard();
    const out = run(['list', '--assignee', 'Ben Dechrai', '--json'], root);
    expect(out.code, out.stderr).toBe(0);
    expect((oneJson(out) as { id: string }[]).map((t) => t.id)).toEqual([T2]);
  });

  it('a ticket held by such a name is handed on with release --force --reason', () => {
    const { root } = oldBoard();
    const out = run(
      [
        'release',
        T2,
        '--force',
        '--reason',
        'the holder name can no longer be passed',
        '--as',
        'orch',
      ],
      root,
      cliEnv(),
    );
    expect(out.code, out.stderr).toBe(0);
    expect(shown(root, T2).assignee).toBeNull();
  });
});
