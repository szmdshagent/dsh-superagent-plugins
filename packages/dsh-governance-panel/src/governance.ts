/**
 * 治理引擎：把 cc-worker / 派活引擎留在磁盘上的痕迹，归纳成若干「治理维度」。
 *
 * 设计约束：
 *   - **纯只读**：只 stat/read，不改任何文件，不起进程（周报生成由调用方决定）。
 *   - **单点失败不扩散**：任何工单、任何文件的解析失败都只跳过那一项。
 *   - **维度正交**：交接闭环、执行器健康、预算纪律、成本、上下文、活性各自独立，
 *     一个问题只归到一个主维度，避免同一现象在多处重复计数。
 *
 * 全部数据源都是 cc-worker 既有产物，新增维度不需要改执行层。
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

/** 治理维度标识。前端按这个顺序分组显示。 */
export type DimensionKey = 'team' | 'handoff' | 'executor' | 'budget' | 'cost' | 'context' | 'liveness'

/** 严重度：critical 要立刻处理，warn 值得看一眼，info 只是背景信息。 */
export type Severity = 'critical' | 'warn' | 'info'

/** 一条治理发现。`evidence` 放原始片段，前端只在展开时显示。 */
export type Finding = {
  dimension: DimensionKey
  severity: Severity
  /** 稳定标识，前端据此去重/折叠，例如 `handoff:extract_failed:<工单名>`。 */
  id: string
  /** 一句话结论（人话）。 */
  title: string
  /** 补充说明：为什么算问题、怎么处理。 */
  detail?: string
  /** 涉及的工单目录名（没有就省略）。 */
  ticket?: string
  /** 结构化指标，前端可表格化。 */
  metrics?: Record<string, number | string | null>
  /** 原始证据片段（截断），默认折叠。 */
  evidence?: string
  /** 发生时间（ISO），用于排序。 */
  at?: string
}

/** 一个维度的汇总。 */
export type DimensionSummary = {
  key: DimensionKey
  /** 该维度问题条目数（不含 info）。 */
  issues: number
  critical: number
  warn: number
  /** 维度级指标（不针对单个工单），例如今日总成本。 */
  metrics: Record<string, number | string | null>
  /** 维度级结论。 */
  verdict: 'ok' | 'watch' | 'bad' | 'unknown'
}

/** 一条 lane 的执行状态；pending 表示计划里有、但目录还没建。 */
export type LaneStatus = 'pending' | 'running' | 'done' | 'failed' | 'unknown'
/** lead 是统筹 lane，不在 team-plan 里；worker 是计划内的子任务；other 是历史/非 team lane。 */
export type LaneRole = 'lead' | 'worker' | 'other'

/**
 * 一条 lane 的聚合结果（token / 成本 / 轮次 / 时长 / 交接切换）。
 *
 * 数据源优先级：lane 自己的 budget-ledger.jsonl（逐轮）→ result.json（单轮兜底）。
 * 成本走与成本维度相同的 trueCostRows 差分，避免 resume 后把会话累计值当单轮成本。
 */
export type LaneExecution = {
  ticket: string
  lane: string
  role: LaneRole
  task: string | null
  status: LaneStatus
  resultOk: boolean | null
  error: string | null
  runs: number
  /** 工具调用步数（台账 act_steps 之和）。 */
  steps: number
  /** Claude Code 内部轮次（result.num_turns）；没有 result 时为 0。 */
  turns: number
  tokens: { input: number; cacheRead: number; output: number; total: number }
  costUsd: number
  uncalibratedRuns: number
  /** 单轮真实上下文峰值（台账 context_size 的最大值）。 */
  contextPeak: number
  /** switch.log 里 `cctrim ... switch to` 的次数。 */
  handoffSwitches: number
  handoffAnomalies: number
  handoffStatus: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  lastActivity: string | null
}

/** 单个工单的 team 维度汇总。 */
export type TeamTicketSummary = {
  ticket: string
  planPath: string
  planError: string | null
  /** 计划里的子任务数（不含 lead）。 */
  workerLanes: number
  done: number
  failed: number
  running: number
  pending: number
  unknown: number
  totalCostUsd: number
  totalRuns: number
  totalTokens: number
  configuredParallelism: number
  peakParallelism: number
  currentParallelism: number
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  /** 含 lead lane，便于面板直接展示子任务与统筹。 */
  lanes: LaneExecution[]
}

/** 全局 team 汇总；没有 team-plan 时 present=false，其余字段为零值。 */
export type TeamReport = {
  present: boolean
  tickets: number
  lanes: number
  workerLanes: number
  done: number
  failed: number
  running: number
  pending: number
  unknown: number
  totalCostUsd: number
  totalRuns: number
  totalTokens: number
  configuredParallelism: number
  peakParallelism: number
  currentParallelism: number
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  teams: TeamTicketSummary[]
}

/** 共享区里的一份产物：conflicts.md 或 findings/*.md。 */
export type SharedItem = {
  ticket: string
  kind: 'conflicts' | 'findings'
  path: string
  /** findings 的作者 lane（文件名去掉 .md）；conflicts 为 null。 */
  lane: string | null
  /** conflicts.md 里涉及的 lane；findings 为该 lane 自己。 */
  lanes: string[]
  /** conflicts.md 解析出的重叠路径；findings 为空。 */
  paths: string[]
  blocked: boolean
  bytes: number
  modifiedAt: string | null
  excerpt: string
}

export type ConflictReport = {
  present: boolean
  /** conflicts.md 里解析出的重叠路径数。 */
  conflictPaths: number
  /** shared/findings/*.md 文件数。 */
  findingsFiles: number
  /** 内容里出现 BLOCKED 的 findings 文件数。 */
  blockedFindings: number
  tickets: string[]
  items: SharedItem[]
}

export type GovernanceReport = {
  generatedAt: string
  /** 全局判定：任一 critical 即 bad；有 warn 即 watch。 */
  overall: 'ok' | 'watch' | 'bad'
  /** 一句话总结。 */
  headline: string
  dimensions: DimensionSummary[]
  findings: Finding[]
  /** lane 维度聚合（含 team 的 lead / worker，也含历史非 team lane）。 */
  lanes: LaneExecution[]
  /** team 计划与并行度汇总；无 team 时 present=false。 */
  team: TeamReport
  /** shared/findings 与 conflicts.md 的识别结果。 */
  conflicts: ConflictReport
  /** 扫描规模，便于判断数据是否可信（目录很多但状态文件很少就要怀疑路径）。 */
  scanned: {
    tickets: number
    withWorkerDir: number
    withHandoffState: number
    ledgerRuns: number
    laneUnits: number
    teamTickets: number
  }
}

/** 阈值集中在这里，改口径只需要动这一处。 */
export const THRESHOLDS = {
  /** 单次 run 成本超过这个值算贵（美元）。 */
  runCostWarn: 1,
  runCostCritical: 5,
  /**
   * 单轮**真实上下文**超过这个值才算膨胀（token）。
   *
   * 口径必须是「最后一次 API 调用的 input + cache_read」，也就是 `context_size`
   * （cc-worker 按 usage 去重后取的最大值），**不能**用 `act_cache_read`：
   * 后者是一轮内所有 API 调用的累计，正常一轮 20+ 步天然是窗口的十几倍。
   * 2026-11-11 实测：code-yongshi-mag-gap 那轮台账 act_cache_read=2,530,048，
   * 而 runlog 里单次调用峰值只有 150,253；全量 615 行 context_size 最大 392,005，
   * 超过 400K 声明窗口的一行为零。旧阈值 800K 打在累计值上，误报 148 条。
   */
  contextSizeWarn: 320_000,
  /** 单次 run 的步数超过这个值说明任务发散。 */
  stepsWarn: 40,
  /** 步数达到这个值就算「长跑一轮」：总价高可能只是因为干得多，要看每步成本。 */
  efficientLongSteps: 20,
  /** 每步成本低于这个值（美元）的长轮属正常吞吐，不按「单轮成本高」报警。取全量 p95≈$0.26。 */
  costPerStepWarn: 0.3,
  /** 重复同一命令达到这个次数算纪律问题。 */
  duplicateWarn: 3,
  /** 交接连续异常达到这个次数升级为 critical。 */
  handoffStreakCritical: 2,
  /** 运行中的工单多久没动静算停滞（毫秒）。 */
  stallWarnMs: 5 * 60_000,
  stallCriticalMs: 20 * 60_000,
  /** 只统计最近多久的数据。 */
  freshMs: 7 * 86400_000,
  /** 工单最近多久还有活动（或进程仍存活）才算「仍在进行」，否则异常只作历史审计。
   *  cc-worker 运行期间会持续追加 runs/*.jsonl，30 分钟没有任何写入即视为没有 run 在跑。 */
  activeWindowMs: 30 * 60_000,
  /** 额度类汇总的窗口（今日）。 */
  todayRunsMax: 400,
} as const

const home = () => process.env.HOME ?? homedir()
const workRoot = () => `${home()}/.dsh/state/superagent/work`
const globalLedger = () => `${home()}/.dsh/state/superagent/budget-ledger.jsonl`

/** 读取 JSON 文件，失败返回 null（调用方不必 try）。 */
function readJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** 读取文本文件前 N 字节，失败返回空串。 */
function readHead(path: string, bytes = 4096): string {
  try { return readFileSync(path, 'utf8').slice(0, bytes) } catch { return '' }
}

/** 读全文。只用于小文件（switch.log 十几 KB 级）；大文件请用 readHead/readTail。 */
function readFile(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** 读取文本文件后 N 字节（runlog 尾部才是 result 事件），失败返回空串。 */
function readTail(path: string, bytes = 512 * 1024): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = statSync(path).size
      const start = Math.max(0, size - bytes)
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

/** 读 jsonl 的每一行；坏行跳过。 */
function readJsonl(path: string, limit = 5000): any[] {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  const lines = text.split('\n')
  const start = Math.max(0, lines.length - limit)
  const rows: any[] = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return rows
}

/** 文件修改时间（毫秒），不存在返回 0。 */
function mtimeMs(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

/** 工单目录名去掉末尾的 `-<12位哈希>` 作为人话标题。 */
export function ticketTitle(name: string): string {
  return name.replace(/-[0-9a-f]{12}$/, '') || name
}

/** 把工单目录扫成一张表，后面各维度共用，避免反复读目录。 */
type TicketScan = {
  name: string
  /** 执行 lane：'' 表示 main（`.cc-worker/`），否则是 `.cc-worker/lanes/<lane>/`。 */
  lane: string
  /** 全局唯一标识：main 用工单名，lane 用 `<工单名>#<lane>`；finding id 与索引都按它去重。 */
  key: string
  dir: string
  workerDir: string | null
  handoff: any | null
  budget: any | null
  stderr: string
  ledger: any[]
  at: number
}

/** 按一个状态根（main 或某条 lane）读成扫描条目。 */
function makeScan(name: string, lane: string, dir: string, workerDir: string | null, at: number): TicketScan {
  return {
    name, lane, key: lane ? `${name}#${lane}` : name, dir, workerDir, at,
    handoff: workerDir ? readJson(`${workerDir}/handoff-state.json`) : null,
    budget: workerDir ? readJson(`${workerDir}/budget-status.json`) : null,
    stderr: workerDir ? readHead(`${workerDir}/stderr.log`, 2000).trim() : '',
    ledger: workerDir ? readJsonl(`${workerDir}/budget-ledger.jsonl`, 400) : [],
  }
}

function scanTickets(now: number, onlyTicket?: string): TicketScan[] {
  let names: string[] = []
  try { names = readdirSync(workRoot()) } catch { return [] }
  // 可选只扫一个工单：验收取样用，也方便面板按工单钻取；默认仍是全量。
  if (onlyTicket) names = names.filter(name => name === onlyTicket)
  const out: TicketScan[] = []
  for (const name of names) {
    const dir = `${workRoot()}/${name}`
    const dirAt = mtimeMs(dir)
    if (!dirAt) continue
    const cc = `${dir}/.cc-worker`
    const ccAt = mtimeMs(cc)
    // main lane：与旧版完全一致；没有 .cc-worker 的工单也保留一条（只有目录 mtime）。
    // 工单目录本身可能长期不动，真正的活动痕迹在 .cc-worker 里，两者取新。
    const mainAt = Math.max(dirAt, ccAt,
      mtimeMs(`${cc}/handoff-state.json`),
      mtimeMs(`${cc}/budget-status.json`))
    // 只看最近的工单：7 天前的老目录不参与治理，否则永远红。
    if (now - mainAt <= THRESHOLDS.freshMs) out.push(makeScan(name, '', dir, ccAt ? cc : null, mainAt))
    if (!ccAt) continue
    // 协作 lane（2026-11-11 起支持）：每个 `.cc-worker/lanes/<lane>/` 是独立执行单元，
    // 交接/预算/日志各记一份，必须单独扫，否则 lane 里的异常在面板上完全看不见。
    let lanes: string[] = []
    try {
      lanes = readdirSync(`${cc}/lanes`, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name))
        .map(entry => entry.name)
    } catch { /* 没有 lanes 目录：绝大多数工单都是这种情况 */ }
    for (const lane of lanes) {
      const workerDir = `${cc}/lanes/${lane}`
      const at = Math.max(dirAt, mtimeMs(workerDir),
        mtimeMs(`${workerDir}/handoff-state.json`),
        mtimeMs(`${workerDir}/budget-status.json`))
      if (now - at > THRESHOLDS.freshMs) continue
      out.push(makeScan(name, lane, dir, workerDir, at))
    }
  }
  return out
}

/** pid 是否仍存活。收尾后残留的 pid 文件不能当成「还在跑」。 */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 工单是否仍在进行：进程活着，或者最近 activeWindowMs 内还有文件活动。
 * 已结束工单的历史异常仍保留在审计里，但不再占用「需立刻处理」的严重名额。
 */
function isActiveTicket(scan: TicketScan, now: number): boolean {
  if (scan.workerDir) {
    const pid = Number(readHead(`${scan.workerDir}/claude.pid`, 32).trim())
    if (pidAlive(pid)) return true
  }
  return now - scan.at <= THRESHOLDS.activeWindowMs
}

/** 统计一个工单换过几次会话（switch.log 里 cctrim switch 的行数）。 */
function switchCount(workerDir: string | null): number {
  if (!workerDir) return 0
  // 必须读全文：switch.log 会随工单长跑不断追加，实测 13.5KB 的文件只读前 8KB
  // 会把 31 次换会话数成 20 次（4 个工单受影响）。
  return (readFile(`${workerDir}/switch.log`).match(/cctrim .*switch to/g) ?? []).length
}

// ——— 维度一：交接闭环 ———

/** 交接异常的中文说明，键来自 handoff_state.py 的 anomalies。 */
const HANDOFF_TEXT: Record<string, string> = {
  run_failed: '本轮执行失败，没有产出可用结果',
  unconsumed: '上一轮写入的交接没有被下一轮读走',
  extract_failed: '模型没有按模板输出交接段，提取为空或过短',
}

function handoffFindings(scans: TicketScan[], now: number): Finding[] {
  const findings: Finding[] = []
  for (const scan of scans) {
    const state = scan.handoff
    if (!state) continue
    const anomalies: string[] = Array.isArray(state.anomalies) ? state.anomalies : []
    if (anomalies.length === 0) continue
    const streak = Number(state.streak ?? 0)
    const active = isActiveTicket(scan, now)
    // 连续两次以上不正常就升级为 critical：单次抖动可以忍，连续说明契约没生效。
    // 工单已经结束则只作历史审计（info），历史失败无法再补救，不应长期占「需立刻处理」。
    const severity: Severity = active
      ? (streak >= THRESHOLDS.handoffStreakCritical ? 'critical' : 'warn')
      : 'info'
    for (const code of anomalies) {
      findings.push({
        dimension: 'handoff',
        severity,
        id: `handoff:${code}:${scan.key}`,
        title: `${active ? '' : '历史遗留：'}${HANDOFF_TEXT[code] ?? `交接异常：${code}`}`,
        detail: active
          ? `连续 ${streak} 次未恢复。交接契约的作用是让下一轮不必重读历史，持续失败等于每轮都在烧重复的 token。`
          : `工单已结束（最后活动 ${new Date(scan.at).toISOString()}），这次失败不会再影响后续轮次；保留作审计，不计入「需立刻处理」。`,
        ticket: scan.key,
        metrics: {
          异常码: code,
          连续次数: streak,
          注入: Number(state.injected ?? 0),
          消费: Number(state.consumed ?? 0),
          提取成功: Number(state.extract_ok ?? 0),
        },
        evidence: typeof state.extract === 'string' ? state.extract : undefined,
        at: typeof state.updated === 'string' ? state.updated : undefined,
      })
    }
  }
  return findings
}

// ——— 维度二：执行器健康 ———

/** 已知的良性告警：只影响 SDK 侧标注，不影响执行结果，不必天天报红。 */
const BENIGN_STDERR = [/unrecognized_model/]

/**
 * 台账里的 `cost_usd` 来自 Claude Code 的 `result.total_cost_usd`，是**同一 session 的累计成本**：
 * resume 一轮就会把整段会话重新报一次。直接相加等于同一笔钱被数很多遍，
 * 所以这里按 `session_id` 做差分，得到「这一轮真正新增的成本」。
 *
 * 差分只在同一 session 内成立：累计值只增不减；一旦变小（换了新基线或换了会话）就按原始值计。
 */
/**
 * 从 runlog 里找同一 session 更早一轮的 `total_cost_usd`，作为「面板台账外的」累计基线。
 *
 * 为什么需要：面板只扫各工单 `.cc-worker/budget-ledger.jsonl`，而台账可能只保留了该 session
 * 最后几轮（实测量：long-dsh 的 session 有 13 轮 result，本地台账只剩 10 行，更早的高价轮不在台账里）。
 * 缺了更早的行，面板就把整段会话累计当成这一轮的成本（$30.23 实为 $0.69）。
 * runlog 每轮都留，是这个基线最完整的来源。
 */
/** runlog 基线缓存：同一 (目录, run, session) 只解析一次；文件 mtime 变了才重算。 */
const baselineCache = new Map<string, number | null>()

function baselineFromRunlog(scan: TicketScan, run: string, session: string): number | null {
  const dir = scan.workerDir ? `${scan.workerDir}/runs` : ''
  if (!dir) return null
  const key = `${dir}\u0000${run}\u0000${session}\u0000${mtimeMs(`${dir}/${run}`)}`
  const hit = baselineCache.get(key)
  if (hit !== undefined) return hit
  const value = baselineFromRunlogUncached(dir, run, session)
  if (baselineCache.size > 500) baselineCache.clear()
  baselineCache.set(key, value)
  return value
}

/**
 * 三档 token 的计价权重（input : cacheRead : output = 10 : 1 : 50）。
 *
 * 只用于**比例**，不需要绝对值：即使换模型/换价目，只要三档单价比例不变，折算就成立；
 * 比例变了也只是 `cost_usd` 本身不准，不引入额外误差。数值来自 9 个 cost-state 快照的
 * 最小二乘反解（deepseek 实为 $5 / $0.5 / $25 per M，比例正是 10:1:50）。
 */
const TOKEN_WEIGHT = { input: 10, cacheRead: 1, output: 50 }

/** 用 token 量算相对权重；三档都取自同一份 usage 的同一统计口径。 */
function tokenWeight(input: number, cacheRead: number, output: number): number {
  return input * TOKEN_WEIGHT.input + cacheRead * TOKEN_WEIGHT.cacheRead + output * TOKEN_WEIGHT.output
}

/**
 * 「累计 / 本轮」权重比的容忍上限，与 `isInheritedSession` 的 8 倍同源。
 * 超过它说明这一轮只占整段历史的零头，无法区分「同会话正常多轮」与「继承了别人的历史」。
 */
const MAX_BASELINE_RATIO = 8

/**
 * 从一条 `result` 事件折出「本轮开始时的会话累计成本」。
 *
 * 依据（2026-11-10 实测，token-usage-plugin-ad419acced89）：
 * - `result.modelUsage` 是整段 session 的累计 token，`result.usage` 只是**本轮**增量。
 *   实测 18091520 - 3909888 === 14181632，与 transcript 中上一条 `cost-state` 快照逐位相等。
 * - `total_cost_usd` 对 token 是线性的。所以按 token 比例就能把累计金额折算到「本轮开始」那个点：
 *   baseline = total_cost_usd × 权重(累计 − 本轮) / 权重(累计)
 * - `TOKEN_WEIGHT` 只以**比例**进入这个式子（分子分母同乘），改单价不影响结果，
 *   **不要**把单价同步到配置或当成账目口径。
 *
 * 三个防护，任一命中返回 null（宁可退回旧行为，也不凭空造基线）：
 * - 缺 `modelUsage` / `usage`，或累计权重非正 → 无从折算；
 * - 累计 < 本轮（任一档）→ `modelUsage` 不是整段累计（例如只写了本轮），硬算会得负值；
 * - 累计权重 > 本轮权重 × 8 → 这一轮相对整段历史太小，典型是 abtopup 那种把 52MB 会话文件
 *   `cp` 成新 sid 起头的克隆（实测 161 倍）。此时折出来的小增量会把「继承历史」伪装成
 *   「本轮很便宜」，所以放弃折算，交给 `isInheritedSession` 走未校准路径。
 */
function baselineOfResult(ev: any, cost: number): number | null {
  const usage = ev?.usage
  const modelUsage = ev?.modelUsage
  if (!usage || !modelUsage || typeof modelUsage !== 'object') return null
  if (!Number.isFinite(cost) || cost <= 0) return null
  // modelUsage 按模型分档；同一 session 可能中途换模型，累计值要跨档相加才是整段历史。
  let cumInput = 0
  let cumCacheRead = 0
  let cumOutput = 0
  for (const item of Object.values<any>(modelUsage)) {
    cumInput += Number(item?.inputTokens) || 0
    cumCacheRead += Number(item?.cacheReadInputTokens) || 0
    cumOutput += Number(item?.outputTokens) || 0
  }
  const curInput = Number(usage.input_tokens) || 0
  const curCacheRead = Number(usage.cache_read_input_tokens) || 0
  const curOutput = Number(usage.output_tokens) || 0
  if (cumInput < curInput || cumCacheRead < curCacheRead || cumOutput < curOutput) return null
  const wCum = tokenWeight(cumInput, cumCacheRead, cumOutput)
  const wCur = tokenWeight(curInput, curCacheRead, curOutput)
  if (!(wCum > 0) || wCur < 0) return null
  if (wCur > 0 && wCum > wCur * MAX_BASELINE_RATIO) return null
  const baseline = (cost * (wCum - wCur)) / wCum
  if (!Number.isFinite(baseline) || baseline <= 0 || baseline >= cost) return null
  return baseline
}

/** runlog 里一轮的关键数值：会话累计成本 + 本轮最后一次 API 调用的缓存读 + 本轮起点累计成本。 */
type RunSessionFacts = {
  cost: number
  /** 整轮累计缓存读（result.usage.cache_read_input_tokens），只用于「累计 vs 单次」的继承判据。 */
  cacheRead: number
  baseline: number | null
}

/** 目录级索引缓存：一次解析该工单所有 runlog 的 result 事件，按 run 名 → session 取值。 */
const runCostIndexCache = new Map<string, { stamp: number; index: Map<string, Map<string, RunSessionFacts>> }>()

function runCostIndex(dir: string): Map<string, Map<string, RunSessionFacts>> {
  let stamp = 0
  try { stamp = statSync(dir).mtimeMs } catch { return new Map() }
  const cached = runCostIndexCache.get(dir)
  if (cached && cached.stamp === stamp) return cached.index
  const index = new Map<string, Map<string, RunSessionFacts>>()
  let names: string[] = []
  try { names = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort() } catch { return index }
  for (const name of names) {
    // runlog 尾部才是 result 事件；512KB 足够覆盖最后若干条。
    const text = readTail(`${dir}/${name}`)
    for (const line of text.split('\n')) {
      if (!line.includes('"result"')) continue
      let ev: any
      try { ev = JSON.parse(line) } catch { continue }
      if (ev?.type !== 'result') continue
      const session = String(ev?.session_id ?? '')
      const cost = Number(ev?.total_cost_usd)
      if (!session || !Number.isFinite(cost)) continue
      // 注意：result.usage.cache_read_input_tokens 是**整轮所有 API 调用的累计**，不是单次上下文。
      // 2026-11-11 实测 code-yongshi-mag-gap 20261111-012623：24 次去重后的调用求和 = 2,530,048，
      // 与 result.usage.cache_read_input_tokens 逐位相等。所以它只能当「累计」用（基线判据需要），
      // 不能拿来和上下文窗口比。单次上下文由下面的 turnContextPeak 单独算。
      const cacheRead = Number(ev?.usage?.cache_read_input_tokens) || 0
      let perSession = index.get(name)
      if (!perSession) { perSession = new Map(); index.set(name, perSession) }
      perSession.set(session, { cost, cacheRead, baseline: baselineOfResult(ev, cost) })
    }
  }
  if (runCostIndexCache.size > 200) runCostIndexCache.clear()
  runCostIndexCache.set(dir, { stamp, index })
  return index
}

/**
 * 本轮单次 API 调用的上下文峰值（input + cache_read），即「这一轮的上下文真的有多大」。
 *
 * 不能直接用 result.usage.cache_read_input_tokens：它是一轮内所有调用的累计
 * （实测 24 次调用求和与它逐位相等），拿它和 400K 窗口比必然虚高十几倍。
 * 也不能用台账 act_cache_read：那是同一口径的累计值。
 * 唯一的真实口径是逐条 assistant 事件的 usage，按 message.id 去重（同一条消息会拆成
 * thinking/text 多个事件，usage 相同），取最大值。
 *
 * 代价：要读整个 runlog（实测 0.1–2MB/轮）。按「路径 + mtime」缓存，同一次扫描只算一次。
 */
const turnContextCache = new Map<string, number | null>()

function getTurnContextPeak(scan: TicketScan, run: string, session: string): number | null {
  const dir = scan.workerDir ? `${scan.workerDir}/runs` : ''
  if (!dir || !run || !session) return null
  const path = `${dir}/${run}`
  const stamp = mtimeMs(path)
  if (!stamp) return null
  const key = `${path}\u0000${session}\u0000${stamp}`
  const hit = turnContextCache.get(key)
  if (hit !== undefined) return hit
  let peak: number | null = null
  const seen = new Set<string>()
  for (const line of readFile(path).split('\n')) {
    if (!line.includes('"assistant"')) continue
    let ev: any
    try { ev = JSON.parse(line) } catch { continue }
    if (ev?.type !== 'assistant') continue
    if (String(ev?.session_id ?? session) !== session) continue
    const usage = ev?.message?.usage ?? ev?.usage
    if (!usage) continue
    const id = String(ev?.message?.id ?? '')
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    const total = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0)
    if (total > (peak ?? 0)) peak = total
  }
  if (turnContextCache.size > 400) turnContextCache.clear()
  turnContextCache.set(key, peak)
  return peak
}

function baselineFromRunlogUncached(dir: string, run: string, session: string): number | null {
  const index = runCostIndex(dir)
  const names = [...index.keys()].filter(name => name < run).sort()
  let best: number | null = null
  for (const name of names) {
    const facts = index.get(name)!.get(session)
    if (facts !== undefined) best = facts.cost
  }
  return best
}

/**
 * 从本轮自己的 runlog 里求「本轮开始时的累计成本」，用于同 session 没有更早 result 时补基线。
 *
 * 依据（2026-11-10 实测，token-usage-plugin-ad419acced89）：
 * - `result.modelUsage` 是整段 session 的累计 token，`result.usage` 只是**本轮**增量。
 *   实测 18091520 - 3909888 === 14181632，与 transcript 中上一条 `cost-state` 快照逐位相等。
 * - `total_cost_usd` 对 token 是线性的，且三档 token 的单价比例在本机模型下恒定。
 *   用 9 个 `cost-state` 快照最小二乘反解出 input:cacheRead:output = 10:1:50，
 *   回算各快照误差 < $0.00001。所以按同一比例就能把累计金额折算到「本轮开始」那个点：
 *   baseline = total_cost_usd × 权重(累计 - 本轮) / 权重(累计)
 *
 * 为什么不用读 transcript：本机 816 个 session 共 1.3GB，全扫一遍 21 秒，面板扛不住；
 * 而 runlog 的 result 事件里已有全部所需数据，零额外 IO。
 */
function baselineFromRunUsage(dir: string, run: string, session: string): number | null {
  const facts = runSessionFacts(dir, run, session)
  if (!facts) return null
  return facts.baseline
}

/** 取某个 run 里某个 session 的 result 事实；复用 `runCostIndex` 的目录级缓存，不额外读盘。 */
function runSessionFacts(dir: string, run: string, session: string): RunSessionFacts | null {
  if (!dir || !run || !session) return null
  return runCostIndex(dir).get(run)?.get(session) ?? null
}

/**
 * 本轮 runlog 里的**整轮累计**缓存读（result.usage.cache_read_input_tokens）；无 runlog 返回 null。
 *
 * 名字里的 perTurn 指「这一轮」，不是「单次调用」：该字段是一轮内所有 API 调用的累加
 * （实测 24 次调用求和与之逐位相等）。仅用于 `isInheritedSession` 的「累计 vs 单次」之比，
 * 单次上下文请用 `getTurnContextPeak`。
 */
function perTurnCacheReadFromRunlog(scan: TicketScan, run: string, session: string): number | null {
  const dir = scan.workerDir ? `${scan.workerDir}/runs` : ''
  if (!dir) return null
  const facts = runCostIndex(dir).get(run)?.get(session)
  const value = Number(facts?.cacheRead) || 0
  return value > 0 ? value : null
}

/** 单轮上下文理论天花板：声明窗口 400K，留 1.5 倍余量给 1M 窗口模型。 */
const MAX_ROUND_CACHE_READ = 4_000_000

/**
 * 判断一行台账的累计缓存读里是否混进了「不属于本轮」的历史。
 *
 * 背景：abtopup 那单是把 52MB 的 long-dsh 会话文件 `cp` 成新 sid 起的头（脚本 /home/szm/cc-diag/ab-topup.sh:12），
 * 首轮就把 42.4M 缓存整体重放，花掉 $29.73。这类行的 `baseline_source=none`（找不到同 session 更早 result），
 * 但 `baseline_source=none` 本身不足以判定——正常新开会话的首轮也都是 none。
 *
 * 判据拿「本轮自己的累计规模」当分母，不能拿 `context_size`（早期台账常为空）：
 * - 首选 runlog 的 `result.usage.cache_read_input_tokens`：它是**本轮**所有调用的汇总，
 *   与 `act_cache_read_cum` 同源同量级；两者相差 8 倍以上说明这一行混进了别的会话。
 *   注意它**不是**单次上下文（2026-11-11 复核：24 次调用求和与它逐位相等），
 *   所以只用于这个比值，不与上下文窗口比较。
 * - runlog 缺失时退回台账 `context_size × context_rereads`（本轮上下文 × 本轮调用次数），超 4 倍判继承；
 *   正常情况下 cum 与它同量级（p90≈1.0 倍），4 倍已是明显异常。
 * - 两者都没有时才退回绝对上限 4M。
 *
 * 旧实现只比 `context_size` 单值 8 倍，把「长跑一轮把上下文读了 80 次」的正常行（cum 天然几十倍）
 * 全判成继承会话，导致今日「未校准金额」被虚增到 $217.72（实际只有 $16.99）。
 */
function isInheritedSession(scan: TicketScan, row: any): boolean {
  if (String(row?.cloned_from ?? '').length > 0) return true
  if (String(row?.baseline_source ?? '') !== 'none') return false
  const cum = Number(row?.act_cache_read_cum) || 0
  if (cum <= 0) return false
  const session = String(row?.session_id ?? '')
  const run = String(row?.run ?? '')
  const perTurn = session && run ? perTurnCacheReadFromRunlog(scan, run, session) : null
  if (perTurn) return cum > perTurn * 8
  const ctx = Number(row?.context_size) || 0
  const rereads = Number(row?.context_rereads) || 0
  if (ctx > 0 && rereads > 0) return cum > ctx * rereads * 4
  if (ctx > 0) return cum > ctx * 8
  return cum >= MAX_ROUND_CACHE_READ
}

type CostRow = { scan: TicketScan; row: any; cost: number; calibrated: boolean; recoveredBase: number }

function trueCostRows(scans: TicketScan[]): CostRow[] {
  const items = scans.flatMap(scan => scan.ledger.map(row => ({ scan, row })))
  items.sort((a, b) => String(a.row?.ts ?? '').localeCompare(String(b.row?.ts ?? '')))
  const lastBySession = new Map<string, number>()
  const out: CostRow[] = []
  for (const item of items) {
    const raw = Number(item.row?.cost_usd ?? 0) || 0
    const session = String(item.row?.session_id ?? '')
    const before = lastBySession.get(session)
    let cost = before !== undefined && raw >= before ? raw - before : raw
    let calibrated = true
    // 基线差分扣掉的那部分钱，若台账里没有对应行（只有在 before === undefined 时才会走差分分支），
    // 就是「真实花掉但台账未留行」的历史。单轮成本必须扣、总额不能扣，所以这里单独记出来补回总额。
    let recoveredBase = 0
    if (before === undefined) {
      // 面板台账里没有同 session 的更早行时，`total_cost_usd` 默认就是本 run 的完整成本
      // （它本来就是 run 级累计，一轮 150 个内部 turn 的花费全在里面），按原值计入。
      // 唯一的例外是 resume 轮：面板台账被截断（只读最后 400 行）时更早的累计行会丢，
      // 此时必须用 runlog 里同 session 更早的 result 补基线，否则整段会话被当成一轮。
      const run = String(item.row?.run ?? '')
      // 先找同 session 更早 run 的 result；同一 session 连续多轮时更早的 run 常被截断没有 result，
      // 这时退回用本行自己 result 里的 modelUsage/usage 折基线（见 baselineOfResult）。
      // 两者都拿不到才按原值计入。
      const dir = item.scan.workerDir ? `${item.scan.workerDir}/runs` : ''
      const base = !session || !run
        ? null
        : baselineFromRunlog(item.scan, run, session) ?? baselineFromRunUsage(dir, run, session)
      if (base !== null && base > 0 && raw >= base) {
        cost = raw - base
        // 差分后仍为负或为 0 说明基线就是本轮之前的全部历史，如实记 0。
        if (cost < 0) cost = 0
        // 发生扣减即说明基线那笔钱不在台账里（两条基线路径都算）：把它还给总额。
        recoveredBase = base
      }
      // 克隆会话（cc-worker `--new` 但 session 文件是从别处复制来的）会把别人的历史
      // 一次性继承过来，runlog 里找不到同 session 的更早 result，无法用上面的方法折分。
      // 老台账没有 `cloned_from` 字段（cc-worker 至今也没写过），只看它会把克隆行当正常轮，
      // 所以补一个不依赖新字段的结构判据：feature=turn 轮次的上下文不可能超过一整个窗口，
      // `act_cache_read_cum` 远超 `context_size`（>=8 倍）说明这一行的累计值里塞了别人/过去的会话。
      if (isInheritedSession(item.scan, item.row)) calibrated = false
    }
    lastBySession.set(session, raw)
    out.push({ scan: item.scan, row: item.row, cost, calibrated, recoveredBase })
  }
  return out
}

// ——— 维度零：团队协作（team-plan / lanes / shared） ———

/** team-plan.json 的一条计划项。 */
type TeamPlanLane = { lane: string; task: string }
type TeamPlan = { present: boolean; path: string; lanes: TeamPlanLane[]; error: string | null }

/** 压成单行并截断，避免把 2KB 的任务描述塞进面板/JSON。 */
function shortText(value: string, max = 400): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 读 team-plan.json；不存在返回 present=false，存在但格式不对返回 error。 */
function readTeamPlan(ticketDir: string): TeamPlan {
  const path = `${ticketDir}/.cc-worker/team-plan.json`
  const exists = mtimeMs(path) > 0
  const raw = exists ? readJson(path) : null
  if (!Array.isArray(raw)) {
    return { present: false, path, lanes: [], error: exists ? 'team-plan.json 不是合法的 JSON 数组' : null }
  }
  const lanes: TeamPlanLane[] = []
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const lane = String((item as any).lane ?? '').trim()
    const task = String((item as any).task ?? '').replace(/\s+/g, ' ').trim()
    if (!/^[A-Za-z0-9_-]+$/.test(lane) || !task) continue
    lanes.push({ lane, task })
  }
  return {
    present: lanes.length > 0,
    path,
    lanes,
    error: raw.length > 0 && lanes.length === 0 ? 'team-plan.json 有内容但没有合法的 lane/task 条目' : null,
  }
}

/** 解析台账/交接里的时间戳；坏值返回 0。 */
function parseTime(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function isoAt(ms: number): string | null {
  return ms > 0 ? new Date(ms).toISOString() : null
}

/** runs/20261111-231152.jsonl → 本地时间毫秒；不是该格式返回 0。 */
function runStartMs(name: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)
  if (!match) return 0
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6])).getTime()
  return Number.isFinite(at) ? at : 0
}

/**
 * 逐 lane 聚合 token / 成本 / 轮次 / 时长 / 交接切换。
 *
 * 只读 `.cc-worker/lanes/<lane>/`：budget-ledger.jsonl 是逐轮主数据源，
 * result.json 是单轮兜底（lane 刚起步、台账还没写时）。成本复用 trueCostRows 的
 * session 差分，不在这里另造一套口径。
 */
function buildLaneExecutions(scans: TicketScan[], now: number, costRows: CostRow[] = trueCostRows(scans)): LaneExecution[] {
  const costByKey = new Map<string, { cost: number; uncalibratedRuns: number }>()
  for (const item of costRows) {
    const entry = costByKey.get(item.scan.key) ?? { cost: 0, uncalibratedRuns: 0 }
    entry.cost += item.cost + item.recoveredBase
    if (!item.calibrated) entry.uncalibratedRuns++
    costByKey.set(item.scan.key, entry)
  }
  const byTicket = new Map<string, TicketScan[]>()
  for (const scan of scans) {
    const list = byTicket.get(scan.name) ?? []
    list.push(scan)
    byTicket.set(scan.name, list)
  }
  const roleRank: Record<LaneRole, number> = { worker: 0, other: 1, lead: 2 }
  const out: LaneExecution[] = []
  for (const [ticket, ticketScans] of byTicket) {
    const dir = ticketScans[0]!.dir
    const plan = readTeamPlan(dir)
    const planMap = new Map(plan.lanes.map(item => [item.lane, item.task]))
    const scanByLane = new Map(ticketScans.filter(scan => scan.lane).map(scan => [scan.lane, scan] as const))
    let laneDirs: string[] = []
    try {
      laneDirs = readdirSync(`${dir}/.cc-worker/lanes`, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name))
        .map(entry => entry.name)
    } catch { /* 没有 lanes 目录 */ }
    for (const lane of new Set<string>([...planMap.keys(), ...laneDirs])) {
      const laneDir = `${dir}/.cc-worker/lanes/${lane}`
      const laneMtime = mtimeMs(laneDir)
      const exists = laneMtime > 0
      if (!exists && !planMap.has(lane)) continue
      // 计划外的历史 lane 只保留 7 天内的，避免旧 team 结果在面板常驻。
      if (!planMap.has(lane) && exists && now - laneMtime > THRESHOLDS.freshMs) continue
      const scan = scanByLane.get(lane) ?? null
      const resultPath = `${laneDir}/result.json`
      const resultMtime = mtimeMs(resultPath)
      const result = resultMtime > 0 ? readJson(resultPath) : null
      const pid = Number(readHead(`${laneDir}/claude.pid`, 32).trim())
      const alive = pidAlive(pid)
      const role: LaneRole = lane === 'lead' ? 'lead' : planMap.has(lane) ? 'worker' : 'other'
      // lead 在 team 模式下的两段 run 都不写 result.json（被重定向到 team-summary.json），
      // 只能靠 handoff-state 判断收尾；子 worker 仍以 result.json 为准。
      const leadFinished = role === 'lead' && scan?.handoff?.status === 'green'
        && Number(scan.handoff.run_ok ?? 0) > 0
      let status: LaneStatus
      if (!exists) status = 'pending'
      else if (alive) status = 'running'
      else if (result && typeof result.ok === 'boolean') status = result.ok ? 'done' : 'failed'
      else if (leadFinished) status = 'done'
      else status = 'unknown'
      const rows = scan?.ledger ?? []
      let input = 0
      let cacheRead = 0
      let output = 0
      let steps = 0
      let contextPeak = 0
      for (const row of rows) {
        input += Number(row?.act_input ?? 0) || 0
        cacheRead += Number(row?.act_cache_read ?? 0) || 0
        output += Number(row?.act_output ?? 0) || 0
        steps += Number(row?.act_steps ?? 0) || 0
        contextPeak = Math.max(contextPeak, Number(row?.context_size ?? 0) || 0)
      }
      const resultTokens = result?.tokens
      if (rows.length === 0 && resultTokens) {
        input = Number(resultTokens.input ?? 0) || 0
        cacheRead = Number(resultTokens.cache_read ?? 0) || 0
        output = Number(resultTokens.output ?? 0) || 0
      }
      const facts = scan ? costByKey.get(scan.key) : undefined
      const startedCandidates: number[] = []
      for (const row of rows) { const at = parseTime(row?.ts); if (at) startedCandidates.push(at) }
      let runNames: string[] = []
      try { runNames = readdirSync(`${laneDir}/runs`) } catch { /* 无 runs */ }
      for (const name of runNames) { const at = runStartMs(name); if (at) startedCandidates.push(at) }
      if (exists) {
        try { const birth = statSync(laneDir).birthtimeMs; if (birth) startedCandidates.push(birth) } catch { /* 忽略 */ }
      }
      const startedMs = startedCandidates.length ? Math.min(...startedCandidates) : 0
      const endedCandidates: number[] = [resultMtime, mtimeMs(`${laneDir}/handoff.md`)]
      for (const row of rows) { const at = parseTime(row?.ts); if (at) endedCandidates.push(at) }
      const lastRecordedMs = Math.max(...endedCandidates, 0)
      const endedMs = status === 'running' || status === 'unknown' ? now : lastRecordedMs
      const durationMs = startedMs > 0 && endedMs >= startedMs ? endedMs - startedMs : null
      const lastActivity = Math.max(scan?.at ?? 0, resultMtime, lastRecordedMs, laneMtime)
      const plannedTask = planMap.get(lane)
      out.push({
        ticket,
        lane,
        role,
        task: plannedTask ? shortText(plannedTask, 400)
          : (exists ? shortText(readHead(`${laneDir}/task.txt`, 2000), 400) || null : null),
        status,
        resultOk: result && typeof result.ok === 'boolean' ? result.ok : null,
        error: result && result.ok === false
          ? shortText(String(result.error ?? result.result ?? '执行失败'), 300)
          : (status === 'failed' || status === 'unknown') && scan?.stderr ? shortText(scan.stderr, 300) : null,
        runs: Math.max(rows.length, result ? 1 : 0),
        steps,
        turns: Number(result?.num_turns ?? 0) || 0,
        tokens: { input, cacheRead, output, total: input + cacheRead + output },
        costUsd: Number((facts?.cost ?? 0).toFixed(6)),
        uncalibratedRuns: facts?.uncalibratedRuns ?? 0,
        contextPeak,
        handoffSwitches: switchCount(exists ? laneDir : null),
        handoffAnomalies: Array.isArray(scan?.handoff?.anomalies) ? scan.handoff.anomalies.length : 0,
        handoffStatus: typeof scan?.handoff?.status === 'string' ? scan.handoff.status : null,
        startedAt: isoAt(startedMs),
        endedAt: isoAt(endedMs),
        durationMs,
        lastActivity: isoAt(lastActivity),
      })
    }
  }
  return out.sort((a, b) => a.ticket.localeCompare(b.ticket)
    || roleRank[a.role] - roleRank[b.role]
    || a.lane.localeCompare(b.lane, undefined, { numeric: true }))
}

/** 峰值并行度：按各 lane 的起止时间做事件扫描；缺时间的 lane 不参与。 */
function peakParallelism(lanes: LaneExecution[]): number {
  const events: { at: number; delta: number }[] = []
  for (const lane of lanes) {
    const start = parseTime(lane.startedAt)
    const end = parseTime(lane.endedAt)
    if (!start || !end || end <= start) continue
    events.push({ at: start, delta: 1 }, { at: end, delta: -1 })
  }
  // 同一毫秒先结束后开始，避免把「上一路刚结束」算成并行。
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let current = 0
  let peak = 0
  for (const event of events) {
    current += event.delta
    if (current > peak) peak = current
  }
  return peak
}

/** 汇总团队报告：只看有 team-plan 的工单；无计划时 present=false。 */
function buildTeamReport(lanes: LaneExecution[], scans: TicketScan[], now: number): TeamReport {
  const ticketDirs = new Map<string, string>()
  for (const scan of scans) if (!ticketDirs.has(scan.name)) ticketDirs.set(scan.name, scan.dir)
  const teams: TeamTicketSummary[] = []
  for (const [ticket, dir] of ticketDirs) {
    const plan = readTeamPlan(dir)
    if (!plan.present) continue
    const planSet = new Set(plan.lanes.map(item => item.lane))
    // 只算本次计划内的 worker + lead，避免同一工单里历史 lane 的成本混进本 team 总额。
    const ticketLanes = lanes.filter(lane => lane.ticket === ticket
      && (lane.role === 'lead' || planSet.has(lane.lane)))
    const workers = ticketLanes.filter(lane => planSet.has(lane.lane))
    const statusOf = (status: LaneStatus) => workers.filter(lane => lane.status === status).length
    const ticketStarted = ticketLanes.map(lane => parseTime(lane.startedAt)).filter(Boolean)
    const ticketEnded = ticketLanes.map(lane => parseTime(lane.endedAt)).filter(Boolean)
    const ongoing = workers.some(lane => lane.status === 'running' || lane.status === 'pending' || lane.status === 'unknown')
    const startedMs = ticketStarted.length ? Math.min(...ticketStarted) : 0
    const endedMs = ongoing || !ticketEnded.length ? 0 : Math.max(...ticketEnded)
    teams.push({
      ticket,
      planPath: plan.path,
      planError: plan.error,
      workerLanes: plan.lanes.length,
      done: statusOf('done'),
      failed: statusOf('failed'),
      running: statusOf('running'),
      pending: statusOf('pending'),
      unknown: statusOf('unknown'),
      totalCostUsd: Number(ticketLanes.reduce((sum, lane) => sum + lane.costUsd, 0).toFixed(4)),
      totalRuns: ticketLanes.reduce((sum, lane) => sum + lane.runs, 0),
      totalTokens: ticketLanes.reduce((sum, lane) => sum + lane.tokens.total, 0),
      configuredParallelism: plan.lanes.length,
      peakParallelism: peakParallelism(workers),
      currentParallelism: workers.filter(lane => lane.status === 'running').length,
      startedAt: isoAt(startedMs),
      endedAt: ongoing ? null : isoAt(endedMs),
      durationMs: startedMs > 0 && endedMs > 0 ? endedMs - startedMs : (startedMs > 0 && ongoing ? now - startedMs : null),
      lanes: ticketLanes,
    })
  }
  teams.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
  const allStarted = teams.map(team => parseTime(team.startedAt)).filter(Boolean)
  const allEnded = teams.map(team => parseTime(team.endedAt)).filter(Boolean)
  const anyOngoing = teams.some(team => team.endedAt === null && team.workerLanes > 0)
  const startedMs = allStarted.length ? Math.min(...allStarted) : 0
  const endedMs = anyOngoing || !allEnded.length ? 0 : Math.max(...allEnded)
  return {
    present: teams.length > 0,
    tickets: teams.length,
    // 只算 team 工单名下的 lane（含 lead）；顶层 lanes 才是所有 lane。
    lanes: teams.reduce((sum, team) => sum + team.lanes.length, 0),
    workerLanes: teams.reduce((sum, team) => sum + team.workerLanes, 0),
    done: teams.reduce((sum, team) => sum + team.done, 0),
    failed: teams.reduce((sum, team) => sum + team.failed, 0),
    running: teams.reduce((sum, team) => sum + team.running, 0),
    pending: teams.reduce((sum, team) => sum + team.pending, 0),
    unknown: teams.reduce((sum, team) => sum + team.unknown, 0),
    totalCostUsd: Number(teams.reduce((sum, team) => sum + team.totalCostUsd, 0).toFixed(4)),
    totalRuns: teams.reduce((sum, team) => sum + team.totalRuns, 0),
    totalTokens: teams.reduce((sum, team) => sum + team.totalTokens, 0),
    configuredParallelism: teams.reduce((sum, team) => sum + team.configuredParallelism, 0),
    peakParallelism: teams.reduce((peak, team) => Math.max(peak, team.peakParallelism), 0),
    currentParallelism: teams.reduce((sum, team) => sum + team.currentParallelism, 0),
    startedAt: isoAt(startedMs),
    endedAt: anyOngoing ? null : isoAt(endedMs),
    durationMs: startedMs > 0 && endedMs > 0 ? endedMs - startedMs : (startedMs > 0 && anyOngoing ? now - startedMs : null),
    teams,
  }
}

/**
 * findings 里的 BLOCKED 必须落在行首状态位（允许 `-`/`*`/`>`/`**` 前缀），
 * 不能在正文里提一句 BLOCKED 就报警——治理报告自己也会引用这个词。
 */
function isBlockedFinding(text: string): boolean {
  return /^\s{0,3}(?:[-*>]\s*)?\*{0,2}\s*BLOCKED\b/im.test(text)
}

/** 识别 shared/findings/*.md 与 shared/conflicts.md。 */
function buildConflictReport(scans: TicketScan[]): ConflictReport {
  const ticketDirs = new Map<string, string>()
  for (const scan of scans) if (!ticketDirs.has(scan.name)) ticketDirs.set(scan.name, scan.dir)
  const items: SharedItem[] = []
  for (const [ticket, dir] of ticketDirs) {
    const shared = `${dir}/.cc-worker/shared`
    const conflictsPath = `${shared}/conflicts.md`
    const conflictsText = readFile(conflictsPath).trim()
    if (conflictsText) {
      const paths: string[] = []
      const lanes = new Set<string>()
      for (const line of conflictsText.split('\n')) {
        const match = /^-\s+`([^`]+)`\s+←\s+(.+)$/.exec(line.trim())
        if (!match) continue
        paths.push(match[1]!)
        for (const lane of match[2]!.split(',').map(value => value.trim()).filter(Boolean)) lanes.add(lane)
      }
      const stat = statSafe(conflictsPath)
      items.push({
        ticket,
        kind: 'conflicts',
        path: conflictsPath,
        lane: null,
        lanes: [...lanes].sort(),
        paths,
        blocked: false,
        bytes: stat.size,
        modifiedAt: isoAt(stat.mtimeMs),
        excerpt: shortText(conflictsText, 600),
      })
    }
    let files: string[] = []
    try {
      files = readdirSync(`${shared}/findings`, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => entry.name)
        .sort()
    } catch { /* 没有 shared/findings */ }
    for (const file of files) {
      const path = `${shared}/findings/${file}`
      const text = readFile(path)
      const stat = statSafe(path)
      items.push({
        ticket,
        kind: 'findings',
        path,
        lane: file.replace(/\.md$/, ''),
        lanes: [file.replace(/\.md$/, '')],
        paths: [],
        blocked: isBlockedFinding(text),
        bytes: stat.size,
        modifiedAt: isoAt(stat.mtimeMs),
        excerpt: shortText(text, 400),
      })
    }
  }
  const tickets = [...new Set(items.map(item => item.ticket))].sort()
  return {
    present: items.length > 0,
    conflictPaths: items.filter(item => item.kind === 'conflicts')
      .reduce((sum, item) => sum + item.paths.length, 0),
    findingsFiles: items.filter(item => item.kind === 'findings').length,
    blockedFindings: items.filter(item => item.kind === 'findings' && item.blocked).length,
    tickets,
    items,
  }
}

/** stat 的容错版：不存在时返回零值。 */
function statSafe(path: string): { size: number; mtimeMs: number } {
  try { const stat = statSync(path); return { size: stat.size, mtimeMs: stat.mtimeMs } } catch { return { size: 0, mtimeMs: 0 } }
}

/** 工单是否仍在进行：任一扫描单元活跃，或某条 lane 报告 running。 */
function activeTicketSet(scans: TicketScan[], lanes: LaneExecution[], now: number): Set<string> {
  const set = new Set<string>()
  for (const scan of scans) if (isActiveTicket(scan, now)) set.add(scan.name)
  for (const lane of lanes) if (lane.status === 'running') set.add(lane.ticket)
  return set
}

/**
 * team 维度告警：计划完成/失败、共享 findings、conflicts.md。
 *
 * 严重度口径与其它维度一致：仍在进行的工单才占 warn；已结束工单降为 info 审计。
 */
function teamFindings(lanes: LaneExecution[], team: TeamReport, conflicts: ConflictReport,
  scans: TicketScan[], now: number): Finding[] {
  const findings: Finding[] = []
  const active = activeTicketSet(scans, lanes, now)
  for (const summary of team.teams) {
    const isActive = active.has(summary.ticket)
    if (summary.planError) {
      findings.push({
        dimension: 'team',
        severity: 'warn',
        id: `team:plan:${summary.ticket}`,
        title: 'team-plan.json 解析失败或没有合法子任务',
        detail: '统筹 lane 没有写出可用的 lane/task 计划，子任务可能被降级为单 worker 直跑。',
        ticket: summary.ticket,
        metrics: { 计划lane数: summary.workerLanes },
        evidence: summary.planError,
      })
    }
    findings.push({
      dimension: 'team',
      severity: 'info',
      id: `team:summary:${summary.ticket}`,
      title: `team 计划 ${summary.workerLanes} 路：完成 ${summary.done}、失败 ${summary.failed}、进行中 ${summary.running}、未启动 ${summary.pending}`,
      detail: `含 lead 共 ${summary.lanes.length} 条 lane；团队成本 $${summary.totalCostUsd.toFixed(4)}，`
        + `轮次 ${summary.totalRuns}，token ${summary.totalTokens}，峰值并行 ${summary.peakParallelism} 路。`,
      ticket: summary.ticket,
      metrics: {
        计划lane数: summary.workerLanes,
        完成: summary.done,
        失败: summary.failed,
        进行中: summary.running,
        未启动: summary.pending,
        状态未知: summary.unknown,
        团队总成本: summary.totalCostUsd,
        总轮次: summary.totalRuns,
        总token: summary.totalTokens,
        峰值并行: summary.peakParallelism,
      },
    })
    for (const lane of summary.lanes) {
      if (lane.role !== 'worker') continue
      if (lane.status === 'failed') {
        findings.push({
          dimension: 'team',
          severity: isActive ? 'warn' : 'info',
          id: `team:lane-failed:${summary.ticket}:${lane.lane}`,
          title: `${isActive ? '' : '历史遗留：'}子任务 ${lane.lane} 执行失败`,
          detail: isActive
            ? '该 lane 的 result.json 报 ok=false，团队结果是残缺的，需要看 stderr/交接单决定是否重跑。'
            : '工单已结束，这个子任务的失败已成为既定缺口，只作审计。',
          ticket: summary.ticket,
          metrics: { lane: lane.lane, 成本: lane.costUsd, 轮次: lane.runs },
          evidence: lane.error ?? undefined,
          at: lane.endedAt ?? undefined,
        })
      } else if (lane.status === 'unknown') {
        findings.push({
          dimension: 'team',
          severity: 'info',
          id: `team:lane-unknown:${summary.ticket}:${lane.lane}`,
          title: `子任务 ${lane.lane} 状态未知（无 result，进程已退出）`,
          detail: 'lane 目录存在但没有可解析的 result.json，可能是被中断或还在收尾。',
          ticket: summary.ticket,
          metrics: { lane: lane.lane, 轮次: lane.runs },
          evidence: lane.error ?? undefined,
          at: lane.lastActivity ?? undefined,
        })
      }
    }
  }
  // 有 lane 目录但没有 team-plan：可能是历史 lane，也可能是统筹漏写计划。
  if (team.tickets === 0 && team.lanes > 0) {
    findings.push({
      dimension: 'team',
      severity: 'info',
      id: 'team:no-plan',
      title: `发现 ${team.lanes} 条 lane，但没有可用的 team-plan.json`,
      detail: '这些 lane 按独立执行单元统计，但无法判断计划内应有多少子任务、哪些未启动。',
      metrics: { lane数: team.lanes },
    })
  }
  for (const item of conflicts.items) {
    if (item.kind !== 'conflicts') continue
    const isActive = active.has(item.ticket)
    findings.push({
      dimension: 'team',
      severity: isActive ? 'warn' : 'info',
      id: `team:conflicts:${item.ticket}`,
      title: `${isActive ? '' : '历史遗留：'}共享区检测到 ${item.paths.length} 处路径冲突`,
      detail: '多个 lane 在交接单的「改动文件」段落里声明了同一路径，需要统筹裁决；'
        + '这是文本比对结果，可能有误报。',
      ticket: item.ticket,
      metrics: { 冲突路径: item.paths.length, 涉及lane: item.lanes.join(',') },
      evidence: item.excerpt,
      at: item.modifiedAt ?? undefined,
    })
  }
  for (const item of conflicts.items) {
    if (item.kind !== 'findings' || !item.blocked) continue
    const isActive = active.has(item.ticket)
    findings.push({
      dimension: 'team',
      severity: isActive ? 'warn' : 'info',
      id: `team:blocked:${item.ticket}:${item.lane}`,
      title: `${isActive ? '' : '历史遗留：'}子任务 ${item.lane} 在共享区标记 BLOCKED`,
      detail: '该 lane 自报被阻塞；如果需要它继续产出，应由统筹解除阻塞或改派。',
      ticket: item.ticket,
      metrics: { 文件: item.path, 字节: item.bytes },
      evidence: item.excerpt,
      at: item.modifiedAt ?? undefined,
    })
  }
  if (conflicts.findingsFiles > 0) {
    const lanesCovered = new Set(conflicts.items.filter(item => item.kind === 'findings' && item.lane).map(item => `${item.ticket}#${item.lane}`))
    findings.push({
      dimension: 'team',
      severity: 'info',
      id: 'team:findings',
      title: `共享区有 ${conflicts.findingsFiles} 份 findings，覆盖 ${lanesCovered.size} 个 lane`,
      detail: 'findings 是 lane 之间避免重复劳动的中间结论；数量长期为 0 说明共享区没有被用起来。',
      metrics: { findings文件: conflicts.findingsFiles, 覆盖lane: lanesCovered.size, BLOCKED: conflicts.blockedFindings },
    })
  }
  // 已完成子任务没写 findings：只是协作纪律提示，不升级。
  const doneWorkers = lanes.filter(lane => lane.role === 'worker' && lane.status === 'done')
  const covered = new Set(conflicts.items.filter(item => item.kind === 'findings' && item.lane).map(item => `${item.ticket}#${item.lane}`))
  const missing = doneWorkers.filter(lane => !covered.has(`${lane.ticket}#${lane.lane}`))
  if (missing.length > 0) {
    findings.push({
      dimension: 'team',
      severity: 'info',
      id: 'team:findings-missing',
      title: `${missing.length} 个已完成子任务没有写 shared findings`,
      detail: '子 worker 完成后应写一条 findings/<lane>.md，供后续 lane 和汇总阶段复用。',
      metrics: { 缺少findings: missing.length, 已完成子任务: doneWorkers.length },
      ticket: missing.length === 1 ? `${missing[0]!.ticket}` : undefined,
    })
  }
  return findings
}

/** 本机时区的日期键（YYYY-MM-DD）。台账 ts 不带时区，用 UTC 会错位 8 小时。 */
function localDayKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 「近 N 天」窗口包含的日期键集合（含今天，共 N 天）。
 *
 * 成本维度与趋势图必须共用这一个定义：早先成本维度只累加、不按日期过滤，
 * 而 scanTickets 只按「工单目录 7 天内还有动静」筛选，工单里更早的台账行会一起进来——
 * 于是「近7天成本」比趋势图各天之和高出一截（2026-11-10 实测多算 15 行 11-03 的 $9.28）。
 */
function windowDays(now: number, days: number): Set<string> {
  const set = new Set<string>()
  for (let i = days - 1; i >= 0; i--) set.add(localDayKey(now - i * 86400_000))
  return set
}

/** 把一个 stderr 归成「一条规则」的标识：取第一行并把数字/路径替换掉，避免同一条错误千变万化。 */
function stderrKey(text: string): string {
  const first = text.split('\n')[0]!.trim()
  return first.replace(/\d+/g, '#').replace(/\/[^\s]+/g, '/#').slice(0, 120)
}

/**
 * 执行器维度**按错误类型聚合**，不按工单铺。
 * 67 个工单都报同一句 unrecognized_model 时，用户需要知道的是「有一个全局配置问题」，
 * 而不是 67 条一模一样的条目。
 */
function executorFindings(scans: TicketScan[]): Finding[] {
  const byKey = new Map<string, { message: string; tickets: string[]; benign: boolean }>()
  for (const scan of scans) {
    if (!scan.stderr) continue
    const key = stderrKey(scan.stderr)
    if (!key) continue
    const benign = BENIGN_STDERR.some(pattern => pattern.test(scan.stderr))
    const entry = byKey.get(key) ?? { message: scan.stderr.split('\n')[0]!.trim(), tickets: [], benign }
    entry.tickets.push(scan.key)
    byKey.set(key, entry)
  }
  const findings: Finding[] = []
  for (const [key, entry] of byKey) {
    const count = entry.tickets.length
    // 良性告警只报一条 info，且标注「可忽略」，不再占 warn 名额。
    findings.push({
      dimension: 'executor',
      severity: entry.benign ? 'info' : 'warn',
      id: `executor:${key}`,
      title: entry.benign
        ? `已知良性告警，${count} 个工单出现过（可忽略）`
        : `执行器报错，${count} 个工单出现过`,
      detail: entry.benign
        ? 'unrecognized_model 只是 Claude Code 对模型名的 SDK 侧标注，不影响执行结果。如果哪天它开始伴随失败，再升级处理。'
        : '同一句报错跨多个工单出现，通常来自全局配置（模型名、端点、凭据），不是单个任务的问题。',
      ticket: count === 1 ? entry.tickets[0] : undefined,
      metrics: { 命中工单数: count, 良性: entry.benign ? '是' : '否' },
      evidence: entry.message.slice(0, 600),
    })
  }
  return findings
}

// ——— 维度三：预算纪律 ———

function budgetFindings(scans: TicketScan[], now: number): Finding[] {
  const findings: Finding[] = []
  let noPlan = 0
  let dupRuns = 0
  let capped = 0
  for (const scan of scans) {
    const status = scan.budget
    if (status) {
      const violation = status.violation
      const duplicates: string[] = Array.isArray(status.duplicates) ? status.duplicates : []
      const planned = Number(status.planned_steps ?? 0)
      const used = Number(status.steps_used ?? 0)
      if (violation) {
        // 已结束工单的历史违规无法补救，降为 info 审计；只有仍在跑的违规才需要立刻处理。
        const active = isActiveTicket(scan, now)
        findings.push({
          dimension: 'budget', severity: active ? 'critical' : 'info',
          id: `budget:violation:${scan.key}`,
          title: `${active ? '' : '历史遗留：'}预算违规：${String(violation).slice(0, 80)}`,
          detail: active
            ? '硬闸门已记录违规，本轮可能被提前终止。'
            : `工单已结束（最后活动 ${new Date(scan.at).toISOString()}），这次违规不会再影响后续轮次；保留作审计，不计入「需立刻处理」。`,
          ticket: scan.key,
          metrics: { 计划步数: planned, 实际步数: used },
          at: typeof status.ts === 'string' ? status.ts : undefined,
        })
      }
      if (duplicates.length >= THRESHOLDS.duplicateWarn) {
        dupRuns++
        findings.push({
          dimension: 'budget', severity: 'warn',
          id: `budget:duplicate:${scan.key}`,
          title: `重复调用同一命令 ${duplicates.length} 次`,
          detail: '重复执行既烧 token 又说明任务在原地打转，通常是上一步结果没被正确读取。',
          ticket: scan.key,
          metrics: { 重复次数: duplicates.length, 实际步数: used },
          evidence: duplicates.slice(0, 5).join('\n'),
        })
      }
      // 计划 14 步干到 26 步，属于估算失真；差距超过 2 倍才提示。
      if (planned > 0 && used > planned * 2) {
        findings.push({
          dimension: 'budget', severity: 'info',
          id: `budget:overshoot:${scan.key}`,
          title: `步数超计划 ${(used / planned).toFixed(1)} 倍`,
          detail: '该工单的预算校准系数会因此上调，属于自学习而非故障。',
          ticket: scan.key,
          metrics: { 计划步数: planned, 实际步数: used },
        })
      }
    }
    for (const row of scan.ledger) {
      if (row?.capped) {
        capped++
        // 与成本维度同一口径：只有「该工单最新一轮」且工单仍在跑，截断才是当下要处理的事。
        // 旧实现 17 条 capped 全部来自已结束工单的历史轮（最早到 11-06），却按 warn 常驻面板。
        const latestRun = scan.ledger.reduce((best: any, cur: any) =>
          String(cur?.ts ?? '') >= String(best?.ts ?? '') ? cur : best, scan.ledger[0])
        const isLatestRun = String(row?.run ?? '') === String(latestRun?.run ?? '')
        const active = isActiveTicket(scan, now)
        const current = isLatestRun && active
        findings.push({
          dimension: 'budget', severity: current ? 'warn' : 'info',
          id: `budget:capped:${scan.key}:${String(row.run ?? '')}`,
          title: `${current ? '' : '历史遗留：'}本轮触到硬上限被截断`,
          detail: current
            ? 'capped=true 意味着本次结果可能不完整，需要看是否是 --max-turns 或重复调用触发的。'
            : `工单已结束或该轮不是最新一轮（最后活动 ${new Date(scan.at).toISOString()}）：`
              + '这次截断不会再影响后续轮次，只作审计，不占「值得看一眼」名额。',
          ticket: scan.key,
          metrics: { 步数: Number(row.act_steps ?? 0), 成本: Number(row.cost_usd ?? 0) },
          at: typeof row.ts === 'string' ? row.ts : undefined,
        })
      }
      if (row?.plan_found === false) noPlan++
    }
  }
  // 没有预算计划本身只是 info：软计划是可选的，统计出来用于校准。
  const runs = scans.reduce((sum, scan) => sum + scan.ledger.length, 0)
  if (runs > 0 && noPlan > 0) {
    findings.push({
      dimension: 'budget', severity: 'info',
      id: 'budget:noplan',
      title: `${noPlan}/${runs} 轮没有预算计划`,
      detail: 'BUDGET_PLAN 是可选的，只用于事后校准。比例长期偏高说明执行层没在按计划走。',
      metrics: { 无计划轮数: noPlan, 总轮数: runs, 重复命中: dupRuns, 被截断: capped },
    })
  }
  return findings
}

// ——— 维度四：成本 ———

function costFindings(scans: TicketScan[], now: number, precomputed?: CostRow[]): { findings: Finding[]; metrics: Record<string, number | string | null> } {
  const findings: Finding[] = []
  const todayKey = localDayKey(now)
  // 近 7 天窗口按台账日期过滤：工单目录「还新鲜」不代表里面的台账行都在窗口内。
  const window = windowDays(now, 7)
  let worst: { cost: number; ticket: string; run: string; cache: number } | null = null
  // 三层口径：总额（真实花费）＝已校准 + 未校准；单轮指标只用已校准行。
  // 未校准行的钱是真花掉的，不能丢——它只是无法可靠拆到「某一轮」，所以按台账 ts 归日。
  let todayCalCost = 0
  let todayCalRuns = 0
  let todayUncalCost = 0
  let todayUncalRuns = 0
  // 「基线补齐」单独累计：它是真实花掉的钱，但没有对应台账行。
  // 不并进 windowCalCost 是故意的——单轮均值 = windowCalCost / windowCalRuns，
  // 并进去会让均值从 $1.73 漂到 $1.96（钱的来源不是「这一轮」，不该摊到轮数上）。
  let todayRecovered = 0
  let windowRecovered = 0
  let windowCalCost = 0
  let windowCalRuns = 0
  let windowUncalCost = 0
  let windowUncalRuns = 0
  let uncalibratedCost = 0
  let uncalibratedRuns = 0
  let historyRuns = 0
  let historyCost = 0
  const historyTickets = new Set<string>()

  const costRows = precomputed ?? trueCostRows(scans)
  // 每个工单「最新一轮」的 run 名：报警只指向还能处理的那一轮。
  // 旧实现用「工单目录是否新鲜」当判据，工单只要还在跑，里面每一轮历史高价（11-08、11-09 的跑）都会
  // 反复报 warn/critical；2026-11-10 实测 523 条里有 468 条是历史轮，10 条 critical 无一是各工单最新一轮。
  const latestRunByTicket = new Map<string, { run: string; ts: string }>()
  for (const { scan, row } of costRows) {
    if (row?.cost_usd === null || row?.cost_usd === undefined) continue
    const ts = String(row?.ts ?? '')
    const current = latestRunByTicket.get(scan.key)
    if (!current || ts >= current.ts) latestRunByTicket.set(scan.key, { run: String(row?.run ?? ''), ts })
  }

  for (const { scan, row, cost, calibrated, recoveredBase } of costRows) {
    // `act_cache_read` 是「本轮增量」，`act_cache_read_cum` 是「整个 run 累计」。
    // 早期台账没有增量字段，只能退回累计值；诊断文案用累计值，避免「缓存读 151K」却说「极高」。
    const cacheDelta = Number(row?.act_cache_read ?? row?.act_cache_read_cum ?? 0) || 0
    const cacheCum = Number(row?.act_cache_read_cum ?? row?.act_cache_read ?? 0) || 0
    const inputCum = Number(row?.act_input_cum ?? 0) || 0
    const outputCum = Number(row?.act_output_cum ?? 0) || 0
    const cache = cacheDelta
    const ts = String(row?.ts ?? '')
    const dayKey = ts.slice(0, 10)
    const isToday = dayKey === todayKey
    // 窗口外的行既不进今日、也不进近 7 天，更不参与单轮指标：
    // 它们属于「更早的历史」，只在趋势图对应那一天出现（趋势图本身也按窗口建桶）。
    const inWindow = window.has(dayKey)
    // 历史基线补齐：基线差分扣掉的那笔钱没有台账行，按本行 ts 归日还给总额。
    // 只加钱、不加轮数；也不进单轮指标（见 metrics 里单轮均值的分母）。
    if (recoveredBase > 0 && inWindow) windowRecovered += recoveredBase
    if (recoveredBase > 0 && isToday) todayRecovered += recoveredBase
    if (!calibrated) {
      // 未校准行：进总花费（按台账 ts 归日），但不进单轮均值/最贵单轮——它的 cost 是会话累计，
      // 拿去平均或比大小只会重现修好前的虚高。
      if (inWindow) {
        uncalibratedCost += cost
        uncalibratedRuns++
        windowUncalCost += cost
        windowUncalRuns++
      }
      if (isToday) { todayUncalCost += cost; todayUncalRuns++ }
      continue
    }
    if (isToday) { todayCalCost += cost; todayCalRuns++ }
    if (!inWindow) continue
    windowCalCost += cost
    windowCalRuns++
    if (!worst || cost > worst.cost) worst = { cost, ticket: scan.key, run: String(row?.run ?? ''), cache }
    if (cost < THRESHOLDS.runCostWarn) continue
    const isLatest = latestRunByTicket.get(scan.key)?.run === String(row?.run ?? '')
    // 非最新轮不逐条铺：同一工单的历史高价轮（11-08、11-09 跑过的）对「现在该处理什么」没有信息量，
    // 逐条列出会把面板变成流水账。聚合成一条 info，金额仍在（钱确实花了）。
    if (!isLatest) { historyRuns++; historyCost += cost; historyTickets.add(scan.key); continue }
    const steps = Number(row?.act_steps ?? 0)
    // 步数极少但花费极高，是典型的「一轮吃掉整个上下文」。
    // 它与「单轮成本超过阈值」是同一笔钱的两种说法，合并成一条，避免同一 run 被数两次。
    const bloat = steps > 0 && steps <= 3
    const overLimit = cost >= THRESHOLDS.runCostCritical
    // 只有真的超过 $5、且**这一轮是该工单最新一轮**、且工单仍在跑，才升级为「严重」：
    //   - 「仅 2 步花了 $2.50」这类低额 alert 应停在 warn，否则严重名额被噪音占满；
    //   - 已结束工单的尖峰无法再处理，只作 info 复盘，不占 warn 名额（见下）。
    const active = isActiveTicket(scan, now)
    const critical = overLimit && active
    // 长跑一轮（≥20 步）而每步成本低于常规线：总价高只是「干得多」，不是异常。
    // 2026-11-10 实测 523 条成本条目里 91% 属于这种（每分钟/每步成本与中位数同量级），
    // 拿「单轮总价 $1」当阈值等于把「工作量大」报成「成本失控」。
    const perStep = steps > 0 ? cost / steps : Infinity
    const efficientLong = steps >= THRESHOLDS.efficientLongSteps && perStep < THRESHOLDS.costPerStepWarn
    // 长跑且每步便宜：钱是「干出来的」，不升级；否则按 $5 + 活跃判定严重度。
    // 文案已经写明「工单已结束、无法再处理、保留作复盘」，严重度就必须是 info：
    // 旧实现这里仍给 warn，于是 8 条已结束工单的历史高价轮常年占「值得看一眼」名额，
    // 与同一条 finding 的 detail 自相矛盾（2026-11-11 实测）。
    const historical = !active
    const severity: Severity = efficientLong || historical
      ? 'info'
      : critical ? 'critical' : 'warn'
    const bloatDiagnosis = cacheCum >= 10_000_000
      ? `只有 ${steps} 次工具调用，但本轮累计缓存读 ${(cacheCum / 1_000_000).toFixed(1)}M，几乎一定是首轮把超大上下文整个读入。这是最该先切断的成本形态。`
      : inputCum >= 500_000
        ? `只有 ${steps} 次工具调用，但内部累计输入 ${Math.round(inputCum / 1000)}K、输出 ${Math.round(outputCum / 1000)}K：成本来自多次内部轮次，而不是单次巨型上下文。`
        : `只有 ${steps} 次工具调用却花了 $${cost.toFixed(2)}，单轮成本与产出不匹配，值得确认是否做了不必要的长上下文重读。`
    findings.push({
      dimension: 'cost',
      severity,
      id: `cost:run:${scan.key}:${String(row?.run ?? '')}`,
      title: `${active ? '' : '历史遗留：'}${bloat
        ? `仅 ${steps} 步就花了 $${cost.toFixed(2)}${overLimit ? `，超过 $${THRESHOLDS.runCostCritical}` : ''}`
        : overLimit
          ? `单轮成本 $${cost.toFixed(2)}，超过 $${THRESHOLDS.runCostCritical}`
          : `单轮成本 $${cost.toFixed(2)}`}`,
      detail: !isLatest
        ? `这是历史轮（该工单最新一轮是 ${latestRunByTicket.get(scan.key)?.run ?? '未知'}），后续轮次已覆盖它的状态，`
          + '钱已花掉、无法再处理；只作复盘，不占「需立刻处理/值得看一眼」名额。'
        : efficientLong
          ? `${steps} 步共花 $${cost.toFixed(2)}，每步 $${perStep.toFixed(2)}，低于常规线 $${THRESHOLDS.costPerStepWarn}：`
            + '总价高来自工作量大，不是上下文重放或成本失控，属正常吞吐。'
          : !active
            ? `工单已结束（该 run 结束于 ${ts || '未知时间'}），这笔钱已经花掉、无法再处理；保留作复盘，不计入「需立刻处理」。`
            : bloat
              ? bloatDiagnosis
              : critical
                ? '高价 run 一般是上下文过大或 resume 重放历史。看 cache_read 是否同时被打满。'
                : '高于常规单轮成本（$1 起）但低于 $5 严重线，值得看一眼是不是不必要的长上下文。',
      ticket: scan.key,
      metrics: { 成本: Number(cost.toFixed(4)), 每步成本: Number.isFinite(perStep) ? Number(perStep.toFixed(4)) : null, 缓存读: cache, 累计缓存读: cacheCum, 累计输入: inputCum, 输出: outputCum, 步数: steps },
      at: ts || undefined,
    })
  }
  // 未校准行的规模显式报出来：面板数据可信度取决于它有多大。
  if (uncalibratedRuns > 0) {
    findings.push({
      dimension: 'cost',
      severity: 'info',
      id: 'cost:uncalibrated',
      title: `另有 ${uncalibratedRuns} 轮没有会话基线，累计金额 $${uncalibratedCost.toFixed(2)} 已计入总花费、不参与单轮均值`,
      detail: '这些台账行的 baseline_source=none：cc-worker 在同目录的 runlog/台账里找不到同一 session 的更早 result，'
        + '无法把会话累计成本折成单轮增量（典型是新开会话的首轮、克隆会话、或 runlog 已清理）。'
        + '它们的钱确实花了，所以按台账 ts 计入今日/近7天总额；但 cost 是会话累计值，'
        + '拿去做单轮均值或最贵单轮会重现修好前的虚高，所以只从单轮指标里排除。',
      metrics: { 未校准轮数: uncalibratedRuns, 未校准金额: Number(uncalibratedCost.toFixed(4)) },
    })
  }
  // 历史高价轮（非该工单最新一轮）折叠成一条：逐条铺会把面板变成流水账，但金额不能凭空消失，
  // 否则「近7天成本」与各 finding 的加和对不上，评审会以为是漏报。
  if (historyRuns > 0) {
    findings.push({
      dimension: 'cost',
      severity: 'info',
      id: 'cost:history',
      title: `历史轮（非最新一轮）${historyRuns} 轮合计 $${historyCost.toFixed(2)}，已折叠不再逐条报`,
      detail: `这 ${historyRuns} 轮分布在 ${historyTickets.size} 个工单，都不是各自工单的最新一轮：`
        + '后续轮次已经覆盖了它们的运行状态，这些钱已经花掉、无法再处理，只作复盘。'
        + '金额仍计入「近7天成本」总额；逐条展开请查对应工单的 budget-ledger.jsonl。',
      metrics: {
        历史轮数: historyRuns,
        历史轮金额: Number(historyCost.toFixed(4)),
        涉及工单数: historyTickets.size,
      },
    })
  }
  // 三层口径并列：总额 = 已校准 + 未校准（钱都算上），单轮指标只用已校准行。
  return {
    findings,
    metrics: {
      今日成本: Number((todayCalCost + todayUncalCost + todayRecovered).toFixed(4)),
      今日轮数: todayCalRuns + todayUncalRuns,
      今日已校准: Number((todayCalCost + todayRecovered).toFixed(4)),
      今日未校准: Number(todayUncalCost.toFixed(4)),
      近7天成本: Number((windowCalCost + windowUncalCost + windowRecovered).toFixed(4)),
      近7天轮数: windowCalRuns + windowUncalRuns,
      近7天已校准: Number((windowCalCost + windowRecovered).toFixed(4)),
      近7天未校准: Number(windowUncalCost.toFixed(4)),
      // 面板上显式说明这笔钱的来源：已花掉但台账未留行，按轮次基线反推补回，不是新增花费。
      历史基线补齐: Number(windowRecovered.toFixed(4)),
      单轮均值: windowCalRuns ? Number((windowCalCost / windowCalRuns).toFixed(4)) : 0,
      最贵单轮: worst ? Number(worst.cost.toFixed(4)) : 0,
      最贵单轮工单: worst ? worst.ticket : null,
      未校准金额: Number(uncalibratedCost.toFixed(4)),
      未校准轮数: uncalibratedRuns,
    },
  }
}

// ——— 维度五：上下文 ———

function contextFindings(scans: TicketScan[], now: number): Finding[] {
  const findings: Finding[] = []
  // 历史轮（非各工单最新一轮）不逐条铺，折叠成一条 info：与成本维度同一套口径。
  // 换会话与缓存读都是「当时的运行状态」，后续轮次已经覆盖，已结束工单的旧异常无法再处理。
  let historyCacheRuns = 0
  let historyCacheTickets = new Set<string>()
  let liveSwitches = 0
  let staleSwitchTickets = 0
  for (const scan of scans) {
    const latest = scan.ledger.length
      ? scan.ledger.reduce((best: any, row: any) =>
        String(row?.ts ?? '') >= String(best?.ts ?? '') ? row : best, scan.ledger[0])
      : null
    const latestRun = String(latest?.run ?? '')
    const active = isActiveTicket(scan, now)
    // 换会话原因只留最后一次，够判断当前状态。
    const reason = scan.workerDir ? readHead(`${scan.workerDir}/switch-reason`, 200).trim() : ''
    const count = switchCount(scan.workerDir)
    if (count >= 2) {
      // 工单已结束、且最近 N 次换会话都不是最近这一轮的事：只作历史审计。
      // 旧实现不区分活跃度，171 个工单里 53 个在报，实测只有 1 个仍在跑。
      if (active) {
        liveSwitches++
        findings.push({
          dimension: 'context', severity: 'warn',
          id: `context:switch:${scan.key}`,
          title: `同一工单换会话 ${count} 次`,
          detail: '频繁换会话说明上下文持续膨胀。换会话本身省 token，但过于频繁意味着每个会话都没跑完就撑爆了。'
            + `当前判定：工单仍在进行（最后活动 ${new Date(scan.at).toISOString()}）。`,
          ticket: scan.key,
          metrics: { 换会话次数: count },
          evidence: reason || undefined,
        })
      } else {
        staleSwitchTickets++
      }
    }
    for (const row of scan.ledger) {
      // 单轮真实上下文，按可信度三档取，**任何一档都不允许落到累计值**：
      //   1. 台账 `context_size`：cc-worker 按 message.id 去重后取的最大 input+cache_read，正是单次上下文；
      //   2. runlog 逐条 assistant usage 的峰值（getTurnContextPeak），与 1 同义，用于 context_size 为空的轮次；
      //   3. 两档都没有 ⇒ 跳过（不拿 act_cache_read / result.usage.cache_read_input_tokens 顶替，
      //      它们是整轮累计，实测 24 次调用求和 = 2.53M，拿它比 400K 窗口会虚报十几倍）。
      const run = String(row?.run ?? '')
      const session = String(row?.session_id ?? '')
      const fromLedger = Number(row?.context_size) || 0
      const cache = fromLedger > 0
        ? fromLedger
        : (getTurnContextPeak(scan, run, session) ?? 0)
      const steps = Number(row?.act_steps ?? 0)
      if (cache >= THRESHOLDS.contextSizeWarn) {
        if (run !== latestRun || !active) {
          historyCacheRuns++
          historyCacheTickets.add(scan.key)
          continue
        }
        findings.push({
          dimension: 'context', severity: 'warn',
          id: `context:cache:${scan.key}:${run}`,
          title: `单轮上下文 ${Math.round(cache / 1000)}K，接近窗口上限`,
          detail: `本轮真实上下文（最后一次 API 调用的 input + cache_read）${Math.round(cache / 1000)}K，`
            + `超过告警线 ${Math.round(THRESHOLDS.contextSizeWarn / 1000)}K。声明窗口 400K，余量已不多，`
            + '下一轮 resume 会整段重放，应在该轮结束前写入交接并换会话。',
          ticket: scan.key,
          metrics: { 单轮上下文: cache, 步数: steps, 累计缓存读: Number(row?.act_cache_read ?? 0) || 0 },
          at: typeof row.ts === 'string' ? row.ts : undefined,
        })
      }
      if (steps >= THRESHOLDS.stepsWarn) {
        findings.push({
          dimension: 'context', severity: 'info',
          id: `context:steps:${scan.key}:${run}`,
          title: `单轮 ${steps} 步`,
          detail: '步数偏多的轮次，工具输出累积是上下文膨胀的主要来源。',
          ticket: scan.key,
          metrics: { 步数: steps },
          at: typeof row.ts === 'string' ? row.ts : undefined,
        })
      }
    }
  }
  // 被折叠的规模必须显式报出来，否则「0 条告警」会被误读成「历史上一路健康」。
  if (historyCacheRuns > 0) {
    findings.push({
      dimension: 'context', severity: 'info',
      id: 'context:history',
      title: `历史轮 ${historyCacheRuns} 次上下文逼近上限，已折叠不再逐条报`,
      detail: `涉及 ${historyCacheTickets.size} 个工单的历史轮或已结束工单：后续轮次已覆盖其运行状态，`
        + '且工单不在运行中，这些记录无法再处理，只作复盘。告警线按单轮真实上下文（context_size）'
        + `判 ${Math.round(THRESHOLDS.contextSizeWarn / 1000)}K，不再用一轮内累计缓存读。`,
      metrics: { 历史轮数: historyCacheRuns, 涉及工单数: historyCacheTickets.size },
    })
  }
  if (staleSwitchTickets > 0) {
    findings.push({
      dimension: 'context', severity: 'info',
      id: 'context:switch-history',
      title: `${staleSwitchTickets} 个已结束工单换过多次会话，已折叠`,
      detail: '工单已结束，换会话次数只反映历史运行形态；仍计入「换会话合计」指标，不再占「值得看一眼」名额。',
      metrics: { 已结束工单数: staleSwitchTickets, 进行中工单数: liveSwitches },
    })
  }
  return findings
}

// ——— 维度六：活性 ———

/**
 * 「运行中」的判定不能只看 handoff-state 的 updated：收尾轮不写状态。
 * 用 worker 目录里最新文件的 mtime 作为「最后有动静」的近似，再结合 claude.pid 是否还活着。
 */
function livenessFindings(scans: TicketScan[], now: number): Finding[] {
  const findings: Finding[] = []
  for (const scan of scans) {
    if (!scan.workerDir) continue
    const pidText = readHead(`${scan.workerDir}/claude.pid`, 32).trim()
    const pid = Number(pidText)
    const hasPid = Number.isFinite(pid) && pid > 0
    const alive = hasPid && pidAlive(pid)
    const silentMs = now - scan.at
    // pid 文件存在但工单已很久没动静：先查 /proc，区分「进程仍活着」与「残留 pid 文件」。
    if (hasPid && silentMs > THRESHOLDS.stallCriticalMs) {
      findings.push({
        dimension: 'liveness', severity: alive ? 'warn' : 'info',
        id: `liveness:stale:${scan.key}`,
        title: alive
          ? `进程 ${pid} 仍存活但已 ${Math.round(silentMs / 60000)} 分钟没动静`
          : `残留 pid 文件（进程 ${pid} 已退出），已 ${Math.round(silentMs / 60000)} 分钟无新动作`,
        detail: alive
          ? '进程还在但长时间没有新动作，可能卡在单个工具调用里，需要确认是否真的要继续等。'
          : '进程已经退出，只是 pid 文件没被清理；不需要处理，属于收尾残留。',
        ticket: scan.key,
        metrics: { pid, 进程存活: alive ? '是' : '否', 静默分钟: Math.round(silentMs / 60000) },
        at: new Date(scan.at).toISOString(),
      })
    } else if (silentMs > THRESHOLDS.stallWarnMs && silentMs <= THRESHOLDS.stallCriticalMs) {
      findings.push({
        dimension: 'liveness', severity: 'info',
        id: `liveness:idle:${scan.key}`,
        title: `${Math.round(silentMs / 60000)} 分钟无新动作`,
        detail: '处于停滞观察窗口内。长任务在单个工具里耗时不写文件，因此短时静默是正常的。',
        ticket: scan.key,
        metrics: { 静默分钟: Math.round(silentMs / 60000) },
      })
    }
  }
  return findings
}

/** 各维度的中文标题与图例，前端直接用。 */
export const DIMENSION_META: Record<DimensionKey, { label: string; hint: string }> = {
  team: { label: '团队协作', hint: 'team 计划、lane 状态、共享 findings 与冲突' },
  handoff: { label: '交接闭环', hint: '交接是否被写入、读走、正确提取' },
  executor: { label: '执行器', hint: 'cc-worker 与 Claude Code 进程侧的报错' },
  budget: { label: '预算纪律', hint: '计划、重复调用、硬上限' },
  cost: { label: '成本', hint: '单轮与今日花费，异常贵的 run' },
  context: { label: '上下文', hint: '缓存读、换会话、步数膨胀' },
  liveness: { label: '活性', hint: '运行中是否真的在动' },
}

/**
 * 跑一次完整治理扫描。
 * @param now 当前时间（毫秒），测试可注入。
 * @param options.ticket 只扫一个工单目录（验收取样/面板钻取）；默认全量。
 */
export function govern(now = Date.now(), options: { ticket?: string } = {}): GovernanceReport {
  const scans = scanTickets(now, options.ticket)
  // 面板把每条 lane 当独立执行单元扫，但「工单数」必须按唯一工单目录去重，否则 headline 会虚增。
  const ticketCount = new Set(scans.map(scan => scan.name)).size
  // 成本差分只算一次：lane 聚合与成本维度共用，避免同一批台账读两遍。
  const costRows = trueCostRows(scans)
  const lanes = buildLaneExecutions(scans, now, costRows)
  const team = buildTeamReport(lanes, scans, now)
  const conflicts = buildConflictReport(scans)
  const handoff = handoffFindings(scans, now)
  const executor = executorFindings(scans)
  const budget = budgetFindings(scans, now)
  const { findings: cost, metrics: costMetrics } = costFindings(scans, now, costRows)
  const context = contextFindings(scans, now)
  const switchTotal = scans.reduce((sum, scan) => sum + switchCount(scan.workerDir), 0)
  const liveness = livenessFindings(scans, now)
  const teamIssues = teamFindings(lanes, team, conflicts, scans, now)

  const findings = [...teamIssues, ...handoff, ...executor, ...budget, ...cost, ...context, ...liveness]
  // 排序：先按严重度，再按维度固定顺序，最后按时间倒序，保证界面稳定不跳动。
  const severityRank: Record<Severity, number> = { critical: 0, warn: 1, info: 2 }
  const order: DimensionKey[] = ['team', 'handoff', 'executor', 'budget', 'cost', 'context', 'liveness']
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]
    || order.indexOf(a.dimension) - order.indexOf(b.dimension)
    || String(b.at ?? '').localeCompare(String(a.at ?? '')))

  const groups: Record<DimensionKey, Finding[]> = {
    team: teamIssues, handoff, executor, budget, cost, context, liveness,
  }
  const dimensionMetrics: Record<DimensionKey, Record<string, number | string | null>> = {
    // 没有任何 team/lane/shared 数据时保持空对象，前端判定为「无数据」而不是「正常」。
    team: team.present || conflicts.present || team.lanes > 0 ? {
      团队工单: team.tickets,
      计划lane数: team.workerLanes,
      完成: team.done,
      失败: team.failed,
      进行中: team.running,
      未启动: team.pending,
      团队总成本: team.totalCostUsd,
      总轮次: team.totalRuns,
      峰值并行: team.peakParallelism,
      findings文件: conflicts.findingsFiles,
      冲突路径: conflicts.conflictPaths,
    } : {},
    handoff: {
      有交接记录: scans.filter(scan => scan.handoff).length,
      工单数: ticketCount,
    },
    executor: {
      有错误日志: scans.filter(scan => scan.stderr).length,
      工单数: ticketCount,
    },
    budget: {
      台账轮数: scans.reduce((sum, scan) => sum + scan.ledger.length, 0),
      有预算状态: scans.filter(scan => scan.budget).length,
    },
    cost: costMetrics,
    context: {
      换会话合计: switchTotal,
      有台账工单: scans.filter(scan => scan.ledger.length > 0).length,
    },
    liveness: {
      有worker目录: scans.filter(scan => scan.workerDir).length,
    },
  }

  const dimensions: DimensionSummary[] = order.map(key => {
    const list = groups[key]
    const critical = list.filter(item => item.severity === 'critical').length
    const warn = list.filter(item => item.severity === 'warn').length
    const issues = critical + warn
    return {
      key,
      issues,
      critical,
      warn,
      metrics: dimensionMetrics[key],
      // unknown 留给「数据源根本不存在」的情况，避免把「没数据」当成「全好」。
      verdict: critical > 0 ? 'bad' : warn > 0 ? 'watch' : (Object.keys(dimensionMetrics[key]).length ? 'ok' : 'unknown'),
    }
  })

  const totalCritical = findings.filter(item => item.severity === 'critical').length
  const totalWarn = findings.filter(item => item.severity === 'warn').length
  const overall: GovernanceReport['overall'] = totalCritical > 0 ? 'bad' : totalWarn > 0 ? 'watch' : 'ok'
  const headline = overall === 'ok'
    ? `七个维度全绿（${ticketCount} 个工单${team.present ? `，${team.workerLanes} 条 lane` : ''}，${costMetrics['近7天轮数'] ?? 0} 轮）`
    : `${totalCritical} 项需立刻处理，${totalWarn} 项值得看一眼`

  return {
    generatedAt: new Date(now).toISOString(),
    overall,
    headline,
    dimensions,
    findings,
    lanes,
    team,
    conflicts,
    scanned: {
      tickets: ticketCount,
      laneUnits: scans.filter(scan => scan.lane).length,
      withWorkerDir: scans.filter(scan => scan.workerDir).length,
      withHandoffState: scans.filter(scan => scan.handoff).length,
      ledgerRuns: scans.reduce((sum, scan) => sum + scan.ledger.length, 0),
      teamTickets: team.tickets,
    },
  }
}

/** 全局台账的按日汇总，用于「今日/本周成本」趋势。前端可以不要，路由按需提供。 */
export function spendTrend(now = Date.now(), days = 7): { day: string; cost: number; runs: number }[] {
  // 必须与 cost 维度同一个数据源和同一套差分，否则会出现「今日成本 $X 但趋势图最后一天 $Y」。
  // 早期实现直接累加全局台账，既没做 runlog 兜底，也把面板根本扫不到的 run 算了进去。
  const rows = trueCostRows(scanTickets(now))
  const buckets = new Map<string, { cost: number; runs: number }>()
  for (const day of windowDays(now, days)) buckets.set(day, { cost: 0, runs: 0 })
  for (const { row, cost, recoveredBase } of rows) {
    // 趋势图画的是「每天真花了多少钱」，所以未校准行也要计入（按台账 ts 归日）：
    // 总额与趋势最后一天必须对得上，否则又是一处口径分裂。
    // 基线补齐同理：钱按同一行 ts 归到那一天，只加钱不增轮数，否则趋势合计会小于「近7天成本」。
    const bucket = buckets.get(String(row?.ts ?? '').slice(0, 10))
    if (!bucket) continue
    bucket.cost += cost + recoveredBase
    bucket.runs++
  }
  return [...buckets.entries()].map(([day, value]) => ({ day, cost: Number(value.cost.toFixed(4)), runs: value.runs }))
}
