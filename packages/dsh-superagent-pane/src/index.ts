/**
 * dsh-superagent-pane：在面板里派活给 superagent，并显示 worker 正在做什么。
 *
 * 这个包独立存在是有意为之：`/home/szm/src/dsh-superagent-prototype` 不是 git 检出，官方升级会整体覆盖目录。
 * 所以本包只依赖 dsh-superagent 公开导出的接口（`Trigger`、`key`）和 Cordis 服务（`orchestrator`、`webServer`、
 * `sessionPersistence`），路由与 Source 都自己注册，主包 `git pull && pnpm build` 不会碰它。
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type Trigger } from 'dsh-superagent'
import { readCcStatus, requestInterrupt, clearInterrupt, probeExecutor } from './ccvis.ts'
import { ticketHealth, type ExecutorSignals } from './health.ts'
import { appendLog as appendLogShared, logKey as logKeyShared } from './log.ts'
import { nextOccurrence, scheduleKey, SCHEDULE_PREFIX, type PaneSchedule, type ScheduleSpec } from './schedule.ts'

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
      /** 引擎（Runtime 公开字段）；搁浅消息自愈用 `reevaluate` 重新入队。 */
      readonly engine?: { reevaluate(triggerId: string): boolean }
      /** 宿主 Store（Runtime 公开字段），自愈与分流判断用。 */
      readonly store?: {
        readonly tickets?: {
          open?: () => readonly { id?: string; sessionId?: string; ended?: unknown }[]
          get?(id: string): any
        }
        readonly threads?: { get?(key: string): any }
        readonly triggers?: {
          get?(id: string): any
          disposition?(id: string): any
        }
      }
      context(kind: { kind: string; health: readonly string[] }): {
        receive(trigger: Trigger): string | Promise<string>
        report(entry: string, health: { state: string; detail: string }): void
        /** 源作用域的持久 KV；kv.ts 明确支持外部插件使用普通字符串键。 */
        state: {
          get<V>(key: any): V | undefined
          set<V>(key: any, value: V | undefined): void
          keys(prefix: string): string[]
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
/** 定时派活的频率与请求体。 */
const ScheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间须为 HH:mm')
const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every'), everyMinutes: z.number().int().min(1).max(43_200) }).strict(),
  z.object({ kind: z.literal('daily'), time: ScheduleTimeSchema }).strict(),
  z.object({ kind: z.literal('weekly'), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7), time: ScheduleTimeSchema }).strict(),
  z.object({ kind: z.literal('at'), at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, '一次性时间须为 YYYY-MM-DDTHH:mm') }).strict(),
])
const ScheduleIdSchema = z.string().regex(/^[0-9a-f]{12,32}$/)

/**
 * 构造面板里一条消息的 Trigger。
 *
 * 两种模式对齐引擎语义：
 * - `assign`（派活，默认）：`addressed: 'mention'` → 已允许发送者的消息是 explicit。**新建工单还是跟进已有工单，
 *   由路由器按内容自己判断**（2026-11-11 合并：原来拆成「路由器分配」「worker 续做」两档，太麻烦，
 *   改由路由器一次决定）。正文不再附加「必须新建」或「必须 attach」的约束，只说明这张卡片的性质。
 * - `chat`（只对话）：**也带 addressed 走 explicit**，附「只回答、不建单」约束。
 *   以前用 inferred 让路由器分诊，但 `eval.mode=auto` 下路由器一旦匹配到规则就会 accept 建单，
 *   于是「对话」其实也会派活；改成 explicit + 正文约束后，建单与否完全由消息里的约束决定。
 *
 * 对话模式刻意走「影子线程」`<对话>~chat`：引擎的 gate 规定「线程有自己的工单时，一律消息归该工单」
 * （followup 分支先于准入表生效），所以只要还在原线程上，对话消息就会被排进运行中工单的队列、router 收不到。
 * 影子线程永不被工单订阅，router 任何时刻都能立刻接话；回复经 channel 地址仍回落到原对话显示。
 *
 * 派活模式**只在会话线程上的工单已卡死（zombie，永远接不了手）时**才走一条子线程（`<对话>~d<base36>`，
 * 由调用方通过 `options.thread` 指定）：死工单仍占着订阅，fanout 会把消息并进去，而 intake 又因为
 * followupOwners 非空永不排 Eval，这条消息就永远搁浅（2026-11-03 的 897f223d… 即此）。子线程上没有订阅者，
 * 消息会进 Eval 由主 Session 分诊（可 attach 也可新建工单）。健康/待命的工单不触发改投：它对运行中工单的
 * 正常跟进必须留在原线程，交给该工单的 worker 处理，否则会另起新工单、原工单永远收不到跟进。
 * 无论走哪条线程，`channel` 始终指回原会话，回复仍显示在原对话里。
 */
/** 面板模式的内部取值。`note` 只给工单意见会话用：正文自带前缀，不再叠加模式约束。 */
export type PaneMode = 'assign' | 'chat' | 'note' | 'broadcast'
export function paneTrigger(conversation: string, text: string, sender: string = OWNER, mode: PaneMode = 'assign',
  options: { thread?: string } = {}): Trigger {
  const thread = options.thread ?? (mode === 'chat' || mode === 'note' ? `${conversation}~chat` : conversation)
  return {
    id: key('pane', thread, randomUUID()),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: sender },
    human: true,
    addressed: 'mention' as const,
    at: new Date().toISOString(),
    text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { conversation } },
    meta: { conversation, paneMode: mode },
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
const logKey = logKeyShared
const HIDDEN_LIMIT = 200
const hiddenKey = 'pane-hidden' as any
/** 面板只显示 30 分钟内的收尾通知；更早的属于历史积压。 */
const NOTICE_MAX_AGE_MS = 30 * 60_000
/** 旧版批量收尾通知的长度阈值：超过它的长通知是把几十张工单标题拼在一起，属于污染。 */
const NOTICE_MAX_CHARS = 240
/** 人手动停止 / 放弃的收尾通知：不再保留在对话区。 */
const SILENT_NOTICE = /已结束：(stopped|dropped|已放弃)/
/** 定时派活：每 20 秒扫一轮；晚到不超过 10 分钟才补跑，停机更久只记「错过」并推进到下一次。 */
const SCHEDULE_SWEEP_MS = 20_000
const SCHEDULE_GRACE_MS = 10 * 60_000
type LogEntry = { id: string; direction: 'in' | 'out'; at: string; text: string; kind?: string; status?: string; mode?: string }

/**
 * 对话日志统一走 ./log.ts 的共享实现：那边是 2000 条 / 40 万字符双上限并按 id 去重。
 * 这里早先各自维护过一份 200 条上限的版本，两处实现互相覆盖、谁后写谁生效，
 * 结果长对话被截到 200 条——批量收尾通知一涌进来就把真实消息挤掉。改为单一实现。
 */
const appendLog = appendLogShared

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

/**
 * 读一张工单目录下的协作 lane 状态。
 *
 * lane 布局（cc-worker --lane 引入，2026-11-11）：
 *   <dir>/.cc-worker/{lock,session_id,...}             → lane = main（传统单 worker）
 *   <dir>/.cc-worker/lanes/<name>/{lock,session_id,...} → lane = <name>（协作子 worker）
 *
 * 「在跑」的判据与面板其它地方一致：claude.pid 存在且该 pid 的命令行含 claude。
 * 只读目录，不改任何东西；读不到就当没有 lane。
 */
function readLanes(dir: string): { lane: string; state: 'running' | 'idle'; task?: string }[] {
  if (!dir) return []
  const out: { lane: string; state: 'running' | 'idle'; task?: string }[] = []
  const alive = (base: string): boolean => {
    try {
      const pid = Number(readFileSync(join(base, 'claude.pid'), 'utf8').trim())
      if (!Number.isInteger(pid) || pid <= 0) return false
      // 判活必须看 cmdline：pid 文件可能残留，pid 也可能已被别的进程复用。
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude')
    } catch { return false }
  }
  // 任务分配：team 调度时由 cc-worker 写入 lanes/<name>/task.txt；没有就不给该字段。
  const taskOf = (base: string): string | undefined => {
    try {
      const text = readFileSync(join(base, 'task.txt'), 'utf8').replace(/\s+/g, ' ').trim()
      return text ? text.slice(0, 160) : undefined
    } catch { return undefined }
  }
  try {
    const root = join(dir, '.cc-worker')
    if (alive(root)) out.push({ lane: 'main', state: 'running', task: taskOf(root) })
    for (const name of readdirSync(join(root, 'lanes'), { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const base = join(root, 'lanes', name.name)
      out.push({ lane: name.name, state: alive(base) ? 'running' : 'idle', task: taskOf(base) })
    }
  } catch { /* 目录不存在或不可读：没有 lane */ }
  return out
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

/**
 * 会话线程上仍占着订阅、但已经卡死（zombie）的工单。
 *
 * 引擎 intake 会对线程上每个订阅工单 fanout，model.ts 的 followupOwners 又把「仍存活且非 context」的接收者
 * 当成裁决者，于是消息不进 Eval。健康工单的 worker 还能处理，消息应照常并进去；只有 zombie 工单是「占着
 * 订阅却永远接不了手」，必须把派活消息改走子线程，否则会被并进死工单、永久搁浅
 * （2026-11-03 的 897f223d… 即此：worker 读了不接，工单又一直没结束）。
 */
async function zombieTicketsOnThread(ctx: any, conversation: string): Promise<{ ticketId: string; detail?: string }[]> {
  const threadKey = `${SOURCE}:${conversation}`
  const found: { ticketId: string; detail?: string }[] = []
  try {
    const thread = ctx.orchestrator?.store?.threads?.get?.(threadKey)
    const subscriptions: string[] = Array.isArray(thread?.subscriptions) ? thread.subscriptions : []
    const context: string[] = Array.isArray(thread?.context) ? thread.context : []
    for (const id of subscriptions) {
      if (context.includes(id)) continue
      const ticket = ctx.orchestrator?.store?.tickets?.get?.(id)
      if (!ticket || ticket.ended) continue
      const health = ticketHealth(ticket, Date.now(), await collectExecutorSignals(ctx, ticket))
      if (health.health !== 'zombie') continue
      found.push({ ticketId: String(id), ...health.detail ? { detail: health.detail } : {} })
    }
  } catch { /* 宿主内部变动：按没有僵尸处理，保持原线程投递 */ }
  return found
}

/**
 * 派活消息是否需要改投子线程：**只有会话线程上存在 zombie 工单时**才改投。
 * 健康/待命的工单仍按原样接管消息（它的 worker 会处理），不能被绕开成新工单。
 * 子线程键 `<对话>~d<base36 时间戳>`：与 chat 的影子线程共享「永不被工单订阅」的性质，但保留派活的 explicit
 * 语义，由主 Session 经 Eval 分诊。用毫秒时间戳转 base36 而不是 HHMMSS，避免同一秒内的第二条消息落进已经被
 * 新工单订阅的子线程、再次被吞。对话名 schema 不允许 `~`，所以不会与用户自己的对话冲突。
 */
async function divertDispatch(ctx: any, conversation: string): Promise<{ thread: string; reason: string } | undefined> {
  const zombies = await zombieTicketsOnThread(ctx, conversation)
  if (!zombies.length) return undefined
  const thread = `${conversation}~d${Date.now().toString(36)}`
  const first = zombies[0]!
  const reason = `该对话的工单 ${first.ticketId} 已卡死（${first.detail ?? '无执行活动'}），消息改由路由器分诊，不会投进这个死工单`
  return { thread, reason }
}

/** 面板自己的拒绝错误：带 HTTP 状态码，路由层原样回给前端（409 = 状态冲突，可换模式重试）。 */
class PaneRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** 当前对话线程上仍未结束的工单；续做模式靠它决定「交给哪一张」。 */
async function liveTicketsOnThread(ctx: any, conversation: string): Promise<{ id: string; title?: string }[]> {
  const found: { id: string; title?: string }[] = []
  try {
    const thread = ctx.orchestrator?.store?.threads?.get?.(`${SOURCE}:${conversation}`)
    const subscriptions: string[] = Array.isArray(thread?.subscriptions) ? thread.subscriptions : []
    for (const id of subscriptions) {
      const ticket = ctx.orchestrator?.store?.tickets?.get?.(id)
      if (!ticket || ticket.ended) continue
      found.push({ id: String(id), ...(typeof ticket.title === "string" ? { title: ticket.title } : {}) })
    }
  } catch { /* 宿主内部变动：当作没有活单，由调用方给可见提示 */ }
  return found
}

/**
 * 给消息正文加一段模式约束。
 *
 * 为什么不靠引擎区分：三种模式在引擎里都是 explicit 请求（见 paneTrigger 注释），只有正文能告诉路由器
 * 该建单、该并单还是只答话。约束放最前面并明确写「不要……」的边界，避免路由器按规则把闲聊变成工单。
 */
function composeText(mode: PaneMode, text: string): string {
  // note（工单意见/广播单条）与 broadcast（广播入口）的正文都自带前缀，不叠加模式约束。
  if (mode === "note" || mode === "broadcast") return text
  if (mode === "chat") {
    return "【对话模式：只回答这个问题，不要新建工单、不要 attach 工单、不要派 worker、不要改代码。"
      + "能直接答就直接答；需要动代码或长期工作的事，建议我用「派活」重发。"
      + "重要：如果我重复问了同一个问题，说明我没看到你上次的回答——请把答案简短再说一遍，"
      + "不要因为「已答过」而忽略。】\n" + text
  }
  // 派活：新建工单还是跟进已有工单，交给路由器判断——不要再规定死其中一种。
  return "【派活模式：这是我明确要你去做的任务。若它是本对话进行中工单的补充/追问/修正，"
    + "就 attach 给那张工单的 worker 继续做；若要动代码、要交付结果、且没有可接手的工单，"
    + "就新建工单并派给 worker。只答疑、不动代码的问题请直接回答，不必建单。】\n" + text
}

/**
 * 面板路由。
 *
 * `receive` 与 GitHub、Feishu 两个 Source 用的是同一个入口，所以面板消息走完全相同的路径：准入、路由、工单、worker。
 */
/** 把引擎的 reason（`{code, values?}` 数组）渲染成一句可读文本。 */
function reasonText(reason: any): string {
  if (typeof reason === 'string') return reason
  if (!Array.isArray(reason)) return ''
  return reason.slice(0, 2).map((item: any) => {
    if (typeof item === 'string') return item
    const code = String(item?.code ?? '')
    const values = item?.values && typeof item.values === 'object' ? item.values : {}
    const text = typeof values.text === 'string' && values.text ? values.text : ''
    if (text) return text
    // routed 是"转交给了某张工单"，不是丢弃；把目标工单号带出来，面板才看得懂。
    if (code === 'routed') return `转交工单 ${String(values.ticket ?? '').slice(0, 8)}`
    if (code === 'startedTicket') return `该工单已在处理 ${String(values.ticket ?? '').slice(0, 8)}`
    if (code === 'forwarded') return '已转交给该线程上的工单 worker'
    if (code === 'said') return ''
    return code
  }).filter(Boolean).join('；')
}

/** 这张工单当前挂在哪些线程上（面板按线程过滤用）。 */
function threadKeysOf(ctx: any, ticketId: string): { key: string }[] {
  try {
    const threads: any[] = ctx?.orchestrator?.store?.read?.subscribedThreads?.() ?? []
    return threads
      .filter(thread => Array.isArray(thread?.subscriptions) && thread.subscriptions.includes(ticketId))
      .map(thread => ({ key: String(thread?.key ?? '') }))
      .filter(item => item.key)
  } catch { return [] }
}

/** 工单当前阶段压成面板能直接显示的短状态。 */
function ticketStageOf(ticket: any): string {
  if (ticket?.ended) return 'ended'
  const stage = typeof ticket?.stage === 'string' ? ticket.stage : ''
  return stage || 'working'
}

/** 广播单次最多投递的工单数：关键词过宽时不要把全部工单一次打醒。 */
const BROADCAST_MAX = 20

/**
 * 广播前缀：`@广播[关键词] 正文`。也接受 `@broadcast[...]` 与全角括号；
 * 关键词可用逗号/顿号分隔多个，任一命中即投；`[全部]`/`[all]` 表示不筛选。
 * 匹配口径是「标题 + 执行器任务正文」的子串（忽略大小写）。
 */
const BROADCAST_PATTERN = /^@(?:广播|broadcast)\s*[\[［【(（]\s*([^\]］】)）]{1,80}?)\s*[\]］】)）]\s*([\s\S]*)$/i

/** 广播筛选用到的一组条件；`tokens` 为空表示正文里没有可用关键词。 */
type BroadcastCriteria = {
  tokens: string[]
  timeLabel?: string
  mode: 'auto' | 'explicit' | 'all'
}

/** 一次广播的结果。`ended` 是符合条件但已结束、因而没有投递的工单数。 */
type BroadcastResult = {
  /** 显式关键词原文；空串表示自动筛选。 */
  keyword: string
  /** 实际生效的筛选条件，供提示回显。 */
  criteria: BroadcastCriteria
  /** 正文提取不到任何关键词，最后按全量投递。 */
  autoAll: boolean
  /** 有定向关键词但零命中，没有投递任何工单。 */
  noMatch: boolean
  matched: number
  ended: number
  /** 范围内但被人停止、无法唤醒的工单数。 */
  stopped: number
  overLimit: number
  delivered: { ticketId: string; title: string }[]
  failed: { ticketId: string; title: string; error: string }[]
}

/** 工单侧参与文字匹配的内容：标题 + 执行器收到的任务正文。 */
function ticketMatchText(ticket: any): string {
  const title = typeof ticket?.title === 'string' ? ticket.title : ''
  const assignment = typeof ticket?.execution?.assignment === 'string' ? ticket.execution.assignment : ''
  return `${title}\n${assignment}`.toLowerCase()
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** 以本地零点为基准偏移天数。 */
function localDayStart(now: Date, offsetDays = 0): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() + offsetDays)
  return day.getTime()
}

/**
 * 正文里的时间限定词 → 工单创建时间窗。命中后从正文移除，避免「昨晚」被当成普通关键词。
 * 顺序即优先级（「昨晚」必须排在「昨天」前面）。
 */
const TIME_RULES: { re: RegExp; describe: (now: Date, match: RegExpMatchArray) => { label: string; from: number; to: number } }[] = [
  {
    re: /(?:最近|近|过去)\s*(\d+)\s*(?:天|日)/,
    describe: (now, match) => {
      const days = Math.max(1, Math.min(30, Number(match[1]) || 1))
      return { label: `最近 ${days} 天`, from: now.getTime() - days * DAY_MS, to: now.getTime() }
    },
  },
  {
    re: /(?:最近|近|过去)\s*(\d+)\s*(?:小时|钟头)/,
    describe: (now, match) => {
      const hours = Math.max(1, Math.min(72, Number(match[1]) || 1))
      return { label: `最近 ${hours} 小时`, from: now.getTime() - hours * HOUR_MS, to: now.getTime() }
    },
  },
  {
    // 「昨晚」跨午夜：从昨天零点到今天早上六点，凌晨派出的单也算在内。
    re: /昨晚|昨夜|昨天晚上/,
    describe: now => ({ label: '昨晚（昨天 00:00-今天 06:00）', from: localDayStart(now, -1), to: localDayStart(now, 0) + 6 * HOUR_MS }),
  },
  { re: /前天/, describe: now => ({ label: '前天', from: localDayStart(now, -2), to: localDayStart(now, -1) }) },
  { re: /昨天|昨日/, describe: now => ({ label: '昨天', from: localDayStart(now, -1), to: localDayStart(now, 0) }) },
  { re: /今早|今晨|早上|上午/, describe: now => ({ label: '今天上午', from: localDayStart(now, 0), to: localDayStart(now, 0) + 12 * HOUR_MS }) },
  { re: /下午/, describe: now => ({ label: '今天下午', from: localDayStart(now, 0) + 12 * HOUR_MS, to: localDayStart(now, 0) + 18 * HOUR_MS }) },
  { re: /今天|今日|刚才|刚刚/, describe: now => ({ label: '今天', from: localDayStart(now, 0), to: now.getTime() }) },
  {
    re: /本周|这周|这个星期/,
    describe: now => {
      const monday = new Date(now)
      monday.setHours(0, 0, 0, 0)
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
      return { label: '本周', from: monday.getTime(), to: now.getTime() }
    },
  },
  {
    re: /上周|上个星期/,
    describe: now => {
      const monday = new Date(now)
      monday.setHours(0, 0, 0, 0)
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
      return { label: '上周', from: monday.getTime() - 7 * DAY_MS, to: monday.getTime() }
    },
  },
]

/** 广播正文里的通用词；用于把中文段切成候选关键词，不代表具体工作。 */
const CN_FILLER = [
  '所有', '全部', '每张', '每个', '继续', '接着', '然后', '处理', '完成', '未完成', '没完成',
  '运行中', '进行中', '还没结束', '没有结束', '工单', '任务', '工作', '相关', '问题', '内容',
  '东西', '事情', '一下', '一些', '帮忙', '帮我', '我们', '你们', '他们', '她们', '它们',
  '这里', '那里', '这个', '那个', '这些', '那些', '哪张', '哪个', '关于', '针对', '按照', '根据',
  '需要', '应该', '可以', '直接', '一起', '同时', '自动', '尽快', '优先', '清楚', '明白',
  '情况', '状态', '结果',
]
/** 多字词在前、单字虚词在后：正则从左到右取第一个能匹配的分支。 */
const CN_FILLER_SPLIT = new RegExp([
  ...CN_FILLER,
  '的', '了', '吗', '呢', '吧', '啊', '哦', '着', '过',
  '把', '给', '和', '与', '及', '在', '对', '从', '到', '是',
  '我', '你', '要', '就', '也', '都', '再', '还', '没', '不',
  '有', '这', '那', '个', '张', '些',
].join('|'), 'g')

/** 英文停用词；js/ts/io 这类技术缩写不在此列。 */
const EN_FILLER = new Set([
  'the', 'and', 'for', 'all', 'please', 'continue', 'ticket', 'tickets', 'task', 'tasks',
  'with', 'from', 'this', 'that', 'these', 'those', 'you', 'your', 'our', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'can', 'will', 'should', 'must', 'just', 'also', 'then',
  'than', 'into', 'about', 'after', 'before', 'over', 'under', 'out', 'up', 'down', 'off',
  'on', 'in', 'of', 'to', 'is', 'it', 'be', 'do', 'as', 'at', 'by', 'or', 'if', 'so', 'no', 'yes', 'okay',
])

// extractTechTokens 已于 2026-11-10 删除：广播模式改为全投，正文不再自动抽关键词。
// 如需按词定向，用显式写法 `@广播[关键词1,关键词2] 正文`。

type BroadcastSelection = {
  targets: any[]
  criteria: BroadcastCriteria
  autoAll: boolean
  noMatch: boolean
  matchedTotal: number
  ended: number
  /** 范围内但因「人已停止」无法唤醒的工单数（Mandate 已撤回）。 */
  stopped: number
}

/**
 * 选出广播的目标工单。
 * - 显式 `@广播[a,b]`：直接用给定词；`[全部]/[all]` 不筛；
 * - 广播模式：先剥掉时间词和「所有/全部」等限定词，再从正文提取技术词；
 * - 时间词只筛工单创建时间（createdAt），不参与文字匹配；
 * - 一个技术词都没提取到 → 全量投；提取到但零命中 → 定向广播没有对象，不投。
 */
function selectBroadcastTargets(tickets: any[], text: string, explicitKeyword: string): BroadcastSelection {
  const now = new Date()
  let rest = text
  let timeLabel: string | undefined
  let fromMs: number | undefined
  let toMs: number | undefined
  for (const rule of TIME_RULES) {
    const match = rest.match(rule.re)
    if (!match) continue
    const info = rule.describe(now, match)
    timeLabel = info.label
    fromMs = info.from
    toMs = info.to
    rest = rest.replace(rule.re, ' ')
    break
  }
  const allKeyword = /^(?:全部|所有|all|every|\*)$/i.test(explicitKeyword.trim())
  // 「所有/全部/每张/每个」只是范围限定词，不参与文字匹配。
  const allWanted = allKeyword || /(?:所有|全部|每张|每个)/.test(rest)
  rest = rest.replace(/所有|全部|每张|每个|未完成|没完成|还没结束|没有结束|运行中|进行中|在跑|还在跑/g, ' ')
  // 显式  时不再提取技术词：否则正文里的词会反过来把「全部」筛成零命中。
  // 广播=全投：只有显式 `@广播[关键词]` 才按词筛选；广播模式一律不筛关键词。
  // 历史教训（2026-11-10）：曾从正文自动抽「技术词」，中文按标点切片后描述性短语
  // （如「认真反思自己」「收敛效率极差」）被当成关键词，正文越长越必然零命中，广播直接失效。
  const tokens = allKeyword
    ? []
    : explicitKeyword.trim()
      ? explicitKeyword.split(/[,，、;；\s]+/).map(word => word.trim().toLowerCase()).filter(Boolean)
      : []
  // 没写时间词就默认「最近 12 小时」：广播默认范围由用户 2026-11-11 指定，避免一广播就砸到几天前的旧单。
  if (fromMs === undefined || toMs === undefined) {
    fromMs = now.getTime() - 12 * HOUR_MS
    toMs = now.getTime()
    timeLabel = '最近 12 小时'
  }
  const inWindow = (ticket: any): boolean => {
    if (fromMs === undefined || toMs === undefined) return true
    const at = Date.parse(String(ticket?.createdAt ?? ''))
    // 时间戳缺失或损坏时保守保留，宁可多投也不要静默漏掉。
    return Number.isNaN(at) ? true : at >= fromMs && at < toMs
  }
  const scoped = tickets.filter(inWindow)
  const contentOf = new Map<string, string>()
  for (const ticket of scoped) contentOf.set(ticket.id, ticketMatchText(ticket))
  const hits = new Map<string, Set<string>>()
  for (const token of tokens) {
    const set = new Set<string>()
    for (const [id, content] of contentOf) if (content.includes(token)) set.add(id)
    hits.set(token, set)
  }
  const textMatched = tokens.length
    ? scoped.filter(ticket => tokens.some(token => hits.get(token)!.has(ticket.id)))
    : scoped
  const anyHit = tokens.length === 0 || tokens.some(token => hits.get(token)!.size > 0)
  // 广播不再排除已结束工单：用户要的是「最近 12 小时内创建的所有工单」，已结束的也在范围内——
  // 引擎的 attach 会在工单原有 Mandate 下把它唤醒继续干活（docs：An ended ticket resumes under its Mandate）。
  // 唯一例外是被「人」停掉的（ended.by === 'human'）：它的 Mandate 已被撤回，attach 必然抛 ticketStopped，
  // 与其逐张失败，不如在这里先排除，并在提示里如实计数。
  const live = textMatched.filter(ticket => !ticket.ended || ticket.ended.by !== 'human')
  const stopped = textMatched.filter(ticket => !!ticket.ended && ticket.ended.by === 'human')
  return {
    targets: live,
    criteria: {
      tokens,
      timeLabel,
      mode: allKeyword ? 'all' : explicitKeyword.trim() ? 'explicit' : 'auto',
    },
    autoAll: tokens.length === 0,
    noMatch: tokens.length > 0 && !anyHit,
    matchedTotal: textMatched.length,
    // 现在 live 里包含已结束但可唤醒的工单，所以「未投递的已结束数」= 总命中 - 可投递。
    ended: textMatched.length - live.length,
    stopped: stopped.length,
  }
}

/**
 * 广播消息：先按时间窗与关键词筛出目标，再逐单投递。
 *
 * 为什么不能复用普通 `source.receive`：同一会话线程上多张 live 工单会让 intake 判定 `ambiguous`，
 * 整条消息一张都不投（这正是「一条共同消息所有工单都不响应」的根因）；而一条 Trigger 也只能 attach
 * 给一张工单。所以这里为每张工单各建一条独立 Trigger，落在线程 `pane:t<工单id>`（该工单的意见会话，
 * 不是共享的会话线程），再直接调用引擎的 `attach` 把消息作为 Input 交给它——与路由器
 * `orchestrator_route attach` 走同一条路径，不经过 Eval、不依赖模型分诊。`channel` 仍指回用户发消息
 * 的原对话，worker 的回复会显示在那里。
 */
async function broadcastByTitle(ctx: any, conversation: string, keyword: string, text: string): Promise<BroadcastResult> {
  const store = ctx?.orchestrator?.store
  const engine = ctx?.orchestrator?.engine
  if (typeof store?.tickets?.list !== 'function' || typeof store?.triggers?.save !== 'function'
    || typeof engine?.attach !== 'function') {
    throw new Error('宿主未提供广播所需的工单/引擎接口')
  }
  const all: any[] = store.tickets.list()
  const valid = all.filter((ticket: any) => typeof ticket?.id === 'string' && ticket.id
    && typeof ticket?.title === 'string')
  const selection = selectBroadcastTargets(valid, text, keyword)
  // 最近更新的工单优先；超过单次上限的部分不投递，但在结果里如实计数。
  const targets = [...selection.targets]
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, BROADCAST_MAX)
  const criteriaText = [
    selection.criteria.timeLabel ? `时间窗「${selection.criteria.timeLabel}」` : '',
    selection.criteria.tokens.length ? `关键词「${selection.criteria.tokens.join('、')}」` : '',
  ].filter(Boolean).join(' + ')
  const scope = criteriaText || '最近 12 小时'
  const delivered: BroadcastResult['delivered'] = []
  const failed: BroadcastResult['failed'] = []
  for (const ticket of targets) {
    const title = String(ticket.title).trim()
    const composed = `【广播给工单「${title}」(${ticket.id})：这条消息按${scope}筛选后同时投给了多张工单，`
      + `请按本工单的上下文处理，不要新建工单】
${text}`
    // 独立 Trigger + 每单一条：共享线程会被 ambiguous 吃掉，同一条 Trigger 也不能 attach 给多张工单。
    // note：正文已自带「广播给工单 X」前缀，不能再叠一层模式约束。
    const trigger = paneTrigger(conversation, composed, OWNER, 'note', { thread: `t${ticket.id}` })
    try {
      store.triggers.save(trigger)
      engine.attach(ticket.id, trigger.id, `面板广播（${scope}）`)
      delivered.push({ ticketId: ticket.id, title })
    } catch (error) {
      failed.push({ ticketId: ticket.id, title, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    keyword,
    criteria: selection.criteria,
    autoAll: selection.autoAll,
    noMatch: selection.noMatch,
    matched: selection.matchedTotal,
    ended: selection.ended,
    stopped: selection.stopped,
    overLimit: selection.targets.length - targets.length,
    delivered,
    failed,
  }
}


// ——— 定时派活 ———

/** 读出全部定时任务，按下次触发时间升序；扫描与面板列表共用同一份校验。 */
function readSchedules(state: any): PaneSchedule[] {
  const items: PaneSchedule[] = []
  for (const key of state.keys(SCHEDULE_PREFIX) ?? []) {
    const record = state.get(key) as PaneSchedule | undefined
    if (record && typeof record.id === 'string' && typeof record.conversation === 'string'
      && typeof record.text === 'string' && record.spec && typeof record.nextAtMs === 'number') items.push(record)
  }
  return items.sort((a, b) => a.nextAtMs - b.nextAtMs)
}

/** 写入一条任务；同 id 覆盖。 */
function writeSchedule(state: any, record: PaneSchedule): void { state.set(scheduleKey(record.id), record) }

/** 删除一条任务（state.set 传 undefined 即删行）。 */
function deleteSchedule(state: any, id: string): void { state.set(scheduleKey(id), undefined) }

/**
 * 面板发送与定时派活的唯一实现。抽出来是为了让定时器与 HTTP 路由走**完全相同**的一条路：
 * 广播展开、僵尸改投、投递前解档、Trigger 构造、对话日志，一处改动两边同时生效。
 *
 * 定时来源会在入站日志上标 `status: 'scheduled'`，面板据此显示「定时」徽标。
 */
async function dispatchPaneMessage(ctx: any, body: { conversation: string; text: string; mode: PaneMode | 'dispatch' },
  origin: 'panel' | 'schedule' = 'panel'): Promise<any> {
  // 旧客户端仍发 `dispatch`，语义就是「路由器分配」。
  const mode: PaneMode = body.mode === 'dispatch' ? 'assign' : body.mode
  const source = ctx.orchestrator.context({ kind: SOURCE, health: ['pane'] })
  // 广播有两条入口：
  //   1) 派活模式下写 `@广播[关键词] 正文`（显式指定关键词，多个用逗号分隔，只投给匹配的工单）；
  //   2) 直接把模式切成「广播」——投给全部运行中工单（2026-11-10 起不再从正文自动抽关键词）。
  // 共享线程 + 多张 live 工单会被 intake 判成 ambiguous、一张都不投，所以广播在这里展开成多条独立 Trigger。
  const matched = mode === 'assign' ? BROADCAST_PATTERN.exec(body.text) : null
  if (mode === 'broadcast' || matched) {
    {
      const keyword = matched ? matched[1]!.trim() : ''
      const content = (matched ? matched[2]! : body.text).trim()
      if (mode === 'assign' && !keyword) throw new Error('广播关键词不能为空：请写成 @广播[关键词] 正文')
      if (!content) throw new Error(mode === 'broadcast' ? '广播内容不能为空' : '广播内容不能为空：请写成 @广播[关键词] 正文')
      const result = await broadcastByTitle(ctx, body.conversation, keyword, content)
      const at = new Date().toISOString()
      const basis = [
        result.criteria.timeLabel ? `时间窗「${result.criteria.timeLabel}」` : '',
        result.criteria.tokens.length ? `关键词「${result.criteria.tokens.join('、')}」` : '',
      ].filter(Boolean).join(' + ')
      const notice = result.delivered.length
        ? `已广播给 ${result.delivered.length} 张工单：${result.delivered.map(item => `「${item.title}」`).join('、')}`
          + (result.criteria.mode === 'all' ? '（范围内全部工单）' : basis ? `（筛选依据：${basis}）` : '')
          + (result.autoAll ? `（${basis || '默认范围'}内全部工单，含已结束可唤醒的）` : '')
          + (result.stopped ? `；另有 ${result.stopped} 张已被人停止、无法唤醒，未投递` : '')
          + (result.ended ? `；另有 ${result.ended} 张不符合条件，未投递` : '')
          + (result.overLimit ? `；超过单次上限 ${result.overLimit} 张未投递` : '')
          + (result.failed.length ? `；投递失败 ${result.failed.length} 张：${result.failed.map(item => `「${item.title}」`).join('、')}` : '')
        : (result.noMatch
            ? `没有工单匹配${basis ? `（${basis}）` : ''}，未广播`
            : (result.matched
                ? `范围内的 ${result.matched} 张工单都已结束且无法唤醒${result.stopped ? `（其中 ${result.stopped} 张被人停止）` : ''}，未广播`
                : `${basis || '最近 12 小时'}内没有符合条件的工单，未广播`))
      appendLog(source, body.conversation, { id: `broadcast-${randomUUID()}`, direction: 'in', at,
        text: body.text, mode: 'broadcast', ...(origin === 'schedule' ? { status: 'scheduled' } : {}) })
      appendLog(source, body.conversation, { id: `broadcast-notice-${randomUUID()}`, direction: 'out', at, text: notice, kind: 'broadcast' })
      return { broadcast: true, thread: `${SOURCE}:${body.conversation}`,
        received: result.delivered.length ? 'stored' : 'none', notice, ...result }
    }
  }
  // 防陷：该对话线程上的工单若已卡死（zombie），它仍占着订阅却永远接不了手，派活消息会被并进去、
  // 永久搁浅。这时改投一条派活子线程 `<对话>~d<base36>`：那里没有订阅者，消息走 Eval 由主 Session
  // 分诊；回复仍回落到原对话。健康工单不改投——跟进本就该交给它的 worker，绕开只会另起新工单。
  const conversation = body.conversation
  // 派活消息若会被卡死的工单吞掉，改投子线程由路由器分诊（chat 有自己的影子线程，不参与）。
  const diverted = mode === 'assign' ? await divertDispatch(ctx, conversation) : undefined
  // 投递前先手解档：跟进可能唤醒已结束的工单，而它的 worker 会话可能已被收尾归档
  // （被归档的会话跑不了回合，投递只会秒 blocked、消息丢失）。详见 wakeThreadSessions。
  await wakeThreadSessions(ctx, conversation)
  const trigger = paneTrigger(conversation, composeText(mode, body.text), OWNER, mode,
    diverted ? { thread: diverted.thread } : {})
  // 日志里存用户原话（不含约束前缀），面板显示才干净。
  appendLog(source, conversation, { id: trigger.id, direction: 'in', at: trigger.at, text: body.text,
    mode, ...(origin === 'schedule' ? { status: 'scheduled' } : {}) })
  const received = await source.receive(trigger)
  return { triggerId: trigger.id, thread: `${SOURCE}:${trigger.threads[0]!.id}`, received, mode,
    ...(diverted ? { diverted: diverted.reason } : {}) }
}

/** 到点扫描：晚到 10 分钟内补跑，停机更久只记录「错过」并推进；单条异常不打断其它任务。 */
async function runDueSchedules(ctx: any): Promise<void> {
  const source = liveSource ?? ctx.orchestrator?.context({ kind: SOURCE, health: ['pane'] })
  const state = source?.state
  if (!state?.keys) return
  const now = Date.now()
  for (const record of readSchedules(state)) {
    if (!record.enabled || record.nextAtMs > now) continue
    const overdue = now - record.nextAtMs
    if (overdue > SCHEDULE_GRACE_MS) {
      record.lastAt = new Date(now).toISOString()
      record.lastResult = `错过：服务停机约 ${Math.max(1, Math.round(overdue / 60_000))} 分钟，未执行`
      if (record.spec.kind === 'at') record.enabled = false
      else record.nextAtMs = nextOccurrence(record.spec, now)
      writeSchedule(state, record)
      continue
    }
    try {
      const outcome = await dispatchPaneMessage(ctx, { conversation: record.conversation, text: record.text, mode: record.mode }, 'schedule')
      record.lastAt = new Date(now).toISOString()
      record.lastResult = outcome?.broadcast ? String(outcome.notice ?? '已广播') : '已派发'
    } catch (error) {
      record.lastAt = new Date(now).toISOString()
      record.lastResult = `失败：${error instanceof Error ? error.message : String(error)}`
    }
    if (record.spec.kind === 'at') record.enabled = false
    else record.nextAtMs = nextOccurrence(record.spec, now)
    writeSchedule(state, record)
  }
}

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
          mode: z.enum(['dispatch', 'chat', 'broadcast', 'assign', 'note']).default('dispatch') }).parse(await readJson(req))
        sendJson(res, 200, await dispatchPaneMessage(ctx, body, 'panel'))
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
      // GET /orchestrator/api/pane/conversations —— 面板下拉切换用的对话清单：
      // 本插件记录过的对话（KV 前缀 `pane-log:`），按最后一条消息时间倒序，最多 50 条。
      if (req.method === 'GET' && url.pathname === '/orchestrator/api/pane/conversations') {
        const conversations: { name: string; count: number; lastAt: string }[] = []
        for (const key of source.state.keys('pane-log:')) {
          const name = String(key).slice('pane-log:'.length)
          if (!/^[A-Za-z0-9_-]+$/.test(name)) continue
          const entries: LogEntry[] = source.state.get(logKey(name)) ?? []
          if (!entries.length) continue
          const last = entries[entries.length - 1]!
          conversations.push({ name, count: entries.length, lastAt: last.at })
        }
        conversations.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
        sendJson(res, 200, { conversations: conversations.slice(0, 50) })
        return
      }
      // GET /orchestrator/api/pane/log/<对话> —— 面板渲染用的对话流。
      // 入站消息的最终裁决挂在 disposition/decision 上；被 ignore 的消息本身不会产生任何回复，
      // 面板若只看日志会像"卡住了"。这里给每条入站消息补上 disposition 摘要，
      // 让面板能如实标出"已忽略（附理由）"，不再静默。
      const logMatch = /^\/orchestrator\/api\/pane\/log\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      if (req.method === 'GET' && logMatch) {
        const conversation = logMatch[1]!
        const entries: LogEntry[] = source.state.get(logKey(conversation)) ?? []
        const store: any = ctx.orchestrator?.store
        const annotated = entries.map((entry: LogEntry) => {
          if (entry.direction !== 'in') return entry
          try {
            const disposition: any = store?.triggers?.disposition?.(entry.id)
            if (!disposition) return entry
            const out: any = { ...entry }
            const decisionId = String(disposition.decisionId ?? '')
            if (decisionId && typeof store?.decisions?.get === 'function') {
              const decision: any = store.decisions.get(decisionId)
              if (decision) {
                out.decision = { kind: decision.kind, reason: reasonText(decision.reason) }
                const ticketId = String(decision.ticketId ?? '')
                const ticket: any = ticketId && typeof store?.tickets?.get === 'function' ? store.tickets.get(ticketId) : undefined
                if (ticket) out.outcome = ticket.ended ? String(ticket.ended.outcome ?? 'ended') : ticketStageOf(ticket)
              }
            } else if (disposition.evalId) {
              out.decision = { kind: 'evaluating' }
            }
            return out
          } catch { return entry }
        })
        sendJson(res, 200, { conversation, thread: `${SOURCE}:${conversation}`, items: annotated })
        return
      }
      // POST /orchestrator/api/pane/log/<对话>/clean —— 一次性清理污染对话的旧收尾通知。
      // 只删 kind=notice 且满足「超过 30 分钟 / 超过 240 字的长批量 / stopped|dropped」的条目；
      // 用户消息、agent 回复、最近的通知一律保留。删除不可逆（直接覆盖 KV 日志）。
      const cleanMatch = /^\/orchestrator\/api\/pane\/log\/([A-Za-z0-9_-]+)\/clean$/.exec(url.pathname)
      if (req.method === 'POST' && cleanMatch) {
        const conversation = cleanMatch[1]!
        const entries: LogEntry[] = source.state.get(logKey(conversation)) ?? []
        const since = Date.now() - NOTICE_MAX_AGE_MS
        // 长广播回执（kind=broadcast，direction=out）同样是旧版把几十张工单标题拼成的一段，属于同类污染。
        const polluted = (entry: LogEntry): boolean => {
          if (entry.direction === 'in') return false
          if (entry.kind !== 'notice' && entry.kind !== 'broadcast') return false
          const text = String(entry.text ?? '')
          if (text.length > NOTICE_MAX_CHARS || SILENT_NOTICE.test(text)) return true
          return !(Date.parse(String(entry.at ?? '')) >= since)
        }
        const kept = entries.filter(entry => !polluted(entry))
        if (kept.length !== entries.length) source.state.set(logKey(conversation), kept)
        sendJson(res, 200, { conversation, removed: entries.length - kept.length, kept: kept.length })
        return
      }
      // GET /orchestrator/api/pane/tickets?state=open|ended&limit=N —— 宿主工单列表 + 未读条数。
      // 宿主视图只给 inputs 的总数，不告诉面板"有几条没被读过"。而"工单带着未读消息结束"正是
      // 消息像石沉大海的直接指纹，所以在这里按 store 里的原始 inputs.readAt 现算一个 unread 附上去。
      if (req.method === 'GET' && url.pathname === '/orchestrator/api/pane/tickets') {
        const state = url.searchParams.get('state') === 'ended' ? 'ended' : 'open'
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1), 200)
        const store: any = ctx.orchestrator?.store
        const all: any[] = state === 'ended'
          ? (store?.tickets?.list?.() ?? []).filter((t: any) => !!t?.ended)
          : (store?.tickets?.open?.() ?? [])
        all.sort((a: any, b: any) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))
        // undelivered 里的 id 往往同时出现在 inputs 中（同一条输入既"未读"又"未投递"），
        // 简单相加会重复计数（曾出现"未读 2 / 共 1 条"）。按 id 去重后再数。
        const unreadOf = (ticket: any): number => {
          const inputs: any[] = Array.isArray(ticket?.inputs) ? ticket.inputs : []
          const ids = new Set<string>()
          for (const item of inputs) {
            if (!item?.readAt && item?.id) ids.add(String(item.id))
            else if (!item?.readAt) ids.add(`idx:${ids.size}`)
          }
          for (const id of (Array.isArray(ticket?.undelivered) ? ticket.undelivered : [])) ids.add(String(id))
          return ids.size
        }
        const items = all.slice(0, limit).map((ticket: any) => ({
          id: ticket.id, title: ticket.title, stage: ticketStageOf(ticket), state: ticket.ended ? 'ended' : 'open',
          ended: ticket.ended, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
          summary: typeof ticket?.assignments?.slice?.(-1)?.[0]?.report?.summary === 'string'
            ? ticket.assignments.slice(-1)[0].report.summary : '',
          sessionId: Array.isArray(ticket?.assignments) && ticket.assignments.some((a: any) => a?.startedAt)
            ? `worker-${ticket.id}` : '',
          inputs: Array.isArray(ticket?.inputs) ? ticket.inputs.length : 0,
          undelivered: Array.isArray(ticket?.undelivered) ? ticket.undelivered.length : 0,
          unread: unreadOf(ticket),
          threads: threadKeysOf(ctx, ticket.id),
        }))
        sendJson(res, 200, { items, total: all.length })
        return
      }
      // GET /orchestrator/api/pane/hidden —— 面板上被手动关闭（不再显示）的工单 id 名单。
      if (req.method === 'GET' && url.pathname === '/orchestrator/api/pane/hidden') {
        const ids: string[] = source.state.get(hiddenKey) ?? []
        sendJson(res, 200, { ids })
        return
      }
      // GET /orchestrator/api/pane/crew —— 协作规模：有多少工单在跑、各自跑着什么。
      //
      // 为什么要有这个：`pgrep -c cc-worker` 数的是「进程树」——一张工单会拉起 cc-worker 的父子 bash、
      // timeout 看门狗、claude 本体、python 旁路，共 5 个进程。用进程数判断 worker 数会严重高估
      // （2026-11-11 实测 6 张工单 = 31 个进程）。这里按工单聚合，给出人真正想知道的规模。
      if (req.method === 'GET' && url.pathname === '/orchestrator/api/pane/crew') {
        const tickets = ctx.orchestrator?.store?.tickets
        const live: any[] = []
        try {
          for (const ticket of tickets?.list?.() ?? []) {
            const assignments = Array.isArray(ticket.assignments) ? ticket.assignments : []
            const last = assignments.length ? assignments[assignments.length - 1] : undefined
            const state = String(last?.state ?? 'idle')
            const dir = String(ticket.execution?.directory ?? '')
            // 一张工单下的协作 lane：main 是传统单 worker，lanes/* 是 --lane 起的并行 worker。
            // 已结束的工单只有留下 lane 目录（真协作过）才上报，避免几百张历史单刷屏。
            const lanes = readLanes(dir)
            const ended = !!ticket?.ended
            if (ended && lanes.length === 0) continue
            live.push({
              ticketId: String(ticket.id),
              title: String(ticket.title ?? '').slice(0, 80),
              assignment: state,
              working: !ended && state === 'running',
              sessionId: typeof ticket.sessionId === 'string' ? ticket.sessionId : undefined,
              lanes,
            })
          }
        } catch { /* 宿主内部变动：按没有工单上报 */ }
        // 真实并发的 Claude 会话数：只有 running 的 assignment 才真的在消耗模型额度。
        const active = live.filter(item => item.working).length
        // 实际在跑的 cc-worker 数：按 lane 计，而不是按进程数（一张工单会拉起 5 个进程）。
        const workers = live.reduce((sum, item) => sum + item.lanes.filter((lane: any) => lane.state === 'running').length, 0)
        sendJson(res, 200, {
          tickets: live.length,
          active,
          queued: live.filter(item => item.assignment === 'pending').length,
          workers,
          items: live.sort((a, b) => Number(b.working) - Number(a.working)),
        })
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
      // ——— 定时派活：列表 / 创建 / 启停 / 立即执行 / 删除 ———
      if (url.pathname === '/orchestrator/api/pane/schedules' && req.method === 'GET') {
        const wanted = url.searchParams.get('conversation') ?? ''
        const items = readSchedules(source.state).filter(item => !wanted || item.conversation === wanted)
        sendJson(res, 200, { items, now: Date.now() })
        return
      }
      if (url.pathname === '/orchestrator/api/pane/schedules' && req.method === 'POST') {
        const body = z.object({ conversation: ConversationSchema, text: TextSchema,
          mode: z.enum(['dispatch', 'chat', 'broadcast', 'assign', 'note']).default('dispatch'), spec: ScheduleSpecSchema }).parse(await readJson(req))
        const now = Date.now()
        const nextAtMs = nextOccurrence(body.spec, now)
        if (body.spec.kind === 'at' && nextAtMs <= now) throw new Error('指定时间已经过去，请改到将来')
        const record: PaneSchedule = { id: randomUUID().replace(/-/g, ''), conversation: body.conversation,
          text: body.text, mode: body.mode, spec: body.spec, enabled: true,
          createdAt: new Date(now).toISOString(), nextAtMs }
        writeSchedule(source.state, record)
        sendJson(res, 200, { schedule: record })
        return
      }
      const scheduleMatch = /^\/orchestrator\/api\/pane\/schedules\/([0-9a-f]{12,32})\/(toggle|run|delete)$/.exec(url.pathname)
      if (req.method === 'POST' && scheduleMatch) {
        const id = ScheduleIdSchema.parse(scheduleMatch[1])
        const action = scheduleMatch[2]!
        const record = source.state.get(scheduleKey(id)) as PaneSchedule | undefined
        if (!record) { sendJson(res, 404, { error: '没有这条定时任务' }); return }
        if (action === 'toggle') {
          const body = z.object({ enabled: z.boolean() }).parse(await readJson(req))
          if (body.enabled && record.nextAtMs <= Date.now()) {
            if (record.spec.kind === 'at') throw new Error('指定时间已经过去，不能再启用；请重新创建')
            record.nextAtMs = nextOccurrence(record.spec, Date.now())
          }
          record.enabled = body.enabled
          writeSchedule(source.state, record)
          sendJson(res, 200, { schedule: record })
          return
        }
        if (action === 'delete') {
          deleteSchedule(source.state, id)
          sendJson(res, 200, { deleted: true, id })
          return
        }
        // 立即执行：不改变原有下次触发时间；一次性任务执行完即停用。
        const outcome = await dispatchPaneMessage(ctx, { conversation: record.conversation, text: record.text, mode: record.mode }, 'schedule')
        record.lastAt = new Date().toISOString()
        record.lastResult = outcome?.broadcast ? String(outcome.notice ?? '已广播') : '已派发'
        if (record.spec.kind === 'at') record.enabled = false
        writeSchedule(source.state, record)
        sendJson(res, 200, { schedule: record, outcome })
        return
      }
      sendJson(res, 404, { error: 'Unknown pane operation' })
    } catch (error) {
      const status = error instanceof PaneRefusal ? error.status : 400
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
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

/** 搁浅消息自愈：检查间隔、工单「失去接手能力」多久内才重投、pane-log 最长回溯、每轮上限、每轮最多扫多少个对话。 */
const STRANDED_SWEEP_MS = 30_000
/**
 * 重投窗口的基准是「占用它的工单失去接手能力的时间」（工单 ended.at，或僵尸工单的当前时间），
 * **不是消息发送时间**。旧实现按 `entry.at` 算窗口，导致「消息发出很久、但工单刚刚才结束/卡死」的消息
 * 永远进不了窗口——这正是 897f223d… 永久丢失的原因（发送于 16:32，工单次日 03:20 才结束）。
 */
const STRANDED_WINDOW_MS = 60 * 60_000
/** pane-log 条目的最长回溯：发送时间解析不出来、或早于这个年龄的条目不参与自愈。 */
const STRANDED_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const STRANDED_MAX_PER_SWEEP = 3
const STRANDED_LOG_SCAN = 100
const STRANDED_RECOVERED_TEXT = '这条消息之前被并进了运行中的工单但一直没被接手，已重新交给路由器分诊。'

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
    // 工单与线程的关联按可靠性分三路匹配：
    // 1) origin.triggerId 指向的 Trigger 的 threads（intake 归线程的真正依据；ThreadRef[]
    //    拼成 `${source}:${id}` 即线程键）——主路；
    // 2) ticket.follows[].thread（Source 让工单跟随的线程，如 PR 的生命周期；pane 工单一般为空）；
    // 3) ticket.threads[].key（仅视图层有这个形状，宿主 store 里没有；防御式兼容）。
    const triggersRepo = ctx.orchestrator?.store?.triggers
    const triggerMatches = (ticket: any): boolean => {
      const triggerId = ticket?.origin?.triggerId
      if (!triggerId || typeof triggersRepo?.get !== 'function') return false
      const trigger = triggersRepo.get(triggerId)
      const refs: any[] = Array.isArray(trigger?.threads) ? trigger.threads : []
      return refs.some(ref => `${ref?.source}:${ref?.id}` === threadKey)
    }
    const followsThread = (ticket: any): boolean => {
      if (triggerMatches(ticket)) return true
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

/**
 * 搁浅消息自愈：把「并进了工单、但工单已结束/卡死、worker 从未接手」的派活消息重新交给路由器。
 *
 * 触发条件仅为 disposition 中有 fanout、无 evalId/decisionId/requeued/acked，且 fanout 里所有工单都已结束或被
 * 判定为 zombie。只要还有一张工单存活且非 zombie，就跳过：它仍可能接手，提前重投会制造重复工单。
 * `reevaluate` 会把 trigger 标记 requeued，followupOwners 因此返回空，主 Session 的 accept 不会再被
 * workerDecides 挡住（core/part.ts）。每轮最多处理 3 条，任何单条失败都不影响其它条目。
 *
 * 窗口按「工单失去接手能力的时间」算：`latestLostAt` = 各 fanout 工单里最晚的那个时刻（已 ended 取
 * `ended.at`，僵尸工单取当前时间）。只有它落在最近 `STRANDED_WINDOW_MS` 内才重投——这样工单刚结束的消息
 * 能被救回，而重启时不会把几小时前甚至几天前的死消息一次性全部重投。消息本身的发送时间只用来做
 * `STRANDED_MAX_AGE_MS` 的兜底回溯上限。
 */
async function recoverStranded(ctx: any): Promise<void> {
  const source = liveSource
  const store = ctx.orchestrator?.store
  const engine = ctx.orchestrator?.engine
  if (!source?.state?.keys || typeof store?.triggers?.get !== 'function'
    || typeof store?.triggers?.disposition !== 'function' || typeof engine?.reevaluate !== 'function') return
  const tickets = store.tickets
  const now = Date.now()
  const cutoff = now - STRANDED_WINDOW_MS
  const oldest = now - STRANDED_MAX_AGE_MS
  let handled = 0
  const keys: string[] = [...(source.state.keys('pane-log:') ?? [])].slice(-STRANDED_LOG_SCAN)
  for (const logKeyValue of keys) {
    if (handled >= STRANDED_MAX_PER_SWEEP) break
    const entries: LogEntry[] = source.state.get(logKeyValue) ?? []
    for (let index = entries.length - 1; index >= 0 && handled < STRANDED_MAX_PER_SWEEP; index--) {
      const entry = entries[index]!
      try {
        if (entry.direction !== 'in' || !['dispatch', 'assign'].includes(String(entry.mode))) continue
        // 消息自身的发送时间只做兜底回溯上限（太老的 pane-log 条目连 disposition 都不必读）。
        const sentAt = entry.at ? Date.parse(entry.at) : Number.NaN
        if (!Number.isFinite(sentAt) || sentAt < oldest) continue
        const trigger = store.triggers.get(entry.id)
        if (!trigger) continue
        const disposition = store.triggers.disposition(entry.id)
        if (!disposition || disposition.evalId || disposition.decisionId || disposition.requeued || disposition.acked?.length) continue
        const fanout: string[] = Array.isArray(disposition.fanout) ? disposition.fanout : []
        if (!fanout.length) continue
        // 每个接收工单都已明确交回：handback 时引擎已把它排进 Eval，别再重复入队。
        const returned: string[] = (disposition.handbacks ?? []).map((item: any) => String(item?.ticketId ?? ''))
        if (fanout.every(id => returned.includes(id))) continue
        // 只要有一张工单仍存活且不是 zombie，就留给它接手；全部已结束/卡死才算永久搁浅。
        // 同时记录「最晚失去接手能力的时刻」：已结束取 ended.at，僵尸工单按当前时间（它此刻仍接不了手）。
        let viable = false
        let latestLostAt = Number.NEGATIVE_INFINITY
        for (const ticketId of fanout) {
          const ticket = tickets?.get?.(ticketId)
          if (!ticket) continue
          if (ticket.ended) {
            const endedAt = Date.parse(String(ticket.ended.at ?? ''))
            if (Number.isFinite(endedAt)) latestLostAt = Math.max(latestLostAt, endedAt)
            continue
          }
          const health = ticketHealth(ticket, now, await collectExecutorSignals(ctx, ticket))
          if (health.health !== 'zombie') { viable = true; break }
          latestLostAt = Math.max(latestLostAt, now)
        }
        if (viable) continue
        // 窗口基准是「工单变得接不了手的时间」，不是消息发送时间（见 STRANDED_WINDOW_MS 注释）：
        // 工单刚结束/刚卡死就重投；几小时前就已成定局的，等下次再说，避免重启时批量重投陈年消息。
        if (!(latestLostAt >= cutoff)) continue
        handled += 1
        if (engine.reevaluate(entry.id) !== true) continue
        // 提示写回用户看得见的原对话：分流消息在 `~d` 子线程里，但 trigger.channel 始终指回原会话。
        const address = trigger.channel?.address?.conversation
        const conversation = typeof address === 'string' && address ? address : logKeyValue.slice('pane-log:'.length)
        appendLog(source, conversation, {
          id: `recovered:${entry.id}`, direction: 'out', at: new Date().toISOString(),
          text: STRANDED_RECOVERED_TEXT, kind: 'recovered',
        })
        ;(ctx as any).logger?.info?.('dsh-superagent-pane: 已重新入队搁浅消息 %s（对话 %s）', entry.id, conversation)
      } catch (error) {
        ;(ctx as any).logger?.warn?.('dsh-superagent-pane: 搁浅消息检查失败 %s', String(error))
      }
    }
  }
}

/**
 * 读 /proc/meminfo（可选 /proc/loadavg），算面板小部件要的内存指标。
 *
 * 口径与 mem-watch.py、云厂商监控一致：usage_pct = (MemTotal - MemAvailable) / MemTotal * 100。
 * 与 `free` 的 used 不同——`free` 扣掉了可回收的 SReclaimable，数值会偏低。
 * 只读、无副作用；任何读取失败由调用方兜成 500 JSON。
 */
function readSysMem(): {
  mem_total_mb: number
  mem_available_mb: number
  usage_pct: number
  swap_pct: number | null
  load1: number | null
} {
  const fields: Record<string, number> = {}
  for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const at = line.indexOf(':')
    if (at < 0) continue
    const value = Number.parseFloat(line.slice(at + 1).trim())
    if (Number.isFinite(value)) fields[line.slice(0, at).trim()] = value
  }
  const total = fields.MemTotal ?? 0
  const available = fields.MemAvailable ?? 0
  const swapTotal = fields.SwapTotal ?? 0
  const swapFree = fields.SwapFree ?? 0
  const round1 = (n: number) => Math.round(n * 10) / 10
  let load1: number | null = null
  try {
    const parsed = Number.parseFloat(readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0] ?? '')
    if (Number.isFinite(parsed)) load1 = parsed
  } catch { /* loadavg 读不到不影响内存指标 */ }
  return {
    mem_total_mb: round1(total / 1024),
    mem_available_mb: round1(available / 1024),
    usage_pct: total > 0 ? round1(((total - available) / total) * 100) : 0,
    swap_pct: swapTotal > 0 ? round1(((swapTotal - swapFree) / swapTotal) * 100) : null,
    load1,
  }
}

/** GET /api/sys-mem —— 只读；失败也回 JSON，不把异常抛到宿主。 */
const sysMemHandler = (req: any, res: any): void => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD')
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  try {
    sendJson(res, 200, readSysMem())
  } catch (error) {
    sendJson(res, 500, { error: `无法读取 /proc/meminfo: ${String(error)}` })
  }
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
  // 面板小部件用的只读系统指标（内存/swap/load）。做 exact 路由：WebServer 先查精确表再走前缀，
  // 所以能抢在 client-connection 的 `/api` 前缀（RPC 网关、对无 cookie 请求回 401）之前命中。
  // 鉴权沿用页面 cookie：网关未登录时根本不会走到这里；这里不额外校验自定义头，便于同源 fetch 直接取。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/sys-mem',
    handler: sysMemHandler,
  }), 'pane: sys-mem route')
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
  // 搁浅消息自愈：启动后先扫一次，之后每 30 秒一次；只处理最近一小时内的派活消息，每轮最多 3 条。
  ctx.effect(() => {
    let busy = false
    const sweep = () => {
      if (busy) return
      busy = true
      void recoverStranded(ctx).catch(error => {
        ;(ctx as any).logger?.warn?.('dsh-superagent-pane: 搁浅消息自愈检查失败 %s', String(error))
      }).finally(() => { busy = false })
    }
    const boot = setTimeout(sweep, 0)
    const timer = setInterval(sweep, STRANDED_SWEEP_MS)
    return () => { clearTimeout(boot); clearInterval(timer) }
  }, 'pane: stranded recovery')
  // 定时派活：每 20 秒扫一轮到点任务；启动后先等 2 秒让 Source 就绪，避免第一轮读不到 state。
  ctx.effect(() => {
    let busy = false
    const sweep = () => {
      if (busy) return
      busy = true
      void runDueSchedules(ctx).catch(error => {
        ;(ctx as any).logger?.warn?.('dsh-superagent-pane: 定时派活检查失败 %s', String(error))
      }).finally(() => { busy = false })
    }
    const boot = setTimeout(sweep, 2_000)
    const timer = setInterval(sweep, SCHEDULE_SWEEP_MS)
    return () => { clearTimeout(boot); clearInterval(timer) }
  }, 'pane: scheduled dispatch')
}