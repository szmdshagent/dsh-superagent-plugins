/**
 * worker 执行层的硬约束：cc-worker 调用参数与成本预算。
 *
 * 为什么需要这一层：提示词只是「承诺」，模型可以不遵守。实测证据（2026-11-04）：
 *   - rev13 提示词写「单文件 15 轮」，实际有一次跑了 16 轮；
 *   - 提示词写「估算预算省钱」，实际出现「4 轮花 $29」的运行；
 *   - 22 次续跑同一会话，重放历史占总成本 89.6%。
 * 把校验放进代码，模型不听也没用。
 *
 * 注册的是全局工具守卫（`ctx.tools.guard()`），只对 Executor Session（`worker-*`）生效，
 * 主 Session、子代理、人的会话一律放行。
 */
import type { Context } from '@deepseek-ai/cordis'

/** cc-worker 的可执行名；命令里出现它才做参数校验。 */
const CC_WORKER = 'cc-worker'

/** 每次 cc-worker 调用必须显式给出的参数，否则拒绝启动。 */
const REQUIRED_FLAGS: { flag: string; why: string }[] = [
  { flag: '--max-turns', why: '没有轮数上限的运行会无限烧钱；按任务规模显式给值，不要在事后补救。' },
]

/** team 计划内的并行 lane 命名规范：ccw1、ccw2……（cc-worker 2026-11-11 起按这个口径展示）。 */
const CCW_LANE = /^ccw([1-9][0-9]*)$/

/** lane 名会拼进 `.cc-worker/lanes/<lane>` 路径，绝不允许 /、.. 之类字符。 */
const LANE_NAME = /^[A-Za-z0-9_-]+$/

/** 不参与并行编号的保留 lane：main=旧行为，lead=team 的统筹/汇总。 */
const RESERVED_LANES = new Set(['main', 'lead'])

/** cc-worker 对 --workers 的硬上限（超出会被静默截断，这里直接拒绝以暴露配置错误）。 */
const MAX_WORKERS = 4

/** 一个命令行参数是否存在、是否给了取值。 */
type FlagValue = { present: boolean; value?: string; dangling?: boolean }

/**
 * 取某个参数的值（同一参数出现多次时以最后一次为准，与 cc-worker 的赋值循环一致）。
 *
 * 只看下一个 token；下一个 token 是另一个 `-x/--xx` 参数时，视为该参数没给值。
 */
function flagValue(tokens: readonly string[], flag: string): FlagValue {
  const at = tokens.lastIndexOf(flag)
  if (at < 0) return { present: false }
  const next = tokens[at + 1]
  if (next === undefined || /^-{1,2}[A-Za-z]/.test(next)) return { present: true, dangling: true }
  return { present: true, value: next }
}

/** Executor Session 的 id 形状；与主包 `worker-<工单 id>` 一致。 */
const WORKER_SESSION = /^worker-/

/** 工具调用的最小形状；只用得到名字与参数。 */
type Execution = { name?: string; arguments?: unknown; agent?: AgentLike } | undefined
/** agent 的最小形状：只读 session.header.id。 */
type AgentLike = { session?: { header?: { id?: unknown } } }

/** 本插件挂接的 tools 服务；类型自行声明，不依赖主包未公开的内部类型。 */
type ToolsService = {
  guard(guard: (execution: Execution) => string | undefined): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
  }
}

/** 是否是 Executor Session。 */
function isWorker(agent: AgentLike | undefined): boolean {
  const id = agent?.session?.header?.id
  return typeof id === 'string' && WORKER_SESSION.test(id)
}

/**
 * 把命令行切成词，够用于识别参数。
 *
 * 不追求完整 shell 语义：只要能把 `--dir /x --max-turns 40` 切成
 * `['--dir','/x','--max-turns','40']` 即可。引号内的空格保留。
 */
export function words(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (current) { out.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/** 这些词出现在 cc-worker 前面时，cc-worker 仍然处在命令位置。 */
const PREFIX_WORDS = new Set(['env', 'sudo', 'time', 'nohup', 'exec', 'command', 'setsid'])

/** 是否是 cc-worker 这个可执行文件本身。 */
function isCcWorker(word: string): boolean {
  return word === CC_WORKER || word.endsWith('/' + CC_WORKER)
}

/**
 * 命令行里是否**执行**了 cc-worker。
 *
 * 只看命令位置（首词，或 `|`、`&&`、`;`、`||` 之后，或 env/sudo/time 等前缀之后），
 * 不看到名字就算——否则 `cat /tmp/cc-worker`、`grep pattern cc-worker` 会被误判成调用，
 * 从而被要求带 --max-turns。
 */
export function ccWorkerIndex(command: string): number {
  const tokens = words(command)
  let atCommandPosition = true
  /** `timeout` 后面紧跟的那个数值参数不改变命令位置。 */
  let skipCount = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '|' || token === '||' || token === '&&' || token === ';' || token === '&') {
      atCommandPosition = true
      skipCount = 0
      continue
    }
    if (atCommandPosition) {
      if (isCcWorker(token)) return i
      if (token === 'timeout') { skipCount = 1; continue }
      if (PREFIX_WORDS.has(token)) continue
      // `env FOO=bar cc-worker ...` 里的赋值也属于前缀，不改变命令位置。
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
      if (skipCount > 0 && /^[\d.]+[smhd]?$/.test(token)) { skipCount--; continue }
      atCommandPosition = false
      continue
    }
  }
  return -1
}

/**
 * 命令行里是否**执行**了 cc-worker。见 {@link ccWorkerIndex}。
 */
export function invokesCcWorker(command: string): boolean {
  return ccWorkerIndex(command) >= 0
}

/**
 * 校验一条 cc-worker 命令行；返回拒绝理由，或 undefined 表示放行。
 *
 * 先确认这条命令**确实在调用** cc-worker 再校验参数：否则 `ls -la`、
 * `cat /tmp/cc-worker.log` 这类只是提到名字的命令会被误拒。
 *
 * 2026-11-11 起 cc-worker 支持 team/lane 协作，参数校验同步扩展：
 *   - `--lane` 只能是 main、lead 或 ccw1..ccwN（N 不超过 --workers，默认上限 4）；
 *   - `--workers` 必须是 1..4 的整数；
 *   - `--task` 必须带非空任务描述；
 *   - team 不能嵌套（CC_TEAM_DEPTH 已置位时拒绝）。
 */
export function ccWorkerVerdict(command: string): string | undefined {
  const tokens = words(command)
  const at = ccWorkerIndex(command)
  if (at < 0) return undefined
  const sub = tokens[at + 1]
  const args = tokens.slice(at + 1)
  const problems: string[] = []

  // 1. 必需参数（先报这一条，它的代价最大）。
  for (const { flag: name, why } of REQUIRED_FLAGS) {
    const found = flagValue(args, name)
    if (!found.present) problems.push(`缺少 ${name}（${why}）`)
    else if (found.dangling) problems.push(`${name} 缺少取值（${why}）`)
  }

  // 2. team 嵌套：cc-worker 自己也会拒绝，但在参数层先拦下来，省掉一次启动。
  if (sub === 'team') {
    const depth = Number(process.env.CC_TEAM_DEPTH ?? 0)
    if (Number.isFinite(depth) && depth >= 1) {
      problems.push(`team 不能嵌套（当前 CC_TEAM_DEPTH=${process.env.CC_TEAM_DEPTH}）；子任务请用 run --lane ccwN`)
    }
  }

  // 3. --workers：cc-worker 越界会静默截断，这里直接拒绝。
  const workersFlag = flagValue(args, '--workers')
  let workers: number | undefined
  if (workersFlag.present) {
    const raw = workersFlag.value
    if (workersFlag.dangling || raw === undefined) {
      problems.push(`--workers 缺少取值（应为 1..${MAX_WORKERS} 的整数）`)
    } else if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_WORKERS) {
      problems.push(`--workers 必须是 1..${MAX_WORKERS} 的整数，收到 ${raw}`)
    } else {
      workers = Number(raw)
    }
  }

  // 4. --lane：安全字符集 + team 计划命名规范。
  const laneFlag = flagValue(args, '--lane')
  if (laneFlag.present) {
    const lane = laneFlag.value
    if (laneFlag.dangling || !lane) {
      problems.push('--lane 缺少取值')
    } else if (!LANE_NAME.test(lane)) {
      problems.push(`--lane "${lane}" 不合法：只允许字母、数字、- 和 _，不能带路径分隔符`)
    } else if (!RESERVED_LANES.has(lane)) {
      const match = CCW_LANE.exec(lane)
      if (!match) {
        problems.push(`--lane "${lane}" 不符合 team 计划命名：并行 lane 必须是 ccw1..ccwN（或 main/lead）`)
      } else {
        const n = Number(match[1])
        const limit = workers ?? MAX_WORKERS
        if (n > limit) problems.push(`--lane "${lane}" 超出团队规模：workers=${limit}，最多 ${limit} 路`)
      }
    }
  }

  // 5. --task：team 分工会写进 task.txt，空描述等于没分工。
  const taskFlag = flagValue(args, '--task')
  if (taskFlag.present && (taskFlag.dangling || !taskFlag.value?.trim())) {
    problems.push('--task 缺少任务描述')
  }

  if (problems.length) {
    return `cc-worker 调用参数不合规：${problems.join('；')}。参数是硬性要求，请补齐后重试。`
  }
  return undefined
}

/** 一次工具调用的裁决：返回字符串即拒绝，返回 undefined 即放行。 */
export function workerVerdict(execution: Execution): string | undefined {
  const name = execution?.name
  if (!name) return undefined
  if (!isWorker(execution?.agent)) return undefined
  if (name !== 'bash') return undefined
  const command = (execution?.arguments as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string') return undefined
  if (!invokesCcWorker(command)) return undefined
  return ccWorkerVerdict(command)
}

/**
 * 挂上全局 guard，返回卸载函数。
 *
 * 用 `ctx.inject(['tools'], ...)` 而不是直接 `ctx.tools`：tools 服务由 DSH 的插件提供，
 * 加载顺序不保证；inject 回调会在服务就绪时调用，并在卸载时自动回收。
 */
export function installExecutorGuard(ctx: Context): void {
  ctx.inject(['tools'], (scope: Context) => {
    scope.effect(() => scope.tools.guard(workerVerdict), 'executor: cc-worker 参数硬约束')
  })
}

/** 插件条目：name 与 inject 直接导出，供 bundle patch 引用。 */
export const name = 'dsh-superagent-executor-guard'
export const inject = ['tools'] as const

export function apply(ctx: Context): void {
  installExecutorGuard(ctx)
}
