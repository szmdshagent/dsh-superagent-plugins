/**
 * 定时派活的纯数据层：类型、存储键与「下一次触发」计算。
 *
 * 不依赖 Node 或 React，服务端（index.ts）与浏览器端（client.tsx 只取类型）共用，
 * 避免两边的频率语义、存储前缀各自漂移。时间一律按**宿主机本地时间**解释：
 * 面板与 dsh 通常在同一台机器上，用户看到的 09:00 就是服务端的 09:00。
 */

/** 一条定时任务的频率。 */
export type ScheduleSpec =
  | { kind: 'every'; everyMinutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }
  | { kind: 'at'; at: string }

/** 落盘的定时任务记录。`nextAtMs` 是绝对毫秒，服务重启后照样能判断是否到点。 */
export type PaneSchedule = {
  id: string
  conversation: string
  text: string
  mode: 'dispatch' | 'chat' | 'broadcast' | 'assign' | 'note'
  spec: ScheduleSpec
  enabled: boolean
  createdAt: string
  nextAtMs: number
  lastAt?: string
  lastResult?: string
}

/** KV 前缀：与面板日志的 `pane-log:` 并列，互不干扰。 */
export const SCHEDULE_PREFIX = 'pane-sched:'

/** 外部插件用普通字符串键即可（kv.ts 明确支持）。 */
export const scheduleKey = (id: string) => `${SCHEDULE_PREFIX}${id}` as any

const MINUTE = 60_000
const DAY = 86_400_000

/** 解析 HH:mm；非法返回 undefined。 */
function parseTime(time: string): { hour: number; minute: number } | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!match) return undefined
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

/** 本地某天的零点毫秒，向后偏移 offsetDays 天。 */
function localDayStart(ms: number, offsetDays = 0): number {
  const date = new Date(ms)
  date.setDate(date.getDate() + offsetDays)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 某天零点的本地 HH:mm 对应的时间戳。 */
function localAt(dayStartMs: number, hour: number, minute: number): number {
  const date = new Date(dayStartMs)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

/**
 * 从 fromMs 起算的下一次触发时间。
 *
 * - `every`：from + N 分钟；
 * - `daily`：今天的时间还没到就是今天，否则明天；
 * - `weekly`：向后最多找 7 天，命中第一个选中的星期；
 * - `at`：一次性时间原样返回；调用方判断是否已过期。
 */
export function nextOccurrence(spec: ScheduleSpec, fromMs: number): number {
  const from = Math.max(0, Math.floor(fromMs))
  switch (spec.kind) {
    case 'every':
      return from + Math.max(1, Math.floor(spec.everyMinutes)) * MINUTE
    case 'daily': {
      const time = parseTime(spec.time)
      if (!time) return from + DAY
      const today = localAt(localDayStart(from), time.hour, time.minute)
      return today > from ? today : localAt(localDayStart(from, 1), time.hour, time.minute)
    }
    case 'weekly': {
      const time = parseTime(spec.time)
      if (!time) return from + 7 * DAY
      const days = [...new Set(spec.weekdays.map(day => Math.min(7, Math.max(1, Math.floor(day)))))].sort((a, b) => a - b)
      // 本地星期：getDay() 里 0 是周日，ISO 是 1..7。
      const todayIso = new Date(from).getDay() || 7
      for (let offset = 0; offset <= 7; offset += 1) {
        const iso = ((todayIso - 1 + offset) % 7) + 1
        if (!days.includes(iso)) continue
        const when = localAt(localDayStart(from, offset), time.hour, time.minute)
        if (when > from) return when
      }
      return from + 7 * DAY
    }
    case 'at': {
      const when = Date.parse(spec.at)
      return Number.isFinite(when) ? when : from
    }
  }
}
