/**
 * 自包含的 Claude Code 执行器：不依赖任何外部脚本，装好插件即可用。
 *
 * 移植自 cc-worker（bash）的必需部分，只保留「跑得起来」所必需的能力：
 *   - 会话管理：预分配 session_id 并落盘，下次同目录默认 resume
 *   - 调用 claude CLI：stream-json 输出，逐事件解析
 *   - 进程组管理：自成一组，中断时整组收掉，不留僵尸
 *   - 中断旁路：监视 state/interrupt 文件
 *   - 输出契约：{ok, result, session_id, cost_usd, duration_s, log}
 *
 * 权限：默认不跳过审批，走 Claude Code 自身的权限流程。
 * 需要无人值守的部署可显式把 skipPermissions 设为 true —— 这是使用方自己的安全决定，
 * 不由插件代做；公开分发时默认值必须是安全的那一侧。
 *
 * 未移植（可选能力）：cctrim 会话瘦身、预算裁决、team 多 worker 协调、handoff 契约提取。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RunnerConfig {
  /** 允许的工作目录根；--dir 必须在其下，防止会话串到别的工单。 */
  workRoot: string
  /** claude 可执行文件，默认取 PATH 里的 claude。 */
  claudeBin: string
  /** 是否跳过权限审批。默认 false；设为 true 等于允许无人值守执行任意命令，由部署方自行承担。 */
  skipPermissions?: boolean
  /** 额外的 claude 参数（如 --model、MCP 配置）。 */
  extraArgs?: string[]
  defaultTimeoutS: number
  defaultMaxTurns: number
  /** 宿主进程 pid；给了就在它消失时收掉 claude（父死子亡）。 */
  hostPid?: number
}

export interface RunRequest {
  task: string
  dir: string
  lane?: string
  fresh?: boolean
  model?: string
  timeoutS?: number
  maxTurns?: number
  /** 放行理由，写进结果供事后审计。 */
  why?: string
}

export interface RunResult {
  ok: boolean
  result?: string
  sessionId?: string
  costUsd?: number
  durationS?: number
  log?: string
  error?: string
  code?: number | null
  timedOut?: boolean
  interrupted?: boolean
}

/** 状态根：main 与 lanes/<name> 分开，各自独立会话。 */
export function stateBase (dir: string, lane = 'main'): string {
  return lane === 'main' ? join(dir, '.cc-worker') : join(dir, '.cc-worker', 'lanes', lane)
}

/** 校验目录：必须在 workRoot 之下，lane 名只允许安全字符。 */
export function validateRequest (req: RunRequest, config: RunnerConfig): void {
  if (!req.task || !req.task.trim()) throw new Error('empty prompt')
  if (!req.dir) throw new Error('missing --dir: pass the ticket directory')
  const root = config.workRoot.replace(/\/+$/, '')
  const dir = req.dir.replace(/\/+$/, '')
  if (dir !== root && !dir.startsWith(root + '/')) throw new Error('--dir must be under ' + root + ', got: ' + req.dir)
  const lane = req.lane ?? 'main'
  if (lane !== '' && !/^[A-Za-z0-9_-]+$/.test(lane)) throw new Error('invalid lane: use letters, digits, - and _ only')
}

/** 拼 claude 命令行参数。审批跳过只在配置显式开启时出现。 */
export function buildClaudeArgs (req: RunRequest, mode: 'new' | 'resume', sid: string, config: RunnerConfig): string[] {
  const args: string[] = []
  if (config.skipPermissions === true) args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', 'default')
  args.push('--output-format', 'stream-json', '--verbose')
  const turns = req.maxTurns ?? config.defaultMaxTurns
  if (turns > 0) args.push('--max-turns', String(turns))
  if (req.model) args.push('--model', req.model)
  for (const extra of config.extraArgs ?? []) args.push(extra)
  args.push(mode === 'resume' ? '--resume' : '--session-id', sid)
  args.push('-p', req.task)
  return args
}

/** 从 stream-json 事件流里取最后一条 result 事件。 */
export function parseStreamLog (text: string): { result?: string; sessionId?: string; costUsd?: number } {
  let out: { result?: string; sessionId?: string; costUsd?: number } = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed)
      if (event?.type === 'result') {
        out = {
          result: typeof event.result === 'string' ? event.result : out.result,
          sessionId: event.session_id ?? out.sessionId,
          costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : out.costUsd,
        }
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
  return out
}

const note = (base: string, kind: string, text: string): void => {
  try { appendFileSync(join(base, kind + '.log'), new Date().toISOString() + ' ' + text + '\n') } catch { /* 忽略 */ }
}

/** 执行一次任务；永不抛异常，失败以 ok:false 返回。 */
export async function runClaude (config: RunnerConfig, req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
  try { validateRequest(req, config) } catch (error) { return { ok: false, error: String((error as Error).message ?? error) } }
  const lane = req.lane ?? 'main'
  const base = stateBase(req.dir, lane)
  try { mkdirSync(join(base, 'runs'), { recursive: true }) } catch { return { ok: false, error: 'bad dir' } }
  const sidFile = join(base, 'session_id')
  const runlog = join(base, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl')
  const pidFile = join(base, 'claude.pid')
  const interruptFile = join(base, 'interrupt')
  try { rmSync(interruptFile, { force: true }); rmSync(pidFile, { force: true }) } catch { /* 不存在 */ }

  const existing = existsSync(sidFile) ? readFileSync(sidFile, 'utf8').trim() : ''
  const mode: 'new' | 'resume' = req.fresh || !existing ? 'new' : 'resume'
  const sid = mode === 'new' ? randomUUID() : existing
  if (mode === 'new') { try { writeFileSync(sidFile, sid + '\n') } catch { /* 仍可执行 */ } }

  const args = buildClaudeArgs(req, mode, sid, config)
  const timeoutS = req.timeoutS ?? config.defaultTimeoutS
  const startedAt = Date.now()

  return await new Promise<RunResult>(resolve => {
    let settled = false
    let timedOut = false
    let interrupted = false
    const finish = (value: RunResult): void => { if (!settled) { settled = true; resolve(value) } }
    let child
    try {
      child = spawn('setsid', ['timeout', String(timeoutS), config.claudeBin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ ok: false, error: String(error), sessionId: sid })
      return
    }
    let stdout = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', () => { /* 诊断走 stderr.log，不混入结果 */ })
    if (child.pid) { try { writeFileSync(pidFile, String(child.pid) + '\n') } catch { /* 忽略 */ } }

    const killGroup = (): void => {
      try { process.kill(-child.pid!, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* 已退出 */ } }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* 已退出 */ } } }, 2000).unref?.()
    }
    const watchdog = setInterval(() => {
      if (existsSync(interruptFile)) { interrupted = true; note(base, 'fallback', 'interrupt requested'); killGroup() }
      else if (config.hostPid && !isAlive(config.hostPid)) { note(base, 'fallback', 'host gone'); killGroup() }
    }, 1000)
    const timer = setTimeout(() => { timedOut = true; killGroup() }, (timeoutS + 10) * 1000)
    const onAbort = (): void => { interrupted = true; killGroup() }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => {
      clearInterval(watchdog); clearTimeout(timer); signal?.removeEventListener('abort', onAbort)
      finish({ ok: false, error: String(error), sessionId: sid })
    })
    child.on('close', code => {
      clearInterval(watchdog); clearTimeout(timer); signal?.removeEventListener('abort', onAbort)
      try { writeFileSync(runlog, stdout, 'utf8') } catch { /* 忽略 */ }
      const parsed = parseStreamLog(stdout)
      const durationS = Math.round((Date.now() - startedAt) / 100) / 10
      if (timedOut) { finish({ ...parsed, ok: false, sessionId: sid, durationS, log: runlog, code, timedOut: true, error: 'timeout after ' + timeoutS + 's' }); return }
      if (interrupted) { finish({ ...parsed, ok: false, sessionId: sid, durationS, log: runlog, code, interrupted: true, error: 'interrupted' }); return }
      const ok = code === 0 && parsed.result !== undefined
      finish({ ...parsed, ok, sessionId: parsed.sessionId ?? sid, durationS, log: runlog, code,
        ...(ok ? {} : { error: parsed.result === undefined ? 'claude 没有产出 result 事件' : 'exit ' + code }) })
    })
  })
}

function isAlive (pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}