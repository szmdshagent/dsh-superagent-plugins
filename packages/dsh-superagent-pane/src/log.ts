/**
 * 面板对话日志：面板插件与收尾插件共用的一份镜像。
 *
 * 域内（dsh-superagent）只保存 Trigger 与 Outbox 回执，读不到面板要的对话形态，所以这里按对话镜像一份：
 * 入站消息在 `SourceContext.receive` 被调用时记（任何入口注入的面板 Trigger 都会经过它），
 * 出站消息在 `channel.send` 里记。两个插件同包共用这个模块，避免两份实现各自漂移。
 */

/** 入站与出站都用的条目形态；`ticketId` 只有出站消息才有。 */
export type LogEntry = {
  id: string
  direction: 'in' | 'out'
  at: string
  text: string
  kind?: string
  ticketId?: string
  /** dispatch（派活）或 chat（问答）；入站条目用来区分派活与闲聊。 */
  mode?: string
  /** 投递/处理状态标记。 */
  status?: string
}

/** 每个对话保留的条数上限与字符总预算；超出后从最旧的开始丢弃。 */
export const LOG_ENTRIES = 2000
export const LOG_CHARS = 400_000

/** 一个对话一份 KV 记录；外部插件用纯字符串键，kv.ts 已说明这是允许的。 */
export const logKey = (conversation: string) => `pane-log:${conversation}` as any

/** 读出某对话的全部条目；没有记录时返回空数组。 */
export function readLog(source: any, conversation: string): LogEntry[] {
  const stored = source?.state?.get(logKey(conversation))
  return Array.isArray(stored) ? (stored as LogEntry[]) : []
}

/**
 * 先按条数截断，再按字符预算从最旧丢弃：一条超长消息不至于把整个对话挤掉，一份记录也不会无限增长。
 */
export function trimLog(entries: LogEntry[]): LogEntry[] {
  const kept = entries.slice(-LOG_ENTRIES)
  let used = 0
  let start = kept.length
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    used += (kept[index]?.text?.length ?? 0) + 96
    if (used > LOG_CHARS) break
    start = index
  }
  return kept.slice(start)
}

/** 追加一条；同一个 id 再写会替换原条目而不是重复（域内重试会重复投递回执）。 */
export function appendLog(source: any, conversation: string, entry: LogEntry): void {
  if (!source?.state || typeof conversation !== 'string' || !conversation) return
  const existing = readLog(source, conversation)
  const next = trimLog([...existing.filter(item => item.id !== entry.id), entry])
  source.state.set(logKey(conversation), next)
}