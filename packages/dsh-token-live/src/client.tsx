/**
 * dsh-token-live —— 浏览器半。
 *
 * 在 composer dock 里加一枚「今日累计 + 实时速度」小条：每 2 秒打一次
 * POST /api/usage/query（由 dsh-plugin-usage 提供），用相邻两次的
 * totalTokens 差值 / 秒数算 tok/s。
 *
 * 约定：
 * - slot 不存在、路由不可用、数据格式不对 → 不渲染、不抛错（dock 常驻，不能刷屏）。
 * - 首次只显示累计，没有速率。
 */
import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['slots', 'locale']

const NS = 'token-live'
const SLOT = 'conversation.composer.dock'
const REFRESH_MS = 2000

const zh = {
  label: '今日',
  title: '今日 {tokens} tokens · {calls} 次调用{rate}',
  rate: ' · {rate} tok/s',
}
const en = {
  label: 'Today',
  title: '{tokens} tokens today · {calls} calls{rate}',
  rate: ' · {rate} tok/s',
}

type Translate = (key: string, params?: Record<string, unknown>) => string

/** 今天 00:00（本地时区）的毫秒时间戳。 */
function startOfDay(now: Date): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 数值格式化：>=1e8 用「亿」；英文环境用 M/B。 */
function formatTokens(n: number, isZh: boolean): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (isZh) {
    if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿'
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万'
    return String(Math.round(n))
  }
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(Math.round(n))
}

function formatRate(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (n >= 100) return String(Math.round(n))
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, '')
  return n.toFixed(2).replace(/\.?0+$/, '') || '0'
}

type Snapshot = { tokens: number; calls: number; at: number }
type State =
  | { status: 'idle' }
  | { status: 'ready'; tokens: number; calls: number; rate: number | null }

async function queryUsage(now: number): Promise<{ tokens: number; calls: number } | null> {
  try {
    const res = await fetch('/api/usage/query', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: startOfDay(new Date(now)), to: now, fill: false, granularity: 'day' }),
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

function LivePill(props: { t?: Translate }) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const prev = useRef<Snapshot | null>(null)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      const startedAt = Date.now()
      const data = await queryUsage(startedAt)
      if (!alive) return
      if (data === null) {
        // 不显示、不抛错；下一轮继续。
        setState((s) => (s.status === 'ready' ? s : { status: 'idle' }))
      } else {
        const last = prev.current
        let rate: number | null = null
        if (last !== null) {
          const dt = (startedAt - last.at) / 1000
          const delta = data.tokens - last.tokens
          if (dt > 0 && delta >= 0) rate = delta / dt
        }
        prev.current = { tokens: data.tokens, calls: data.calls, at: startedAt }
        setState({ status: 'ready', tokens: data.tokens, calls: data.calls, rate })
      }
      if (alive) timer = setTimeout(tick, REFRESH_MS)
    }

    tick()
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        if (timer !== null) clearTimeout(timer)
        tick()
      }
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (state.status !== 'ready') return null

  const tr = props.t ?? ((k: string) => k)
  // 用 locale 文案本身判断语言，只影响数字单位（亿/万 vs B/M/K）。
  const isZh = tr('label') === zh.label
  const tokensText = formatTokens(state.tokens, isZh)
  const rateText = state.rate === null ? '' : formatRate(state.rate)
  const title = tr('title', {
    tokens: state.tokens.toLocaleString(),
    calls: state.calls.toLocaleString(),
    rate: state.rate === null ? '' : tr('rate', { rate: rateText }),
  })

  return (
    <span className="tl-dock" title={title} data-token-live="1">
      <span className="tl-dock-label">{tr('label')}</span>
      <span className="tl-dock-tokens">{tokensText}</span>
      {state.rate !== null && <span className="tl-dock-rate"> · {rateText} tok/s</span>}
    </span>
  )
}

export function apply(ctx: Context): void {
  const anyCtx = ctx as any
  anyCtx.effect(() => anyCtx.locale.register(NS, { zh, en }), 'token-live: dictionaries')
  const t = anyCtx.locale.bind(NS) as Translate

  // slot 不存在（旧宿主）只告警，不影响其它插件。
  try {
    anyCtx.slots.inject(SLOT, () =>
      anyCtx.slots.register(
        { name: SLOT, id: 'token-live', order: 3, locale: NS },
        (props: { t?: Translate }) => <LivePill t={props?.t ?? t} />,
      ),
    )
  } catch (e) {
    console.warn('[token-live] composer dock slot unavailable', e)
  }
}
