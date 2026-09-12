/**
 * tsdown build for dsh-typst-preview, replicating the DSH client-bundle preset:
 *  - host half: lib/index.js (ESM, node),
 *  - browser half: lib/client.js (CJS closure factory registered through
 *    `window.__ModuleLoader__.load({ id, factory })`; react and the shared UI
 *    primitives stay external and resolve through the loader module table).
 * Types ship from lib/types via `tsc -p tsconfig.build.json`.
 */

import type { UserConfig } from 'tsdown'

/** Module specifiers the web shell shares into its frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
]

function clientBundle(pluginId: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    inputOptions: {
      resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  }
}

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    // Standalone copies of the host internals, so `scripts/smoke.mjs` can drive
    // the proxy and the highlighter against real `tinymist` processes without
    // booting DSH.
    entry: {
      'dev/host-proxy': 'src/host/proxy.ts',
      'dev/host-tinymist': 'src/host/tinymist.ts',
      'dev/host-highlight': 'src/host/highlight.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  clientBundle('dsh-typst-preview'),
] satisfies UserConfig[]
