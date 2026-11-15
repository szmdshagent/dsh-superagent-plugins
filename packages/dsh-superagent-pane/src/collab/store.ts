/**
 * 协作组关系的读写：直接操作工单对象上的 collab 字段。
 *
 * 工单在 SQLite 里是整体 JSON 序列化存储，主包不认识 collab 也会原样保存，
 * 所以插件可以在不改主包的前提下维护协作组。
 *
 * 开关：COLLAB_WRITE 为 false 时只读不写（默认），用于「插件与主包版并存」的过渡期；
 * 主包里的协作实现删掉后再打开写入。
 */
import { GROUP_LIMIT, type Collaboration, type CollaborationInput, liveTicket } from './types.ts'

/** 是否允许插件写 collab 字段。主包协作实现已于 2026-11-15 摘除，插件成为唯一写入方，故开启。 */
export const COLLAB_WRITE = true

/** 出错原因，与主包 error 码同名，便于前端复用文案。 */
export class CollabError extends Error {
  constructor (readonly code: string) { super(code) }
}

/** 校验并归一化一次组写入；抛 CollabError 表示拒绝。 */
export function normalizeChange (change: CollaborationInput): { group: string; role?: string; dependsOn: string[] } {
  const group = String(change.group ?? '').trim()
  if (!group || group.length > 64 || /[\s/]/.test(group)) throw new CollabError('collabGroupInvalid')
  const role = change.role == null ? undefined : String(change.role)
  if (role !== undefined && (role.length > 40 || /[\r\n]/.test(role))) throw new CollabError('collabRoleInvalid')
  const dependsOn = change.dependsOn == null ? [] : [...change.dependsOn].map(String)
  if (dependsOn.length > GROUP_LIMIT - 1) throw new CollabError('collabDependency')
  return { group, ...(role ? { role } : {}), dependsOn }
}

/** 是否已构成环：沿 dependsOn 走，回到起点即成环。 */
export function closesCycle (edges: Map<string, readonly string[]>, from: string): boolean {
  const seen = new Set<string>()
  const walk = (id: string): boolean => {
    if (id === from) return true
    if (seen.has(id)) return false
    seen.add(id)
    return (edges.get(id) ?? []).some(walk)
  }
  return (edges.get(from) ?? []).some(walk)
}

/** 校验组容量与依赖合法性，返回要写入的最终字段。 */
export function validateAgainstGroup (ticket: any, change: CollaborationInput, all: any[]): Collaboration {
  const { group, role, dependsOn } = normalizeChange(change)
  if (!ticket || !liveTicket(ticket)) throw new CollabError('ticketEnded')
  const members = all.filter(item => item?.collab?.group === group && item.id !== ticket.id)
  if (members.length >= GROUP_LIMIT) throw new CollabError('collabGroupFull')
  const dependencies = dependsOn.filter(id => id !== ticket.id && all.some(item => item.id === id && item.collab?.group === group))
  if (dependencies.length !== dependsOn.length) throw new CollabError('collabDependency')
  const edges = new Map<string, readonly string[]>(
    [...members, { ...ticket, collab: { group, dependsOn: dependencies } }].map(item => [item.id, item.collab?.dependsOn ?? []]),
  )
  if (dependencies.some(() => closesCycle(edges, ticket.id))) throw new CollabError('collabCycle')
  return { group, ...(role ? { role } : {}), ...(dependencies.length ? { dependsOn: dependencies } : {}) }
}
