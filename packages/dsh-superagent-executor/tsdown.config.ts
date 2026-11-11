import { defineConfig } from 'tsdown'

// Node-only bundle: this package hosts the worker execution layer -- cc-worker supervision,
// budget enforcement and run-state readers. It has no client half, so a single ESM build.
export default defineConfig({
  entry: { index: 'src/index.ts', guard: 'src/guard.ts', state: 'src/state.ts' },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
