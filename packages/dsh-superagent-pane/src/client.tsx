/**
 * 浏览器侧插件入口：侧边栏「派活」面板——派活、读对话、看 worker 正在做什么。
 *
 * 它注册自己的 slot，而不是改 dsh-superagent 的面板，所以升级主包不会把它弄丢。与主包唯一的接触面，
 * 是本插件自己提供的 HTTP 路由，以及宿主公开的管理 API（工单列表）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { CcPanel, type CcStatus } from './ccpanel.tsx'

/** 后端 /pane/health 返回的真实健康度。 */
type Health = { health: 'ok' | 'idle' | 'zombie' | 'working'; detail?: string; silentMs?: number }

export const inject = ['slots', 'locale', 'layout']

const NS = 'dshSuperagentPane'
const PANEL_ID = 'dsh-superagent-pane'

/** 本插件自己的路由，位于面板的 API 前缀下。 */
const API = '/orchestrator/api/pane'
/** 宿主的管理 API（只读工单），与面板同源。 */
const HOST_API = '/orchestrator/api'
/** pane Source 的 Thread 键前缀，与 Node 侧一致。 */
const THREAD_PREFIX = 'pane:'

/** 派活面板选中态的持久键：记住本标签页里用户是不是停在派活界面。
 *  宿主的全局面板选中态只存在内存里：派活插件的客户端 bundle 热更新（HMR）会先注销它的 main 槽注册、
 *  稍后重新注册，布局插件在注销那一瞬把选中态清回会话界面，重新注册后不会自动恢复；整页刷新同样会
 *  重置布局。两者都表现为「正在派活界面，却被意外切到主界面」。把选中态记下来，重载插件后补回去。 */
const SELECTED_KEY = 'dsh-superagent-pane/selected-panel'

/** 读「本标签页里刚才停在派活界面」的标记；sessionStorage 不可用（隐私模式）时当作没有。 */
function rememberedSelection(): boolean {
  try { return window.sessionStorage.getItem(SELECTED_KEY) === '1' } catch { return false }
}

/** 写选中标记。写不进去就算了，不能影响面板本身。 */
function rememberSelection(selected: boolean): void {
  try { window.sessionStorage.setItem(SELECTED_KEY, selected ? '1' : '0') } catch { /* 隐私模式没有 sessionStorage */ }
}

/** 派活面板当前对话的持久键：面板卸载重挂、整页刷新后要回到用户刚才所在的对话，
 *  否则会退回 main——新建对话里派出的工单卡看起来就像“消失”了（工单其实还挂在 pane:<对话> 上）。 */
const CONVERSATION_KEY = 'dsh-superagent-pane/conversation'
/** 本标签页新建、宿主里可能还没有任何记录的对话名（点 + 之后、派活之前）。 */
const NEW_CONVERSATIONS_KEY = 'dsh-superagent-pane/new-conversations'
/** 用户在派活面板里删掉的对话名。删的是「下拉里的入口」，宿主里的消息与线程一条都不动；
 *  存 localStorage（跨刷新、跨标签页生效），上限 200 条，按名字去重。 */
const REMOVED_CONVERSATIONS_KEY = 'dsh-superagent-pane/removed-conversations'
const REMOVED_LIMIT = 200
/** 对话名允许的字符集，与宿主线程键、pane-log 键一致。 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,200}$/
/** 每张工单的意见会话前缀：t<工单id>。这个线程没有订阅者，消息不会广播给同对话的其它工单。 */
const COMMENT_PREFIX = 't'
function commentConversation(ticketId: string): string { return COMMENT_PREFIX + ticketId }
function isCommentConversation(name: string): boolean { return /^t[0-9a-f]{8,32}$/i.test(name) }

/** 读上次停留的对话名；没存过、存的内容非法、sessionStorage 不可用时都当作没有。 */
function rememberedConversation(): string | null {
  try {
    const value = window.sessionStorage.getItem(CONVERSATION_KEY)
    return value && NAME_PATTERN.test(value) ? value : null
  } catch { return null }
}

/** 记住当前对话名。写不进去就算了，不能影响面板本身。 */
function rememberConversation(name: string): void {
  try { if (NAME_PATTERN.test(name)) window.sessionStorage.setItem(CONVERSATION_KEY, name) } catch { /* 隐私模式没有 sessionStorage */ }
}

/** 读本标签页新建过的对话名（最多 20 条）；解析失败或内容非法就当作没有。 */
function rememberedNewConversations(): string[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(NEW_CONVERSATIONS_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((name: unknown): name is string => typeof name === 'string' && NAME_PATTERN.test(name)).slice(0, 20)
      : []
  } catch { return [] }
}

/** 记住本标签页新建过的对话名。写不进去就算了，不能影响面板本身。 */
function rememberNewConversations(names: string[]): void {
  try { window.sessionStorage.setItem(NEW_CONVERSATIONS_KEY, JSON.stringify(names.slice(0, 20))) } catch { /* 隐私模式没有 sessionStorage */ }
}

/** 读用户删掉的对话名；localStorage 不可用（隐私模式）、JSON 坏掉、内容非法时都当作没有。 */
function rememberedRemovedConversations(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REMOVED_CONVERSATIONS_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((name: unknown): name is string => typeof name === 'string' && NAME_PATTERN.test(name)))].slice(-REMOVED_LIMIT)
      : []
  } catch { return [] }
}

/** 记住删掉的对话名（新的排在末尾，超上限丢最旧的）。写不进去就算了，不能影响面板本身。 */
function rememberRemovedConversations(names: string[]): void {
  try {
    window.localStorage.setItem(REMOVED_CONVERSATIONS_KEY, JSON.stringify([...new Set(names)].slice(-REMOVED_LIMIT)))
  } catch { /* 隐私模式没有 localStorage */ }
}

/** 用户展开过的工单卡 id：存模块级 Set，不用组件 state。
 *  轮询每 2.5 秒换掉 tickets 数组、宿主重渲染导致组件重挂时，展开态都不会丢；
 *  只有用户自己收起（toggle）或关闭（×）该卡时才移除。 */
const EXPANDED_TICKETS = new Set<string>()

/** 记/忘一张卡的展开态；上限 200 条，超出丢最旧的，避免长期运行无限增长。 */
function rememberExpandedTicket(id: string, value: boolean): void {
  if (value) {
    EXPANDED_TICKETS.add(id)
    while (EXPANDED_TICKETS.size > 200) {
      const oldest = EXPANDED_TICKETS.values().next().value
      if (typeof oldest === 'string') EXPANDED_TICKETS.delete(oldest)
    }
  } else {
    EXPANDED_TICKETS.delete(id)
  }
}

/** 同源管理调用需要的头，面板每个请求都带；令牌随页面 URL 而来。 */
function headers(): Record<string, string> {
  return { 'x-orchestrator-request': '1', 'content-type': 'application/json' }
}
function token(): string {
  return new URLSearchParams(window.location.search).get('token') ?? ''
}
/** 发一个同源管理请求；`path` 为完整路径（令牌自动附加）。 */
async function request(path: string, init?: RequestInit): Promise<any> {
  const value = token()
  const url = `${path}${value ? `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(value)}` : ''}`
  const response = await fetch(url, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}
/** 调本插件自己的路由。 */
const call = (path: string, init?: RequestInit) => request(`${API}${path}`, init)

const zh = {
  panel: '派活',
  placeholder: '输入任务，回车发送（Shift+回车换行）',
  send: '发送',
  sending: '发送中…',
  conversation: '对话',
  empty: '还没有消息。输入一句话就能派活给 superagent。',
  failed: '发送失败：{error}',
  you: '你',
  agent: '智能体',
  newConversation: '新对话',
  conversationNewAt: '新对话 {time}',
  deleteConversation: '删除当前对话',
  confirmDelete: '确认删除？',
  deleteHint: '从下拉里删掉这个对话（宿主里的消息不删）',
  deleteMainBlocked: 'main 对话不能删除',
  deleteBusyBlocked: '这个对话还有进行中的工单，不能删除',
  statusWorking: '运行中',
  statusPerson: '等你处理',
  statusIdle: '待命',
  statusEnded: '已结束',
  stopTicket: '确认停止？',
  closeHintEnded: '关闭这张工单卡（不再显示）',
  closeHintOpen: '停止这张工单并收起：正在执行的 worker 会被中断',
  commentOnTicket: '给这张工单提意见',
  commentPlaceholder: '给这张工单提意见，会转交给它的 worker（回车发送，Shift+回车换行）',
  commentSend: '发意见',
  commentSending: '发送中…',
  commentSent: '已发给这张工单',
  commentFailed: '意见发送失败：{error}',
  commentOpenConversation: '打开这张工单的意见会话',
  commentLabel: '工单意见 · {name}',
  // 时长
  elapsedSec: '{n} 秒',
  elapsedMin: '{n} 分钟',
  elapsedHour: '{h} 小时 {m} 分',
  // 动作短语（说人话）
  workPython: '运行 Python 脚本',
  workVideo: '处理视频',
  workScript: '运行脚本',
  workDeps: '安装依赖',
  workGit: 'Git 操作',
  workSearch: '搜索内容',
  workDownload: '下载文件',
  workView: '查看文件',
  workFind: '查找文件',
  workFiles: '整理文件',
  workCommand: '执行命令',
  workRunning: '工作中',
  think: '正在思考…',
  thinkWith: '正在思考…（上一步：{what}）',
  waitAfter: '上一步：{what}，等待继续',
  waitNext: '等待下一步…',
  stalled: '{mins} 分钟没有新动作',
  waitingReply: '已送达 · 等待 worker 回复（{n} 条排队，已等 {time}）',
  waitingBusy: '已送达 · worker 正忙，你的消息在排队（已等 {time}）',
  waitingChat: '已送达 · 等待路由器回复（已等 {time}）',
  modeDispatch: '派活',
  modeChat: '对话（路由器）',
  placeholderChat: '和路由器对话：问工单状态、闲聊、查设置（派活请用左侧「派活」）',
  chatBusyHint: '此对话有进行中的工单：「派活」消息会并进该工单交给它的 worker（工单卡死时才改由路由器分诊）；「对话」消息由路由器即时回复。',
  divertedHint: '这条派活消息没进卡死的工单，改由路由器分诊：{reason}',
  details: '详情',
  collapse: '收起',
  // 工具名
  toolBash: '执行命令',
  toolRead: '读取文件',
  toolWrite: '写入文件',
  toolEdit: '编辑文件',
  toolGrep: '搜索内容',
  toolGlob: '查找文件',
  toolSearch: '联网搜索',
  toolFetch: '抓取网页',
  toolPlan: '更新计划',
  toolTask: '处理子任务',
  toolTicket: '查看工单',
  toolReport: '汇报进度',
  toolReply: '回复消息',
  toolAck: '确认消息',
  toolNote: '记录备注',
  toolStatus: '查询状态',
  toolRoute: '分派工作',
  toolJob: '等待命令输出',
  toolOrchestrator: '处理工单',
  usageOpen: '打开用量统计',
  usageClose: '收起用量统计',
  usageTitle: '用量统计',
  usageToday: '今日',
  usageWeek: '近 7 天',
  usageCalls: '{n} 次调用',
  usageByModel: '按模型',
  usageEmpty: '用量数据暂不可用',
}
const en = {
  panel: 'Dispatch',
  placeholder: 'Type a task, Enter to send (Shift+Enter for a newline)',
  send: 'Send',
  sending: 'Sending…',
  conversation: 'Conversation',
  empty: 'No messages yet. Type a line to dispatch work to the superagent.',
  failed: 'Send failed: {error}',
  you: 'You',
  agent: 'Agent',
  newConversation: 'New conversation',
  conversationNewAt: 'New conversation {time}',
  deleteConversation: 'Delete current conversation',
  confirmDelete: 'Delete it?',
  deleteHint: 'Remove this conversation from the list (its messages stay on the host)',
  deleteMainBlocked: 'The main conversation cannot be deleted',
  deleteBusyBlocked: 'This conversation still has a running ticket and cannot be deleted',
  statusWorking: 'running',
  statusPerson: 'needs you',
  statusIdle: 'idle',
  statusEnded: 'ended',
  stopTicket: 'Stop it?',
  closeHintEnded: 'Close this card (hide it from the panel)',
  closeHintOpen: 'Stop this ticket and hide the card; a running worker will be interrupted',
  commentOnTicket: 'Comment on this ticket',
  commentPlaceholder: 'Comment on this ticket; it is handed to its worker (Enter sends)',
  commentSend: 'Send comment',
  commentSending: 'Sending…',
  commentSent: 'Sent to this ticket',
  commentFailed: 'Comment failed: {error}',
  commentOpenConversation: 'Open this ticket comment thread',
  commentLabel: 'Ticket comments · {name}',
  elapsedSec: '{n}s',
  elapsedMin: '{n} min',
  elapsedHour: '{h}h {m}m',
  workPython: 'running a Python script',
  workVideo: 'processing video',
  workScript: 'running a script',
  workDeps: 'installing dependencies',
  workGit: 'git operations',
  workSearch: 'searching content',
  workDownload: 'downloading',
  workView: 'reading files',
  workFind: 'locating files',
  workFiles: 'organizing files',
  workCommand: 'running a command',
  workRunning: 'working',
  think: 'Thinking…',
  thinkWith: 'Thinking…（last step: {what}）',
  waitAfter: 'Last step: {what}, waiting',
  waitNext: 'Waiting for the next step…',
  stalled: 'no activity for {mins} min',
  waitingReply: 'Delivered · waiting for the worker ({n} queued, {time} so far)',
  waitingBusy: 'Delivered · the worker is busy; your message is queued ({time} so far)',
  waitingChat: 'Delivered · waiting for the router ({time} so far)',
  modeDispatch: 'Dispatch',
  modeChat: 'Chat (router)',
  placeholderChat: 'Chat with the router: ticket status, questions, settings (use Dispatch on the left to assign work)',
  chatBusyHint: 'This conversation has a running ticket: Dispatch messages join that ticket for its worker (they go to the router only when the ticket is stuck); Chat messages are answered by the router right away.',
  divertedHint: 'This dispatch message did not go into the stuck ticket; the router is triaging it instead: {reason}',
  details: 'details',
  collapse: 'hide',
  toolBash: 'command',
  toolRead: 'file read',
  toolWrite: 'file write',
  toolEdit: 'file edit',
  toolGrep: 'content search',
  toolGlob: 'file search',
  toolSearch: 'web search',
  toolFetch: 'web fetch',
  toolPlan: 'plan',
  toolTask: 'subtask',
  toolTicket: 'ticket read',
  toolReport: 'reporting',
  toolReply: 'replying',
  toolAck: 'ack',
  toolNote: 'note',
  toolStatus: 'status',
  toolRoute: 'routing',
  toolJob: 'waiting for job output',
  toolOrchestrator: 'ticket ops',
  usageOpen: 'Open usage stats',
  usageClose: 'Hide usage stats',
  usageTitle: 'Usage',
  usageToday: 'Today',
  usageWeek: 'Last 7 days',
  usageCalls: '{n} calls',
  usageByModel: 'By model',
  usageEmpty: 'Usage data is unavailable',
}

type Item = { id: string; direction: 'in' | 'out'; at: string; text: string; kind?: string; mode?: string }
type Ticket = {
  id: string; title: string; stage?: string; state?: string; summary?: string; sessionId?: string
  createdAt?: string; updatedAt?: string; threads?: { key?: string }[]
}
type Activity = { state?: string; kind?: string | null; tool?: string; text?: string; at?: number; ageMs?: number }
type Translate = (key: keyof typeof zh, values?: Record<string, string>) => string

/** 工具名到文案键的映射；未知工具直接显示原名。 */
const TOOL_KEYS: Record<string, keyof typeof zh> = {
  bash: 'toolBash', read: 'toolRead', write: 'toolWrite', edit: 'toolEdit', multi_edit: 'toolEdit',
  grep: 'toolGrep', glob: 'toolGlob', web_search: 'toolSearch', web_fetch: 'toolFetch',
  todo_write: 'toolPlan', task: 'toolTask',
  orchestrator_read: 'toolTicket', orchestrator_report: 'toolReport', orchestrator_reply: 'toolReply',
  orchestrator_ack: 'toolAck', orchestrator_ticket_note: 'toolNote',
  orchestrator_ticket_request_status: 'toolStatus', orchestrator_route: 'toolRoute',
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole)
}

/** 时长说人话：<1 分钟按秒，之后按分钟，再往上按小时。 */
function formatElapsed(t: Translate, ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return fill(t('elapsedSec'), { n: String(seconds) })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return fill(t('elapsedMin'), { n: String(minutes) })
  return fill(t('elapsedHour'), { h: String(Math.floor(minutes / 60)), m: String(minutes % 60) })
}

/** 插件开发期自测/探针会话的命名（probe、selftest、demo、cc-*、c-test*、routertest、ui 等）。
 *  数据一条都不删，只在下拉里隐藏，免得测试会话淹掉用户自己的对话；去掉这条过滤即可恢复显示。 */
const TEST_CONVERSATION = /^(probe\d*|selftest\d*|demo\d*|cc(?:-[A-Za-z0-9_-]+)?|health-test-\d+|rev9-test-\d+|c-test[A-Za-z0-9_-]*|routertest|ui)$/i

/** 对话下拉的显示文案：自动生成的新对话名（c+时间戳）翻成「新对话 MM-DD HH:mm」，其余直显。 */
function conversationLabel(t: Translate, name: string): string {
  const hit = /^c(\d{10,13})$/.exec(name)
  if (!hit) return name
  const date = new Date(Number(hit[1]))
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return fill(t('conversationNewAt'), { time })
}

/** 把 bash 命令归类成一句人话，并顺带挑出好认的脚本名 / 文件名。 */
function humanizeCommand(command: string): { key: keyof typeof zh; name?: string } {
  const text = command.replace(/\s+/g, ' ').trim()
  const script = /([\w.\-]+\.(?:py|sh|js|mjs|ts|rb|pl))\b/.exec(text)?.[1]
  const media = /([\w.\-]+\.(?:mp4|mkv|mov|avi|png|jpe?g|bmp|webp|csv|json|txt|md|log))\b/i.exec(text)?.[1]
  if (/\bpython3?\b/.test(text)) return { key: 'workPython', name: script }
  if (/\bffmpeg\b|\bffprobe\b/.test(text)) return { key: 'workVideo', name: media }
  if (/\bnode\b|\bpytest\b|\bpandas\b/.test(text)) return { key: 'workScript', name: script }
  if (/\b(pip3?|npm|pnpm|yarn|apt-get|apt)\b/.test(text)) return { key: 'workDeps' }
  if (/\bgit\b/.test(text)) return { key: 'workGit' }
  if (/\b(grep|rg|ag)\b/.test(text)) return { key: 'workSearch', name: quote(text) }
  if (/\b(curl|wget)\b/.test(text)) return { key: 'workDownload' }
  if (/\b(cat|head|tail|less|wc|sed|awk)\b/.test(text)) return { key: 'workView', name: media }
  if (/\b(find|ls|tree|du|stat)\b/.test(text)) return { key: 'workFind', name: media }
  if (/\b(cp|mv|rm|mkdir|touch|rsync)\b/.test(text)) return { key: 'workFiles' }
  return { key: 'workCommand' }
}
/** 取命令里第一个被引号括起来的词（通常是 grep 的模式）。 */
function quote(text: string): string | undefined {
  const hit = /['"]([^'"]{2,40})['"]/.exec(text)?.[1]
  return hit
}
/** 工具的对象：文件类只留文件名；工单类不带对象；JSON 参数先展开第一个字符串字段。 */
function toolTarget(tool: string | undefined, text: string): string | undefined {
  if (!text) return undefined
  // 查看/确认工单、等作业输出这类动作，参数是内部 id，说出来反而添乱。
  if (tool?.startsWith('job_')) return undefined
  if (tool?.startsWith('orchestrator_') && tool !== 'orchestrator_reply' && tool !== 'orchestrator_report') return undefined
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const first = Object.values(JSON.parse(text) as Record<string, unknown>).find(value => typeof value === 'string')
      if (typeof first !== 'string') return undefined
      text = first
    } catch { return undefined }
  }
  if (tool === 'read' || tool === 'write' || tool === 'edit' || tool === 'multi_edit') {
    const base = text.replace(/\\/g, '/').split('/').filter(Boolean).pop()
    return base && base.length > 40 ? `${base.slice(0, 40)}…` : base
  }
  return text.length > 48 ? `${text.slice(0, 48)}…` : text
}
/** 工具名 → 人话短语；未知但成族的（job_*、orchestrator_*）走兜底。 */
function toolPhrase(t: Translate, tool: string | undefined): string {
  if (!tool) return t('workRunning')
  if (tool.startsWith('job_')) return t('toolJob')
  if (tool.startsWith('orchestrator_')) return t('toolOrchestrator')
  const key = TOOL_KEYS[tool]
  return key ? t(key) : tool
}

/** 一行「正在做什么」：短语 + 可选对象 + 卡住提示；原始命令留给详情折叠。 */
type WorkSummary = { phrase: string; detail?: string; stalled?: number; raw: string }
function workSummary(t: Translate, activity: Activity): WorkSummary {
  const raw = (activity.text ?? '').trim()
  const flat = raw.replace(/\s+/g, ' ')
  const stalled = activity.ageMs !== undefined && activity.ageMs > 120_000 ? Math.max(1, Math.round(activity.ageMs / 60_000)) : undefined
  const last = (): { phrase: string; detail?: string } => {
    if (activity.kind === 'job') {
      const { key, name } = humanizeCommand(flat)
      return { phrase: t(key), detail: name }
    }
    if (activity.kind === 'tool') return { phrase: toolPhrase(t, activity.tool), detail: toolTarget(activity.tool, flat) }
    if (activity.kind === 'text') return { phrase: flat.length > 80 ? `${flat.slice(0, 80)}…` : flat }
    return { phrase: t('workRunning') }
  }
  if (activity.state === 'running') return { ...last(), stalled, raw }
  if (activity.state === 'thinking') return { phrase: fill(t('thinkWith'), { what: last().phrase }), stalled, raw }
  if (activity.state === 'waiting') return { phrase: fill(t('waitAfter'), { what: last().phrase }), stalled, raw }
  return { phrase: t('waitNext'), stalled, raw }
}

/** 状态条里的圆点：运行中呼吸闪烁，其余静态。 */
const DOT_STYLE = `.dsh-pane-dot-running{animation:dsh-pane-pulse 1.6s ease-in-out infinite}@keyframes dsh-pane-pulse{0%,100%{opacity:1}50%{opacity:.35}}`

/** 对话上方的一条工单状态条：哪个工单、到哪一步、worker 此刻在做什么（说人话，详情可展开原始命令）。 */
function TicketBar({ ticket, activity, t, ccStatus, ccExpanded, onToggleCc, onInterrupt, onClear, ccBusy, health, confirmStop, onClose, onComment, onOpenComment }: {
  ticket: Ticket; activity: Activity | null; t: Translate
  ccStatus: CcStatus | null; ccExpanded: boolean
  onToggleCc: () => void; onInterrupt: () => void; onClear: () => void; ccBusy: boolean
  health?: Health | null; confirmStop: boolean; onClose: () => void
  onComment?: (ticket: Ticket, text: string) => Promise<void>
  onOpenComment?: (ticket: Ticket) => void
}) {
  const [open, setOpen] = useState(false)
  const stage = ticket.stage ?? 'ended'
  const zombie = health?.health === 'zombie'
  // 默认全折叠：面板刚进来时所有工单只显示单行摘要，不按 stage 自动展开/收起。
  // 展开与否完全由用户点击决定，这样 10 张工单能同时放下，不挤占下方对话区。
  // 展开态按 id 存在模块级 EXPANDED_TICKETS 里：数据轮询/组件重挂都不会把它重置掉。
  const [expanded, setExpanded] = useState(() => EXPANDED_TICKETS.has(ticket.id))
  const setCardExpanded = (next: boolean) => {
    rememberExpandedTicket(ticket.id, next)
    setExpanded(next)
  }
  const cardRef = useRef<HTMLDivElement | null>(null)
  // 原型把 report=waiting 的工单一律算成 idle，哪怕 Assignment 还标着 running（僵尸）。
  // 这里用真实健康度覆盖显示，别让人误以为它在待命。
  const label = zombie ? '卡死 · 需处理'
    : stage === 'working' ? t('statusWorking') : stage === 'person' ? t('statusPerson') : stage === 'idle' ? t('statusIdle') : t('statusEnded')
  const created = typeof ticket.createdAt === 'string' ? Date.parse(ticket.createdAt) : 0
  const elapsed = stage === 'working' && created ? formatElapsed(t, Date.now() - created) : ''
  const work = stage === 'working' && activity ? workSummary(t, activity) : null
  const summary = (ticket.summary ?? '').replace(/\s+/g, ' ').trim()
  const dot = zombie ? '#e53e3e' : stage === 'working' ? '#38a169' : stage === 'ended' ? '#888' : '#d69e2e'
  // 收起时的一句话：在跑的说当前动作，其余说结果/问题摘要。
  const compact = work ? `${work.phrase}${work.detail ? `（${work.detail}）` : ''}` : summary
  // 展开后若卡片被滚出可视区，把它带回工单区可见范围；block:'nearest' 只滚动最近的滚动祖先（工单区），不动整页。
  const toggle = () => {
    const next = !expanded
    setCardExpanded(next)
    if (next) requestAnimationFrame(() => cardRef.current?.scrollIntoView({ block: 'nearest' }))
  }
  // 这张工单的意见输入框：与面板底部主输入框互不影响，失败只在卡内提示。
  const [commentDraft, setCommentDraft] = useState('')
  const [commentState, setCommentState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle')
  const [commentError, setCommentError] = useState('')
  const commentRef = useRef<HTMLTextAreaElement | null>(null)
  const submitComment = async () => {
    const text = commentDraft.trim()
    if (!text || commentState === 'busy' || !onComment) return
    setCommentState('busy'); setCommentError('')
    try {
      await onComment(ticket, text)
      setCommentDraft('')
      setCommentState('ok')
    } catch (failure) {
      setCommentState('error')
      setCommentError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  return <div ref={cardRef} data-ticket-id={ticket.id}
    style={{ border: '1px solid var(--dt-border, #333)', borderRadius: 6, padding: expanded ? '7px 10px' : '4px 9px', fontSize: 12,
      background: 'var(--dt-surface, rgba(255,255,255,.04))', display: 'flex', flexDirection: 'column', gap: expanded ? 4 : 0,
      flexShrink: 0 }}>
    {/* 头部一行：收起时单行（标题 + 行内摘要 + 状态 + 关闭），展开时允许换行。 */}
    <div onClick={toggle} aria-expanded={expanded}
      style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: expanded ? 'wrap' : 'nowrap', cursor: 'pointer', minWidth: 0 }}>
      <span style={{ opacity: 0.5, fontSize: 10, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
      <span className={stage === 'working' ? 'dsh-pane-dot-running' : ''} style={{ color: dot, fontSize: 10, flexShrink: 0 }}>●</span>
      <strong title={ticket.title} style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.25, flex: '0 1 auto',
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: expanded ? 'normal' : 'nowrap' }}>{ticket.title}</strong>
      {!expanded && compact && <span title={compact} style={{ fontSize: 11, opacity: 0.6, flex: '1 1 0', minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{compact}</span>}
      <span style={{ marginLeft: 'auto', opacity: 0.65, whiteSpace: 'nowrap', flexShrink: 0 }}>{label}{elapsed ? ` · ${elapsed}` : ''}</span>
      <button type="button" data-pane-ticket-comment={ticket.id}
        aria-label={t('commentOnTicket')} title={t('commentOnTicket')}
        onClick={event => { event.stopPropagation(); setCardExpanded(true); requestAnimationFrame(() => commentRef.current?.focus()) }}
        style={{ background: 'none', border: '1px solid var(--dt-border, #333)', borderRadius: 4, cursor: 'pointer',
          padding: '0 4px', fontSize: 11, lineHeight: 1.35, flexShrink: 0, color: 'inherit', opacity: 0.65 }}>
        ✎
      </button>
      <button type="button" title={stage === 'ended' ? t('closeHintEnded') : t('closeHintOpen')}
        onClick={event => { event.stopPropagation(); rememberExpandedTicket(ticket.id, false); onClose() }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', fontSize: 12, lineHeight: 1, flexShrink: 0,
          color: confirmStop ? '#e53e3e' : 'inherit', opacity: confirmStop ? 1 : 0.55 }}>
        {confirmStop ? t('stopTicket') : '×'}
      </button>
    </div>
    {expanded && work && <div style={{ opacity: 0.88 }}>
      {work.phrase}{work.detail ? `（${work.detail}）` : ''}
      {work.stalled !== undefined && <span style={{ color: '#d69e2e' }}>{` · ${fill(t('stalled'), { mins: String(work.stalled) })}`}</span>}
      <button type="button" onClick={() => setOpen(!open)} style={{ background: 'none', border: 'none', padding: 0, marginLeft: 6,
        color: 'inherit', opacity: 0.6, cursor: 'pointer', textDecoration: 'underline', fontSize: 11 }}>
        {open ? t('collapse') : t('details')}
      </button>
    </div>}
    {expanded && open && work?.raw && <div style={{ fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      maxHeight: 140, overflowY: 'auto', background: 'rgba(0,0,0,.25)', padding: '6px 8px', borderRadius: 4, opacity: 0.85 }}>{work.raw}</div>}
    {expanded && <CcPanel status={ccStatus} expanded={ccExpanded} onToggle={onToggleCc}
      onInterrupt={onInterrupt} onClear={onClear} busy={ccBusy} />}
    {zombie && <div style={{ color: '#e53e3e', fontSize: 11 }}>⚠ {health?.detail ?? '执行器卡死，新消息投进去出不来。建议停止该工单后重新派活。'}</div>}
    {/* 展开态就是「展开看全文」：不再做行数/溢出截断，卡片自身负责折叠。
        运行中（working）也显示已有 summary——worker 在跑不代表报告内容不该看。 */}
    {expanded && summary && <div title={summary} data-pane-ticket-summary={ticket.id} style={{ opacity: 0.7,
      whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{summary}</div>}
    {expanded && <div data-pane-ticket-comment-box={ticket.id}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--dt-border, #333)', paddingTop: 5 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end' }}>
        <textarea ref={commentRef} data-pane-ticket-comment-input={ticket.id}
          value={commentDraft} rows={1} placeholder={t('commentPlaceholder')} aria-label={t('commentPlaceholder')}
          disabled={commentState === 'busy'}
          onChange={event => { setCommentDraft(event.target.value); if (commentState === 'ok' || commentState === 'error') setCommentState('idle') }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitComment() } }}
          style={{ flex: '1 1 0', minWidth: 0, minHeight: 26, maxHeight: 110, resize: 'vertical', fontSize: 12, padding: '3px 6px',
            border: '1px solid var(--dt-border, #333)', borderRadius: 6, background: 'var(--dt-surface, #2d2d2d)', color: 'inherit' }} />
        <button type="button" data-pane-ticket-comment-send={ticket.id}
          aria-label={t('commentSend')} title={t('commentSend')}
          disabled={commentState === 'busy' || !commentDraft.trim()}
          onClick={event => { event.stopPropagation(); void submitComment() }}
          style={{ flexShrink: 0, height: 26, padding: '0 8px', fontSize: 12, lineHeight: 1, borderRadius: 6,
            border: '1px solid var(--dt-border, #333)',
            background: commentState === 'busy' || !commentDraft.trim() ? 'transparent' : 'var(--dt-accent, #2b6cb0)',
            color: commentState === 'busy' || !commentDraft.trim() ? 'inherit' : '#fff',
            cursor: commentState === 'busy' || !commentDraft.trim() ? 'not-allowed' : 'pointer' }}>
          {commentState === 'busy' ? t('commentSending') : t('commentSend')}
        </button>
      </div>
      {commentState === 'ok' && <span data-pane-ticket-comment-status={ticket.id} style={{ fontSize: 11, color: '#38a169', display: 'flex', gap: 6, alignItems: 'baseline' }}>
        {t('commentSent')}
        <button type="button" data-pane-ticket-comment-open={ticket.id}
          aria-label={t('commentOpenConversation')} title={t('commentOpenConversation')}
          onClick={event => { event.stopPropagation(); setCommentState('idle'); onOpenComment?.(ticket) }}
          style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, color: 'inherit', opacity: 0.75,
            cursor: 'pointer', textDecoration: 'underline' }}>
          {t('commentOpenConversation')}
        </button>
      </span>}
      {commentState === 'error' && <span data-pane-ticket-comment-status={ticket.id} style={{ fontSize: 11, color: '#e53e3e' }}>{fill(t('commentFailed'), { error: commentError })}</span>}
    </div>}
  </div>
}

/* ------------------------------------------------------------------ *
 * 面板右上角常驻小部件（纯客户端）：内存占比 + 今日 token 累计与实时速率。
 *
 * 模块作用域零副作用：这里只定义常量、纯函数和组件，不发请求、不读存储、不抛错。
 * 所有取数都在组件 effect 里，失败一律静默降级成「—」，不弹窗、不刷屏。
 * ------------------------------------------------------------------ */

/** 本机 mem-watch.py 的只读内存接口（已带 CORS）。 */
/** 首选同源接口：由插件宿主半注册，任何客户端都能访问。 */
const WIDGET_MEM_API = '/api/sys-mem'
/** 兜底：本机 mem-watch（只有浏览器跑在本虚拟机内才通）。 */
const WIDGET_MEM_API_FALLBACK = 'http://127.0.0.1:8099/api/mem'
const WIDGET_MEM_MS = 2000
const WIDGET_MEM_TIMEOUT_MS = 1000
/** token 轮询与内存错开半秒，避免同一拍打两个接口。 */
const WIDGET_TOKEN_MS = 2500
const WIDGET_TOKEN_DELAY_MS = 500

type WidgetMem = { usage_pct: number; mem_total_mb: number; mem_available_mb: number; swap_pct: number | null }
type WidgetToken = { tokens: number; rate: number | null }

/** 今天 00:00（本地时区），与 dsh-token-live 的「今日」口径一致。 */
function widgetStartOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** <70 绿 / 70–85 黄 / ≥85 红。 */
function widgetMemColor(pct: number): string {
  if (pct >= 85) return '#f87171'
  if (pct >= 70) return '#fbbf24'
  return '#34d399'
}

/** token 累计用「万/亿」缩写，避免把卡片撑宽。 */
function widgetCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e8) return `${(n / 1e8).toFixed(2).replace(/\.?0+$/, '')}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`
  return String(Math.round(n))
}

/** 速率：≥1000 用 k，否则最多一位小数。 */
function widgetRate(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n >= 10) return String(Math.round(n))
  return n.toFixed(1).replace(/\.0$/, '')
}

/**
 * 读一次内存指标，两条路按顺序降级：
 *   1. 同源 GET /api/sys-mem（插件宿主半注册，任何客户端都能访问）
 *   2. 本机 mem-watch：http://127.0.0.1:8099/api/mem（仅浏览器跑在本虚拟机内才通）
 * 每条都带 1 秒超时；全部失败返回 null（调用方显示「内存 —」）。
 */
async function fetchWidgetMemOnce(url: string, credentials: RequestCredentials): Promise<WidgetMem | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WIDGET_MEM_TIMEOUT_MS)
    try {
      const res = await fetch(url, { cache: 'no-store', credentials, signal: controller.signal })
      if (!res.ok) return null
      const body = await res.json()
      if (!body || typeof body.usage_pct !== 'number') return null
      return {
        usage_pct: Number(body.usage_pct),
        mem_total_mb: Number(body.mem_total_mb ?? 0),
        mem_available_mb: Number(body.mem_available_mb ?? 0),
        swap_pct: typeof body.swap_pct === 'number' ? Number(body.swap_pct) : null,
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/** 先同源，再退回本机 8099。 */
async function fetchWidgetMem(): Promise<WidgetMem | null> {
  const same = await fetchWidgetMemOnce(WIDGET_MEM_API, 'same-origin')
  if (same !== null) return same
  return fetchWidgetMemOnce(WIDGET_MEM_API_FALLBACK, 'omit')
}

/** 同源查今日 token；请求形态与 dsh-token-live 完全一致（不带自定义鉴权头）。 */
async function fetchWidgetToken(now: number): Promise<{ tokens: number; calls: number } | null> {
  try {
    const res = await fetch('/api/usage/query', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: widgetStartOfDay(now), to: now, fill: false, granularity: 'day' }),
    })
    if (!res.ok) return null
    if ((res.headers.get('content-type') || '').indexOf('application/json') === -1) return null
    const body = await res.json()
    if (!body || body.ok !== true) return null
    const total = body.value && body.value.total
    if (!total || typeof total.totalTokens !== 'number') return null
    return { tokens: total.totalTokens, calls: typeof total.calls === 'number' ? total.calls : 0 }
  } catch {
    return null
  }
}

/** 用量统计一行：daily / byModel 两种粒度共用这个形状。 */
type UsageBucket = { key: string; calls: number; totalTokens: number; cost: number }
type UsageOverview = {
  today: UsageBucket | null
  /** 近 7 天逐日序列，按日期升序，缺数据的天补 0；柱状图直接用它。 */
  days: UsageBucket[]
  weekTokens: number
  weekCost: number
  weekCalls: number
  models: UsageBucket[]
  symbol: string
}

/** 费用格式化：小额保留 3 位，1 以上两位，大额取整。 */
function widgetCost(n: number, symbol: string): string {
  if (!Number.isFinite(n) || n <= 0) return `${symbol}0`
  const text = n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3)
  return `${symbol}${text}`
}

/**
 * 拉近 7 天用量：同一个 /api/usage/query，返回 daily（逐日）与 byModel（按模型）。
 * 只读、无副作用；失败返回 null，视图降级成「暂不可用」。
 */
async function fetchUsageOverview(now: number): Promise<UsageOverview | null> {
  try {
    const res = await fetch('/api/usage/query', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: widgetStartOfDay(now) - 6 * 86_400_000,
        to: now,
        fill: true,
        granularity: 'day',
      }),
    })
    if (!res.ok) return null
    if ((res.headers.get('content-type') || '').indexOf('application/json') === -1) return null
    const body = await res.json()
    if (!body || body.ok !== true || !body.value) return null
    const bucket = (raw: any): UsageBucket => ({
      key: String(raw?.key ?? ''),
      calls: Number(raw?.calls ?? 0),
      totalTokens: Number(raw?.totalTokens ?? 0),
      cost: Number(raw?.cost ?? 0),
    })
    const rawDays = (Array.isArray(body.value.daily) ? body.value.daily : []).map(bucket)
    // sv-SE 输出 YYYY-MM-DD，且按本地时区，与 daily.key 口径一致。
    const todayKey = new Date(now).toLocaleDateString('sv-SE')
    // 服务端 fill 之后通常已补齐 7 天；这里再按本地日期窗口对齐一次，
    // 保证柱状图固定 7 根、顺序稳定（缺的天补 0，多余的天丢弃）。
    const dayByKey = new Map(rawDays.map(item => [item.key, item]))
    const days: UsageBucket[] = []
    for (let offset = 6; offset >= 0; offset -= 1) {
      const key = new Date(widgetStartOfDay(now) - offset * 86_400_000).toLocaleDateString('sv-SE')
      days.push(dayByKey.get(key) ?? { key, calls: 0, totalTokens: 0, cost: 0 })
    }
    return {
      today: dayByKey.get(todayKey) ?? null,
      days,
      weekTokens: days.reduce((sum, item) => sum + item.totalTokens, 0),
      weekCost: days.reduce((sum, item) => sum + item.cost, 0),
      weekCalls: days.reduce((sum, item) => sum + item.calls, 0),
      models: (Array.isArray(body.value.byModel) ? body.value.byModel : [])
        .map(bucket).filter(item => item.totalTokens > 0).sort((a, b) => b.totalTokens - a.totalTokens),
      symbol: typeof body.value.currency?.symbol === 'string' ? body.value.currency.symbol : '',
    }
  } catch {
    return null
  }
}

/**
 * 近 7 天 token 柱状图：纯 div 实现，不引新依赖。
 * 柱高按窗口内最大值归一，零用量保留 2px 底边；每根柱的 title 给出日期与当天 token 数。
 */
function UsageBars({ days }: { days: UsageBucket[] }) {
  const max = Math.max(1, ...days.map(day => day.totalTokens))
  const todayKey = days.length > 0 ? days[days.length - 1].key : ''
  const barArea = 46
  return (
    <div data-pane-usage-chart="" style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 60, marginTop: 4 }}>
      {days.map(day => {
        // 非零天至少 6px：日用量量级差可达千倍，纯归一化会把小流量天压成看不见的细线。
        const height = day.totalTokens > 0 ? Math.max(6, Math.round((day.totalTokens / max) * barArea)) : 1
        return (
          <div key={day.key} data-pane-usage-bar="" data-day={day.key} data-tokens={day.totalTokens}
            title={`${day.key} · ${day.totalTokens.toLocaleString()} tokens`}
            style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
            <div style={{ width: '100%', height, borderRadius: 2,
              background: day.key === todayKey ? '#93c5fd' : '#5b8def',
              opacity: day.totalTokens > 0 ? 1 : 0.2 }} />
            <span style={{ fontSize: 9, lineHeight: 1, opacity: 0.55, whiteSpace: 'nowrap' }}>
              {day.key.slice(5).replace('-', '/')}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 右上角两行小卡片；每 2 秒轮询，卸载时清理定时器。点一下展开/收起用量统计。 */
function PaneStatusWidget({ t }: { t: Translate }) {
  const [mem, setMem] = useState<WidgetMem | null>(null)
  const [token, setToken] = useState<WidgetToken | null>(null)
  /** 展开的用量统计面板；只在展开时拉数据，直接复用上面的 /api/usage/query。 */
  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<UsageOverview | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => {
      void fetchUsageOverview(Date.now()).then(next => { if (alive) setUsage(next) })
    }
    load()
    const timer = setInterval(load, 15_000)
    return () => { alive = false; clearInterval(timer) }
  }, [open])

  useEffect(() => {
    let alive = true
    let memTimer: ReturnType<typeof setInterval> | null = null
    let tokenTimer: ReturnType<typeof setInterval> | null = null
    let tokenBoot: ReturnType<typeof setTimeout> | null = null
    let previous: { tokens: number; at: number } | null = null

    const tickMem = () => {
      void fetchWidgetMem().then(next => { if (alive) setMem(next) })
    }
    const tickToken = () => {
      const at = Date.now()
      void fetchWidgetToken(at).then(next => {
        if (!alive || next === null) return
        let rate: number | null = null
        if (previous !== null) {
          const dt = (at - previous.at) / 1000
          const delta = next.tokens - previous.tokens
          if (dt > 0 && delta >= 0) rate = delta / dt
        }
        previous = { tokens: next.tokens, at }
        setToken({ tokens: next.tokens, rate })
      })
    }

    tickMem()
    memTimer = setInterval(tickMem, WIDGET_MEM_MS)
    tokenBoot = setTimeout(() => {
      tickToken()
      tokenTimer = setInterval(tickToken, WIDGET_TOKEN_MS)
    }, WIDGET_TOKEN_DELAY_MS)

    return () => {
      alive = false
      if (memTimer !== null) clearInterval(memTimer)
      if (tokenTimer !== null) clearInterval(tokenTimer)
      if (tokenBoot !== null) clearTimeout(tokenBoot)
    }
  }, [])

  const memTitle = mem
    ? `已用 ${((mem.mem_total_mb - mem.mem_available_mb) / 1024).toFixed(2)} GiB / 总量 ${(mem.mem_total_mb / 1024).toFixed(2)} GiB`
      + ` · 可用 ${(mem.mem_available_mb / 1024).toFixed(2)} GiB`
      + ` · Swap ${mem.swap_pct === null ? 'n/a' : `${mem.swap_pct.toFixed(1)}%`}`
    : '内存数据暂不可用'
  const tokenTitle = token
    ? `今日 ${token.tokens.toLocaleString()} tokens` + (token.rate === null ? '' : ` · ${widgetRate(token.rate)} tok/s`)
    : 'token 数据暂不可用'

  return (
    // 单行排布：竖排两行时整块高 41.7px，顶部条带压不到 36px 而不遮挡；并成一行后约 24px，
    // 完整文案仍在 title 里，两项数据都在。
    <div data-testid="pane-status-widget" style={{ position: 'absolute', top: 6, right: 12, zIndex: 5, pointerEvents: 'auto',
      display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 260,
      padding: '4px 8px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l3, #4b5563)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(20, 20, 20, 0.6))', fontSize: 11, lineHeight: 1.35,
      fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
      <button type="button" data-pane-usage="" aria-expanded={open}
        aria-label={open ? t('usageClose') : t('usageOpen')} title={open ? t('usageClose') : t('usageOpen')}
        onClick={() => setOpen(value => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, padding: 0, background: 'none',
          border: 'none', color: 'inherit', font: 'inherit', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
        <span title={memTitle} style={{ color: mem ? widgetMemColor(mem.usage_pct) : 'var(--dsw-alias-label-tertiary, #888)' }}>
          内存 {mem ? `${mem.usage_pct.toFixed(1)}%` : '—'}
        </span>
        <span title={tokenTitle} style={{ color: 'var(--dsw-alias-label-tertiary, #888)' }}>
          {token ? `今日 ${widgetCompact(token.tokens)}tok${token.rate === null ? '' : ` · ${widgetRate(token.rate)}/s`}` : 'token —'}
        </span>
        <span aria-hidden style={{ opacity: 0.6, fontSize: 9 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && <div data-pane-usage-panel="" role="region" aria-label={t('usageTitle')}
        style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 268, padding: '8px 10px',
          display: 'flex', flexDirection: 'column', gap: 3, whiteSpace: 'normal', textAlign: 'left',
          borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l3, #4b5563)',
          background: 'var(--dsw-alias-bg-layer-2, #1b1b1b)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)', fontSize: 11 }}>
        {usage === null ? <span style={{ opacity: 0.7 }}>{t('usageEmpty')}</span> : <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
            <strong>{t('usageTitle')}</strong><span style={{ opacity: 0.6 }}>{t('usageWeek')}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ opacity: 0.75 }}>{t('usageToday')}</span>
            <span>{widgetCompact(usage.today?.totalTokens ?? 0)}tok · {fill(t('usageCalls'), { n: String(usage.today?.calls ?? 0) })}
              · {widgetCost(usage.today?.cost ?? 0, usage.symbol)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ opacity: 0.75 }}>{t('usageWeek')}</span>
            <span>{widgetCompact(usage.weekTokens)}tok · {fill(t('usageCalls'), { n: String(usage.weekCalls) })}
              · {widgetCost(usage.weekCost, usage.symbol)}</span>
          </div>
          <UsageBars days={usage.days} />
          <div style={{ marginTop: 5, opacity: 0.6 }}>{t('usageByModel')}</div>
          {usage.models.slice(0, 5).map(model => (
            <div key={model.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span title={model.key} style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.key}</span>
              <span style={{ flexShrink: 0 }}>{widgetCompact(model.totalTokens)}tok
                {usage.weekTokens > 0 ? ` · ${((model.totalTokens / usage.weekTokens) * 100).toFixed(0)}%` : ''}</span>
            </div>
          ))}
        </>}
      </div>}
    </div>
  )
}

/** 派活面板：一次一个对话，打开期间轮询。 */
function PanePanel({ t }: { t: Translate }) {
  // 挂载时恢复本标签页上次停留的对话：面板卸载重挂 / 整页刷新后不能退回 main。
  const [conversation, setConversation] = useState<string>(() => rememberedConversation() ?? 'main')
  /** 宿主里的 pane: 线程（对话清单，按最近活动倒序）、本标签页新建且宿主还没落地的对话名，
   *  以及从进行中工单反推出来的 pane 会话名。 */
  const [conversations, setConversations] = useState<{ name: string; lastAt: string }[]>([])
  const [extraConversations, setExtraConversations] = useState<string[]>(() => rememberedNewConversations())
  /** 从 open 工单的 threads[].key 反推的会话名：有任务的会话即使不在宿主线程清单里，也不能从下拉消失。 */
  const [ticketConversations, setTicketConversations] = useState<string[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'dispatch' | 'chat'>('dispatch')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [activities, setActivities] = useState<Record<string, Activity>>({})
  const [ccStatuses, setCcStatuses] = useState<Record<string, CcStatus>>({})
  const [ccExpanded, setCcExpanded] = useState(false)
  const [ccBusy, setCcBusy] = useState(false)
  const [healths, setHealths] = useState<Record<string, Health>>({})
  /** 用户在面板里删掉（只是从下拉隐藏）的对话名，持久在 localStorage。 */
  const [removedConversations, setRemovedConversations] = useState<string[]>(() => rememberedRemovedConversations())
  /** 正在等第二次点击确认删除的对话名；5 秒没有下文自动还原。 */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  /** 删除被拒绝时的可见提示（不进发送失败的 error，两者文案不同）。 */
  const [removeNotice, setRemoveNotice] = useState('')
  const [confirmStop, setConfirmStop] = useState<string | null>(null)
  /** 上一次发送被服务端分流时的原因；下次发送或切换对话即清除。 */
  const [divertedNotice, setDivertedNotice] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 用户是否停在底部（含 16px 容差）。轮询会不停换掉 items 数组，只有本来就在底部才跟随滚动。
  const pinnedRef = useRef(true)

  /** 记录用户当前位置：贴底就是「跟随」，往上翻历史就解除跟随，不再被拽回底部。 */
  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (element) pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 16
  }, [])

  // 选中对话与本标签页新建的对话名写回 sessionStorage：卸载重挂、刷新后都能回到原处。
  useEffect(() => { rememberConversation(conversation) }, [conversation])
  useEffect(() => { rememberNewConversations(extraConversations) }, [extraConversations])
  // 删掉的对话名写回 localStorage：刷新、换标签页后都不再出现在下拉里。
  useEffect(() => { rememberRemovedConversations(removedConversations) }, [removedConversations])

  // 切换对话时回到「跟随」状态：新对话应该直接看到最新消息。
  useEffect(() => { pinnedRef.current = true }, [conversation])

  useEffect(() => { setDivertedNotice('') }, [conversation])

  const load = useCallback(async () => {
    try {
      const body = await call(`/log/${encodeURIComponent(conversation)}`)
      setItems(Array.isArray(body?.items) ? body.items : [])
    } catch { /* 未知对话就是还没有消息 */ }
  }, [conversation])

  /** 读 pane 对话清单：宿主线程（pane: 前缀去掉即对话名）与本插件 KV 里记过的对话（/conversations，
   *  能补回只有 ~chat 影子线程、宿主没有 base 线程的名字）。两路各自失败互不影响，合并时同名取较新的 lastAt；
   *  都读不到就保持现状，不打扰用户。 */
  const loadConversations = useCallback(async () => {
    const [threads, logged] = await Promise.allSettled([
      request(`${HOST_API}/threads?filter=all&limit=1000`),
      call('/conversations'),
    ])
    const merged = new Map<string, string>()
    if (threads.status === 'fulfilled') {
      for (const item of (Array.isArray(threads.value?.items) ? threads.value.items : []))
        if (typeof item?.key === 'string' && item.key.startsWith(THREAD_PREFIX))
          merged.set(item.key.slice(THREAD_PREFIX.length), String(item.lastAt ?? item.createdAt ?? ''))
    }
    if (logged.status === 'fulfilled') {
      for (const item of (Array.isArray(logged.value?.conversations) ? logged.value.conversations : []))
        if (typeof item?.name === 'string') {
          const lastAt = String(item.lastAt ?? '')
          if (!(merged.get(item.name) ?? '') || lastAt.localeCompare(merged.get(item.name) ?? '') > 0) merged.set(item.name, lastAt)
        }
    }
    if (threads.status === 'rejected' && logged.status === 'rejected') return
    setConversations([...merged]
      .map(([name, lastAt]) => ({ name, lastAt }))
      .filter(item => item.name && !item.name.includes('~') && /^[A-Za-z0-9_-]+$/.test(item.name)))
  }, [])

  useEffect(() => {
    let live = true
    void loadConversations()
    const timer = setInterval(() => { if (live) void loadConversations() }, 10_000)
    return () => { live = false; clearInterval(timer) }
  }, [loadConversations])

  /** 下拉选项：清单按最近活动倒序，再补本标签页新建的、当前对话和 main，按名字去重。
   *  开发期测试会话从清单里跳过；本标签页新建的、当前选中的和 main 永不隐藏。
   *  用户删掉的对话同样跳过——但如果它还有进行中的工单，仍然保留（隐藏它会连工单卡一起看不到）。 */
  const conversationOptions = (() => {
    const names = [...conversations].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).map(item => item.name)
    const keep = new Set<string>([...extraConversations, conversation, 'main'])
    const removed = new Set(removedConversations)
    const busy = new Set(ticketConversations)
    const seen = new Set<string>()
    return [...names, ...extraConversations, ...ticketConversations, conversation, 'main']
      .filter(name => name && !(TEST_CONVERSATION.test(name) && !keep.has(name)))
      .filter(name => !(removed.has(name) && !busy.has(name)))
      .filter(name => !seen.has(name) && seen.add(name))
  })()

  /** 当前对话还有进行中的工单吗：ticketConversations 由 open 工单反推，tickets 里也可能有 working/person 的卡。
   *  有就不许删——删掉下拉入口会把正在跑的工单卡一并藏起来。 */
  const conversationBusy = ticketConversations.includes(conversation)
    || tickets.some(ticket => (ticket.stage ?? 'ended') !== 'ended')
  const canDeleteConversation = conversation !== 'main' && !conversationBusy
  const confirmingRemove = confirmRemove === conversation
  const deleteBlockedHint = conversation === 'main'
    ? t('deleteMainBlocked')
    : conversationBusy ? t('deleteBusyBlocked') : t('deleteHint')
  /** 删除当前对话：两段式确认；第一次点击只把按钮变成「确认删除？」，5 秒后自动还原。
   *  确认后把名字记进 localStorage、从下拉移除，并切回 main 清空消息区。 */
  const removeConversation = useCallback(async (name: string) => {
    if (name === 'main' || !NAME_PATTERN.test(name)) return
    if (confirmRemove !== name) { setConfirmRemove(name); setRemoveNotice(''); return }
    setConfirmRemove(null)
    if (ticketConversations.includes(name) || tickets.some(ticket => (ticket.stage ?? 'ended') !== 'ended')) {
      // 确认期间又来了新工单（或工单状态还没刷新）：不删，给出可见提示。
      setRemoveNotice(t('deleteBusyBlocked'))
      return
    }
    setRemovedConversations(previous => [...previous.filter(item => item !== name), name])
    setExtraConversations(previous => previous.filter(item => item !== name))
    setConversation('main')
    setItems([])
    setRemoveNotice('')
  }, [confirmRemove, ticketConversations, tickets, t])

  // 「确认删除？」亮着 5 秒没有下文就自动还原，和工单卡的「确认停止？」一致。
  useEffect(() => {
    if (!confirmRemove) return
    const timer = setTimeout(() => setConfirmRemove(null), 5000)
    return () => clearTimeout(timer)
  }, [confirmRemove])

  // 兜底：上次停在的对话正好被删掉（刷新后从 sessionStorage 恢复出来的情形）时回到 main，
  // 免得下拉里的选中项指向一个已经不在清单里的名字。
  useEffect(() => {
    if (conversation === 'main' || !removedConversations.includes(conversation)) return
    if (ticketConversations.includes(conversation)) return
    setConversation('main')
    setItems([])
  }, [conversation, removedConversations, ticketConversations])

  /** 读本对话的工单（进行中优先，全部显示）与每个运行中工单的实时动作。 */
  const pollStatus = useCallback(async () => {
    // 线程键既认本对话自己的线程，也认它的子线程（`~chat` 影子线程、`~d<base36>` 派活分流线程），
    // 否则分流出去的工单在面板上完全不可见。
    const thread = `${THREAD_PREFIX}${conversation}`
    const onThread = (item: Ticket) => item.threads?.some(entry =>
      typeof entry.key === 'string' && (entry.key === thread || entry.key.startsWith(`${thread}~`)))
    try {
      // 手动关闭过的工单不再显示（只作用于已结束的参照卡；进行中的工单一定如实显示）。
      const hideList = await call('/hidden').catch(() => ({ ids: [] }))
      const hiddenIds: string[] = Array.isArray(hideList?.ids) ? hideList.ids : []
      // 显式带 limit：宿主默认只回最新 20 条 open 工单，open 多时目标会话的卡会被漏掉。
      const open = await request(`${HOST_API}/tickets?state=open&limit=1000`)
      // 从进行中工单绑定（含 ~chat / ~d* 子线程）的线程反推 pane 会话名：有任务的会话不能从下拉消失。
      const derived = new Set<string>()
      for (const item of (open?.items ?? []))
        for (const entry of (Array.isArray(item?.threads) ? item.threads : []))
          if (typeof entry?.key === 'string' && entry.key.startsWith(THREAD_PREFIX)) {
            const name = entry.key.slice(THREAD_PREFIX.length).split('~')[0]!
            if (NAME_PATTERN.test(name)) derived.add(name)
          }
      setTicketConversations([...derived].sort())
      const mine = (open?.items ?? []).filter(onThread)
      let list: Ticket[] = mine
      if (!list.length) {
        const ended = await request(`${HOST_API}/tickets?state=ended&limit=20`)
        // 参照卡只认最近一张已结束的工单；关过的那张不再显示，也不顺延到更旧的。
        const latest = (ended?.items ?? []).filter(onThread)[0]
        list = latest && !hiddenIds.includes(latest.id) ? [latest] : []
      }
      setTickets(list)
      const next: Record<string, Activity> = {}
      for (const item of list) {
        if (item.stage === 'working' && item.sessionId) {
          try {
            const info = await request(`${API}/activity/${encodeURIComponent(item.sessionId)}`)
            if (info?.activity) next[item.sessionId] = info.activity
          } catch { /* 单个工单读不到，不拖累其他 */ }
        }
      }
      setActivities(next)
      // Claude Code 的执行实况：每个工单单独读，失败不影响工单本身。
      const cc: Record<string, CcStatus> = {}
      for (const item of list) {
        if (!item.id) continue
        try {
          const info = await request(`${API}/cc/${encodeURIComponent(item.id)}`)
          if (info?.cc) cc[item.id] = info.cc as CcStatus
        } catch { /* 读不到就当作没有委托 */ }
      }
      setCcStatuses(cc)
      // 真实健康度：识别假 idle 的僵尸工单。
      const hs: Record<string, Health> = {}
      for (const item of list) {
        if (!item.id) continue
        try {
          const info = await request(`${API}/health/${encodeURIComponent(item.id)}`)
          if (info?.health) hs[item.id] = info.health as Health
        } catch { /* 读不到就按普通状态显示 */ }
      }
      setHealths(hs)
    } catch { /* 管理 API 暂不可达就保持现状，不打扰用户 */ }
  }, [conversation])

  // 「等回复」= 最后一条 agent 消息之后还有你发的消息。派活消息排给 worker（长任务期间按回合收，会等）；
  // 对话消息走影子线程由 router 即时回，两条路互不影响——排队提示按最后一条消息的模式如实显示。
  const lastOut = (() => { for (let index = items.length - 1; index >= 0; index--) if (items[index]!.direction === 'out') return index; return -1 })()
  const pending = items.filter((item, index) => item.direction === 'in' && index > lastOut)
  const waitingSince = pending.length ? Date.parse(pending[0]!.at) : 0
  const working = tickets.some(ticket => ticket.stage === 'working')

  useEffect(() => {
    let live = true
    void load()
    // 打开期间轮询：worker 的回复在确认之后才落地，面板得持续读；等回复时刷得更勤。
    const timer = setInterval(() => { if (live) void load() }, pending.length > 0 ? 1200 : 2000)
    return () => { live = false; clearInterval(timer) }
  }, [load, pending.length])

  useEffect(() => {
    let live = true
    void pollStatus()
    const timer = setInterval(() => { if (live) void pollStatus() }, 2500)
    return () => { live = false; clearInterval(timer) }
  }, [pollStatus])

  useEffect(() => {
    // 轮询每 1.2-2 秒就换一个新的 items 数组；只有用户本来就停在底部才跟随到底，
    // 正在往上翻历史时不许把他拽回底部。
    const element = scrollRef.current
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight
  }, [items])

  /** 中止请求：写 interrupt 标记并立刻刷新一次。 */
  const ccCommand = useCallback(async (ticketId: string, action: 'interrupt' | 'clear') => {
    setCcBusy(true)
    try {
      await call(`/cc/${encodeURIComponent(ticketId)}/${action}`, { method: 'POST', body: '{}' })
      await pollStatus()
    } catch { /* 失败就保持现状，下一轮轮询会如实反映 */ } finally { setCcBusy(false) }
  }, [pollStatus])

  /**
   * 关闭一张工单卡。已结束的直接收起（记进名单，不动工单）；进行中的先停止——两步确认，
   * 第一次点击变成「确认停止？」，5 秒没有下文自动还原，再点一次才真的停，避免误杀正在跑的 worker。
   * 停完立刻把 id 记进名单，否则它作为「最近一张已结束」会马上又冒出来。
   */
  const closeTicket = useCallback(async (ticket: Ticket) => {
    if ((ticket.stage ?? 'ended') === 'ended') {
      try { await call('/hide', { method: 'POST', body: JSON.stringify({ ticketId: ticket.id }) }) } catch { /* 失败就下一轮再试 */ }
      setConfirmStop(null)
      await pollStatus()
      return
    }
    if (confirmStop !== ticket.id) { setConfirmStop(ticket.id); return }
    setConfirmStop(null)
    try {
      await request(`${HOST_API}/tickets/${encodeURIComponent(ticket.id)}/stop`, { method: 'POST', body: '{}' })
      await call('/hide', { method: 'POST', body: JSON.stringify({ ticketId: ticket.id }) })
    } catch { /* 失败就保持现状，下一轮轮询会如实反映 */ }
    await pollStatus()
  }, [confirmStop, pollStatus])

  // 「确认停止？」亮着 5 秒没有下文就自动还原，免得一直红着。
  useEffect(() => {
    if (!confirmStop) return
    const timer = setTimeout(() => setConfirmStop(null), 5000)
    return () => clearTimeout(timer)
  }, [confirmStop])

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true); setError(null)
    try {
      const sent = await call('/message', { method: 'POST', body: JSON.stringify({ conversation, text, mode }) })
      setDraft('')
      // 服务端只在会话线程的工单卡死时把派活消息改投子线程，如实提示一次；没分流则清掉上次的提示。
      setDivertedNotice(typeof sent?.diverted === 'string' ? sent.diverted : '')
      // 自己刚发的消息必须能看见：重新钉回底部，让下面的 load() 跟随到底。
      pinnedRef.current = true
      await load()
      void loadConversations()
      void pollStatus()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  /** 把「给某张工单的意见」发到这张工单专属的意见会话 t<id>：该线程没有工单订阅，消息不会广播给同对话其它工单，
   *  只走 Eval → 路由器按文本里的工单 id 挂到那一张。 */
  const commentOnTicket = useCallback(async (ticket: Ticket, text: string) => {
    const composed = `【给工单「${ticket.title}」(${ticket.id}) 的意见，请交给该工单的 worker，不要新建工单】\n${text}`
    const sent = await call('/message', { method: 'POST', body: JSON.stringify({ conversation: commentConversation(ticket.id), text: composed, mode: 'dispatch' }) })
    setDivertedNotice(typeof sent?.diverted === 'string' ? sent.diverted : '')
    pinnedRef.current = true
    await load()
    void loadConversations()
    void pollStatus()
  }, [load, loadConversations, pollStatus])

  // boxSizing: 'border-box' 让 height:100% 把 padding 也算进去，否则 content-box 下
  // 100% + 24px 内边距会在工单展开时把面板撑出视口 24px、裁掉底部输入区。
  // 顶部条带按实测收窄：小部件改成单行后 top 6 + 高约 24px = 底部约 30，paddingTop 取 36 留 6px 间距，
  // 会话切换行与工单列表各上移 16px，省下的高度全部给对话区。
  return <div className="dsh-pane-panel" style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box', gap: 8, padding: '36px 12px 12px' }}>
    <style>{DOT_STYLE}</style>
    <PaneStatusWidget t={t} />
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
      <span style={{ fontSize: 11, opacity: 0.65, flexShrink: 0 }}>{t('conversation')}</span>
      <select className="dsh-pane-conversation" data-pane-conversation="" value={conversation}
        aria-label={t('conversation')} title={t('conversation')}
        onChange={event => { setConversation(event.target.value); setItems([]) }}
        style={{ flex: '0 1 auto', minWidth: 0, maxWidth: 220, height: 24, fontSize: 12, padding: '0 4px',
          border: '1px solid var(--dt-border,#333)', borderRadius: 6, background: 'var(--dt-surface,#2d2d2d)',
          color: 'inherit', cursor: 'pointer' }}>
        {conversationOptions.map(name => <option key={name} value={name}>{isCommentConversation(name)
          ? fill(t('commentLabel'), { name: tickets.find(item => item.id === name.slice(1))?.title ?? name.slice(1, 9) })
          : conversationLabel(t, name)}</option>)}
      </select>
      <button type="button" aria-label={t('newConversation')} title={t('newConversation')}
        onClick={() => {
          const name = `c${Date.now()}`
          setExtraConversations(previous => [name, ...previous.filter(item => item !== name)].slice(0, 20))
          setConversation(name)
          setItems([])
        }}
        style={{ height: 24, padding: '0 8px', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>+</button>
      {/* 删除当前对话：只把名字从下拉里去掉，不动宿主里的消息。两边按钮用了同一段两段式确认（第一次变成红色「确认删除？」）。 */}
      <button type="button" data-pane-delete-conversation={conversation}
        aria-label={t('deleteConversation')} title={canDeleteConversation ? t('deleteHint') : deleteBlockedHint}
        disabled={!canDeleteConversation}
        onClick={() => { void removeConversation(conversation) }}
        style={{ height: 24, padding: '0 8px', fontSize: 12, lineHeight: 1, flexShrink: 0,
          color: confirmingRemove ? '#e53e3e' : 'inherit', opacity: confirmingRemove ? 1 : (canDeleteConversation ? 0.7 : 0.35),
          cursor: canDeleteConversation ? 'pointer' : 'not-allowed' }}>
        {confirmingRemove ? t('confirmDelete') : '×'}
      </button>
    </div>
    {/* 工单区独立限高滚动：工单多或展开时只在这个区域里滚，不撑破面板。 */}
    {tickets.length > 0 && <div className="dsh-pane-tickets"
      style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '0 1 auto', minHeight: 0, overflowY: 'auto' }}>
      {tickets.map(ticket => (
        <TicketBar key={ticket.id} ticket={ticket} activity={ticket.sessionId ? activities[ticket.sessionId] ?? null : null} t={t}
          ccStatus={ccStatuses[ticket.id] ?? null} ccExpanded={ccExpanded}
          health={healths[ticket.id] ?? null}
          onToggleCc={() => setCcExpanded(value => !value)}
          ccBusy={ccBusy}
          onInterrupt={() => { void ccCommand(ticket.id, 'interrupt') }}
          onClear={() => { void ccCommand(ticket.id, 'clear') }}
          onComment={commentOnTicket}
          onOpenComment={ticket => { setConversation(commentConversation(ticket.id)); setItems([]) }}
          confirmStop={confirmStop === ticket.id}
          onClose={() => { void closeTicket(ticket) }} />
      ))}
    </div>}
    {/* 对话区保底 220px：工单再多也不能把对话挤到不可用。 */}
    <div ref={scrollRef} onScroll={onScroll} style={{ flex: '1 1 0', minHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: 8,
      border: '1px solid var(--dt-border, #333)', borderRadius: 6 }}>
      {items.length === 0 ? <span style={{ opacity: 0.6 }}>{t('empty')}</span> : items.map(item => (
        <div key={item.id} style={{ alignSelf: item.direction === 'in' ? 'flex-end' : 'flex-start', maxWidth: '85%',
          padding: '6px 10px', borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: item.direction === 'in' ? 'var(--dt-accent, #2b6cb0)' : 'var(--dt-surface, #2d2d2d)',
          color: item.direction === 'in' ? '#fff' : 'inherit' }}>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
            {item.direction === 'in' ? t('you') : `${t('agent')}${item.kind ? ` · ${item.kind}` : ''}`}
          </div>
          {item.text}
        </div>
      ))}
    </div>
    {divertedNotice && <div style={{ fontSize: 11, opacity: 0.7 }}>{fill(t('divertedHint'), { reason: divertedNotice })}</div>}
    {removeNotice && <div role="alert" data-pane-remove-notice="" style={{ color: '#e53e3e', fontSize: 12 }}>{removeNotice}</div>}
    {error && <div style={{ color: '#e53e3e', fontSize: 12 }}>{fill(t('failed'), { error })}</div>}
    {pending.length > 0 && <div style={{ fontSize: 12, opacity: 0.75 }}>
      {(() => {
        const time = formatElapsed(t, Date.now() - waitingSince)
        // 对话模式由路由器直接接话（影子线程），不排 worker 的队，提示不跟着工单繁忙走。
        if (pending[pending.length - 1]?.mode === 'chat') return fill(t('waitingChat'), { time })
        return working ? fill(t('waitingBusy'), { time }) : fill(t('waitingReply'), { n: String(pending.length), time })
      })()}
    </div>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
      <textarea value={draft} onChange={event => setDraft(event.target.value)}
        placeholder={mode === 'chat' ? t('placeholderChat') : t('placeholder')} rows={3}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
        }}
        style={{ flex: 1, resize: 'vertical', padding: 8 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', border: '1px solid var(--dt-border, #333)', borderRadius: 6, overflow: 'hidden' }}>
          {(['dispatch', 'chat'] as const).map(item => (
            <button key={item} type="button" onClick={() => setMode(item)}
              title={item === 'chat' ? t('placeholderChat') : ''}
              style={{ padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer',
                background: mode === item ? 'var(--dt-accent, #2b6cb0)' : 'transparent', color: mode === item ? '#fff' : 'inherit' }}>
              {item === 'dispatch' ? t('modeDispatch') : t('modeChat')}
            </button>
          ))}
        </div>
        <button type="button" style={{ padding: '6px 12px' }} disabled={busy || !draft.trim()} onClick={() => { void send() }}>
          {busy ? t('sending') : t('send')}
        </button>
      </div>
    </div>
    {mode === 'chat' && working && <div style={{ fontSize: 11, opacity: 0.6 }}>{t('chatBusyHint')}</div>}
  </div>
}

/** 侧边栏图标：纸飞机，内联绘制，插件不背图标依赖。 */
function PlaneIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" /></svg>
}

export function apply(ctx: Context): void {
  const anyCtx = ctx as any
  anyCtx.effect(() => anyCtx.locale.register(NS, { zh, en }), 'pane: dictionaries')
  const t = anyCtx.locale.bind(NS) as Translate
  // layout 是文件头 inject 里声明的必需服务，cordis 会等它就绪再执行 apply。
  const layout = anyCtx.layout
  // 先读标记：下面注册选中态监听时会做一次初始同步，那时面板还没被选中，会把标记写成 false。
  let restore = rememberedSelection()
  // main 面板注册要在 slot 声明之后才生效，所以补回选中态放在注册回调里：注册一成功就补，
  // 否则 layout.selectPanel 会因为面板还没注册而抛错。
  anyCtx.slots.inject('main', () => {
    const registration = anyCtx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
      (props: { t: Translate }) => <PanePanel t={props.t ?? t} />)
    if (restore && layout?.panelInfo?.getSnapshot().activePanelId == null) {
      restore = false
      // bundle 热更新 / 整页刷新把布局重置回会话界面：用户刚才明明在派活界面，补回来。
      try { layout.selectPanel(PANEL_ID) } catch { /* 注册尚未生效时保持现状 */ }
    }
    return registration
  })
  anyCtx.slots.inject('sidebar.panellist', () => anyCtx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), locale: NS,
  }, PlaneIcon))
  // 记住用户当前是不是停在派活界面。只有在本插件的 main 面板仍注册着时，才把选中态的消失
  // 当成用户主动离开；bundle 热更新的注销窗口里 main 注册已经消失，不能据此清标记。
  anyCtx.effect(() => {
    if (!layout?.panelInfo?.subscribe) return () => {}
    const sync = () => {
      const active = layout.panelInfo.getSnapshot().activePanelId
      if (active === PANEL_ID) rememberSelection(true)
      else if (active !== null) rememberSelection(false)
      else if (anyCtx.slots.entries('main').some((entry: any) => entry.options?.key === PANEL_ID)) rememberSelection(false)
    }
    const off = layout.panelInfo.subscribe(sync)
    sync()
    return () => { off() }
  }, 'pane: remember selected panel')
}