/**
 * Guard for the documentation of Markdown descriptions
 * (add-description-markdown task group 2): README.md ("Watching the board
 * in a browser" and the security model's "Script in the page"), the new
 * ADR 0015 and its entry in adr/README.md, the amendment note on ADR 0006,
 * STATUS.md and the change's tasks.md.
 *
 * The facts pinned here are the ones the renderer in
 * src/web/client/markdown.tsx implements: CommonMark plus GFM tables, task
 * lists, strikethrough and autolinks; elements only, never an HTML string;
 * links only for absolute `http:`, `https:` and `mailto:` URLs, in a new tab
 * with `rel="noopener noreferrer"`; images as links labelled with their alt
 * text; disabled task checkboxes; `MAX_MARKDOWN_DEPTH` 32 and
 * `MAX_MARKDOWN_LENGTH` 16384 characters with a plain-text fallback. The
 * wording around them is free; the numbers, scheme names and file names are
 * not.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = join(ROOT, 'README.md');
const STATUS = join(ROOT, 'STATUS.md');
const ADR_DIR = join(ROOT, 'adr');
const ADR_INDEX = join(ADR_DIR, 'README.md');
const ADR_0006 = join(ADR_DIR, '0006-local-web-server-security-model.md');
const TASKS = join(ROOT, 'openspec', 'changes', 'add-description-markdown', 'tasks.md');
const SELF = fileURLToPath(import.meta.url);

/** The headings every ADR with alternatives shares (0001 to 0010, 0012, 0013), in order. */
const ADR_HEADINGS = ['Status', 'Context', 'Decision', 'Rationale', 'Consequences', 'Alternatives considered'];

/** Any byte outside printable ASCII, newline and tab (the precedent's check). */
const NON_ASCII = /[^ -~\n\t]/;

const read = (path: string): string => readFileSync(path, 'utf8');

/** The section of `text` under `## <title>` (or `### <title>`), up to the next heading of the same level. */
function section(text: string, title: string, level = 2): string {
  const marker = '#'.repeat(level);
  const start = text.indexOf(`\n${marker} ${title}\n`);
  expect(start, `section ${title}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(`\n${marker} `, start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** `text` with every run of whitespace folded to one space. */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The sentences of `text`: paragraphs and list items split apart, line
 * breaks folded, then split after a full stop followed by a space.
 */
function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n|\n\s*[-*] /)
    .map(fold)
    .flatMap((p) => p.split(/(?<=\.)\s+/))
    .filter((s) => s.length > 0);
}

/** Whether one sentence of `text` matches every pattern. */
function oneSentence(text: string, ...patterns: RegExp[]): boolean {
  return sentences(text).some((s) => patterns.every((p) => p.test(s)));
}

/** "Watching the board in a browser" without its "Security model" subsection. */
function browserSection(): string {
  const whole = section(read(README), 'Watching the board in a browser');
  const security = section(whole, 'Security model', 3);
  return whole.replace(security, '\n');
}

/** The "Script in the page" bullet of the security model. */
function scriptInThePage(): string {
  const security = section(read(README), 'Security model', 3);
  const start = security.indexOf('- **Script in the page.**');
  expect(start, 'the Script in the page bullet').toBeGreaterThanOrEqual(0);
  const end = security.indexOf('\n- ', start + 1);
  return security.slice(start, end < 0 ? undefined : end);
}

/** The ADR files numbered 0015. */
function adr0015Files(): string[] {
  return readdirSync(ADR_DIR).filter((name) => /^0015-.+\.md$/.test(name));
}

/** The text of the single ADR 0015. */
function adr0015(): string {
  const files = adr0015Files();
  expect(files, 'exactly one adr/0015-*.md').toHaveLength(1);
  return read(join(ADR_DIR, files[0] ?? ''));
}

describe('README.md "Watching the board in a browser" documents Markdown descriptions', () => {
  it('says a description is rendered as Markdown: CommonMark plus the four GitHub extensions', () => {
    const text = browserSection();
    expect(oneSentence(text, /description/i, /Markdown/)).toBe(true);
    expect(text).toContain('CommonMark');
    expect(text).toMatch(/tables/i);
    expect(text).toMatch(/task lists?/i);
    expect(text).toMatch(/strikethrough/i);
    expect(text).toMatch(/autolinks?/i);
  });

  it('says it is rendered into elements only, never as HTML, and raw HTML is shown literally', () => {
    const text = browserSection();
    expect(oneSentence(text, /elements/, /never[^.]*HTML/)).toBe(true);
    expect(oneSentence(text, /raw HTML/i, /literal|as (plain )?text|as written/i)).toBe(true);
  });

  it('names the three link schemes, the new tab and no opener and no referrer', () => {
    const text = browserSection();
    expect(fold(text)).toMatch(/`?http:?`?, `?https:?`?,? (?:and|or) `?mailto:?`?/);
    expect(text).toMatch(/new (tab|window|browsing context)/i);
    expect(text).toMatch(/no ?opener|noopener/i);
    expect(text).toMatch(/no ?referrer|noreferrer/i);
  });

  it('says images are never loaded and appear as links labelled with their alt text', () => {
    const text = browserSection();
    expect(oneSentence(text, /image/i, /\b(never|not)\b[^.]*\b(load|fetch|request)/i)).toBe(true);
    expect(oneSentence(text, /link/i, /alt text/i)).toBe(true);
  });

  it('says task list checkboxes cannot be changed', () => {
    const text = browserSection();
    expect(oneSentence(
      text,
      /checkbox/i,
      /cannot be (changed|ticked|toggled|edited|clicked)|can't be (changed|ticked|toggled)|disabled|read-only/i,
    )).toBe(true);
  });

  it('names both caps that fall back to text: 32 levels of nesting and 16384 characters', () => {
    const text = browserSection();
    expect(oneSentence(text, /\b32\b/, /nest/i, /text/i)).toBe(true);
    expect(oneSentence(text, /\b16,?384\b/, /characters/i, /text/i)).toBe(true);
  });

  it('keeps titles, labels, comments and notes plain text, and top unchanged', () => {
    const text = browserSection();
    expect(oneSentence(text, /titles?/i, /labels?/i, /comments?/i, /notes?/i, /plain text|as text/i)).toBe(true);
    expect(oneSentence(
      text,
      /`top`|agentboard top|terminal UI/,
      /unchanged|plain text|not (rendered|changed|affected)|no Markdown/i,
    )).toBe(true);
  });
});

describe('README.md security model, "Script in the page"', () => {
  it('no longer claims anywhere that board text is never rendered as markup', () => {
    expect(fold(read(README))).not.toMatch(/board text is never rendered as markup/i);
  });

  it('says the description becomes elements from an allow-list and no HTML string is inserted', () => {
    const bullet = scriptInThePage();
    expect(bullet).toMatch(/description/i);
    expect(bullet).toContain('Markdown');
    expect(bullet).toMatch(/elements/);
    expect(bullet).toMatch(/allow-?list/i);
    expect(fold(bullet)).toMatch(/\b(no|never)\b[^.]*HTML string|HTML string[^.]*\b(never|no)\b/i);
  });

  it('names the guard test that scans the client source for innerHTML', () => {
    const bullet = scriptInThePage();
    expect(bullet).toContain('innerHTML');
    expect(bullet).toMatch(/\btests?\b/i);
    for (const path of bullet.match(/src\/[\w/.-]+\.test\.tsx?/g) ?? []) {
      expect(existsSync(join(ROOT, path)), `${path} exists`).toBe(true);
    }
  });

  it('says the Content-Security-Policy and the token handling are unchanged', () => {
    const bullet = scriptInThePage();
    expect(bullet).toMatch(/Content-Security-Policy|CSP/);
    expect(bullet).toContain('sessionStorage');
    expect(bullet).toMatch(/unchanged|still|as before|not changed/i);
  });
});

describe('ADR 0015 records the decision', () => {
  it('exists as one adr/0015-*.md in plain ASCII', () => {
    expect(adr0015Files()).toHaveLength(1);
    expect(NON_ASCII.test(adr0015()), 'plain ASCII').toBe(false);
  });

  it('has the house title, date and headings in order', () => {
    const text = adr0015();
    expect(text).toMatch(/^# 15\. [^\n]*Markdown/);
    expect(text).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/m);
    const headings = text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
    expect(headings).toEqual(ADR_HEADINGS);
    expect(section(text, 'Status')).toMatch(/Accepted/);
  });

  it('amends ADR 0006 and says what changes in its reasoning', () => {
    const text = adr0015();
    expect(section(text, 'Status')).toMatch(/Amends ADR 0006/);
    const folded = fold(text);
    expect(folded).toMatch(/never rendered as markup/i);
    expect(folded).toMatch(/never[^.]*(inserted|insert)[^.]*as HTML|never inserted[^.]*HTML/i);
    expect(folded).toMatch(/rendered (to|into|as) [^.]*elements/i);
  });

  it('states the facts of the decision: mdast, the schemes, images and the two caps', () => {
    const folded = fold(adr0015());
    expect(folded).toMatch(/mdast/);
    expect(folded).toMatch(/`?http:?`?, `?https:?`?,? (?:and|or) `?mailto:?`?/);
    expect(folded).toMatch(/image/i);
    expect(folded).toMatch(/\b32\b/);
    expect(folded).toMatch(/\b16,?384\b/);
  });

  it('names the rejected alternatives: a sanitizer with innerHTML, marked, and a hand-written parser', () => {
    const alternatives = fold(section(adr0015(), 'Alternatives considered'));
    expect(alternatives).toMatch(/saniti[sz]er|DOMPurify/i);
    expect(alternatives).toMatch(/innerHTML/);
    expect(alternatives).toMatch(/\bmarked\b/);
    expect(alternatives).toMatch(/hand-?written|own parser/i);
    expect(alternatives.match(/Rejected/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe('the ADR index and ADR 0006', () => {
  it('lists 0015 with a Markdown title, linking the file that exists', () => {
    const files = adr0015Files();
    expect(files).toHaveLength(1);
    const entry = /^- \[0015\. ([^\]]*)\]\((0015-[^)]+\.md)\)$/m.exec(read(ADR_INDEX));
    expect(entry, 'the 0015 entry of adr/README.md').not.toBeNull();
    expect(entry?.[1]).toMatch(/Markdown/);
    expect(entry?.[2]).toBe(files[0]);
  });

  it('marks ADR 0006 as amended by ADR 0015, as ADR 0001 is by ADR 0012', () => {
    const status = section(read(ADR_0006), 'Status');
    expect(status).toMatch(/Accepted/);
    expect(status).toMatch(/Amended by ADR 0015/);
  });
});

describe('STATUS.md records Markdown descriptions', () => {
  it('lists Markdown descriptions under What exists, naming ADR 0015 and the archive', () => {
    const exists = section(read(STATUS), 'What exists');
    const entry = exists.split(/\n- /).find((item) => /Markdown/.test(item));
    expect(entry, 'the Markdown descriptions entry').toBeDefined();
    const text = fold(entry ?? '');
    expect(text).toMatch(/description/i);
    expect(text).toContain('`board-web`');
    expect(text).toContain('ADR 0015');
    expect(text).toContain('add-description-markdown');
    expect(text).toMatch(/archiv/i);
  });

  it('no longer lists add-description-markdown as proposed under What is next', () => {
    const next = fold(section(read(STATUS), 'What is next'));
    expect(next).not.toMatch(/`add-description-markdown` \(proposed/);
    if (next.includes('add-description-markdown')) {
      expect(next).toMatch(/`add-description-markdown` \(in progress/);
    }
  });
});

describe('the change tasks', () => {
  it('names ADR 0015 in task 2.1, not ADR 0012', () => {
    const line = read(TASKS).split('\n').find((l) => /^- \[[ x]\] 2\.1 /.test(l));
    expect(line, 'task 2.1').toBeDefined();
    expect(line).toContain('ADR 0015');
    expect(line).not.toContain('ADR 0012');
  });
});

describe('every file of this group is plain ASCII', () => {
  it.each([
    ['README.md', README],
    ['STATUS.md', STATUS],
    ['adr/README.md', ADR_INDEX],
    ['adr/0006', ADR_0006],
    ['tasks.md', TASKS],
    ['this test', SELF],
  ])('%s', (_name, path) => {
    expect(NON_ASCII.test(read(path)), 'plain ASCII').toBe(false);
  });
});
