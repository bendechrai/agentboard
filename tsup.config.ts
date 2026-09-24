import { defineConfig } from 'tsup';

// node:sqlite exists only under its node: name, so the prefix must be kept
// (tsup strips node: prefixes by default).
//
// The third entry is the browser front end of `agentboard serve`
// (add-board-web task 4.1): `src/web/client/main.tsx` bundled for the
// browser with everything inlined (Preact included, so it stays a
// devDependency) into one minified `dist/web/app.js`, with no chunks and no
// source map. `publicDir` copies `index.html` and `app.css` from
// `src/web/client/public/` beside it. The server serves `dist/web/` (the
// directory `web` next to the CLI bundle).

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'es2022',
    removeNodeProtocol: false,
    dts: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    removeNodeProtocol: false,
    dts: true,
  },
  {
    entry: { app: 'src/web/client/main.tsx' },
    outDir: 'dist/web',
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    tsconfig: 'src/web/client/tsconfig.json',
    minify: true,
    splitting: false,
    sourcemap: false,
    dts: false,
    noExternal: [/.*/],
    publicDir: 'src/web/client/public',
    esbuildOptions(options) {
      options.jsx = 'automatic';
      options.jsxImportSource = 'preact';
    },
  },
]);
