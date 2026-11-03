import { defineConfig } from 'tsdown'

// Two builds: the Node plugins (panel source kind + HTTP routes, and the ticket tidy sweeper) and the browser panel
// (sidebar icon + dispatch view). The browser build mirrors dsh-superagent's own client wrapper so the panel's module
// loader can mount it.
export default defineConfig([
  {
    entry: { index: 'src/index.ts', tidy: 'src/tidy.ts', guard: 'src/guard-entry.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^dsh-superagent/, /^@deepseek-ai\//, 'zod'] },
  },
  {
    entry: { client: 'src/client.tsx' },
    outDir: 'lib',
    format: 'cjs',
    fixedExtension: false,
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent-pane", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])