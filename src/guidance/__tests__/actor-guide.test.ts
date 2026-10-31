/**
 * The guide states the actor form (actor-secret-check group 2, task 2.2;
 * board-agent-guidance "Guide states the actor form", scenario "Guide
 * names the form").
 *
 * - The actor rule section of `agentboard help agents` (and so of the MCP
 *   resource `agentboard://guide`, whose text is byte-identical to it:
 *   src/mcp/__tests__/guide-mcp.test.ts) gives the form in the words of
 *   the `--as` help, read with line breaks as spaces, says that a name
 *   outside it or matching a secret pattern exits 1 with `invalid-actor`,
 *   and that `--allow-secret-like does not apply`.
 * - Every output, with and without `--role`, stays within
 *   `GUIDE_MAX_LINES` (180); the orchestrator output was already at 180,
 *   so the room comes from tightening the guide's prose, not from long
 *   lines: every prose line of every output (not a command line, not an
 *   exit code line) is at most 80 characters (group 2 test author ruling).
 * - The installed guidance text is unchanged: its version stays 3 and
 *   `agents check` on this repository reports every target `current`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cliEnv, oneJson, run } from '../../cli/__tests__/cli-helpers.js';
import { VERSION } from '../../version.js';
import {
  GUIDE_MAX_LINES,
  GUIDE_SECTIONS,
  ROLES,
  renderGuide,
  renderRoleChecklist,
} from '../guide.js';
import { GUIDANCE_VERSION } from '../installed-text.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The form, in the words of the `--as` and `--to` help. */
const FORM_WORDS = '1 to 32 ASCII letters, digits, . _ - or @, the first a letter or digit';

/** The most characters of a prose line of the guide. */
const PROSE_MAX_CHARS = 80;

/** Every guide output, as `[name, text]`: the guide alone, then with each role. */
function outputs(): [string, string][] {
  return [
    ['help agents', renderGuide(VERSION)],
    ...ROLES.map((r): [string, string] => [
      `help agents --role ${r}`,
      renderGuide(VERSION) + renderRoleChecklist(r),
    ]),
  ];
}

/** The lines of a text that ends with one newline. */
function linesOf(text: string): string[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

/** The actor rule section, heading excluded, with line breaks read as spaces. */
function actorRule(): string {
  const lines = linesOf(renderGuide(VERSION));
  const start = lines.indexOf('The actor rule');
  const next = GUIDE_SECTIONS[GUIDE_SECTIONS.indexOf('The actor rule') + 1] ?? '';
  const end = lines.indexOf(next);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
}

describe('scenario: Guide names the form', () => {
  it('the actor rule gives the form in the words of the --as help', () => {
    expect(actorRule()).toContain(FORM_WORDS);
  });

  it('the actor rule says a name outside the form or matching a secret pattern exits 1 with invalid-actor', () => {
    const text = actorRule();
    expect(text).toContain('invalid-actor');
    expect(text).toMatch(/\bexits? 1\b/);
    expect(text).toMatch(/secret/);
  });

  it('the actor rule says --allow-secret-like does not apply', () => {
    expect(actorRule()).toContain('--allow-secret-like does not apply');
  });

  it('the actor rule keeps what it said before', () => {
    const text = actorRule();
    for (const fragment of ['--as <actor>', 'AGENTBOARD_ACTOR', 'OS user', 'inbox', 'watch']) {
      expect(text, fragment).toContain(fragment);
    }
  });

  it.each(outputs())('%s is within the line limit', (_name, text) => {
    expect(GUIDE_MAX_LINES).toBe(180);
    expect(linesOf(text).length).toBeLessThanOrEqual(GUIDE_MAX_LINES);
  });

  it.each(outputs())(
    '%s: every prose line is at most 80 characters (room comes from tightening, not long lines)',
    (_name, text) => {
      for (const line of linesOf(text)) {
        const command = line.trimStart().startsWith('agentboard ');
        const exitCode = /^ {2}[0-5] {2,}\S/.test(line);
        if (!command && !exitCode) {
          expect(line.length, line).toBeLessThanOrEqual(PROSE_MAX_CHARS);
        }
      }
    },
  );
});

describe('the installed guidance text does not move', () => {
  it('its version stays 3', () => {
    expect(GUIDANCE_VERSION).toBe(3);
  });

  it('agents check on this repository reports every target current', () => {
    const out = run(['agents', 'check', '--json'], REPO_ROOT, cliEnv());
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { target: string; state: string }[];
    expect(doc.length).toBeGreaterThan(0);
    for (const entry of doc) {
      expect(entry.state, entry.target).toBe('current');
    }
  });
});
