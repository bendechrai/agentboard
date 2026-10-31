/**
 * The mutex ticket recipe in the agent guide, the role checklists and the
 * MCP instructions summary (add-claim-leases task 6.1; board-agent-guidance:
 * "Agent guide", scenario "Guide contains the mutex recipe", and "Mutex
 * ticket recipe", scenarios "Recipe commands parse", "Mutex lines in every
 * role checklist" and "MCP instructions carry the worker rule").
 *
 * Wording is checked as the spec delta pins it: phrases are searched in the
 * text with line breaks read as spaces and case ignored, so the guide may
 * wrap them anywhere. The section is the guide's lines from the heading
 * `Mutex tickets` to the next heading, `Using the MCP tools`.
 */

import { describe, expect, it } from 'vitest';

import { VERSION } from '../../version.js';
import {
  GUIDE_MAX_LINES,
  GUIDE_SECTIONS,
  GUIDE_SUMMARY_MAX_CHARS,
  ROLES,
  agentsHelpOutput,
  renderGuide,
  renderGuideSummary,
  renderRoleChecklist,
  type Role,
} from '../guide.js';
import {
  ASCII_LINE,
  commandLines,
  linesMissingActor,
  parseLine,
  parsedLines,
  unservedTools,
  type Parsed,
} from './guide-lines.js';

const HEADING = 'Mutex tickets';

function linesOf(text: string): string[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

/** `text` with every run of whitespace (line breaks included) as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** The body of the `Mutex tickets` section (heading excluded). */
function mutexSection(): string {
  const lines = linesOf(renderGuide(VERSION));
  const start = lines.indexOf(HEADING);
  expect(start, 'the Mutex tickets heading').toBeGreaterThan(0);
  const end = lines.indexOf('Using the MCP tools');
  expect(end, 'Using the MCP tools follows Mutex tickets').toBeGreaterThan(start);
  return lines.slice(start + 1, end).join('\n');
}

/** The numbered steps of a role checklist, each with its continuation lines. */
function steps(role: Role): string[] {
  const body = renderRoleChecklist(role).split('\n').slice(2).join('\n');
  return body
    .split(/^(?=\d+\. )/m)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** The one step of `role`'s checklist that names mutex tickets. */
function mutexStep(role: Role): string {
  const found = steps(role).filter((s) => /mutex/i.test(s));
  expect(found, `${role}: exactly one step names mutex tickets`).toHaveLength(1);
  return found[0] ?? '';
}

describe('the Mutex tickets section (scenario: Guide contains the mutex recipe)', () => {
  it('is a required section, after Tickets and planning tasks and before Using the MCP tools', () => {
    const at = GUIDE_SECTIONS.indexOf(HEADING);
    expect(at).toBeGreaterThan(0);
    expect(GUIDE_SECTIONS[at - 1]).toBe('Tickets and planning tasks');
    expect(GUIDE_SECTIONS[at + 1]).toBe('Using the MCP tools');
  });

  it('appears in the guide once, as a heading line after an empty line', () => {
    const lines = linesOf(renderGuide(VERSION));
    const at = lines.indexOf(HEADING);
    expect(at).toBeGreaterThan(lines.indexOf('Tickets and planning tasks'));
    expect(at).toBeLessThan(lines.indexOf('Using the MCP tools'));
    expect(lines[at - 1]).toBe('');
    expect(lines.filter((l) => l === HEADING)).toHaveLength(1);
  });

  it.each([undefined, ...ROLES])(
    'help agents --role %s is at most 180 lines, ASCII, with the section',
    (role) => {
      const text = agentsHelpOutput(VERSION, role).text;
      const lines = linesOf(text);
      expect(lines.length).toBeLessThanOrEqual(GUIDE_MAX_LINES);
      expect(lines.length).toBeLessThanOrEqual(180);
      for (const line of lines) {
        expect(line, JSON.stringify(line)).toMatch(ASCII_LINE);
      }
      expect(lines).toContain(HEADING);
    },
  );
});

describe('scenario: recipe commands parse', () => {
  function sectionLines(): Parsed[] {
    return parsedLines(mutexSection());
  }

  it('every agentboard line of the section parses and passes --as when it writes', () => {
    const lines = commandLines(mutexSection());
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) {
      expect(() => parseLine(line), line).not.toThrow();
    }
    expect(linesMissingActor(mutexSection())).toEqual([]);
  });

  it('acquires with claim --ttl (not waiting) and renews', () => {
    const lines = sectionLines();
    const claim = lines.find(
      (p) => p.command === 'claim' && typeof p.values.ttl === 'string' && p.values.wait !== true,
    );
    expect(claim, 'a claim <id> --ttl <duration> line').toBeDefined();
    expect(lines.some((p) => p.command === 'renew')).toBe(true);
  });

  it('waits in the foreground with claim --ttl --wait --timeout', () => {
    const wait = sectionLines().find(
      (p) =>
        p.command === 'claim' &&
        typeof p.values.ttl === 'string' &&
        p.values.wait === true &&
        typeof p.values.timeout === 'string',
    );
    expect(wait, 'a claim <id> --ttl <d> --wait --timeout <d> line').toBeDefined();
  });

  it('releases, and force-releases with a reason', () => {
    const lines = sectionLines();
    expect(lines.some((p) => p.command === 'release' && p.values.force !== true)).toBe(true);
    const force = lines.find(
      (p) =>
        p.command === 'release' &&
        p.values.force === true &&
        typeof p.values.reason === 'string' &&
        p.values.reason !== '',
    );
    expect(force, 'a release <id> --force --reason "<why>" line').toBeDefined();
  });

  it('sets the queue window or grace with config set', () => {
    const set = sectionLines().find((p) => p.command === 'config set');
    expect(set, 'a config set line').toBeDefined();
    expect(['queue.window', 'lease.grace']).toContain(set?.values.key);
  });

  it('names only served MCP tools, among them board_claim and board_inbox', () => {
    const text = mutexSection();
    expect(text).toContain('board_claim');
    expect(text).toContain('board_inbox');
    expect(unservedTools(text)).toEqual([]);
  });
});

describe('the recipe text (board-agent-guidance: "Mutex ticket recipe")', () => {
  // The phrases the spec delta pins, in the order the recipe covers them.
  it.each([
    // What a mutex ticket is.
    ['one standing ad hoc ticket per lock', ['standing', 'ad hoc', 'never close']],
    // Acquiring.
    ['renew as the first action of real work', ['first action of real work']],
    ['an unconfirmed claim lapses after the grace period', ['grace period']],
    ['a ttl longer than the critical section', ['longer than the critical section']],
    [
      'renew at about half the ttl and before the critical step',
      ['half the ttl', 'before the critical step'],
    ],
    ['stop when renew fails with not-assignee', ['not-assignee']],
    // Releasing.
    ['release when done, including on failure', ['on failure']],
    // Worker rules.
    ['never wait on a mutex in a loop', ['never wait on a mutex in a loop']],
    ['never claim from a background process', ['background process']],
    ['wait in the foreground, on the CLI only', ['foreground', 'CLI only']],
    ['or report ready and stop', ['report ready']],
    [
      'over MCP board_claim with wait only joins the queue',
      ['only joins the queue', 'board_claim', 'board_inbox'],
    ],
    // Orchestrator rules.
    ['the orchestrator is the single queue runner', ['queue runner', 'one holder at a time']],
    ['the next holder only after release or a lapsed lease', ['released', 'lapse']],
    ['the two settings', ['queue.window', 'lease.grace']],
    ['stale holds never by impersonating the holder', ['impersonat']],
    // Across machines.
    ['across machines only as strong as sync', ['sync', 'before claiming', 'exact']],
    // A wait that ends without a grant (review round 1, finding 2).
    [
      'a wait ending in wait-timeout or wait-interrupted leaves the ticket unheld',
      ['wait-timeout', 'wait-interrupted', 'do not hold', 'do not run the critical step'],
    ],
    ['after such a wait, retry or report', ['retry', 'report']],
    // Accepting a grant over MCP (review round 1, finding 3).
    [
      'over MCP the grantee renews within the accept window or the grant passes on',
      ['board_renew', 'accept window', 'passes on'],
    ],
  ])('says %s', (_name, phrases) => {
    const text = flat(mutexSection()).toLowerCase();
    for (const phrase of phrases) {
      expect(text, phrase).toContain(phrase.toLowerCase());
    }
  });

  it('names board_renew and the accept window in one sentence', () => {
    expect(flat(mutexSection())).toMatch(
      /board_renew[^.]*accept window|accept window[^.]*board_renew/i,
    );
  });

  it('pairs "never" with impersonating the holder, and names --as there', () => {
    const text = flat(mutexSection());
    expect(text).toMatch(/never[^.]*impersonat[^.]*--as|never[^.]*--as[^.]*impersonat/i);
  });
});

describe('scenario: mutex lines in every role checklist', () => {
  it.each<Role>(['test-author', 'implementer', 'reviewer'])(
    '%s has one step with the worker rules',
    (role) => {
      const step = flat(mutexStep(role)).toLowerCase();
      for (const phrase of ['mutex', 'in a loop', 'background process', 'report ready']) {
        expect(step, phrase).toContain(phrase);
      }
      for (const line of parsedLines(mutexStep(role))) {
        expect(line.command, line.line).toBeTruthy();
      }
      expect(linesMissingActor(mutexStep(role))).toEqual([]);
    },
  );

  it('orchestrator has one step making it the queue runner, one holder at a time', () => {
    const step = flat(mutexStep('orchestrator')).toLowerCase();
    for (const phrase of ['mutex', 'queue runner', 'one holder at a time']) {
      expect(step, phrase).toContain(phrase);
    }
    expect(linesMissingActor(mutexStep('orchestrator'))).toEqual([]);
  });

  it('keeps the existing first and last steps of each checklist where they were', () => {
    // The mutex step is added, not swapped in: inbox stays the orchestrator's
    // first command and each worker still ends with its hand-off or link.
    expect(parsedLines(renderRoleChecklist('orchestrator'))[0]?.command).toBe('inbox');
    const last = (role: Role): string | undefined =>
      parsedLines(renderRoleChecklist(role)).at(-1)?.command;
    expect(['handoff']).toContain(last('test-author'));
    expect(['handoff']).toContain(last('implementer'));
    expect(['link', 'handoff']).toContain(last('reviewer'));
  });

  it('the orchestrator output, the longest, is still at most 180 lines', () => {
    const out = renderGuide(VERSION) + renderRoleChecklist('orchestrator');
    expect(linesOf(out).length).toBeLessThanOrEqual(GUIDE_MAX_LINES);
  });
});

describe('scenario: MCP instructions carry the worker rule', () => {
  const summary = (): string => renderGuideSummary(VERSION);

  it('says never to wait on a mutex in a loop or claim from a background process', () => {
    const text = flat(summary()).toLowerCase();
    expect(text).toContain('never wait on a mutex');
    expect(text).toContain('in a loop');
    expect(text).toContain('background process');
  });

  it('says board_claim with wait only joins the queue, and the grant arrives in board_inbox', () => {
    const text = flat(summary());
    expect(text.toLowerCase()).toContain('only joins the queue');
    expect(text).toMatch(/board_claim[^.]*\bwait\b/);
    expect(text).toMatch(/grant[^.]*board_inbox/);
  });

  it('says the grantee must board_renew within the accept window, or the grant passes on', () => {
    const text = flat(summary());
    expect(text).toContain('board_renew');
    expect(text.toLowerCase()).toContain('accept window');
    expect(text.toLowerCase()).toContain('passes on');
    expect(text).toMatch(/board_renew[^.]*accept window|accept window[^.]*board_renew/i);
  });

  it('states the rule in at most two sentences, inside the 2000 character cap', () => {
    const text = flat(summary());
    // The sentences that name mutexes.
    const sentences = text.split(/(?<=[.;])\s/).filter((s) => /mutex/i.test(s));
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.length).toBeLessThanOrEqual(2);
    expect(summary().length).toBeLessThanOrEqual(GUIDE_SUMMARY_MAX_CHARS);
    expect(summary().length).toBeLessThanOrEqual(2000);
    for (const line of linesOf(summary())) {
      expect(line, JSON.stringify(line)).toMatch(ASCII_LINE);
    }
  });
});
