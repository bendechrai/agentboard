/**
 * Guard for the documentation of the ad hoc ticket lifecycle
 * (add-adhoc-ticket-lifecycle task group 6): README.md, STATUS.md and the
 * landing site describe the scope disposition at merge and close, and
 * nothing in them still describes the removed gate at `implementing`
 * (`needs-task-link`). The README's quoted refusal is the hint the CLI
 * renders, so the two cannot drift apart. The shell walkthrough that runs
 * the README example on a temporary board is checked for its shape here;
 * it is run by hand (`make build && sh
 * src/__tests__/walkthroughs/adhoc-lifecycle.sh`), not by `make check`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderHint } from '../guidance/hints.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = join(ROOT, 'README.md');
const STATUS = join(ROOT, 'STATUS.md');
const DOCS = join(ROOT, 'docs');
const WALKTHROUGH = join(ROOT, 'src', '__tests__', 'walkthroughs', 'adhoc-lifecycle.sh');

/** The removed refusal reason; it must appear in none of the documents. */
const OLD_REASON = 'needs-' + 'task-link';

const readme = (): string => readFileSync(README, 'utf8');
const status = (): string => readFileSync(STATUS, 'utf8');

/** The section of `text` under `## <title>` (or `### <title>`), up to the next heading of the same level. */
function section(text: string, title: string, level = 2): string {
  const marker = '#'.repeat(level);
  const start = text.indexOf(`\n${marker} ${title}\n`);
  expect(start, `section ${title}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(`\n${marker} `, start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...filesUnder(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

/** The paragraphs of `text` (blank-line separated), with line breaks folded to spaces. */
function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
}

describe('README.md documents the ad hoc ticket lifecycle', () => {
  it('names the removed gate nowhere', () => {
    expect(readme()).not.toContain(OLD_REASON);
    expect(readme()).not.toMatch(/cannot (move|enter) into `?implementing`?/i);
    expect(readme()).not.toMatch(/must be linked to one before implementation starts/);
  });

  it('says an ad hoc ticket is worked normally and gives its scope at merge or close', () => {
    const text = section(readme(), 'Tickets and task references');
    expect(text).toMatch(/worked (normally|like any other)/i);
    expect(text).toContain('`merged`');
    expect(text).toContain('--unplanned');
    expect(text).toContain('--task');
    expect(text).toContain('`close`');
    expect(text).toContain('needs-scope-disposition');
    expect(text).toContain('already-linked');
    expect(text).toMatch(/never create an issue, task file or task reference/i);
    expect(text).toContain('`[unplanned]`');
    expect(text).toContain('`[adhoc]`');
  });

  it('quotes the refusal exactly as the CLI prints it', () => {
    const text = section(readme(), 'Tickets and task references');
    const refusal = /agentboard: ticket\.move on ticket ([0-9A-Z]{26}) refused: needs-scope-disposition\nhint: (.+)\n/.exec(text);
    expect(refusal, 'the refused move merged and its hint line').not.toBeNull();
    const id = refusal?.[1] ?? '';
    const hint = refusal?.[2] ?? '';
    const actor = /--as ([a-z0-9-]+)'/.exec(hint)?.[1] ?? '';
    expect(actor, 'the actor of the quoted hint').not.toBe('');
    expect(hint).toBe(renderHint('needs-scope-disposition', { surface: 'cli', command: 'move', id, actor }));
    expect(text).toContain(`agentboard move ${id} merged --unplanned`);
    expect(text).toContain('[unplanned]');
  });

  it('documents the flags of move and close in the command reference', () => {
    const working = section(readme(), 'Working a ticket');
    expect(working).toMatch(/`move <id> merged`[^\n]*--task/);
    expect(working).toContain('--unplanned');
    expect(working).toContain('needs-scope-disposition');
    const closing = section(readme(), 'Decisions and closing tickets');
    expect(closing).toContain('--unplanned');
    expect(closing).toContain('--task');
    expect(closing).toMatch(/scope disposition/);
    expect(closing).toContain('needs-scope-disposition');
    expect(closing).toContain('already-linked');
  });

  it('lists both reasons in the exit codes table and the hints section', () => {
    const codes = section(readme(), 'Exit codes');
    const row = codes.split('\n').find((line) => line.startsWith('| 4 |'));
    expect(row).toContain('`needs-scope-disposition`');
    expect(row).toContain('`already-linked`');
    const hints = section(readme(), 'Error hints');
    expect(hints).toContain('`needs-scope-disposition`');
    expect(hints).toContain('`already-linked`');
    expect(hints).toContain('--unplanned');
    expect(hints).toMatch(/do not create an issue or task only to satisfy this/);
  });

  it('shows the disposition in the web action bodies and the 409 reasons', () => {
    const actions = section(readme(), 'Acting from the browser', 3);
    const rows = actions.split('\n');
    const move = rows.find((line) => line.startsWith('| `move` |'));
    expect(move).toContain('"unplanned"');
    expect(move).toContain('"task"');
    const close = rows.find((line) => line.startsWith('| `close` |'));
    expect(close).toContain('"unplanned"');
    expect(close).toContain('"task"');
    const conflict = rows.find((line) => line.startsWith('| 409 |'));
    expect(conflict).toContain('`needs-scope-disposition`');
    expect(conflict).toContain('`already-linked`');
  });

  it('describes unplanned scope in Board health: the row, the text and the JSON keys', () => {
    const health = section(readme(), 'Board health');
    const row = health.split('\n').find((line) => /^\| Unplanned scope \|/.test(line));
    expect(row, 'the Unplanned scope row of the checks table').toBeDefined();
    expect(row).toContain('`merged`');
    expect(row).toContain('7 days');
    expect(row).toContain('`--unplanned-within`');
    expect(health).toMatch(/agentboard health \[--stale-after <duration>\] \[--blocked-after <duration>\] \[--unplanned-within <duration>\]/);
    expect(health).toMatch(/^unplanned scope: \d+ in the last 7d \(\d+ in all\)$/m);
    expect(health).toMatch(/\[unplanned\] [^\n]+ merged [^\n]+, unplanned: /);
    for (const key of ['`unplannedWithin`', '`unplannedScope`', '`total`', '`tickets`', '`reason`', '`outcome`', '`since`', '`ageMs`']) {
      expect(health, key).toContain(key);
    }
    expect(health).toMatch(/information, not a (failure|finding)/i);
    const mcp = section(readme(), 'Over MCP: `board_health`', 3);
    expect(mcp).toContain('`unplanned-within`');
    const browser = section(readme(), 'In the browser', 3);
    expect(browser).toMatch(/Unplanned within/);
    expect(browser).toMatch(/information/i);
  });

  it('tells boards shared between machines to upgrade before an ad hoc ticket moves past tests', () => {
    const note = paragraphs(readme()).find(
      (p) => /upgrade/i.test(p) && /ad hoc/.test(p) && /past `tests`/.test(p),
    );
    expect(note, 'the upgrade note').toBeDefined();
    expect(note).toMatch(/every machine/i);
  });

  it('restates what the board is not in terms of disclosure', () => {
    const not = section(readme(), 'What the board is not');
    expect(not).toMatch(/\*\*Not a source of scope\.\*\*/);
    expect(not).toMatch(/unplanned/);
    expect(not).not.toMatch(/before implementation starts/);
  });
});

describe('STATUS.md records the lifecycle as built', () => {
  it('names the removed gate nowhere', () => {
    expect(status()).not.toContain(OLD_REASON);
  });

  it('lists the lifecycle and board sharing under What exists, and no longer under What is next', () => {
    const exists = section(status(), 'What exists');
    expect(exists).toMatch(/ad hoc/);
    expect(exists).toContain('`--unplanned`');
    expect(exists).toContain('`needs-scope-disposition`');
    expect(exists).toContain('ADR 0013');
    expect(exists).toMatch(/refs\/agentboard\/board|board sharing/);
    expect(exists).toContain('ADR 0012');
    const next = section(status(), 'What is next');
    expect(next).not.toContain('add-adhoc-ticket-lifecycle');
    expect(next).not.toContain('add-board-sharing');
  });

  it('notes the add-claim-leases re-sync and the into-host snapshot flake as known gaps', () => {
    const gaps = section(status(), 'Known gaps');
    expect(gaps).not.toMatch(/None open/);
    expect(gaps).toContain('`add-claim-leases`');
    expect(gaps).toContain('`GUIDANCE_VERSION`');
    expect(gaps).toMatch(/180/);
    expect(gaps).toContain('01M54J9C8VWG6V6E751JHHVW66');
  });
});

describe('the landing site', () => {
  it('names the removed gate nowhere', () => {
    const files = filesUnder(DOCS).filter((f) => /\.(html|js|md|txt|svg|css|json)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes(OLD_REASON));
    expect(offenders).toEqual([]);
  });
});

describe('the walkthrough script', () => {
  it('exists, parses, and follows the README example', () => {
    const text = readFileSync(WALKTHROUGH, 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain('set -eu');
    expect(text).toContain('--adhoc');
    expect(text).toMatch(/move "\$[a-z_]+" (tests|implementing|review)/);
    expect(text).toContain('needs-scope-disposition');
    expect(text).toContain('do not create an issue or task only to satisfy this');
    expect(text).toContain('--unplanned');
    expect(text).toContain('[unplanned]');
    expect(text).toMatch(/health/);
    expect(text).toMatch(/unplanned scope: \d+ in the last 7d \(\d+ in all\)/);
    expect(text).toContain('already-linked');
    expect(/[^ -~\n\t]/.test(text), 'plain ASCII').toBe(false);
    // `sh -n` parses the script without running it.
    expect(() => execFileSync('sh', ['-n', WALKTHROUGH], { stdio: 'pipe' })).not.toThrow();
  });
});
