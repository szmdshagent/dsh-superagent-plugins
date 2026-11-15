/**
 * 协作模式在插件层需要的类型与最小工具函数。
 *
 * 这些字段（collab、result、note.from）原本是 2026-11-07 直接改在主包 core/model.ts 上的。
 * 为实现「升级不丢」，此处改为插件本地声明：工单在 SQLite 里整体 JSON 序列化存储，
 * 主包不认识的字段会原样保留，因此插件写入的 collab/result 既能持久化，也不干扰主包逻辑。
 */
import type { Ticket as CoreTicket, ReportState } from 'dsh-superagent'

/** 一组最多四张工单；自动组只到三张。 */
export const GROUP_LIMIT = 4
/** 自动组存活时间。 */
export const AUTO_GROUP_TTL_MS = 2 * 60 * 60_000

/**
 * 协作组成员关系：role 是该工单在组内的分工，dependsOn 是它等结果的同组工单。
 * 只是路由与看板事实，不授予权限，也不改变工单的授权或批次边界。
 */
export interface Collaboration {
  group: string
  role?: string
  dependsOn?: string[]
  auto?: true
  confidence?: number
  signals?: string[]
  writeScopes?: string[]
  expiresAt?: string
}

/** 给工单加组或改组时提交的内容；role 与 dependsOn 传 null 表示清除。 */
export interface CollaborationInput {
  group: string
  role?: string | null
  dependsOn?: readonly string[] | null
}

/** L1 结果卡：工单 ready 时从报告文本截取的只读摘要，供同域新工单复用。 */
export interface ResultCard {
  ticketId: string
  title: string
  conclusion: string
  artifacts: string[]
  numbers: string[]
  at: string
  keys: string[]
}

/** 带上协作字段的工单视图：主包类型 + 插件层附加字段。 */
export type Ticket = CoreTicket & { collab?: Collaboration; result?: ResultCard }

/** 最新一次报告；没有 report 的 assignment 不算。 */
export function latestReport (ticket: Pick<CoreTicket, 'assignments'> | undefined): { state: ReportState; summary?: string; at: string } | undefined {
  const assignments = Array.isArray(ticket?.assignments) ? [...ticket.assignments].reverse() : []
  for (const assignment of assignments) {
    if (assignment?.report) return assignment.report as { state: ReportState; summary?: string; at: string }
  }
  return undefined
}

/** 工单是否仍活着（未结束）。 */
export function liveTicket (ticket: Pick<CoreTicket, 'ended'> | undefined): boolean {
  return !!ticket && !ticket.ended
}
