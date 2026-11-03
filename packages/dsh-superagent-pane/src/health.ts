/**
 * 僵尸 Assignment 检测（只读，不改主包）。
 *
 * 原型 `stage.ts` 的判定有一条致命漏洞：
 *   if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
 * 它只看 report，不看 assignment 是否真的还在 `running`。昨晚 VM 反复重启制造出一条
 * `state: running` 却永远不收尾的 Assignment；report 停在 `waiting`，于是工单被算成
 * `idle`，面板显示"待命"，但后续消息都被投进这条僵尸会话，卡死在里面。
 *
 * 这里把假 idle 认出来，面板据此改显示，并在派活时把消息改投到新线程，避免再陷进去。判据分三层：
 *   - 执行器有活信号（进程 / 事件文件 / 会话新事件）→ 在跑，不是僵尸（长任务的投递时间戳天然不动）；
 *   - 执行器已交回终态 report（waiting 等）→ 正常待命，不是僵尸（等下一步可以等很久）；
 *   - 只有「running、没有任何 report、且长时间无投递无活动」才算僵尸。
 */

/** 判定为僵尸的时间阈值：Assignment 在此期间没有任何新投递、也没有任何执行活动。 */
export const ZOMBIE_MS = 20 * 60_000

/** 执行器活跃信号（由调用方探测后传入）：用来把「投递后长跑的正常任务」与真僵尸区分开。 */
export type ExecutorSignals = {
  /** 最近一次执行活动时间（毫秒）：事件文件 mtime 或 worker 会话最后事件。 */
  atMs?: number
  /** 执行器进程是否存活（claude.pid 指向的 CC 进程）。 */
  alive?: boolean
}

export type Health = 'ok' | 'idle' | 'zombie' | 'working'

export type TicketHealth = {
  health: Health
  /** 真实的 Assignment 状态（不是 stage 推出来的）。 */
  assignmentState?: string
  assignmentId?: string
  /** 距最近一次投递过去了多久（毫秒）。 */
  silentMs?: number
  /** 面板用的一句话说明；`ok` 时为空。 */
  detail?: string
}

/** 把时间戳（ISO 字符串或数字）解析成毫秒；解析不出来返回 undefined。 */
function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 判定一张工单的真实健康度。
 *
 * 判定顺序：
 *   1. 已结束 → ok（不归这里管）
 *   2. 没有 assignment 或 pending → idle（正常排队）
 *   3. assignment 已 ended / pending → 正常
 *   4. assignment 仍是 running，但执行器已交回终态 report（waiting/blocked/failed/ready）→ working（等下一步）
 *   5. 执行器仍在动（进程存活 / 事件文件刷新 / 会话新事件）→ working
 *   6. 以上都不成立、且超过 ZOMBIE_MS 没有任何新投递或活动 → zombie
 */
export function ticketHealth(ticket: any, now = Date.now(), signals?: ExecutorSignals): TicketHealth {
  if (!ticket || ticket.ended) return { health: 'ok' }
  // 列表接口把 assignments 给成数字计数，只有详情/store 里才是数组。
  // 拿到数字时无法判断真实状态，返回 unknown 而不是谎报 idle，免得把正在跑的工单说成没开始。
  if (typeof ticket.assignments === 'number') {
    return { health: 'working', detail: '列表视图只有计数，无法判断执行健康度' }
  }
  const assignments: any[] = Array.isArray(ticket.assignments) ? ticket.assignments : []
  const assignment = assignments.length ? assignments[assignments.length - 1] : undefined
  if (!assignment) return { health: 'idle', detail: '还没有开始执行' }
  const state = String(assignment.state ?? '')
  const assignmentId = String(assignment.id ?? '')
  const report = String(assignment.report?.state ?? '')

  // 已收尾的 Assignment 不可能是僵尸。
  if (state === 'ended' || state === 'pending') {
    return { health: state === 'pending' ? 'idle' : 'ok', assignmentState: state, assignmentId }
  }

  // 仍标 running：用「最近一次投递或执行活动」判断是不是假活。
  // 长任务（如 cc-worker 跑 Claude Code 几十分钟）执行期间投递时间戳天然不动，
  // 所以要结合调用方传入的执行器活跃信号（进程存活 / 事件文件刷新 / 会话新事件）。
  const delivered = toMs(assignment.deliveredAt) ?? toMs(assignment.startedAt) ?? toMs(assignment.createdAt)
  const lastActive = Math.max(delivered ?? 0, signals?.atMs ?? 0)
  const silentMs = lastActive > 0 ? Math.max(0, now - lastActive) : undefined
  const base = { assignmentState: state, assignmentId, silentMs }
  // 执行器已交回终态 report（waiting 待命 / blocked 待人 / failed 出错 / ready 交付）：
  // 「等下一步」是正常形态，长待命不算僵尸（会话被归档的真僵尸已由 unarchiveSweep 自愈兜底）。
  if (report === 'waiting' || report === 'blocked' || report === 'failed' || report === 'ready') {
    return { ...base, health: 'working', detail: '已交回等待中，可继续投递' }
  }
  const expired = silentMs !== undefined && silentMs > ZOMBIE_MS
  if (signals?.alive || !expired) {
    return { ...base, health: 'working' }
  }
  const mins = Math.round((silentMs ?? 0) / 60_000)
  return {
    ...base,
    health: 'zombie',
    detail: `执行器已 ${mins} 分钟没有任何动静，多半是卡死的僵尸任务；新消息会投进去出不来`,
  }
}
