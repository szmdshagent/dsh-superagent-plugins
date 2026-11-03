/**
 * dsh-superagent-pane：在面板里派活给 superagent，并显示 worker 正在做什么。
 *
 * 这个包独立存在是有意为之：`/home/szm/src/dsh-superagent-prototype` 不是 git 检出，官方升级会整体覆盖目录。
 * 所以本包只依赖 dsh-superagent 公开导出的接口（`Trigger`、`key`）和 Cordis 服务（`orchestrator`、`webServer`、
 * `sessionPersistence`），路由与 Source 都自己注册，主包 `git pull && pnpm build` 不会碰它。
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key, type Trigger } from 'dsh-superagent'
import { readCcStatus, requestInterrupt, clearInterrupt, probeExecutor } from './ccvis.ts'
import { ticketHealth, type ExecutorSignals } from './health.ts'

/**
 * 本插件挂接的 Cordis 服务。`orchestrator` 由 dsh-superagent 声明；`webServer` 与 `sessionPersistence` 是
 * DSH 宿主的服务（主包 inject 里同样要求 sessionPersistence，所以它必定存在）。类型在这里自行声明，
 * 不依赖主包 `exports` 未公开的内部类型。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-superagent 的 SourceHost：注册 Source 并取得按 kind 划分的上下文。 */
    orchestrator: {
      readonly sources: { register(kind: unknown): () => void }
      /** 主 Session 的会话 id（Runtime 公开字段），自愈用。 */
      readonly masterId?: string
      /** 宿主 Store 的工单集合（Runtime 公开字段），自愈时取活跃工单的 worker 会话。 */
      readonly store?: { readonly tickets?: { open?: () => readonly { sessionId?: string }[] } }
      context(kind: { kind: string; health: readonly string[] }): {
        receive(trigger: Trigger): string | Promise<string>
        report(entry: string, health: { state: string; detail: string }): void
        /** 源作用域的持久 KV；kv.ts 明确支持外部插件使用普通字符串键。 */
        state: {
          get<V>(key: any): V | undefined
          set<V>(key: any, value: V | undefined): void
        }
      }
    }
    /** DSH 工作区的会话注册表；被归档的会话无法运行任何回合，这里用于自愈。 */
    workspaceRegistry: {
      readonly archivedSessionIds: readonly string[]
      unarchiveSession(sessionId: string): Promise<void>
    }
    /** DSH 的环回 Web 服务；prefix 路由匹配 `path` 以及 `path/<任意>`。 */
    webServer: {
      register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: any, res: any) => unknown }): () => void
    }
    /** DSH 的会话持久化服务（这里只做只读）：按会话 id 打开事件流，用来显示 worker 当前动作。 */
    sessionPersistence: {
      open(id: string, access: 'read' | 'write'): Promise<{
        read(offset?: number, length?: number): Promise<{ events: readonly PaneSessionEvent[] }>
        close(): Promise<void>
      }>
    }
  }
}

/** 只读消费的会话事件形状；只关心 `type`/`time`/`data`，其余字段不理会。 */
type PaneSessionEvent = { type?: string; time?: number; data?: any }

export const name = 'dsh-superagent-pane'
export const inject = ['orchestrator', 'sessionPersistence', 'webServer', 'workspaceRegistry']

/** Source id；Thread 键为 `pane:<对话>`。 */
const SOURCE = 'pane'
/** 面板对话所属的唯一准入作用域。 */
const ROW = 'panel'
/** 面板上报的发送者，代表持有面板令牌的人。 */
const OWNER = 'owner'

const ConversationSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, '仅限字母、数字、- 和 _')
const TextSchema = z.string().trim().min(1).max(8000)
const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)

/**
 * 构造面板里一条消息的 Trigger。
 *
 * 两种模式对齐引擎语义：
 * - `dispatch`（默认）：`addressed: 'mention'` → 已允许发送者的消息是 explicit，直接建单/追加给工单，权限完整。
 * - `chat`：不带 addressed → 消息按准入表成为 inferred 候选，交给主 Session（router）分诊：它能直接答疑，
 *   或按规则接下小活；不需要工单的问题不会再变成工单。
 *
 * 对话模式刻意走「影子线程」`<对话>~chat`：引擎的 gate 规定「线程有自己的工单时，一律消息归该工单」
 * （followup 分支先于准入表生效），所以只要还在原线程上，对话消息就会被排进运行中工单的队列、router 收不到。
 * 影子线程永不被工单订阅，router 任何时刻都能立刻接话；回复经 channel 地址仍回落到原对话显示。
 */
export function paneTrigger(conversation: string, text: string, sender: string = OWNER, mode: 'dispatch' | 'chat' = 'dispatch'): Trigger {
  const thread = mode === 'chat' ? `${conversation}~chat` : conversation
  return {
    id: key('pane', thread, randomUUID()),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: sender },
    human: true,
    ...(mode === 'chat' ? {} : { addressed: 'mention' as const }),
    at: new Date().toISOString(),
    text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { conversation } },
    meta: { conversation },
  }
}

/**
 * 注册 Source kind 时拿到的 SourceContext。`channel.send` 只收到命令运行器，所以 kind 保留这个引用，
 * 用它访问支撑对话记录的作用域 KV。
 */
let liveSource: any

/** Source kind：一个作用域、没有配置项，回复本身就在本地。 */
const paneKind: any = {
  kind: SOURCE,
  title: { zh: '面板', en: 'Panel' },
  description: {
    zh: '在面板的对话里输入消息即可派活；发了消息就有一个对话，不需要配置。',
    en: 'Dispatch work by typing in a panel conversation; a conversation exists once a message names it, with nothing to configure.',
  },
  schema: z.object({}).strict(),
  fields: [],
  health: ['pane'],
  // 面板观察自己对话作用域里的全部消息（用户在这里说的话没有"@不@"之分），所以 observed 为 true——
  // 未打 addressed 的「对话」消息才有资格进准入表、成为 router 的候选。
  scope: () => ({ listened: true, observed: true, row: ROW }),
  channel: {
    allowed: () => true,
    // 不出进程：每条回复追加到面板读回的那份对话记录里。
    send: async (_host: any, message: any) => {
      const conversation = message?.channel?.address?.conversation
      if (liveSource && typeof conversation === 'string' && conversation) {
        appendLog(liveSource, conversation, {
          id: message.id, direction: 'out', at: new Date().toISOString(),
          text: String(message.text ?? ''), kind: message.kind,
        })
      }
      return 'sent' as const
    },
    link: (address: Record<string, string>) => ({
      url: '', label: { zh: `面板对话 ${address.conversation ?? ''}`, en: `Panel conversation ${address.conversation ?? ''}` },
    }),
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine((users: { id: string }[]) => new Set(users.map(user => user.id)).size === users.length, '发送者 id 不能重复')
        .default([{ id: OWNER, name: '我' }]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能在面板里派活的人', en: 'People who may dispatch from the panel' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' }, pattern: '[A-Za-z0-9_-]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: {
      zh: '面板只给本团队使用。「派活」模式的消息是明确的请求（自动 explicit，不需要 @ 智能体），直接建单或追加给工单；「对话」模式的消息交给主 Session 分诊，能直接答疑或按规则接活。',
      en: 'The panel is for this team only. Messages sent in Dispatch mode are explicit requests (no mention needed) and become or join tickets; messages sent in Chat mode are triaged by the main Session, which answers directly or accepts rule-matched work.',
    },
    rows: () => [{ id: ROW, label: { zh: '面板对话', en: 'Panel conversations' }, note: { zh: '全部消息', en: 'Everything' },
      cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } }],
  },
}

/** 读取 JSON 请求体，超过 `limit` 字节即拒绝。 */
async function readJson(req: any, limit = 64 * 1024): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function sendJson(res: any, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

/**
 * 把消息累积进面板自己的对话记录。
 *
 * 领域层把入站 Trigger 与出站回执分开存放，而面板的读取接口不在本插件的可达面内，所以对话在这里镜像一份：
 * 每个对话一条 KV 记录，设上限，避免长对话把存储撑爆。
 */
const LOG_LIMIT = 200
const logKey = (conversation: string) => `pane-log:${conversation}` as any
/** 手动关闭的工单 id 名单（只影响面板显示，不动工单）；设上限，避免名单无限增长。 */
const HIDDEN_LIMIT = 200
const hiddenKey = 'pane-hidden' as any
type LogEntry = { id: string; direction: 'in' | 'out'; at: string; text: string; kind?: string; status?: string; mode?: string }

function appendLog(source: any, conversation: string, entry: LogEntry): void {
  const key = logKey(conversation)
  const existing: LogEntry[] = source.state.get(key) ?? []
  const next = [...existing.filter((item: LogEntry) => item.id !== entry.id), entry].slice(-LOG_LIMIT)
  source.state.set(key, next)
}

// ——— worker 活动：读 worker 会话的事件流，回答「现在在做什么」 ———

/** 只保留事件尾部这么多条，足够描述当前动作。 */
const ACTIVITY_TAIL = 80
/** 只读句柄缓存，键为会话 id；增量读取，避免每 2.5 秒轮询都全量解析长会话。 */
const openReads = new Map<string, { handle: any; offset: number; tail: PaneSessionEvent[]; touched: number }>()
/** 空闲这么久（毫秒）的句柄会被关闭，不让缓存无限占用文件。 */
const IDLE_CLOSE_MS = 10 * 60_000

type PaneActivity = {
  state: 'running' | 'thinking' | 'waiting' | 'idle'
  kind: 'job' | 'tool' | 'text' | null
  tool?: string
  text?: string
  at?: number
  ageMs?: number
}

/** 把工具参数 JSON 压成一行可读文本，优先取命令 / 文件路径 / 检索词。 */
function toolText(args: unknown): string {
  if (typeof args !== 'string' || !args) return ''
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    const value = parsed.command ?? parsed.file_path ?? parsed.path ?? parsed.pattern ?? parsed.query ?? parsed.url ?? parsed.description ?? parsed.text
    return typeof value === 'string' ? value : args
  } catch {
    return args
  }
}

/** 从事件尾部往回找最近一个有描述价值的动作。 */
function lastAction(tail: readonly PaneSessionEvent[]): Pick<PaneActivity, 'kind' | 'tool' | 'text'> | undefined {
  for (let index = tail.length - 1; index >= 0; index--) {
    const event = tail[index]!
    const data = event.data ?? {}
    if (event.type === 'job/registered') return { kind: 'job', tool: String(data.kind ?? ''), text: String(data.label ?? '') }
    if (event.type === 'tool/call') return { kind: 'tool', tool: String(data.name ?? ''), text: toolText(data.arguments) }
    if (event.type === 'assistant/message') {
      const parts: any[] = data.message?.content ?? []
      const text = parts.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n').trim()
      const call = parts.find(part => part?.type === 'tool-call')
      if (call) return { kind: 'tool', tool: String(call.name ?? ''), text: toolText(call.arguments) }
      if (text) return { kind: 'text', text }
    }
  }
  return undefined
}

/**
 * 根据事件尾部判断 worker 状态，并配上一句「在做什么」。
 *
 * 状态语义：`running` 表示最后一步还没收尾（作业或工具调用仍在进行）；`thinking` 表示模型刚开口或刚进入
 * 新步骤；`waiting` 表示上一步已收尾、正等下一步；`idle` 表示没有事件。
 */
function describeActivity(events: readonly PaneSessionEvent[], now: number): PaneActivity {
  const tail = events.slice(-ACTIVITY_TAIL)
  if (!tail.length) return { state: 'idle', kind: null }
  const last = tail[tail.length - 1]!
  const at = typeof last.time === 'number' ? last.time : undefined
  const type = last.type ?? ''
  const state: PaneActivity['state'] = type === 'job/registered' || type === 'tool/call' ? 'running'
    : type === 'assistant/message' || type === 'step/start' ? 'thinking' : 'waiting'
  const action = lastAction(tail) ?? { kind: null as null }
  return { state, ...action, at, ageMs: at === undefined ? undefined : now - at }
}

/** 丢弃并关闭一个缓存的只读句柄。 */
function dropRead(sessionId: string, entry: { handle: any }): void {
  openReads.delete(sessionId)
  void entry.handle.close().catch(() => {})
}

/** 增量读取 worker 会话尾部事件，汇总成当前活动。 */
async function readActivity(persistence: any, sessionId: string): Promise<PaneActivity> {
  const now = Date.now()
  let entry = openReads.get(sessionId)
  if (!entry) {
    const handle = await persistence.open(sessionId, 'read')
    entry = { handle, offset: 0, tail: [], touched: now }
    openReads.set(sessionId, entry)
  }
  entry.touched = now
  let events: readonly PaneSessionEvent[]
  try {
    ({ events } = await entry.handle.read(entry.offset))
  } catch (error) {
    // 句柄失效就丢掉缓存，下次调用重新打开；本次如实报错。
    dropRead(sessionId, entry)
    throw error
  }
  if (events.length) {
    entry.offset += events.length
    entry.tail = [...entry.tail, ...events].slice(-ACTIVITY_TAIL)
  }
  for (const [id, item] of openReads) {
    if (item !== entry && now - item.touched > IDLE_CLOSE_MS) dropRead(id, item)
  }
  return describeActivity(entry.tail, now)
}

/**
 * 收集执行器活跃信号：.cc-worker 产物（进程存活 / 事件文件 mtime）+ worker 会话最后事件。
 * 长任务执行期间 Assignment 的投递时间戳不再变化，靠这些信号把「还在跑」与「真僵尸」区分开。
 */
async function collectExecutorSignals(ctx: any, ticket: any): Promise<ExecutorSignals> {
  const signals: ExecutorSignals = {}
  try {
    const dir = String(ticket?.execution?.directory ?? '')
    if (dir) Object.assign(signals, probeExecutor(dir))
  } catch { /* 目录读不到就只看会话 */ }
  try {
    const sessionId = String(ticket?.sessionId ?? '')
    if (sessionId) {
      const activity = await readActivity(ctx.sessionPersistence, sessionId)
      const at = typeof activity?.at === 'number' ? activity.at : undefined
      if (at !== undefined) signals.atMs = Math.max(signals.atMs ?? 0, at)
    }
  } catch { /* 宿主内部变动：忽略，不影响健康判定 */ }
  return signals
}

/** 按 id 找工单（含已结束的）；读不到就返回 undefined。 */
function findTicket(ctx: any, ticketId: string): any {
  try {
    const tickets = ctx.orchestrator?.store?.tickets
    const hit = tickets?.get?.(ticketId)
    if (hit) return hit
    for (const ticket of tickets?.list?.() ?? []) if (ticket?.id === ticketId) return ticket
  } catch { /* 宿主内部变动：当作找不到 */ }
  return undefined
}

/** 找该对话线程上挂着僵尸 Assignment 的工单；没有则返回 undefined。 */
async function zombieOnThread(ctx: any, conversation: string): Promise<{ ticketId: string; detail?: string } | undefined> {
  const threadKey = `${SOURCE}:${conversation}`
  try {
    for (const ticket of ctx.orchestrator?.store?.tickets?.open?.() ?? []) {
      const threads: any[] = Array.isArray(ticket?.threads) ? ticket.threads : []
      if (!threads.some(entry => entry?.key === threadKey)) continue
      const health = ticketHealth(ticket, Date.now(), await collectExecutorSignals(ctx, ticket))
      if (health.health === 'zombie') return { ticketId: String(ticket.id), detail: health.detail }
    }
  } catch { /* 宿主内部变动：当作没有僵尸，按原路投递 */ }
  return undefined
}

/**
 * 面板路由。
 *
 * `receive` 与 GitHub、Feishu 两个 Source 用的是同一个入口，所以面板消息走完全相同的路径：准入、路由、工单、worker。
 */
function paneHandler(ctx: any) {
  return async (req: any, res: any): Promise<void> => {
    if (req.headers['x-orchestrator-request'] !== '1') {
      sendJson(res, 403, { error: 'Same-origin management request required' }); return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const source = ctx.orchestrator.context({ kind: SOURCE, health: ['pane'] })
    try {
      // POST /orchestrator/api/pane/message —— 派出一条消息（默认派活；mode=chat 交给 router）。
      if (req.method === 'POST' && url.pathname === '/orchestrator/api/pane/message') {
        const body = z.object({ conversation: ConversationSchema, text: TextSchema,
          mode: z.enum(['dispatch', 'chat']).default('dispatch') }).parse(await readJson(req))
        // 防陷：该对话的线程上若挂着僵尸 Assignment，消息投进去会永远出不来。
        // 这时自动改投到一个新线程，让它成为独立工单，并把原因如实告诉调用方。
        let conversation = body.conversation
        let rerouted: string | undefined
        if (body.mode === 'dispatch') {
          const zombie = await zombieOnThread(ctx, conversation)
          if (zombie) {
            const stamp = new Date().toTimeString().slice(0, 5).replace(':', '')
            conversation = `${body.conversation.replace(/[^A-Za-z0-9_-]/g, '')}-r${stamp}`
            rerouted = zombie.detail
            ;(ctx as any).logger?.warn?.('dsh-superagent-pane: 线程 %s 挂着僵尸工单 %s，已改投新线程 %s',
              body.conversation, zombie.ticketId, conversation)
          }
        }
        // 投递前先手解档：跟进可能唤醒已结束的工单，而它的 worker 会话可能已被收尾归档
        // （被归档的会话跑不了回合，投递只会秒 blocked、消息丢失）。详见 wakeThreadSessions。
        await wakeThreadSessions(ctx, conversation)
        const trigger = paneTrigger(conversation, body.text, OWNER, body.mode)
        appendLog(source, conversation, { id: trigger.id, direction: 'in', at: trigger.at, text: trigger.text, mode: body.mode })
        const received = await source.receive(trigger)
        sendJson(res, 200, { triggerId: trigger.id, thread: `${SOURCE}:${conversation}`, received,
          ...(rerouted ? { rerouted, originalConversation: body.conversation, conversation } : {}) })
        return
      }
      // GET /orchestrator/api/pane/activity/<会话 id> —— worker 当前在做什么。
      const activityMatch = /^\/orchestrator\/api\/pane\/activity\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      if (req.method === 'GET' && activityMatch) {
        const sessionId = SessionIdSchema.parse(activityMatch[1])
        const activity = await readActivity(ctx.sessionPersistence, sessionId)
        sendJson(res, 200, { sessionId, activity })
        return
      }
      // GET /orchestrator/api/pane/log/<对话> —— 面板渲染用的对话流。
      const logMatch = /^\/orchestrator\/api\/pane\/log\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      if (req.method === 'GET' && logMatch) {
        const conversation = logMatch[1]!
        sendJson(res, 200, { conversation, thread: `${SOURCE}:${conversation}`, items: source.state.get(logKey(conversation)) ?? [] })
        return
      }
      // GET /orchestrator/api/pane/hidden —— 面板上被手动关闭（不再显示）的工单 id 名单。
      if (req.method === 'GET' && url.pathname === '/orchestrator/api/pane/hidden') {
        const ids: string[] = source.state.get(hiddenKey) ?? []
        sendJson(res, 200, { ids })
        return
      }
      // POST /orchestrator/api/pane/hide —— 关闭一张工单卡：只把 id 记进名单，不动工单本身。
      // 进行中的工单由浏览器侧先走宿主的 stop，再调用这里收起，服务端不重复做决定。
      if (req.method === 'POST' && url.pathname === '/orchestrator/api/pane/hide') {
        const body = z.object({ ticketId: z.string().regex(/^[A-Za-z0-9_-]+$/) }).parse(await readJson(req))
        const existing: string[] = source.state.get(hiddenKey) ?? []
        const next = [...existing.filter(id => id !== body.ticketId), body.ticketId].slice(-HIDDEN_LIMIT)
        source.state.set(hiddenKey, next)
        sendJson(res, 200, { hidden: true, count: next.length })
        return
      }
      // GET /orchestrator/api/pane/health/<工单 id> —— 真实的执行健康度（识别假 idle 的僵尸 Assignment）。
      const healthMatch = /^\/orchestrator\/api\/pane\/health\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      if (req.method === 'GET' && healthMatch) {
        const ticket = findTicket(ctx, healthMatch[1]!)
        if (!ticket) { sendJson(res, 404, { error: 'ticket not found' }); return }
        const signals = await collectExecutorSignals(ctx, ticket)
        sendJson(res, 200, { ticketId: healthMatch[1], stage: ticket.stage ?? null, health: ticketHealth(ticket, Date.now(), signals) })
        return
      }
      // GET /orchestrator/api/pane/cc/<工单 id> —— 该工单交给 Claude Code 的执行实况（只读）。
      const ccMatch = /^\/orchestrator\/api\/pane\/cc\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      if (req.method === 'GET' && ccMatch) {
        const ticketId = ccMatch[1]!
        const ticket = findTicket(ctx, ticketId)
        if (!ticket) { sendJson(res, 404, { error: 'ticket not found' }); return }
        const dir = String(ticket.execution?.directory ?? '')
        if (!dir) { sendJson(res, 200, { ticketId, directory: '', cc: { present: false, state: 'none', steps: [], interruptRequested: false, alert: 'none' } }); return }
        sendJson(res, 200, { ticketId, directory: dir, cc: readCcStatus(dir) })
        return
      }
      // POST /orchestrator/api/pane/cc/<工单 id>/interrupt —— 请求中止 CC 执行。
      const ccStop = /^\/orchestrator\/api\/pane\/cc\/([A-Za-z0-9_-]+)\/(interrupt|clear)$/.exec(url.pathname)
      if (req.method === 'POST' && ccStop) {
        const ticket = findTicket(ctx, ccStop[1]!)
        if (!ticket) { sendJson(res, 404, { error: 'ticket not found' }); return }
        const dir = String(ticket.execution?.directory ?? '')
        if (!dir) { sendJson(res, 400, { error: 'ticket has no execution directory' }); return }
        const ok = ccStop[2] === 'interrupt' ? requestInterrupt(dir) : clearInterrupt(dir)
        sendJson(res, 200, { ticketId: ccStop[1], action: ccStop[2], ok })
        return
      }
      sendJson(res, 404, { error: 'Unknown pane operation' })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

// ——— 自愈：被「归档」的会话跑不了任何回合 ———
//
// DSH 的 archived-session-gate 规定：被归档的会话（或其子代理谱系）在恢复前不允许执行模型步骤——迟到唤醒
// 的投递只会让回合作废（约 30ms 以 `blocked` 结束）。对 orchestrator 主会话而言这等于整个派活引擎静默瘫痪：
// router 不再答疑、eval 永远无人裁决、relay 被吞。2026-11-02 实际发生过（面板里归档会话/清工作区时把
// 「dsh-superagent orchestrator」一并归档，表现为「对话模式迟迟没人回」）。这里定期检查并自动取消归档。

/** 自愈检查间隔；一次只是内存数组查找，代价可忽略。 */
const UNARCHIVE_SWEEP_MS = 30_000

/** 需要保护的会话：主 Session + 所有活跃工单的 worker 会话（都被归档过就一定有东西停摆）。 */
function protectedSessions(ctx: any): string[] {
  const ids: string[] = []
  try { if (typeof ctx.orchestrator?.masterId === 'string' && ctx.orchestrator.masterId) ids.push(ctx.orchestrator.masterId) } catch { /* 宿主内部变动：跳过 */ }
  try {
    for (const ticket of ctx.orchestrator?.store?.tickets?.open?.() ?? []) {
      // 工单对象上没有现成的会话字段（主包 Ticket 模型不含 sessionId），worker 会话 id 按形状推导：
      // `worker-<工单 id>`，与 tidy 的 WORKER_SESSION 正则、执行器建会话的命名一致。此前这里读的
      // ticket.sessionId 恒为 undefined，等于 worker 从未进过保护名单——收尾归档后没有解档兜底，
      // 跟进已结束工单的投递会被 archived-session-gate 拒掉（回合秒 blocked、消息丢失、工单永卡 idle）。
      const sid = typeof ticket?.sessionId === 'string' && ticket.sessionId
        ? ticket.sessionId
        : (typeof ticket?.id === 'string' && ticket.id ? `worker-${ticket.id}` : '')
      if (sid) ids.push(sid)
    }
  } catch { /* 工单集合读不到就只保护主会话 */ }
  return ids
}

/** 一次自愈扫描：发现受保护会话被归档就立刻取消归档，并如实记日志。 */
async function unarchiveSweep(ctx: any): Promise<void> {
  for (const id of protectedSessions(ctx)) {
    if (!ctx.workspaceRegistry.archivedSessionIds.includes(id)) continue
    await ctx.workspaceRegistry.unarchiveSession(id)
    ;(ctx as any).logger?.info?.('dsh-superagent-pane: 已自动取消归档会话 %s（被归档的会话无法运行任何回合，会让派活链路静默瘫痪）', id)
  }
}

/**
 * 投递前先手解档：把该对话线程相关工单的 worker 会话从归档里解出来。
 *
 * 与自愈扫描同因：收尾插件（tidy）会把已结束工单的 worker 会话归档（并以 stopActivity 终止残留活动），
 * 归档会话跑不了任何回合——对它的迟到投递只会让回合约 40ms 内以 blocked 结束、消息被消费后无人再唤醒，
 * 表现为「跟进已结束工单，但工单永远停在 idle」。面板是跟进已结束工单的主要入口，所以在把 trigger
 * 交给引擎之前先解档，让回合真的能开跑。筛选口径对齐引擎 intake 的 fanout：线程上所有跟随该线程的
 * 工单（`follows`，兼容读 `threads` 形状），跳过人停的（对它们消息本来就不投，见 `resumes` 条件）。
 */
async function wakeThreadSessions(ctx: any, conversation: string): Promise<void> {
  try {
    const registry = ctx.workspaceRegistry
    const archived: readonly string[] = registry?.archivedSessionIds ?? []
    if (!archived.length) return
    const threadKey = `${SOURCE}:${conversation}`
    const followsThread = (ticket: any): boolean => {
      const follows: any[] = Array.isArray(ticket?.follows) ? ticket.follows : []
      if (follows.some(entry => entry?.thread === threadKey)) return true
      const threads: any[] = Array.isArray(ticket?.threads) ? ticket.threads : []
      return threads.some(entry => entry?.key === threadKey)
    }
    const tickets = ctx.orchestrator?.store?.tickets
    const seen = new Set<string>()
    const all: any[] = [...(tickets?.open?.() ?? []), ...(tickets?.list?.() ?? [])]
    for (const ticket of all) {
      const id = String(ticket?.id ?? '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      if (ticket?.ended?.by === 'human') continue // 人停的工单撤回授权，消息本来就不投给它
      if (!followsThread(ticket)) continue
      const sessionId = `worker-${id}`
      if (!archived.includes(sessionId)) continue
      await registry.unarchiveSession(sessionId)
      ;(ctx as any).logger?.info?.('dsh-superagent-pane: 投递前已解档会话 %s（跟进已结束工单需要唤醒它的 worker 会话）', sessionId)
    }
  } catch { /* 解档失败不阻断投递；若回合仍被归档门禁拒掉，自愈扫描与日志可见 */ }
}

export function apply(ctx: Context): void {
  // 先注册 kind：sources.register() 会重新认领 `pane` 健康项并重置为 `starting`，所以下面的上报必须排在后面，
  // 否则会被覆盖。
  ctx.effect(() => ctx.orchestrator.sources.register(paneKind as any), 'pane: source kind')
  ctx.effect(() => {
    const source = ctx.orchestrator.context({ kind: SOURCE, health: ['pane'] })
    liveSource = source
    // 没有轮询也没有凭据：kind 一注册面板就能用。放到下一个 tick 上报，避免被注册动作的重置覆盖。
    const timer = setTimeout(() => {
      source.report('pane', { state: 'ready', detail: 'Panel conversations accept messages' })
    }, 0)
    return () => { clearTimeout(timer); liveSource = undefined }
  })
  // 喂给 kind 的路由。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/orchestrator/api/pane',
    handler: paneHandler(ctx),
  }), 'pane: dispatch route')
  // 自愈：启动时扫一次，之后每 30 秒一次；被归档的 orchestrator/worker 会话自动恢复。
  ctx.effect(() => {
    let busy = false
    const sweep = () => {
      if (busy) return
      busy = true
      void unarchiveSweep(ctx).catch(error => {
        ;(ctx as any).logger?.warn?.('dsh-superagent-pane: 自动解档检查失败 %s', String(error))
      }).finally(() => { busy = false })
    }
    const boot = setTimeout(sweep, 0)
    const timer = setInterval(sweep, UNARCHIVE_SWEEP_MS)
    return () => { clearTimeout(boot); clearInterval(timer) }
  }, 'pane: unarchive self-heal')
}