/**
 * The built front end and its tool coverage (board-web: "Self-contained
 * front end", scenario "No external requests"):
 * `make build` produces `dist/web/index.html`, `app.js` and `app.css`, the
 * bundle inlines everything, no built asset names another host, `npm run
 * typecheck` and `npm run lint` cover the client project, and
 * `npm pack --dry-run` lists `dist/web/` with no new runtime dependency.
 *
 * These tests read the build output: `make check` builds before it tests.
 *
 * Design note: the bundle
 * inlines Preact, which holds the XML namespace names of SVG, MathML and
 * XHTML (`http://www.w3.org/...`). They are identifiers compared with
 * `namespaceURI`, never requested, so the scan allows exactly those
 * namespace names (`NAMESPACE_URIS`) and nothing else.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIST_WEB = join(ROOT, 'dist', 'web');
const CLIENT = join(ROOT, 'src', 'web', 'client');

/** XML namespace names: identifiers, never fetched. */
const NAMESPACE_URIS = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
]);

/**
 * Every `http://` or `https://` URL in `text` that names a host (anything
 * but a bare scheme), except the allowed namespace names.
 */
function externalUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>()\\,;]*/gi)) {
    const url = match[0].replace(/[.]+$/, '');
    if (/^https?:\/\/$/i.test(url) || NAMESPACE_URIS.has(url)) {
      continue;
    }
    found.push(url);
  }
  return found;
}

function builtFiles(): string[] {
  if (!existsSync(DIST_WEB)) {
    throw new Error('dist/web does not exist: run `npm run build` (make check builds first)');
  }
  return readdirSync(DIST_WEB).sort();
}

describe('the scanner', () => {
  it('finds URLs naming a host and allows only namespace names', () => {
    expect(
      externalUrls(
        [
          'a="http://example.com/x.js"',
          "b='https://cdn.example.org'",
          'c=`http://127.0.0.1:8080/`',
          'd="http://www.w3.org/2000/svg"',
          'e="https://www.w3.org/2000/svg"',
          'f="http://"+host',
          'url(https://fonts.example/f.woff)',
        ].join(';'),
      ),
    ).toEqual([
      'http://example.com/x.js',
      'https://cdn.example.org',
      'http://127.0.0.1:8080/',
      'https://www.w3.org/2000/svg',
      'https://fonts.example/f.woff',
    ]);
  });
});

describe('dist/web', () => {
  it('holds exactly index.html, app.js and app.css', () => {
    expect(builtFiles()).toEqual(['app.css', 'app.js', 'index.html']);
    for (const name of builtFiles()) {
      expect(readFileSync(join(DIST_WEB, name), 'utf8').length, name).toBeGreaterThan(0);
    }
  });

  it('copies index.html and app.css from the client sources', () => {
    for (const name of ['index.html', 'app.css']) {
      expect(readFileSync(join(DIST_WEB, name), 'utf8')).toBe(
        readFileSync(join(CLIENT, 'public', name), 'utf8'),
      );
    }
  });

  it('has a page that loads the bundle and the stylesheet from its own origin only', () => {
    const html = readFileSync(join(DIST_WEB, 'index.html'), 'utf8');
    expect(html).toMatch(/<script[^>]*\btype="module"[^>]*\bsrc="\/app\.js"[^>]*><\/script>/);
    expect(html).toMatch(/<link[^>]*\brel="stylesheet"[^>]*\bhref="\/app\.css"/);
    expect(html).toMatch(/<div id="app"><\/div>/);
    // The CSP allows no inline script or style.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it('bundles the client with everything inlined', () => {
    const js = readFileSync(join(DIST_WEB, 'app.js'), 'utf8');
    expect(js).not.toMatch(/\bimport\s*[\w{*][^;]*?\bfrom\s*["']/);
    expect(js).not.toMatch(/\bimport\s*\(\s*["']/);
    expect(js).not.toMatch(/\bimport\s*["']/);
    expect(js).not.toMatch(/\brequire\s*\(/);
    expect(js).not.toContain('node:');
    expect(js).not.toContain('not implemented');
  });

  it('contains no http:// or https:// URL naming a host (scenario "No external requests")', () => {
    for (const name of builtFiles()) {
      expect(externalUrls(readFileSync(join(DIST_WEB, name), 'utf8')), name).toEqual([]);
    }
  });
});

describe('tooling covers the client', () => {
  it('typechecks the client as its own project with the DOM library and no Node types', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['typecheck']).toMatch(/tsc\b[^&]*--noEmit/);
    expect(pkg.scripts['typecheck']).toMatch(/-p src\/web\/client\b/);

    const config = JSON.parse(readFileSync(join(CLIENT, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { lib: string[]; jsxImportSource: string; types: string[] };
    };
    expect(config.compilerOptions.lib).toContain('DOM');
    expect(config.compilerOptions.jsxImportSource).toBe('preact');

    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const listed = execFileSync(
      process.execPath,
      [tsc, '-p', join(CLIENT, 'tsconfig.json'), '--listFilesOnly'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    for (const name of ['main.tsx', 'App.tsx', 'client.ts', 'api.ts', 'hash.ts']) {
      expect(
        listed.some((file) => file.endsWith(`/src/web/client/${name}`)),
        name,
      ).toBe(true);
    }
    expect(listed.some((file) => file.includes('/@types/node/'))).toBe(false);
    expect(listed.some((file) => file.endsWith('/lib.dom.d.ts'))).toBe(true);
  }, 60_000);

  it('keeps the client out of the Node project', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as {
      exclude?: string[];
    };
    expect(config.exclude).toContain('src/web/client');
  });

  it('lints the client sources with the type-aware rules', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const files = ['App.tsx', 'client.ts', 'views/BoardView.tsx', '__tests__/app.test.tsx'].map(
      (name) => join(CLIENT, name),
    );
    for (const file of files) {
      expect(await eslint.isPathIgnored(file), file).toBe(false);
      const config = (await eslint.calculateConfigForFile(file)) as {
        rules?: Record<string, unknown>;
      };
      expect(config.rules?.['@typescript-eslint/no-explicit-any'], file).toEqual([2]);
    }
    const results = await eslint.lintFiles(files);
    for (const result of results) {
      expect(
        result.messages.filter((m) => m.fatal === true).map((m) => m.message),
        result.filePath,
      ).toEqual([]);
    }
  }, 60_000);
});

describe('package', () => {
  it('packs dist/web and adds no runtime dependency', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const packed = JSON.parse(out) as { files: { path: string }[] }[];
    const paths = (packed[0]?.files ?? []).map((f) => f.path);
    for (const name of ['index.html', 'app.js', 'app.css']) {
      expect(paths, name).toContain(`dist/web/${name}`);
    }

    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      '@modelcontextprotocol/sdk',
      'yaml',
      'zod',
    ]);
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    for (const name of ['preact', '@testing-library/preact', 'happy-dom']) {
      expect(pkg.devDependencies?.[name], name).toBeDefined();
    }
  }, 60_000);
});
