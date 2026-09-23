import { defineConfig } from 'tsup';

// node:sqlite exists only under its node: name, so the prefix must be kept
// (tsup strips node: prefixes by default).

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
]);
