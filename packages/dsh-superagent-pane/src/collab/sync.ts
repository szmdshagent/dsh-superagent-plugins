/**
 * 协作协调器：把主包原 collab 行为搬到插件层，靠定时轮询而非事务内钩子。
 *
 * 与主包版的三处差异（均可接受，均已注释说明）：
 *  1) 自动组队在建单后异步补写，不是同一事务 —— 协作组不授予权限，毫秒级窗口无实际影响。
 *  2) 终态广播靠轮询 ready report，延迟由毫秒级变成秒级 —— 内容等价。
 *  3) prepareTicket 钩子插件拿不到，故自动组队只能「事后补写」。
 */
import { planAutoGroup, collabView, AUTO_GROUP_TTL_MS } from './auto.ts'
import { COLLAB_WRITE } from './store.ts'
import { latestReport, liveTicket, type Collaboration } from './types.ts'

/** 轮询间隔。 */
export const COLLAB_SYNC_MS = 15_000
/** 自动组候选窗口：只有最近这么多分钟活动过的工单参与聚类。 */
export const COLLAB_ACTIVITY_MS = 30 * 60_000

export interface CollabHost {
  store: any
  now: number
  /** 工单的所有 thread key（origin triggers + follows）。 */
  ticketThreads: (ticket: any) => string[]
  /** 写回工单；主包不认识 collab，但会原样持久化。 */
  save: (ticket: any) => void
  /** 追加一条 note 到工单输入（广播用）。 */
  addNote: (ticketId: string, note: { id: string; text: string; at: string; from: string }) => void
  logger?: any
}

/** 给一张新工单尝试自动组队；返回写入的组关系或 undefined。 */
export function autoGroupTicket (host: CollabHost, ticket: any, all: any[]): Collaboration | undefined {
  if (!COLLAB_WRITE || ticket.collab) return undefined
  const view = collabView(ticket, host.ticketThreads(ticket))
  // planAutoGroup 要的是 {view, group} 候选；group 从候选自身的 collab 推出（人工组会被下游跳过）。
  const candidates = all.filter(item => item.id !== ticket.id && liveTicket(item)
    && Date.parse(String(item.updatedAt ?? '')) >= host.now - COLLAB_ACTIVITY_MS)
    .map(item => ({
      view: collabView(item, host.ticketThreads(item)),
      group: item.collab?.group
        ? { id: item.collab.group, auto: !!item.collab.auto, members: [] }
        : undefined,
    }))
  const plan = planAutoGroup(view, candidates, new Date(host.now).toISOString())
  if (!plan) return undefined
  return { group: plan.group, auto: true, confidence: plan.confidence, signals: plan.signals,
    writeScopes: view.writeScopes, expiresAt: plan.expiresAt }
}

/**
 * 自动组回收：全部成员已结束、超过 TTL、或组内有 dropped 且判为无关报告时解散。
 * 人工组（没有 auto 标记）一律不动。
 */
export function dissolveDueGroups (host: CollabHost, all: any[]): number {
  if (!COLLAB_WRITE) return 0
  const groups = new Map<string, any[]>()
  for (const ticket of all) {
    const name = ticket?.collab?.group
    if (!name) continue
    const list = groups.get(name) ?? []
    list.push(ticket)
    groups.set(name, list)
  }
  let dissolved = 0
  for (const [, members] of groups) {
    if (members.some(member => !member.collab?.auto)) continue
    const expiry = members.flatMap(member => member.collab?.expiresAt ? [Date.parse(member.collab.expiresAt)] : []).sort()[0]
    const expired = expiry !== undefined && Number.isFinite(expiry) && host.now >= expiry
    const allEnded = members.every(member => !liveTicket(member))
    if (!expired && !allEnded) continue
    for (const member of members) { delete member.collab; host.save(member) }
    dissolved += 1
  }
  return dissolved
}

/**
 * 终态广播：同组某成员产生新的 ready 报告时，给组内其他工单各补一条 note。
 * 按 ticketId+assignmentId+state 幂等，重复扫描不会重复投递。
 */
export function shareReadyReports (host: CollabHost, all: any[]): number {
  if (!COLLAB_WRITE) return 0
  let shared = 0
  for (const ticket of all) {
    const group = ticket?.collab?.group
    if (!group) continue
    const assignments: any[] = Array.isArray(ticket.assignments) ? ticket.assignments : []
    const last = assignments[assignments.length - 1]
    const report = latestReport(ticket)
    // 只广播 ready：progress/waiting/dropped 没有可复用结论，广播只会制造噪声。
    if (!last || !report || report.state !== 'ready') continue
    for (const member of all) {
      if (member.id === ticket.id || member.collab?.group !== group) continue
      const text = 'Group ' + group + ': ticket ' + ticket.id + ' reported ready. Result: ticket/' + ticket.id + '/result.'
      host.addNote(member.id, {
        id: 'collab-' + member.id + '-' + ticket.id + '-' + last.id + '-' + report.state,
        text, at: new Date(host.now).toISOString(), from: ticket.id,
      })
      shared += 1
    }
  }
  return shared
}
