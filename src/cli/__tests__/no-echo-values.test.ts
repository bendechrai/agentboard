/**
 * Value refusals of the registry and the board repeat no refused input
 * (no-echo-refusals task 1.2; design.md "Audit" rows 10 to 17 and 19 to
 * 27; board-cli "Refusals never repeat the refused input", "Ticket ids in
 * refusals" and the modified "Close requires a decision disposition").
 *
 * Each refusal runs in process, plain and with `--json`, on a board with
 * one ticket, with every applicable token fixture as the refused input:
 * the message is the design's exact text, the reason, exit code and hint
 * are unchanged, no fixture appears in stdout or stderr, and no event file
 * is written.
 */

import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEX_40,
  HEX_64,
  LONG_WORD,
  TOKEN_FIXTURES,
  type SecretFixture,
} from '../../__tests__/harness/secret-fixtures.js';
import { cliEnv, project, run, written } from './cli-helpers.js';
import { eventNames, expectCliRefusal, type ExpectedRefusal } from './no-echo-helpers.js';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const STATUS_LIST = 'todo, tests, implementing, review, merged, blocked';

const TASK_HINT_BASE =
  'write the task as <source>:<ref>#<item> (for example openspec:add-login#2), or for OpenSpec --change <name> --group <n>';

function argsHint(command: string): string {
  return `check the arguments with 'agentboard help ${command}'`;
}

function taskHint(command: string): string {
  return `${TASK_HINT_BASE}; see 'agentboard help ${command}'`;
}

function refusal(
  exitCode: number,
  reason: string,
  message: string,
  hint: string | null,
): ExpectedRefusal {
  return { exitCode, reason, message, hint };
}

const NOT_AN_ID =
  'no ticket matches the id given, which is not a ticket id: an id is 26 characters of ' +
  'Crockford base32 (digits and letters other than I, L, O and U) starting with 0, or a ' +
  'unique prefix of at least 6 of them';

const UNKNOWN_TICKET_HINT = "no ticket matches that id; find it with 'agentboard list'";
const TOO_SHORT_HINT =
  "give at least 6 characters of the ticket id; 'agentboard list' shows the ids";

let root = '';
let eventsDir = '';
let id = '';

beforeEach(() => {
  const dirs = project();
  root = realpathSync(dirs.root);
  eventsDir = join(dirs.boardDir, 'events');
  const out = run(
    ['new', 'No echo', '--task', 'openspec:no-echo#1', '--as', 'orch', '--json'],
    root,
    cliEnv(),
  );
  expect(out.code, out.stderr).toBe(0);
  id = written(out).id;
});

/** Runs the refusal for every fixture and checks that no event was written. */
function expectRefusals(
  fixtures: readonly SecretFixture[],
  argv: (token: string) => string[],
  expected: ExpectedRefusal | ((token: string) => ExpectedRefusal),
): void {
  for (const f of fixtures) {
    const before = eventNames(eventsDir);
    const want = typeof expected === 'function' ? expected(f.value) : expected;
    expectCliRefusal(argv(f.value), root, want, [f]);
    expect(eventNames(eventsDir), f.name).toEqual(before);
  }
}

describe('unknown status (row 10)', () => {
  it('Unknown status: move <id> <token> names <status> and lists the statuses', () => {
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['move', id, t, '--as', 'orch'],
      refusal(1, 'usage', `move takes <status> as one of ${STATUS_LIST}`, argsHint('move')),
    );
  });

  it('handoff --status and list --status name --status', () => {
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['handoff', id, '--to', 'b', '--status', t, '--note', 'n', '--as', 'a'],
      refusal(1, 'usage', `handoff takes --status as one of ${STATUS_LIST}`, argsHint('handoff')),
    );
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['list', '--status', t],
      refusal(1, 'usage', `list takes --status as one of ${STATUS_LIST}`, argsHint('list')),
    );
  });
});

describe('health durations (row 11)', () => {
  it.each(['stale-after', 'blocked-after', 'unplanned-within'])(
    'Health duration: --%s names the flag and the duration form',
    (name) => {
      expectRefusals(
        TOKEN_FIXTURES,
        (t) => ['health', `--${name}`, t],
        refusal(
          1,
          'usage',
          `invalid --${name}: a duration is <n>m, <n>h or <n>d with <n> a positive integer of at most 5 digits (for example 30m, 2h or 1d)`,
          argsHint('health'),
        ),
      );
    },
  );
});

describe('Malformed task reference, change name, group and filter (rows 12 to 15)', () => {
  const taskRef = (command: string): ExpectedRefusal =>
    refusal(
      1,
      'malformed-task-ref',
      'malformed task reference: --task expects <source>:<ref>#<item>, for example openspec:add-board-core#3',
      taskHint(command),
    );
  const changeName = (command: string): ExpectedRefusal =>
    refusal(
      1,
      'malformed-task-ref',
      'malformed change name: --change must be non-empty and contain no #',
      taskHint(command),
    );

  it('--task of new, link and move', () => {
    expectRefusals(TOKEN_FIXTURES, (t) => ['new', 'x', '--task', t, '--as', 'a'], taskRef('new'));
    expectRefusals(TOKEN_FIXTURES, (t) => ['link', id, '--task', t, '--as', 'a'], taskRef('link'));
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['move', id, 'merged', '--task', t, '--as', 'a'],
      taskRef('move'),
    );
  });

  it('--change of link (taskRefFromArgs) and of list (the registry filter)', () => {
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['link', id, '--change', `${t}#1`, '--group', '1', '--as', 'a'],
      changeName('link'),
    );
    expectRefusals(TOKEN_FIXTURES, (t) => ['list', '--change', `${t}#1`], changeName('list'));
  });

  it('--group of link', () => {
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['link', id, '--change', 'c', '--group', t, '--as', 'a'],
      refusal(
        1,
        'malformed-task-ref',
        'malformed group: --group must be a positive decimal number such as 3',
        taskHint('link'),
      ),
    );
  });

  it('--task of list (the filter)', () => {
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['list', '--task', t],
      refusal(
        1,
        'malformed-task-ref',
        'malformed task filter: --task expects <source>:<ref>[#<item>]',
        taskHint('list'),
      ),
    );
  });
});

describe('ticket ids (rows 16 and 17; board-cli "Ticket ids in refusals")', () => {
  it('Ticket id that is not an id: show and move, exit 4 unknown-ticket naming the id form', () => {
    const unknown = refusal(4, 'unknown-ticket', NOT_AN_ID, UNKNOWN_TICKET_HINT);
    expectRefusals(TOKEN_FIXTURES, (t) => ['show', t], unknown);
    expectRefusals(TOKEN_FIXTURES, (t) => ['move', t, 'review', '--as', 'orch'], unknown);
  });

  it('Unknown ticket id that is id-shaped: show 01J9K3ZZZZ names it', () => {
    expectCliRefusal(
      ['show', '01J9K3ZZZZ'],
      root,
      refusal(4, 'unknown-ticket', 'no ticket matches 01J9K3ZZZZ', UNKNOWN_TICKET_HINT),
      [],
    );
  });

  it('an id with an O, as in 01NOPE0000, is not id-shaped and is not named', () => {
    expectCliRefusal(
      ['show', '01NOPE0000'],
      root,
      refusal(4, 'unknown-ticket', NOT_AN_ID, UNKNOWN_TICKET_HINT),
      [],
    );
    const out = run(['show', '01NOPE0000', '--json'], root, cliEnv());
    expect(`${out.stdout}${out.stderr}`.toUpperCase()).not.toContain('01NOPE0000');
  });

  it('26 Crockford characters starting with 0 are named, 27 are not', () => {
    const max = `0${'Z'.repeat(25)}`;
    expectCliRefusal(
      ['show', max],
      root,
      refusal(4, 'unknown-ticket', `no ticket matches ${max}`, UNKNOWN_TICKET_HINT),
      [],
    );
    expectCliRefusal(
      ['show', `${max}Z`],
      root,
      refusal(4, 'unknown-ticket', NOT_AN_ID, UNKNOWN_TICKET_HINT),
      [],
    );
  });

  it('Crockford text that does not start with 0 is not named (review rounds 1 and 2)', () => {
    for (const text of [
      'Z'.repeat(26),
      'KZQ4XK9M2PVB8RT3NH6WD5YCFJ',
      'JBSWY3DPEHPK3PXP',
      '8ZZZZZZ',
      // Review round 2: 1 to 7 is no longer enough either.
      `7${'Z'.repeat(25)}`,
      '1J9K3ZZZZ',
      '5f3c1a7e5b2d8c4f',
    ]) {
      expectCliRefusal(
        ['show', text],
        root,
        refusal(4, 'unknown-ticket', NOT_AN_ID, UNKNOWN_TICKET_HINT),
        [],
      );
      const out = run(['show', text, '--json'], root, cliEnv());
      expect(`${out.stdout}${out.stderr}`.toUpperCase(), text).not.toContain(text.toUpperCase());
    }
    expectCliRefusal(
      ['show', 'JBSWY'],
      root,
      refusal(
        1,
        'id-too-short',
        'the ticket id given is too short: give at least 6 characters',
        TOO_SHORT_HINT,
      ),
      [],
    );
  });

  it('a character that upper-cases into the alphabet is not id-shaped (review round 1, F3)', () => {
    for (const text of [
      `01${String.fromCharCode(0x17f, 0x17f)}ABCDEFGH23`,
      `0${String.fromCharCode(0xfb06).repeat(12)}`,
    ]) {
      expectCliRefusal(
        ['show', text],
        root,
        refusal(4, 'unknown-ticket', NOT_AN_ID, UNKNOWN_TICKET_HINT),
        [],
      );
    }
  });

  it('lowercase is id-shaped and named as given; I, L, O and U in any case are not', () => {
    expectCliRefusal(
      ['show', '01j9k3zzzz'],
      root,
      refusal(4, 'unknown-ticket', 'no ticket matches 01j9k3zzzz', UNKNOWN_TICKET_HINT),
      [],
    );
    for (const text of [
      '01J9K3III',
      '01J9K3LLL',
      '01J9K3OOO',
      '01J9K3UUU',
      '01j9k3iii',
      '01j9k3uuu',
    ]) {
      expectCliRefusal(
        ['show', text],
        root,
        refusal(4, 'unknown-ticket', NOT_AN_ID, UNKNOWN_TICKET_HINT),
        [],
      );
      const out = run(['show', text], root, cliEnv());
      expect(out.stderr.toUpperCase(), text).not.toContain(text.toUpperCase());
    }
  });

  it('a short id is id-too-short; it is named only when id-shaped', () => {
    expectCliRefusal(
      ['show', '01J9K'],
      root,
      refusal(
        1,
        'id-too-short',
        'ticket id prefix 01J9K is too short: give at least 6 characters',
        TOO_SHORT_HINT,
      ),
      [],
    );
    for (const text of ['gh_p1', 'p4ss!', 'ab-cd', 'AKIL']) {
      expectCliRefusal(
        ['show', text],
        root,
        refusal(
          1,
          'id-too-short',
          'the ticket id given is too short: give at least 6 characters',
          TOO_SHORT_HINT,
        ),
        [],
      );
      const out = run(['show', text], root, cliEnv());
      expect(out.stderr, text).not.toContain(text);
    }
  });

  it('a resolvable id is still accepted in any case', () => {
    expect(run(['show', id.toLowerCase()], root, cliEnv()).code).toBe(0);
    expect(run(['show', id.slice(0, 6)], root, cliEnv()).code).toBe(0);
  });
});

describe('inbox --since (row 19)', () => {
  it('Unknown inbox cursor: a well-formed hash of no event names --since only', () => {
    expectCliRefusal(
      ['inbox', '--as', 'a', '--since', HEX_64],
      root,
      refusal(
        1,
        'unknown-cursor',
        'no event matches --since on this board',
        "--since needs the full hash of an event on this board; 'agentboard inbox --as a --peek' lists the events without acknowledging them",
      ),
      TOKEN_FIXTURES,
    );
  });

  it('any other value is the unchanged usage refusal, which names no value', () => {
    expectRefusals(
      TOKEN_FIXTURES.filter((f) => f.value !== HEX_64),
      (t) => ['inbox', '--as', 'a', '--since', t],
      refusal(
        1,
        'usage',
        '--since takes the full 64-character lowercase hex hash of an event',
        argsHint('inbox'),
      ),
    );
  });
});

describe('decision paths (rows 20 and 21)', () => {
  it('Close with a missing decision path: names --decision-recorded-in, not 0099', () => {
    const expected = refusal(
      1,
      'decision-path-missing',
      'the decision record given with --decision-recorded-in does not exist',
      `write and commit the spec delta or ADR first, then run 'agentboard close ${id} --decision-recorded-in <path> --as orch'`,
    );
    expectCliRefusal(
      ['close', id, '--decision-recorded-in', 'docs/adr/0099.md', '--as', 'orch'],
      root,
      expected,
      [],
    );
    const out = run(
      ['close', id, '--decision-recorded-in', 'docs/adr/0099.md', '--as', 'orch', '--json'],
      root,
      cliEnv(),
    );
    expect(`${out.stdout}${out.stderr}`).not.toContain('0099');
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['close', id, '--decision-recorded-in', `docs/${t}.md`, '--as', 'orch'],
      expected,
    );
  });

  it('Decision path outside the working tree: link --decision and close name the root only', () => {
    const outside = refusal(
      1,
      'path-outside-tree',
      `the path given is outside the working tree ${root}`,
      "the path must name a file inside the current working tree; pass it as --decision <path>; see 'agentboard help link'",
    );
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['link', id, '--decision', `../${t}`, '--as', 'a'],
      outside,
    );
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['close', id, '--decision-recorded-in', `../${t}`, '--as', 'orch'],
      refusal(
        1,
        'path-outside-tree',
        `the path given is outside the working tree ${root}`,
        "the path must name a file inside the current working tree; pass it as --decision-recorded-in <path>; see 'agentboard help close'",
      ),
    );
  });
});

describe('Import target (rows 22 to 27)', () => {
  /** Tokens that pass the source pattern /^[a-z][a-z0-9-]*$/. */
  const SOURCE_SHAPED: readonly SecretFixture[] = [
    TOKEN_FIXTURES.find((f) => f.value === LONG_WORD),
    { name: 'a-hex-40', value: `a${HEX_40}`, secret: `a${HEX_40}` },
  ].filter((f): f is SecretFixture => f !== undefined);

  it('<token>#1 names an item (row 22)', () => {
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['import-change', `${t}#1`, '--as', 'orch'],
      refusal(
        1,
        'malformed-task-ref',
        'the change given to import-change names an item (it contains #); import-change takes a whole change or <source>:<ref>',
        taskHint('import-change'),
      ),
    );
  });

  it('a source that fails the source pattern (row 23)', () => {
    const expected = refusal(
      1,
      'malformed-task-ref',
      'the task source given to import-change must match /^[a-z][a-z0-9-]*$/',
      taskHint('import-change'),
    );
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['import-change', `Bad_${t}:x`, '--as', 'orch'],
      expected,
    );
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['import-change', `Bad_Source:${t}`, '--as', 'orch'],
      expected,
    );
  });

  it('a source with no ref (row 24)', () => {
    expectRefusals(
      SOURCE_SHAPED,
      (t) => ['import-change', `${t}:`, '--as', 'orch'],
      refusal(
        1,
        'usage',
        'the change given to import-change names no ref after its source',
        argsHint('import-change'),
      ),
    );
  });

  it('a source with no adapter (row 25)', () => {
    expectRefusals(
      SOURCE_SHAPED,
      (t) => ['import-change', `${t}:x`, '--as', 'orch'],
      refusal(
        1,
        'unsupported-source',
        'the task source given has no adapter in this version; only openspec can be imported',
        "only the openspec source can be imported; create a ticket for other planned work with 'agentboard new <title> --task <source>:<ref>#<item> --as orch'",
      ),
    );
  });

  it('a change name that is not a single directory name (row 26)', () => {
    const expected = refusal(
      1,
      'usage',
      'the OpenSpec change name given is not a single directory name',
      argsHint('import-change'),
    );
    expectRefusals(TOKEN_FIXTURES, (t) => ['import-change', `../${t}`, '--as', 'orch'], expected);
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['import-change', `openspec:${t}/x`, '--as', 'orch'],
      expected,
    );
  });

  it('a change with no tasks file (row 27)', () => {
    expectRefusals(
      TOKEN_FIXTURES,
      (t) => ['import-change', t, '--as', 'orch'],
      refusal(
        1,
        'tasks-not-found',
        'cannot read the tasks file of the change given: import-change reads openspec/changes/<name>/tasks.md; is the name an OpenSpec change?',
        "check the change name and that its tasks file exists, then run 'agentboard import-change <change> --as orch' again",
      ),
    );
  });
});
