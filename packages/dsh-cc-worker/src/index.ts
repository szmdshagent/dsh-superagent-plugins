/**
 * dsh-cc-worker：给 superagent 提供 Claude Code 执行能力的配套插件。
 *
 * 两种执行模式，按配置切换：
 *   1. 自带执行器（默认）：插件内部直接管理会话与 claude 进程，不依赖任何外部脚本。
 *      别人装了这个插件就能用 —— 这是它能独立分发的关键。
 *   2. 外部脚本（可选）：配置 legacyScript 指向本机的 cc-worker，
 *      保留原有 cctrim / 预算裁决 / team 协调 / handoff 等本机特有能力。
 *
 * 为什么做成工具插件而不是替换 Executor：
 *  主包的 Executor 在 src/app/runtime.ts 里是直接 new DshExecutor(...)，没有扩展点；
 *  而 ctx.tools.register() 是官方支持的 agent 作用域工具注册口，
 *  所以把「怎么干活」做成工具，既拿到插件生命周期，也不碰主包源码、升级不丢。
 */
import { writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { runClaude, type RunRequest, type RunnerConfig } from './runner.ts'
import { runWorker as runLegacy, type RunOptions } from './exec.ts'

export const name = 'dsh-cc-worker'
export const inject = ['tools']

/** 插件配置；全部可在 cordis.patch.yml 的 config 里覆盖。 */
export interface Config {
  /** 允许的工作目录根。默认 ~/.dsh/state/superagent/work。 */
  workRoot?: string
  /** claude 可执行文件，默认 PATH 里的 claude。 */
  claudeBin?: string
  /** 是否跳过权限审批。默认 false；无人值守部署才设为 true。 */
  skipPermissions?: boolean
  /** 额外 claude 参数。 */
  extraArgs?: string[]
  defaultTimeoutS?: number
  defaultMaxTurns?: number
  /** 同时在跑的任务上限。 */
  maxConcurrent?: number
  /** 设为路径时改调本机 cc-worker 脚本，获得该脚本特有的 cctrim / team / handoff 能力。 */
  legacyScript?: string
  /** 设为 true 时在 /tmp/dsh-cc-worker.loaded 写一条加载标记，便于确认插件已挂载。 */
  loadMarker?: boolean
}

const DEFAULTS = {
  workRoot: process.env.HOME ? process.env.HOME + '/.dsh/state/superagent/work' : '/tmp/dsh-work',
  claudeBin: 'claude',
  skipPermissions: false,
  extraArgs: [] as string[],
  defaultTimeoutS: 1800,
  defaultMaxTurns: 40,
  maxConcurrent: 3,
  loadMarker: false,
}

/** 在跑的任务：id → 句柄。 */
const running = new Map<string, { startedAt: number; dir: string; abort: AbortController }>()

const taskId = (): string => 'ccw-' + Math.random().toString(36).slice(2, 10)

/**
 * 输出契约：宿主强制要求每个工具声明 output。
 * 本插件的返回值都是 JSON 对象，统一按 JSON 文本投影给模型，内容不裁剪。
 */
const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

export function apply (ctx: Context, config: Config = {}): void {
  const settings = { ...DEFAULTS, ...config }
  const logger = (ctx as any).logger
  if (settings.loadMarker) {
    try { writeFileSync('/tmp/dsh-cc-worker.loaded', new Date().toISOString() + ' ' + JSON.stringify(settings) + '\n') } catch { /* 忽略 */ }
  }
  const disposers: Array<() => void> = []
  const runnerConfig: RunnerConfig = {
    workRoot: settings.workRoot,
    claudeBin: settings.claudeBin,
    skipPermissions: settings.skipPermissions,
    extraArgs: settings.extraArgs,
    defaultTimeoutS: settings.defaultTimeoutS,
    defaultMaxTurns: settings.defaultMaxTurns,
  }

  const runSchema = z.object({
    task: z.string().min(1).describe('任务描述，写清目标、素材路径、验收口径。'),
    dir: z.string().optional().describe('工作目录；缺省用 workRoot 根。'),
    lane: z.string().optional().describe('并行分道名（字母数字-_），不同道各自独立会话。'),
    fresh: z.boolean().optional().describe('true 表示强制新开会话，不续跑上次的。'),
    model: z.string().optional().describe('模型名，透传给 claude。'),
    timeout_s: z.number().int().positive().optional().describe('超时秒数，默认 ' + settings.defaultTimeoutS + '。'),
    max_turns: z.number().int().positive().optional().describe('最大轮数，默认 ' + settings.defaultMaxTurns + '。'),
  }).strict()

  disposers.push((ctx as any).tools.register({
    name: 'ccw_run',
    description: '把一项实质执行工作交给 Claude Code 运行：脚本编写与运行、测量、构建、数据分析、批量改动。'
      + '会阻塞到任务结束或超时。返回 {ok, result, session_id, cost_usd, duration_s, log}。',
    parameters: z.toJSONSchema(runSchema),
    output: textOutput,
    execute: async (args: unknown, exec: any) => {
      const input = runSchema.parse(args)
      if (running.size >= settings.maxConcurrent) {
        return { ok: false, error: '并发已达上限 ' + settings.maxConcurrent + '，请等现有任务结束' }
      }
      const id = taskId()
      const abort = new AbortController()
      if (exec?.signal) {
        if (exec.signal.aborted) abort.abort()
        else exec.signal.addEventListener('abort', () => abort.abort(), { once: true })
      }
      const dir = input.dir ?? settings.workRoot
      running.set(id, { startedAt: Date.now(), dir, abort })
      try {
        if (settings.legacyScript) {
          // 兼容路径：交给本机 cc-worker 脚本，保留 cctrim / team / handoff 等本机特有能力。
          const options: RunOptions = {
            task: input.task, dir: input.dir, fresh: input.fresh, model: input.model,
            timeoutS: input.timeout_s, maxTurns: input.max_turns,
          }
          return { task_id: id, ...(await runLegacy(options, abort.signal)) }
        }
        const request: RunRequest = {
          task: input.task, dir, lane: input.lane, fresh: input.fresh, model: input.model,
          timeoutS: input.timeout_s, maxTurns: input.max_turns,
        }
        return { task_id: id, ...(await runClaude(runnerConfig, request, abort.signal)) }
      } finally {
        running.delete(id)
      }
    },
  }))

  disposers.push((ctx as any).tools.register({
    name: 'ccw_status',
    description: '列出当前在跑的 cc-worker 任务：id、已运行秒数、工作目录。没有任务时返回空数组。',
    parameters: z.toJSONSchema(z.object({})),
    output: textOutput,
    execute: async () => ({
      running: [...running.entries()].map(([id, info]) => ({
        task_id: id, elapsed_s: Math.round((Date.now() - info.startedAt) / 1000), dir: info.dir,
      })),
      max_concurrent: settings.maxConcurrent,
      mode: settings.legacyScript ? 'legacy-script' : 'builtin',
    }),
  }))

  const killSchema = z.object({
    task_id: z.string().optional().describe('要中断的任务 id；省略表示全部。'),
  }).strict()

  disposers.push((ctx as any).tools.register({
    name: 'ccw_kill',
    description: '中断一个在跑的 cc-worker 任务。传 task_id；不传则中断全部。',
    parameters: z.toJSONSchema(killSchema),
    output: textOutput,
    execute: async (args: unknown) => {
      const input = killSchema.parse(args)
      const targets = input.task_id ? [input.task_id] : [...running.keys()]
      const killed: string[] = []
      for (const id of targets) {
        const info = running.get(id)
        if (!info) continue
        info.abort.abort()
        killed.push(id)
      }
      return { killed, running: [...running.keys()] }
    },
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) { try { dispose() } catch { /* 已卸载 */ } }
    for (const info of running.values()) { try { info.abort.abort() } catch { /* 已结束 */ } }
    running.clear()
  })

  logger?.info?.('dsh-cc-worker ready: %s 模式，ccw_run / ccw_status / ccw_kill 已注册',
    settings.legacyScript ? 'legacy-script' : 'builtin')
}

// 导出执行器内部函数，便于测试与二次封装。
export { buildClaudeArgs, parseStreamLog, runClaude, stateBase, validateRequest } from './runner.ts'
export type { RunRequest, RunResult, RunnerConfig } from './runner.ts'