import { defineConfig } from 'tsdown'

// 仅 Node 侧：本插件不提供浏览器面板，只注册工具。
// zod 打进产物 —— 插件要能被单独安装，不能指望使用者那边正好有同版本的 zod。
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
])