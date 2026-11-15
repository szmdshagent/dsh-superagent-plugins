/**
 * cc-worker 执行层：把任务交给 Claude Code（无头模式）。
 *
 * 阶段 1 只做「包装」：内部调用现有的 ~/.local/bin/cc-worker 脚本，行为与现在完全一致。
 * 好处是可以先把插件通道、状态追踪、超时与日志跑通，再逐步把脚本逻辑搬进 TypeScript。
 *
 * 脚本契约（勿改）：
 *   cc-worker run 任务 [--dir DIR] [--new] [--model NAME] [--timeout SEC] [--max-turns N] [--prompt-file F]
 *   stdout 恰一行 JSON：{ok, result, session_id, cost_usd, duration_s, log}
 */
import { spawn } from 'node:child_process'

/** 脚本路径；可用环境变量覆盖，便于测试。 */
export const CCW_PATH = process.env.CCW_PATH ?? 'cc-worker'
/** 默认超时（秒）；脚本自身还有 --timeout，这里只是外层保险。 */
export const DEFAULT_TIMEOUT_S = 1800
/** 单次任务的最大轮数。 */
export const DEFAULT_MAX_TURNS = 40

export interface RunOptions {
  /** 任务描述（必填）。 */
  task: string
  /** 工作目录；缺省用宿主的工单目录。 */
  dir?: string
  /** 强制新开会话，不 resume。 */
  fresh?: boolean
  /** 模型名，透传给 claude CLI。 */
  model?: string
  /** 超时秒数。 */
  timeoutS?: number
  /** 最大轮数。 */
  maxTurns?: number
  /** 从文件读取任务正文。 */
  promptFile?: string
}

export interface RunResult {
  ok: boolean
  result?: string
  sessionId?: string
  costUsd?: number
  durationS?: number
  log?: string
  /** 失败时的原因（脚本没按契约输出、超时、被中断等）。 */
  error?: string
  /** 退出码。 */
  code?: number | null
  /** 是否因超时被杀。 */
  timedOut?: boolean
}

/** 把 RunOptions 拼成脚本参数数组（不经过 shell，避免注入与引号问题）。 */
export function buildArgs (options: RunOptions): string[] {
  const args = ['run', options.task]
  if (options.dir) args.push('--dir', options.dir)
  if (options.fresh) args.push('--new')
  if (options.model) args.push('--model', options.model)
  if (options.promptFile) args.push('--prompt-file', options.promptFile)
  args.push('--timeout', String(options.timeoutS ?? DEFAULT_TIMEOUT_S))
  args.push('--max-turns', String(options.maxTurns ?? DEFAULT_MAX_TURNS))
  return args
}

/** 解析脚本的 stdout：取最后一行非空内容按 JSON 解析。 */
export function parseOutput (stdout: string): RunResult {
  const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  try {
    const parsed = JSON.parse(last)
    return {
      ok: parsed.ok === true,
      result: typeof parsed.result === 'string' ? parsed.result : undefined,
      sessionId: parsed.session_id ?? undefined,
      costUsd: typeof parsed.cost_usd === 'number' ? parsed.cost_usd : undefined,
      durationS: typeof parsed.duration_s === 'number' ? parsed.duration_s : undefined,
      log: parsed.log ?? undefined,
    }
  } catch {
    return { ok: false, error: 'cc-worker 没有输出约定格式的 JSON', result: stdout.slice(-2000) }
  }
}

/** 执行一次任务；永不抛异常，失败以 ok:false 返回。 */
export async function runWorker (options: RunOptions, signal?: AbortSignal): Promise<RunResult> {
  const timeoutMs = (options.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000
  return await new Promise<RunResult>(resolve => {
    let settled = false
    let timedOut = false
    const finish = (value: RunResult): void => { if (!settled) { settled = true; resolve(value) } }
    let child
    try {
      child = spawn(CCW_PATH, buildArgs(options), { stdio: ['ignore', 'pipe', 'pipe'], detached: false })
    } catch (error) {
      finish({ ok: false, error: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    // 外层超时：脚本自己也有 --timeout，这里是双保险，避免脚本卡死拖住插件。
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, 5000)
    }, timeoutMs)
    const onAbort = (): void => { try { child.kill('SIGTERM') } catch { /* 已退出 */ } }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish({ ok: false, error: String(error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const parsed = parseOutput(stdout)
      finish({ ...parsed, code, ...(timedOut ? { timedOut: true, error: '执行超时' } : {}),
        ...(!parsed.ok && stderr ? { error: parsed.error ?? stderr.slice(-1000) } : {}) })
    })
  })
}
