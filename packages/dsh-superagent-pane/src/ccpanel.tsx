/**
 * CC 执行面板：显示 worker 交给 Claude Code（cc-worker）的实况。
 *
 * 面板此前只能看到 worker 的动作，看不到 CC 在干什么、有没有报错——这是「遮遮掩掩」的根源。
 * 本组件按工单轮询 /pane/cc/<工单id>，把「第几步、在跑什么、卡了多久、报了什么错」摊开给用户，
 * 并提供中止按钮（写 interrupt 标记，cc-worker 的旁路监视会杀掉 claude）。
 */

export type CcStep = { step: number; tool?: string; detail?: string; done: boolean }

export type CcStatus = {
  present: boolean
  state: 'none' | 'running' | 'thinking' | 'done' | 'error' | 'stalled'
  log?: string
  sessionId?: string
  steps: CcStep[]
  current?: CcStep
  ageMs?: number
  at?: number
  interruptRequested: boolean
  alert: 'none' | 'warn' | 'critical'
  alertText?: string
  error?: string
}

const STATE_TEXT: Record<CcStatus['state'], string> = {
  none: '未委托',
  running: '执行中',
  thinking: '思考中',
  done: '已完成',
  error: '出错',
  stalled: '疑似卡死',
}

const STATE_COLOR: Record<CcStatus['state'], string> = {
  none: '#888',
  running: '#38a169',
  thinking: '#3182ce',
  done: '#38a169',
  error: '#e53e3e',
  stalled: '#dd6b20',
}

/** 把毫秒压成「n 秒 / n 分钟」。 */
export function formatAge(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  return `${Math.round(ms / 60_000)} 分钟`
}

type Props = {
  status: CcStatus | null
  expanded: boolean
  onToggle: () => void
  onInterrupt: () => void
  onClear: () => void
  busy: boolean
}

export function CcPanel({ status, expanded, onToggle, onInterrupt, onClear, busy }: Props) {
  if (!status || !status.present) return null
  const color = STATE_COLOR[status.state]
  const steps = status.steps ?? []
  const done = steps.filter(step => step.done).length
  const alertColor = status.alert === 'critical' ? '#e53e3e' : status.alert === 'warn' ? '#dd6b20' : undefined
  const running = status.state === 'running' || status.state === 'thinking' || status.state === 'stalled'
  return <div style={{ marginTop: 4, borderTop: '1px dashed var(--dt-border, #333)', paddingTop: 5, fontSize: 11,
    display: 'flex', flexDirection: 'column', gap: 4 }}>
    <div style={{ display: 'flex', gap: 5, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ color, fontWeight: 600 }}>● Claude Code</span>
      <span style={{ opacity: 0.8 }}>{STATE_TEXT[status.state]}</span>
      {steps.length > 0 && <span style={{ opacity: 0.6 }}>第 {done}/{steps.length} 步</span>}
      {status.ageMs !== undefined && running && <span style={{ opacity: 0.6 }}>· {formatAge(status.ageMs)}前有动作</span>}
      <button type="button" onClick={onToggle} style={{ marginLeft: 'auto', background: 'none', border: 'none', padding: 0,
        color: 'inherit', opacity: 0.65, cursor: 'pointer', textDecoration: 'underline', fontSize: 11 }}>
        {expanded ? '收起' : '展开'}
      </button>
    </div>
    {status.current && running && <div style={{ opacity: 0.85, fontFamily: 'monospace', wordBreak: 'break-all' }}>
      {status.current.tool}{status.current.detail ? `：${status.current.detail.slice(0, 120)}` : ''}
    </div>}
    {status.alertText && <div style={{ color: alertColor, fontWeight: 500 }}>⚠ {status.alertText}</div>}
    {status.error && <div style={{ color: '#e53e3e', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      maxHeight: 80, overflowY: 'auto' }}>{status.error}</div>}
    {expanded && steps.length > 0 && <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2,
      background: 'rgba(0,0,0,.25)', padding: '5px 7px', borderRadius: 4 }}>
      {steps.slice(-20).map(step => (
        <div key={step.step} style={{ display: 'flex', gap: 5, opacity: step.done ? 0.65 : 1 }}>
          <span style={{ color: step.done ? '#38a169' : '#dd6b20', minWidth: 14 }}>{step.done ? '✓' : '→'}</span>
          <span style={{ fontWeight: 500 }}>{step.tool}</span>
          <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{(step.detail ?? '').slice(0, 100)}</span>
        </div>
      ))}
    </div>}
    {running && <div>
      {status.interruptRequested
        ? <span style={{ color: '#dd6b20' }}>已请求中止，等待 cc-worker 响应…</span>
        : <button type="button" disabled={busy} onClick={onInterrupt}
            style={{ fontSize: 11, padding: '2px 8px', cursor: busy ? 'wait' : 'pointer' }}>中止执行</button>}
      {status.interruptRequested && <button type="button" disabled={busy} onClick={onClear}
        style={{ fontSize: 11, padding: '2px 8px', marginLeft: 6, cursor: busy ? 'wait' : 'pointer' }}>取消中止请求</button>}
    </div>}
  </div>
}
