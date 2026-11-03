/**
 * cc-worker 执行过程可见层（只读）。
 *
 * 背景：worker 通过 `cc-worker` 把活交给 VM 上的无头 Claude Code（`claude -p`），该进程的所有输出只落在
 * `<工单目录>/.cc-worker/runs/<时间戳>.jsonl`，面板此前完全看不到，也无法及时纠正。本模块只做三件事：
 *   1. 读出该事件流，还原「CC 现在第几步、在跑什么工具、有没有报错」；
 *   2. 用文件 mtime 判断是否卡住（无新事件），超阈值给出告警级别；
 *   3. 提供中断标记的读写，供面板「停止」按钮与 cc-worker 协作。
 *
 * 全程只读 cc-worker 的产物，不改 cc-worker 的行为；唯一写入的是 `interrupt` 标记文件。
 */
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync, existsSync, readdirSync, unlinkSync, fstatSync } from 'node:fs'
import { join } from 'node:path'

/** 事件流尾部只保留这么多行，足够描述当前动作。 */
const TAIL_LIMIT = 120
/** 无新事件超过这么久（毫秒）判为疑似卡住。 */
export const STALL_WARN_MS = 120_000
/** 无新事件超过这么久判为严重卡住（多半是模型或工具挂死）。 */
export const STALL_CRITICAL_MS = 600_000
/** 事件文件超过这么久没更新，就当作历史遗留的运行记录，不再按「正在卡住」报警。 */
export const STALE_RUN_MS = 60 * 60_000
/** 增量读缓存；按目录键。 */
const cache = new Map<string, { file: string; size: number; tail: CcEvent[]; touched: number }>()
const CACHE_TTL_MS = 30 * 60_000

type CcEvent = {
  type?: string
  subtype?: string
  timestamp?: string
  message?: { content?: any[] }
  result?: string
  is_error?: boolean
  session_id?: string
}

export type CcStep = {
  /** 第几步（从 1 开始，按 assistant 消息计）。 */
  step: number
  /** 工具名，如 Bash / Write / Edit / Read。 */
  tool?: string
  /** 一句话描述：命令、文件路径等。 */
  detail?: string
  /** 这一步是否已拿到工具结果。 */
  done: boolean
}

export type CcStatus = {
  /** 有没有跑过 cc-worker。 */
  present: boolean
  /** running=正在执行 thinking=模型思考中 done=已完成 error=报错 stalled=长时间无输出 */
  state: 'none' | 'running' | 'thinking' | 'done' | 'error' | 'stalled'
  /** 事件文件路径（相对工单目录）。 */
  log?: string
  sessionId?: string
  /** 已产生的步骤与最近若干步，供面板展开查看。 */
  steps: CcStep[]
  /** 当前正在跑的那一步。 */
  current?: CcStep
  /** 最近一次事件距今毫秒。 */
  ageMs?: number
  /** 最近一次事件耗时的绝对时间。 */
  at?: number
  /** 中断标记是否存在（用户已请求停止）。 */
  interruptRequested: boolean
  /** 告警级别：none / warn / critical。 */
  alert: 'none' | 'warn' | 'critical'
  /** 告警说明（中文，直接给用户看）。 */
  alertText?: string
  /** 报错摘要（来自事件或 stderr）。 */
  error?: string
}

/** 把工具输入压成一行可读文本。 */
function inputText(tool: string | undefined, input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description
  if (typeof pick === 'string') return pick.replace(/\s+/g, ' ').trim()
  return undefined
}

/** 从事件尾部还原步骤列表与当前动作。 */
function describe(events: readonly CcEvent[]): Pick<CcStatus, 'steps' | 'current' | 'state' | 'error' | 'sessionId'> {
  const steps: CcStep[] = []
  let pending: CcStep | undefined
  let error: string | undefined
  let sessionId: string | undefined
  let sawResult = false
  let resultError = false
  for (const event of events) {
    if (!sessionId && typeof event.session_id === 'string') sessionId = event.session_id
    if (event.type === 'result') {
      sawResult = true
      if (event.is_error) { resultError = true; error = String(event.result ?? '').slice(0, 500) }
      continue
    }
    if (event.type === 'assistant') {
      const content: any[] = event.message?.content ?? []
      for (const part of content) {
        if (part?.type === 'tool_use') {
          if (pending) steps.push(pending)
          pending = { step: steps.length + 1, tool: String(part.name ?? ''), detail: inputText(part.name, part.input), done: false }
        }
      }
      continue
    }
    if (event.type === 'user') {
      const content: any[] = event.message?.content ?? []
      for (const part of content) {
        if (part?.type !== 'tool_result') continue
        if (pending) { pending.done = true; steps.push(pending); pending = undefined }
        if (part.is_error && !error) {
          const body = typeof part.content === 'string' ? part.content
            : Array.isArray(part.content) ? part.content.map((item: any) => String(item?.text ?? '')).join(' ') : ''
          error = body.replace(/\s+/g, ' ').slice(0, 500)
        }
      }
    }
  }
  const current = pending
  const state: CcStatus['state'] = sawResult
    ? (resultError ? 'error' : 'done')
    : current ? 'running' : 'thinking'
  return { steps, current, state, error, sessionId }
}

/** 取目录下最新的 runs/<时间戳>.jsonl；没有则退回 log.jsonl。 */
function latestEventFile(dir: string): string | undefined {
  const runDir = join(dir, '.cc-worker', 'runs')
  let newest: { path: string; at: number } | undefined
  try {
    for (const name of readdirSync(runDir)) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(runDir, name)
      try {
        const at = statSync(path).mtimeMs
        if (!newest || at > newest.at) newest = { path, at }
      } catch { /* 文件刚被删，跳过 */ }
    }
  } catch { /* 没有 runs 目录 */ }
  if (newest) return newest.path
  const log = join(dir, '.cc-worker', 'log.jsonl')
  return existsSync(log) ? log : undefined
}

/** 增量读出事件尾部。 */
function readTail(dir: string, file: string): { events: CcEvent[]; mtime: number; size: number } {
  let stat
  try { stat = statSync(file) } catch { return { events: [], mtime: 0, size: 0 } }
  const now = Date.now()
  let entry = cache.get(dir)
  // 文件被换成新的（新一轮运行）就重新开始，不承接上一轮的尾部。
  if (!entry || entry.file !== file || stat.size < entry.size) entry = { file, size: 0, tail: [], touched: now }
  entry.touched = now
  let grown = stat.size - entry.size
  if (grown > 0) {
    // 只读新增部分；单次最多读 512KB，避免一轮超大输出把内存吃掉。
    grown = Math.min(grown, 512 * 1024)
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(grown)
      const start = Math.max(0, stat.size - grown)
      readSync(fd, buffer, 0, grown, start)
      entry.tail = [...entry.tail, ...parseLines(buffer.toString('utf8'), start > 0)].slice(-TAIL_LIMIT)
      entry.size = start + grown
    } finally { closeSync(fd) }
  }
  for (const [id, item] of cache) if (item !== entry && now - item.touched > CACHE_TTL_MS) cache.delete(id)
  cache.set(dir, entry)
  return { events: entry.tail, mtime: stat.mtimeMs, size: stat.size }
}

/** 按行解析；首行可能是半截（从中间开始读），丢掉。 */
function parseLines(text: string, partialHead: boolean): CcEvent[] {
  const lines = text.split('\n')
  if (partialHead) lines.shift()
  const events: CcEvent[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { events.push(JSON.parse(trimmed) as CcEvent) } catch { /* 半行，跳过 */ }
  }
  return events
}

/** 中断标记路径。 */
export const interruptPath = (dir: string) => join(dir, '.cc-worker', 'interrupt')

/** 请求中断：写标记，cc-worker 的旁路监视会杀掉 claude。 */
export function requestInterrupt(dir: string): boolean {
  try { writeFileSync(interruptPath(dir), new Date().toISOString()) ; return true } catch { return false }
}

/** 清除中断标记（新一轮开始前）。 */
export function clearInterrupt(dir: string): boolean {
  try { if (existsSync(interruptPath(dir))) { unlinkSync(interruptPath(dir)); return true } } catch { /* 忽略 */ }
  return false
}

/** 读 cc-worker 的 stderr.log 最后一条有意义的内容。 */
function stderrHint(dir: string): string | undefined {
  const path = join(dir, '.cc-worker', 'stderr.log')
  try {
    const stat = statSync(path)
    const length = Math.min(stat.size, 4096)
    if (!length) return undefined
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, stat.size - length)
      const text = buffer.toString('utf8').trim()
      if (!text) return undefined
      // 已知无害噪音：模型名不被识别（模型由路由器覆写），不作为告警。
      const lines = text.split('\n').map(line => line.trim())
        .filter(line => line && !line.includes('unrecognized_model'))
      return lines.length ? lines[lines.length - 1]!.slice(0, 300) : undefined
    } finally { closeSync(fd) }
  } catch { return undefined }
}

/** 汇总一个工单目录的 CC 执行状态。 */
export function readCcStatus(dir: string): CcStatus {
  const empty: CcStatus = { present: false, state: 'none', steps: [], interruptRequested: false, alert: 'none' }
  if (!dir) return empty
  const file = latestEventFile(dir)
  if (!file) return { ...empty, interruptRequested: existsSync(interruptPath(dir)) }
  const { events, mtime } = readTail(dir, file)
  if (!events.length) return { ...empty, present: true, interruptRequested: existsSync(interruptPath(dir)) }
  const described = describe(events)
  const now = Date.now()
  const ageMs = Math.max(0, now - mtime)
  const interruptRequested = existsSync(interruptPath(dir))

  let state = described.state
  let alert: CcStatus['alert'] = 'none'
  let alertText: string | undefined
  const settled = state === 'done' || state === 'error'
  // 一小时没更新 = 历史遗留的运行记录（多半早已被重启/中止掐断），标成「已中断」而不是报警。
  if (!settled && ageMs > STALE_RUN_MS) {
    state = 'done'
    alertText = `上次运行在 ${Math.round(ageMs / 60_000)} 分钟前中断，未留下结果`
  } else if (!settled && ageMs > STALL_CRITICAL_MS) {
    state = 'stalled'
    alert = 'critical'
    alertText = `Claude Code 已 ${Math.round(ageMs / 60_000)} 分钟没有任何输出，可能已挂死，建议中止并重跑`
  } else if (!settled && ageMs > STALL_WARN_MS) {
    alert = 'warn'
    alertText = `Claude Code 已 ${Math.round(ageMs / 60_000)} 分钟没有新动作，可能卡在某个命令上`
  } else if (state === 'error') {
    alert = 'critical'
    alertText = 'Claude Code 报告执行失败'
  }
  return {
    present: true,
    state,
    log: file.slice(dir.length + 1),
    sessionId: described.sessionId,
    steps: described.steps.slice(-30),
    current: described.current,
    ageMs,
    at: mtime,
    interruptRequested,
    alert,
    alertText,
    error: described.error ?? (state === 'error' || alert === 'critical' ? stderrHint(dir) : undefined),
  }
}


/**
 * 执行器活跃探测（只读）。
 *
 * 长任务在 Assignment 的投递时间戳上不再有任何变化，光看它会误判成僵尸；这里补两类实时信号：
 *   - `alive`：claude.pid 指向的 CC 进程是否还在（pid 文件只在一轮运行期间存在，跑完即删）；
 *   - `atMs`：最新事件文件的 mtime（CC 每输出一个事件就刷新，静止超阈值才说明真停了）。
 */
export type ExecutorProbe = {
  /** 最新事件文件的最后更新时间（毫秒）。 */
  atMs?: number
  /** CC 进程是否存活。 */
  alive?: boolean
}

/** 探测一个工单目录的执行活跃度；目录缺失/无产物时返回空对象（不编造信号）。 */
export function probeExecutor(dir: string): ExecutorProbe {
  const probe: ExecutorProbe = {}
  if (!dir) return probe
  try {
    const pid = Number(readFileSync(join(dir, '.cc-worker', 'claude.pid'), 'utf8').trim())
    if (Number.isInteger(pid) && pid > 1) {
      try {
        // 校验 cmdline 确实属于 claude，防 pid 被系统复用给别的进程。
        if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude')) probe.alive = true
      } catch { /* 进程已不在，或 /proc 不可读 */ }
    }
  } catch { /* 没有 pid 文件：没在跑，或跑完已删 */ }
  const file = latestEventFile(dir)
  if (file) {
    try { probe.atMs = statSync(file).mtimeMs } catch { /* 文件刚被替换，忽略 */ }
  }
  return probe
}
