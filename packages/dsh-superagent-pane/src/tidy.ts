/**
 * dsh-superagent-pane-tidy：工单收尾。
 *
 * superagent 每接一张工单就建一个工作区加一个 worker 会话，工单结束后它们留在原处。面板没有删除入口，
 * 归档又会被「有活跃工作」拒绝，于是越积越多。这个插件在工单结束后替人收尾：
 *
 *   1. 把结果（含失败、放弃与原因）写回它出发的那个面板对话，让失败不再无声无息；
 *   2. 归档该工单的 worker 会话（`stopActivity`，会顺带停掉它残留的工作）；
 *   3. 工作区里再没有别的会话时，注销这个工作区注册（只注销登记，磁盘目录默认保留）。
 *
 * 判定用会话 id 的形状 `worker-<工单 id>`，不依赖目录路径，所以换 stateDir 也不会失效。
 */
import { appendLog, readLog } from './log.js'

export const name = 'dsh-superagent-pane-tidy'
export const inject = ['orchestrator', 'workspaceRegistry', 'webServer']

/** 面板 Source 的 id；只有出发于面板的工单才把结果写回面板。 */
const PANE = 'pane'
/** 每轮收尾的间隔；本地库读取，成本很低。 */
const DEFAULT_POLL_MS = 30_000
/** worker 会话 id 的形状：`worker-<工单 id>`，与 `ticketOfSession` 一致。 */
const WORKER_SESSION = /^worker-(.+)$/
/** 收尾通知只写「刚刚结束」的工单；更早的历史工单不再翻出来重播。 */
const NOTICE_MAX_AGE_MS = 30 * 60_000
/** 已通知过的工单 id（持久化）：同一张工单只写一次，不随每轮扫描重复。 */
const NOTIFIED_KEY = 'pane-tidy-notified' as any
const NOTIFIED_LIMIT = 5000
/** 工单结局的中文说法。 */
const OUTCOME_TEXT: Record<string, string> = {
  completed: '完成', merged: '已合并', dropped: '已放弃',
}

type Config = { pollMs?: number; removeDirectories?: boolean }

/** 一轮收尾做了什么；状态路由读它，便于确认插件在工作。 */
type Status = {
  startedAt: string
  lastSweepAt: string | null
  sweeps: number
  archived: string[]
  removedWorkspaces: string[]
  removedDirectories: string[]
  errors: string[]
}

export function apply(ctx: any, config: Config = {}): void {
  const orchestrator = ctx.orchestrator
  const registry = ctx.workspaceRegistry
  const pollMs = Number.isFinite(config.pollMs) && Number(config.pollMs) > 0 ? Number(config.pollMs) : DEFAULT_POLL_MS
  const removeDirectories = config.removeDirectories === true
  const status: Status = {
    startedAt: new Date().toISOString(), lastSweepAt: null, sweeps: 0,
    archived: [], removedWorkspaces: [], removedDirectories: [], errors: [],
  }

  /** 工单出发的那个面板对话；不是面板发起的工单就没有，也就不写回。 */
  const conversationOf = (source: any, ticket: any): string | undefined => {
    const refs: any[] = []
    const originChannel = ticket?.origin?.triggerId ? source.triggers?.get(ticket.origin.triggerId)?.channel : undefined
    if (originChannel) refs.push(originChannel)
    if (Array.isArray(ticket?.channels)) refs.push(...ticket.channels)
    for (const ref of refs) {
      if (ref?.source === PANE && typeof ref.address?.conversation === 'string' && ref.address.conversation) {
        return ref.address.conversation
      }
    }
    return undefined
  }

  /**
   * 收集一张结束了的工单的通知文案（不写日志）。同一条只收集一次。
   *
   * 2026-11-11 改：以前每张结束都往面板对话各写一条，一次收尾批次会瞬间刷 8~10 条「工单已结束」，
   * 把真正有用的回答挤出可视区（实测 main 对话 1342 条里绝大部分是这类通知，用户的问题回复被淹没）。
   * 现在改为：没人接手的废单不通知，有产出的按批次汇总成一条。
   *
   * 2026-11-11 再改：归档失败的会话会一直留在 workspace 列表里，每轮扫描都把它当"刚结束"重播一次
   * （实测同一批 42 张旧工单被写了 200 多条一模一样的「本批 N 张工单已收尾」）。现在按工单 id 去重，
   * 并且只通知最近 30 分钟内结束的工单——历史积压不再翻出来重播。
   */
  const collectEnded = (source: any, ticketId: string): { conversation: string; text: string } | undefined => {
    const ticket = source.tickets?.get(ticketId)
    const conversation = conversationOf(source, ticket)
    if (!conversation) return undefined
    const ended = ticket?.ended
    // 只播报刚结束的：更早的工单用户早就知道了，重播只会刷屏。
    const endedAt = Date.parse(String(ended?.at ?? ''))
    if (!Number.isFinite(endedAt) || Date.now() - endedAt > NOTICE_MAX_AGE_MS) return undefined
    const outcome = OUTCOME_TEXT[String(ended?.outcome)] ?? (ended ? String(ended.outcome) : '已结束')
    const reason = typeof ended?.reason === 'string' && ended.reason ? `，原因：${ended.reason}` : ''
    const title = typeof ticket?.title === 'string' && ticket.title ? `「${ticket.title}」` : ` ${ticketId}`
    // 判断有没有答复：新条目带工单号，可以直接比对；本次改动之前写下的回复没有工单号，
    // 就用时间兜底——工单开始之后的任何一条结果回复都算它答复过了，免得把有回复的报成「没有回复」。
    const startedAt = Date.parse(String(ticket?.createdAt ?? '')) || 0
    const answered = readLog(source, conversation).some(item => {
      if (item.direction !== 'out' || item.kind !== 'reply') return false
      if (item.ticketId === ticketId) return true
      return item.ticketId === undefined && startedAt > 0 && Date.parse(item.at) >= startedAt
    })
    // 无产出结束（被人停止/放弃）且没有结果回复的，属于噪音：不通知。
    const silent = !answered && (ended?.by === 'human' || String(ended?.outcome) === 'stopped' || String(ended?.outcome) === 'dropped')
    if (silent) return undefined
    return { conversation, text: `工单${title}已结束：${outcome}${reason}` }
  }

  /** 把一批结束通知合并成极少数几条写回面板：同对话超过 3 张就只写一条汇总。 */
  const flushEnded = (source: any, items: { conversation: string; text: string }[], stamp: string): void => {
    const byConversation = new Map<string, string[]>()
    for (const item of items) {
      const list = byConversation.get(item.conversation) ?? []
      list.push(item.text)
      byConversation.set(item.conversation, list)
    }
    for (const [conversation, texts] of byConversation) {
      // 单张照常逐条写（有上下文意义）；一次超过 3 张说明是批量收尾，只报数量与最近一张，
      // 不把几十张旧工单的标题再列一遍（那一段长通知用户读不过来，也没人真的看）。
      const chunks = texts.length > 3
        ? [`本批 ${texts.length} 张工单已收尾：最近${texts[texts.length - 1]!.replace(/^工单/, '')}`]
        : texts
      chunks.forEach((text, index) => appendLog(source, conversation, {
        id: `tidy:${stamp}:${index}`,
        direction: 'out',
        at: new Date().toISOString(),
        text,
        kind: 'notice',
      }))
    }
  }

  /** 归档一个 worker 会话；活跃中的工作由 `stopActivity` 停掉，不因为它在跑就放弃收尾。 */
  const archiveSession = async (sessionId: string): Promise<void> => {
    await registry.archiveSession(sessionId, { stopActivity: true })
  }

  /** 只删 stateDir/work 底下的目录：即便开关被打开，也不碰别处的任何路径。 */
  const workRoot = (): string | undefined => {
    try {
      const stateDir = orchestrator.context({ kind: PANE, health: ['pane'] })?.deployment?.stateDir
      return typeof stateDir === 'string' && stateDir ? `${stateDir.replace(/[\\/]+$/, '')}/work` : undefined
    } catch {
      return undefined
    }
  }

  const removeDirectory = async (path: string): Promise<void> => {
    const root = workRoot()
    if (!root || typeof path !== 'string' || !path.startsWith(`${root}/`)) return
    const { rm } = await import('node:fs/promises')
    await rm(path, { recursive: true, force: true })
    status.removedDirectories.push(path)
  }

  const sweep = async (): Promise<void> => {
    const source = orchestrator.context({ kind: PANE, health: ['pane'] })
    if (!source.configured || !source.configured()) return
    const open = new Set<string>((source.tickets?.open() ?? []).map((ticket: any) => String(ticket.id)))
    /** 已通知过的工单 id（持久化）：同一张工单只播报一次，避免每轮扫描重播。 */
    const notified = new Set<string>(Array.isArray(source.state.get(NOTIFIED_KEY)) ? source.state.get(NOTIFIED_KEY) : [])
    /** 本轮收集到的结束通知，循环结束后统一合并写出（避免一次刷十几条）。 */
    const endedNotices: { conversation: string; text: string }[] = []
    const freshlyNotified: string[] = []
    for (const workspace of registry.list()) {
      const sessions: string[] = Array.from(workspace?.sessionIds ?? []).map(String)
      // 只认工单已经不在开放集合里的 worker 会话；正在跑的那张工单因此绝不会被碰到。
      const finished = sessions.filter(sessionId => {
        const matched = WORKER_SESSION.exec(sessionId)
        return !!matched && !open.has(matched[1]!)
      })
      if (finished.length === 0) continue
      for (const sessionId of finished) {
        const ticketId = WORKER_SESSION.exec(sessionId)![1]!
        try {
          if (!notified.has(ticketId)) {
            const item = collectEnded(source, ticketId)
            if (item) { endedNotices.push(item); freshlyNotified.push(ticketId) }
          }
        } catch (error) {
          status.errors.push(`report ${ticketId}: ${String(error)}`)
        }
        try {
          await archiveSession(sessionId)
          status.archived.push(sessionId)
        } catch (error) {
          status.errors.push(`archive ${sessionId}: ${String(error)}`)
          // 归档没成的会话别跟着注销工作区，否则它就成了只在库里、面板上找不到的孤儿。
          continue
        }
      }
      // 整间工作区只剩刚归档的 worker 时连登记一起注销；混着别的会话就留着。
      const rest = sessions.filter(sessionId => !status.archived.includes(sessionId))
      if (sessions.length > 0 && rest.length === 0) {
        try {
          await registry.delete(workspace.id)
          status.removedWorkspaces.push(String(workspace.id))
          if (removeDirectories && typeof workspace.path === 'string') await removeDirectory(workspace.path)
        } catch (error) {
          status.errors.push(`workspace ${workspace.id}: ${String(error)}`)
        }
      }
    }
    // 本轮收集到的结束通知统一写出：同对话超过 3 张合成一条，避免一次收尾刷屏。
    if (endedNotices.length) {
      try {
        flushEnded(source, endedNotices, new Date().toISOString())
        // 写成功才记名单，写失败下一轮还会重试。
        source.state.set(NOTIFIED_KEY, [...notified, ...freshlyNotified].slice(-NOTIFIED_LIMIT))
      } catch (error) {
        status.errors.push(`notify: ${String(error)}`)
      }
    }
    status.sweeps += 1
    status.lastSweepAt = new Date().toISOString()
    if (status.archived.length || status.removedWorkspaces.length || status.errors.length) {
      ctx.logger.info('dsh-superagent-pane-tidy swept: %d archived, %d workspaces removed, %d errors',
        status.archived.length, status.removedWorkspaces.length, status.errors.length)
    }
  }

  // 状态路由：确认插件在跑、看上一轮收了什么。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/orchestrator/api/tidy/status',
    handler: (req: any, res: any) => {
      if (req.headers['x-orchestrator-request'] !== '1') {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'Same-origin management request required' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ...status, removeDirectories, pollMs }))
    },
  }), 'tidy: status route')

  // 先跑一轮再定时：装上就把历史积压收干净，不用等第一个间隔。失败只记不抛，定时器不能被一次异常打断。
  const run = () => { sweep().catch(error => { status.errors.push(String(error)) }) }
  const timer = setInterval(run, pollMs)
  const first = setTimeout(run, 5_000)
  ctx.effect(() => () => { clearInterval(timer); clearTimeout(first) }, 'tidy: sweep timer')
}