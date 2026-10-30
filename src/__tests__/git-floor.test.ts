/**
 * The git floor check (add-board-sharing task 6.1; design.md decision 3):
 * `make check-git-floor` runs the sharing tests in a container whose git is
 * the oldest release the host model supports, so this file pins what that
 * target relies on and cannot verify by itself: that the floor constant,
 * the Makefile's `GIT_FLOOR` and the `dev-git-floor` image's `GIT_VERSION`
 * agree; that `gitVersion` reports exactly the floor under a shim that
 * prints it; that every file the Makefile's `SHARING_TESTS` names exists
 * and no sharing test file is missing from the list, so the target cannot
 * silently run nothing or skip a file; that the Dockerfile's git build
 * step is implemented; and that CONTRIBUTING.md lists the target.
 *
 * The behavior on a git older than the floor is pinned where it belongs
 * and is not repeated here: `init` in a git host under a 2.31 shim takes
 * the standalone fallback with the "git 2.32 or later" message
 * (`src/board/__tests__/init.test.ts`, "scenario: init with an old git");
 * `sync` on a host-model board exits 1 `git-too-old` staging nothing
 * (`src/board/__tests__/host-sync.test.ts` and
 * `src/cli/__tests__/host-sync-cli.test.ts`, "exits 1 git-too-old");
 * `init --into-host` exits 1 `git-too-old` on every board
 * (`src/board/__tests__/into-host.test.ts`); `remote` reports the old git
 * as a problem (`src/board/__tests__/remote.test.ts`); `init --remote`
 * makes the same standalone board on 2.31.8
 * (`src/board/__tests__/init-remote.test.ts`); and 2.32.0 exactly meets
 * the floor for `init`, `sync` and the move (the same files).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HOST_MODEL_GIT_FLOOR, gitVersion, meetsGitFloor } from '../board/git.js';
import { withGitShim } from '../board/__tests__/sharing-helpers.js';
import { syncEnv } from '../board/__tests__/sync-helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8');
const COMPOSE = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile.dev'), 'utf8');
const CONTRIBUTING = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');

/** The floor as `<major>.<minor>`. */
const FLOOR = `${String(HOST_MODEL_GIT_FLOOR.major)}.${String(HOST_MODEL_GIT_FLOOR.minor)}`;

/**
 * The sharing test files that `SHARING_TESTS` must name, relative to the
 * repository root: every test file of groups 1 to 5 that runs git on a
 * board, the no-echo tests of `init --remote` and of git lines quoted
 * from remote commands (no-echo-refusals group 2),
 * plus this file.
 */
const REQUIRED_SHARING_TESTS = [
  'src/board/__tests__/git.test.ts',
  'src/board/__tests__/model.test.ts',
  'src/board/__tests__/init.test.ts',
  'src/board/__tests__/host-init.test.ts',
  'src/board/__tests__/sync.test.ts',
  'src/board/__tests__/host-sync.test.ts',
  'src/board/__tests__/standalone-sync-fixture.test.ts',
  'src/board/__tests__/init-remote.test.ts',
  'src/board/__tests__/init-remote-no-echo.test.ts',
  'src/board/__tests__/remote-line-no-echo.test.ts',
  'src/board/__tests__/into-host.test.ts',
  'src/board/__tests__/remote.test.ts',
  'src/cli/__tests__/init-cli.test.ts',
  'src/cli/__tests__/sync-cli.test.ts',
  'src/cli/__tests__/host-sync-cli.test.ts',
  'src/cli/__tests__/init-remote-cli.test.ts',
  'src/cli/__tests__/init-remote-no-echo-cli.test.ts',
  'src/cli/__tests__/sync-no-echo-cli.test.ts',
  'src/cli/__tests__/remote-config-no-echo-cli.test.ts',
  'src/cli/__tests__/later-steps-no-echo-cli.test.ts',
  'src/cli/__tests__/success-no-echo-cli.test.ts',
  'src/cli/__tests__/into-host-cli.test.ts',
  'src/cli/__tests__/remote-cli.test.ts',
  'src/__tests__/host-sync-clones.test.ts',
  'src/__tests__/host-sync-crash.test.ts',
  'src/__tests__/host-sync-writers.test.ts',
  'src/__tests__/into-host-clones.test.ts',
  'src/__tests__/into-host-race.test.ts',
  'src/__tests__/git-floor.test.ts',
];

/**
 * The value of a `NAME := ...` assignment in `makefile`, with backslash
 * continuations joined; null when the variable is not assigned.
 */
function makeVariable(makefile: string, name: string): string | null {
  const joined = makefile.replace(/\\\n/g, ' ');
  const match = new RegExp(`^${name}\\s*:=[ \\t]*(.*)$`, 'm').exec(joined);
  return match === null ? null : (match[1] ?? '').trim();
}

/** The recipe lines of `target` in `makefile`, continuations joined, as one string. */
function makeRecipe(makefile: string, target: string): string {
  const joined = makefile.replace(/\\\n/g, ' ');
  const match = new RegExp(`^${target}:[^\\n]*\\n((?:\\t[^\\n]*\\n?)+)`, 'm').exec(joined);
  return match?.[1] ?? '';
}

/** The build arguments of the compose service `name`, as `key: value` pairs. */
function composeBuildArgs(compose: string, name: string): Record<string, string> {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name} in docker-compose.yml`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const end = rest.slice(1).search(/\n(?: {2}\S|\S)/);
  const service = end === -1 ? rest : rest.slice(0, end + 1);
  const args: Record<string, string> = {};
  for (const match of service.matchAll(/^ {8}([A-Z_]+):[ \t]*(\S+)[ \t]*$/gm)) {
    args[match[1] ?? ''] = match[2] ?? '';
  }
  return args;
}

describe('the git floor constant, the Makefile and the dev-git-floor image agree', () => {
  it('HOST_MODEL_GIT_FLOOR is 2.32 (design.md decision 3)', () => {
    expect(HOST_MODEL_GIT_FLOOR).toEqual({ major: 2, minor: 32 });
  });

  it('gitVersion reports exactly the floor under a shim printing it, and meetsGitFloor agrees', () => {
    const atFloor = gitVersion(withGitShim(syncEnv(), `${FLOOR}.0`));
    expect(atFloor).toEqual({ ...HOST_MODEL_GIT_FLOOR, patch: 0 });
    expect(atFloor !== null && meetsGitFloor(atFloor)).toBe(true);
    const below = gitVersion(withGitShim(syncEnv(), '2.31.8'));
    expect(below).toEqual({ major: 2, minor: 31, patch: 8 });
    expect(below !== null && meetsGitFloor(below)).toBe(false);
  });

  it('the Makefile GIT_FLOOR is the constant', () => {
    expect(makeVariable(MAKEFILE, 'GIT_FLOOR')).toBe(FLOOR);
  });

  it('the dev-git-floor service builds the floor Node with a GIT_VERSION on the floor line', () => {
    const args = composeBuildArgs(COMPOSE, 'dev-git-floor');
    const floorArgs = composeBuildArgs(COMPOSE, 'dev-floor');
    expect(args.NODE_IMAGE, 'the same Node image as dev-floor').toBe(floorArgs.NODE_IMAGE);
    expect(args.NODE_IMAGE).toMatch(/^node:22\.16\.\d+-/);
    expect(args.GIT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(args.GIT_VERSION?.startsWith(`${FLOOR}.`), `GIT_VERSION ${args.GIT_VERSION ?? ''} on the ${FLOOR} line`).toBe(true);
    expect(COMPOSE).toContain('node-modules-git-floor-cache:/workspace/node_modules');
  });

  it('Dockerfile.dev takes GIT_VERSION and builds that git from source (the step is implemented)', () => {
    expect(DOCKERFILE).toMatch(/^ARG GIT_VERSION=""$/m);
    // The step is a stub until the implementer fills it (the TODO marker
    // and the "not implemented" exit go together).
    expect(DOCKERFILE).not.toContain('not implemented');
    expect(DOCKERFILE).not.toContain('TODO(implementer-6)');
    // It must run as root, before the switch to the dev user.
    const argAt = DOCKERFILE.indexOf('ARG GIT_VERSION');
    const userAt = DOCKERFILE.indexOf('\nUSER dev');
    expect(argAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(argAt);
    // It fetches a release tarball of exactly GIT_VERSION.
    expect(DOCKERFILE).toMatch(/git-\$\{GIT_VERSION\}\.tar/);
  });
});

describe('make check-git-floor runs the sharing tests, all of which exist', () => {
  const listed = (makeVariable(MAKEFILE, 'SHARING_TESTS') ?? '').split(/\s+/).filter((p) => p !== '');

  it('SHARING_TESTS names only plain paths that exist on disk', () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const path of listed) {
      expect(path, 'no patterns or variables').not.toMatch(/[*?$]/);
      expect(path).toMatch(/\.test\.ts$/);
      expect(existsSync(join(ROOT, path)), `${path} exists`).toBe(true);
    }
    expect(new Set(listed).size, 'no duplicates').toBe(listed.length);
  });

  it('SHARING_TESTS includes every sharing test file', () => {
    for (const path of REQUIRED_SHARING_TESTS) {
      expect(listed, path).toContain(path);
    }
  });

  it('check-git-floor builds dev-git-floor, checks the git on the PATH is on the floor line and runs test-sharing', () => {
    const recipe = makeRecipe(MAKEFILE, 'check-git-floor');
    expect(recipe).toContain('docker compose run --rm --build dev-git-floor');
    expect(recipe).toContain('git --version');
    expect(recipe).toContain('"git version $(GIT_FLOOR)."');
    expect(recipe).toContain('make install');
    expect(recipe).toContain('make test-sharing');
    expect(recipe).toContain('docker compose down --volumes --remove-orphans');
  });

  it('test-sharing runs vitest on SHARING_TESTS without coverage', () => {
    const recipe = makeRecipe(MAKEFILE, 'test-sharing');
    expect(recipe).toContain('vitest run $(SHARING_TESTS)');
    expect(recipe).not.toContain('--coverage');
  });

  it('CONTRIBUTING.md "Checks" lists make check-git-floor for changes that touch sharing', () => {
    const start = CONTRIBUTING.indexOf('## Checks');
    expect(start).toBeGreaterThan(-1);
    const rest = CONTRIBUTING.slice(start + '## Checks'.length);
    const section = rest.slice(0, rest.search(/\n## /));
    expect(section).toContain('`make check-git-floor`');
    expect(section).toContain('git 2.32');
    expect(section).toContain('sharing');
    expect(section).toContain('`make test-sharing`');
  });
});
