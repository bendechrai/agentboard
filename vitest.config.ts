import { defineConfig } from 'vitest/config';

// Component tests of the web client (add-board-web group 4) run in
// `happy-dom`, selected per file with a `// @vitest-environment happy-dom`
// comment on the first line (design.md, "Testing strategy"); every other
// test file keeps the default Node environment, so there is one project and
// one coverage run. Client `.tsx` files are compiled with Preact's
// automatic JSX runtime, as the build does.
//
// Coverage: the client source under `src/web/client/` counts toward the
// thresholds below like every other module; nothing is excluded for it.
// Its bootstrap (`main.tsx`) is imported by a component test, and the
// component tests drive every view through the real `App`.

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
