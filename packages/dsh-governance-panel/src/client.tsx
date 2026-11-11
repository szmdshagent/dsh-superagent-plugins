/**
 * 执行治理面板（浏览器侧）：侧边栏一个「治理」图标，点开是一页只读看板。
 *
 * 刻意做成完全独立的插件：自己的图标、自己的面板、自己的路由，不引 pane 插件也不引 superagent。
 * 卸载本包后，superagent 与派活面板行为不变。
 */
import { useCallback, useEffect, useState } from 'react'

/** 宿主 Cordis 上下文：只用到 slots / locale 两个服务。 */
type Context = any

export const inject = ['slots', 'locale']

const NS = 'dshGovernancePanel'
const PANEL_ID = 'dsh-governance-panel'
const API = '/api/governance'

type DimensionKey = 'team' | 'handoff' | 'executor' | 'budget' | 'cost' | 'context' | 'liveness'
type Severity = 'critical' | 'warn' | 'info'
type LaneStatus = 'pending' | 'running' | 'done' | 'failed' | 'unknown'

type Finding = {
  dimension: DimensionKey
  severity: Severity
  id: string
  title: string
  detail?: string
  ticket?: string
  metrics?: Record<string, number | string | null>
  evidence?: string
  at?: string
}

type DimensionSummary = {
  key: DimensionKey
  issues: number
  critical: number
  warn: number
  metrics: Record<string, number | string | null>
  verdict: 'ok' | 'watch' | 'bad' | 'unknown'
}

type Trend = { day: string; cost: number; runs: number }[]
type Weekly = { path: string; updated: string | null; text: string; generated: boolean } | null

type LaneExecution = {
  ticket: string
  lane: string
  role: 'lead' | 'worker' | 'other'
  task: string | null
  status: LaneStatus
  runs: number
  steps: number
  turns: number
  tokens: { input: number; cacheRead: number; output: number; total: number }
  costUsd: number
  handoffSwitches: number
  durationMs: number | null
}

type TeamTicketSummary = {
  ticket: string
  workerLanes: number
  done: number
  failed: number
  running: number
  pending: number
  unknown: number
  totalCostUsd: number
  totalRuns: number
  totalTokens: number
  configuredParallelism: number
  peakParallelism: number
  currentParallelism: number
  durationMs: number | null
  lanes: LaneExecution[]
}

type TeamReport = {
  present: boolean
  tickets: number
  workerLanes: number
  done: number
  failed: number
  running: number
  pending: number
  unknown: number
  totalCostUsd: number
  totalRuns: number
  totalTokens: number
  peakParallelism: number
  teams: TeamTicketSummary[]
}

type ConflictReport = {
  present: boolean
  conflictPaths: number
  findingsFiles: number
  blockedFindings: number
  tickets: string[]
}

type Report = {
  generatedAt: string
  overall: 'ok' | 'watch' | 'bad'
  headline: string
  dimensions: DimensionSummary[]
  findings: Finding[]
  lanes?: LaneExecution[]
  team?: TeamReport
  conflicts?: ConflictReport
  scanned: { tickets: number; withWorkerDir: number; withHandoffState: number; ledgerRuns: number; laneUnits?: number; teamTickets?: number }
  weekly?: Weekly
  trend?: Trend | null
}

const DIM_LABEL: Record<DimensionKey, string> = {
  team: '团队协作',
  handoff: '交接闭环',
  executor: '执行器',
  budget: '预算纪律',
  cost: '成本',
  context: '上下文',
  liveness: '活性',
}
const DIM_ORDER: DimensionKey[] = ['team', 'handoff', 'executor', 'budget', 'cost', 'context', 'liveness']

const LANE_STATUS_TEXT: Record<LaneStatus, string> = {
  pending: '未启动', running: '进行中', done: '完成', failed: '失败', unknown: '未知',
}
const LANE_STATUS_COLOR: Record<LaneStatus, string> = {
  pending: '#888', running: '#3182ce', done: '#38a169', failed: '#e53e3e', unknown: '#d69e2e',
}

/** 时长格式：秒级以内保留一位小数，分钟级给 mm:ss。 */
function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '—'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds % 60)}s`
}

const SEV_COLOR: Record<Severity, string> = { critical: '#e53e3e', warn: '#d69e2e', info: '#718096' }
const SEV_TEXT: Record<Severity, string> = { critical: '严重', warn: '注意', info: '提示' }
const VERDICT_COLOR: Record<DimensionSummary['verdict'], string> = {
  ok: '#38a169', watch: '#d69e2e', bad: '#e53e3e', unknown: '#888',
}
const VERDICT_TEXT: Record<DimensionSummary['verdict'], string> = {
  ok: '正常', watch: '观察', bad: '有问题', unknown: '无数据',
}

const zh = {
  panel: '治理',
  title: '执行治理',
  refresh: '刷新',
  refreshing: '刷新中…',
  loading: '扫描中…',
  empty: '最近 7 天没有任何治理数据。',
  allOk: '七个维度全部正常，没有发现需要处理的问题。',
  scanned: '扫描',
  tickets: '个工单',
  runs: '轮台账',
  weeklyOpen: '治理周报 ▸',
  weeklyClose: '治理周报 ▾',
  weeklyNone: '还没有周报',
  weeklyBusy: '正在生成周报…',
  trendOpen: '成本趋势 ▸',
  trendClose: '成本趋势 ▾',
  trendDay: '日',
  trendCost: '成本',
  trendRuns: '轮数',
  metrics: '指标',
  evidence: '原始证据',
  details: '详情',
  collapse: '收起',
  spread: '展开',
  countSuffix: ' 项',
  severities: '严重/注意/提示',
}

const en = {
  panel: 'Governance',
  title: 'Execution governance',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  loading: 'Scanning…',
  empty: 'No governance data in the last 7 days.',
  allOk: 'All seven dimensions are healthy.',
  scanned: 'Scanned',
  tickets: 'tickets',
  runs: 'ledger runs',
  weeklyOpen: 'Weekly report ▸',
  weeklyClose: 'Weekly report ▾',
  weeklyNone: 'No report yet',
  weeklyBusy: 'Generating…',
  trendOpen: 'Cost trend ▸',
  trendClose: 'Cost trend ▾',
  trendDay: 'day',
  trendCost: 'cost',
  trendRuns: 'runs',
  metrics: 'Metrics',
  evidence: 'Evidence',
  details: 'Details',
  collapse: 'Collapse',
  spread: 'Expand',
  countSuffix: ' issues',
  severities: 'critical/warn/info',
}

type Dict = typeof zh
type Translate = (key: keyof Dict) => string

type LocaleLike = {
  register(ns: string, dicts: Record<string, Dict>): unknown
  bind(ns: string): Translate
}

/** 与宿主其它插件一致的取数方式：令牌随页面 URL 而来。 */
async function fetchReport(params: Record<string, string>): Promise<Report> {
  const query = new URLSearchParams(params)
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  if (token) query.set('token', token)
  const response = await fetch(`${API}?${query.toString()}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as Report
}

/** 工单目录名去掉末位哈希，当标题用。 */
function prettyName(name: string): string {
  // lane 执行单元的 key 形如 `<工单名>#w1`：先拆出 lane，再去掉工单名末尾的哈希。
  const [base, lane] = name.split('#')
  const title = base.replace(/-[0-9a-f]{12}$/, '') || base
  return lane ? `${title} · lane ${lane}` : title
}

/** 指标值格式化：金额保留两位，大数用千分位。 */
function formatMetric(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (Number.isInteger(value)) return value.toLocaleString('en-US')
  return value.toFixed(4)
}

function GovernanceIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6l-8-3Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
}

/** 一条发现：默认两行摘要，点开看指标与证据。 */
function FindingRow({ finding, t }: { finding: Finding; t: Translate }) {
  const [open, setOpen] = useState(false)
  const [showEvidence, setShowEvidence] = useState(false)
  const color = SEV_COLOR[finding.severity]
  const metrics = Object.entries(finding.metrics ?? {})
  return <div data-gov-finding={finding.id}
    style={{ border: '1px solid var(--dt-border,#333)', borderRadius: 6, borderLeft: `3px solid ${color}`,
      padding: '6px 9px', display: 'flex', flexDirection: 'column', gap: 4 }}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
      <span style={{ color, fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{SEV_TEXT[finding.severity]}</span>
      <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }}>{DIM_LABEL[finding.dimension]}</span>
      <span style={{ fontSize: 12, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', flex: '1 1 0' }} title={finding.title}>{finding.title}</span>
      {(metrics.length > 0 || finding.detail) &&
        <button type="button" onClick={() => setOpen(value => !value)}
          style={{ flexShrink: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'inherit', opacity: 0.6, textDecoration: 'underline', fontSize: 11 }}>
          {open ? t('collapse') : t('details')}
        </button>}
    </div>
    {finding.ticket && <div style={{ fontSize: 11, opacity: 0.55, fontFamily: 'monospace' }}>
      {prettyName(finding.ticket)}
    </div>}
    {open && <>
      {finding.detail && <div style={{ fontSize: 11, opacity: 0.8, lineHeight: 1.5 }}>{finding.detail}</div>}
      {metrics.length > 0 && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, opacity: 0.75 }}>
        {metrics.map(([key, value]) => <span key={key}><span style={{ opacity: 0.6 }}>{key}</span> {formatMetric(value)}</span>)}
      </div>}
      {finding.evidence && <div>
        <button type="button" onClick={() => setShowEvidence(value => !value)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit',
            opacity: 0.55, textDecoration: 'underline', fontSize: 11 }}>
          {showEvidence ? t('collapse') : t('evidence')}
        </button>
        {showEvidence && <pre style={{ margin: '4px 0 0', padding: 6, fontSize: 10, maxHeight: 160, overflow: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(0,0,0,.25)', borderRadius: 4 }}>{finding.evidence}</pre>}
      </div>}
    </>}
  </div>
}

/** 单个维度卡片：顶部是维度名与判定，下面是这个维度的发现。 */
function DimensionCard({ dimension, findings, t }: { dimension: DimensionSummary; findings: Finding[]; t: Translate }) {
  const [open, setOpen] = useState(dimension.critical > 0 || dimension.warn > 0)
  const color = VERDICT_COLOR[dimension.verdict]
  const metrics = Object.entries(dimension.metrics)
  return <div data-gov-dim={dimension.key}
    style={{ border: '1px solid var(--dt-border,#333)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
    <div onClick={() => setOpen(value => !value)}
      style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '6px 9px', cursor: 'pointer',
        background: 'rgba(255,255,255,.03)', flexWrap: 'wrap' }}>
      <span style={{ opacity: 0.5, fontSize: 10 }}>{open ? '▾' : '▸'}</span>
      <span style={{ color, fontSize: 10, fontWeight: 700 }}>●</span>
      <strong style={{ fontSize: 12 }}>{DIM_LABEL[dimension.key]}</strong>
      <span style={{ color, fontSize: 11 }}>{VERDICT_TEXT[dimension.verdict]}</span>
      {dimension.issues > 0 && <span style={{ fontSize: 11, opacity: 0.7 }}>
        {dimension.critical > 0 && <span style={{ color: SEV_COLOR.critical }}>严重 {dimension.critical} </span>}
        {dimension.warn > 0 && <span style={{ color: SEV_COLOR.warn }}>注意 {dimension.warn}</span>}
      </span>}
    </div>
    {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 9px' }}>
      {metrics.length > 0 && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, opacity: 0.7 }}>
        {metrics.map(([key, value]) => <span key={key}><span style={{ opacity: 0.6 }}>{key}</span> {formatMetric(value)}</span>)}
      </div>}
      {findings.length === 0 && <div style={{ fontSize: 11, opacity: 0.5 }}>{t('allOk')}</div>}
      {findings.map(finding => <FindingRow key={finding.id} finding={finding} t={t} />)}
    </div>}
  </div>
}

/** team 计划与各 lane 的执行情况；没有 team 时整块不渲染。 */
function TeamCard({ team, conflicts }: { team: TeamReport; conflicts?: ConflictReport }) {
  if (!team.present) return null
  return <div data-gov-team style={{ border: '1px solid var(--dt-border,#333)', borderRadius: 8,
    padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <strong style={{ fontSize: 12 }}>团队协作</strong>
      <span style={{ fontSize: 11, opacity: 0.75 }}>
        计划 {team.workerLanes} 路 · 完成 {team.done} · 失败 {team.failed} · 进行中 {team.running} · 未启动 {team.pending}
      </span>
      <span style={{ fontSize: 11, opacity: 0.6, marginLeft: 'auto' }}>
        成本 ${team.totalCostUsd.toFixed(4)} · token {team.totalTokens.toLocaleString('en-US')}
        {' · '}峰值并行 {team.peakParallelism}
      </span>
    </div>
    {conflicts?.present && <div style={{ fontSize: 11, opacity: 0.65 }}>
      共享区：findings {conflicts.findingsFiles} 份
      {conflicts.blockedFindings > 0 && <span style={{ color: SEV_COLOR.warn }}>（BLOCKED {conflicts.blockedFindings}）</span>}
      {' · '}冲突路径 {conflicts.conflictPaths}
    </div>}
    {team.teams.map(summary => <div key={summary.ticket} style={{ display: 'flex', flexDirection: 'column', gap: 3,
      borderTop: '1px solid var(--dt-border,#333)', paddingTop: 5 }}>
      <div style={{ fontSize: 11, opacity: 0.7, fontFamily: 'monospace' }}>{prettyName(summary.ticket)}</div>
      {summary.lanes.map(lane => <div key={`${summary.ticket}#${lane.lane}`}
        data-gov-lane={`${summary.ticket}#${lane.lane}`}
        style={{ display: 'flex', gap: 7, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 11 }}>
        <span style={{ color: LANE_STATUS_COLOR[lane.status], fontWeight: 700, flexShrink: 0 }}>
          ● {LANE_STATUS_TEXT[lane.status]}
        </span>
        <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>{lane.lane}</span>
        <span style={{ opacity: 0.5, flexShrink: 0 }}>{lane.role === 'lead' ? '统筹' : lane.role === 'worker' ? '子任务' : 'lane'}</span>
        {lane.task && <span title={lane.task} style={{ opacity: 0.75, minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 160px' }}>{lane.task}</span>}
        <span style={{ opacity: 0.55, flexShrink: 0 }}>
          {lane.runs} 轮 · {lane.steps} 步 · ${lane.costUsd.toFixed(4)} · {formatDuration(lane.durationMs)}
          {lane.handoffSwitches > 0 && <> · 换会话 {lane.handoffSwitches}</>}
        </span>
      </div>)}
    </div>)}
  </div>
}

function GovernancePanel({ t }: { t: Translate }) {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [weekly, setWeekly] = useState<Weekly>(null)
  const [weeklyOpen, setWeeklyOpen] = useState(false)
  const [weeklyBusy, setWeeklyBusy] = useState(false)
  const [trend, setTrend] = useState<Trend | null>(null)
  const [trendOpen, setTrendOpen] = useState(false)

  /** 常规扫描：六个维度一次算完。 */
  const load = useCallback(async () => {
    setBusy(true)
    try {
      const next = await fetchReport({})
      setReport(next)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  /** 周报与趋势都按需拉，避免每次进页面都跑脚本。 */
  const loadWeekly = useCallback(async () => {
    setWeeklyBusy(true)
    try { setWeekly((await fetchReport({ weekly: '1' })).weekly ?? null) }
    catch { /* 失败保持原状 */ } finally { setWeeklyBusy(false) }
  }, [])

  const loadTrend = useCallback(async () => {
    try { setTrend((await fetchReport({ trend: '1' })).trend ?? []) } catch { setTrend([]) }
  }, [])

  const findings = report?.findings ?? []
  const byDimension = (key: DimensionKey) => findings.filter(item => item.dimension === key)
  const totalCritical = findings.filter(item => item.severity === 'critical').length
  const totalWarn = findings.filter(item => item.severity === 'warn').length
  const overallColor = report?.overall === 'bad' ? SEV_COLOR.critical : report?.overall === 'watch' ? SEV_COLOR.warn : '#38a169'

  // 宿主不定义 --dt-* 变量，且面板整条祖先链都是透明的；若跟随壁纸皮肤，正文会直接压在
  // 壁纸大图上（亮部把浅色文字冲掉，看起来像空白）。这里必须自己给一层不透底背景。
  return <div data-gov-panel style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8,
    padding: '10px 12px', fontSize: 12, overflowY: 'auto',
    background: 'var(--dt-panel-bg, #0b0f1a)', color: 'var(--dt-text, #e5eaf6)' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
      <strong style={{ fontSize: 14 }}>{t('title')}</strong>
      <button type="button" disabled={busy} onClick={() => { setWeekly(null); setWeeklyOpen(false); void load() }}
        style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? t('refreshing') : t('refresh')}
      </button>
    </div>

    {!report && !error && <div style={{ opacity: 0.6 }}>{t('loading')}</div>}
    {error && <div style={{ color: SEV_COLOR.critical, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{error}</div>}

    {report && <>
      {/* 总判定 + 三个数字：严重 / 注意 / 提示。 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', flexShrink: 0 }}>
        <span style={{ color: overallColor, fontWeight: 700 }}>● {report.headline}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 11, opacity: 0.7, flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ color: totalCritical > 0 ? SEV_COLOR.critical : undefined }}>严重 {totalCritical}</span>
        <span style={{ color: totalWarn > 0 ? SEV_COLOR.warn : undefined }}>注意 {totalWarn}</span>
        <span>提示 {findings.filter(item => item.severity === 'info').length}</span>
        <span style={{ marginLeft: 'auto' }}>{t('scanned')} {report.scanned.tickets} {t('tickets')}
          {(report.scanned.laneUnits ?? 0) > 0 && <> / {report.scanned.laneUnits} lane</>}
          {(report.scanned.teamTickets ?? 0) > 0 && <> / {report.scanned.teamTickets} team</>}
          {' / '}{report.scanned.ledgerRuns} {t('runs')}</span>
      </div>

      {/* team 计划单独一块：按 lane 展示完成/失败，比维度卡片更直观。 */}
      {report.team?.present && <TeamCard team={report.team} conflicts={report.conflicts} />}

      {/* 七个维度卡片，固定顺序，未展开时也能看到判定色。 */}
      {report.dimensions.length > 0 && DIM_ORDER.filter(key => report.dimensions.some(item => item.key === key))
        .map(key => {
          const dimension = report.dimensions.find(item => item.key === key)!
          return <DimensionCard key={key} dimension={dimension} findings={byDimension(key)} t={t} />
        })}

      {findings.length === 0 && <div style={{ opacity: 0.6 }}>{t('allOk')}</div>}
    </>}

    {/* 成本趋势：默认不拉，点开才请求。 */}
    <div style={{ flexShrink: 0 }}>
      <button type="button" data-gov-trend onClick={() => {
        const next = !trendOpen
        setTrendOpen(next)
        if (next && trend === null) void loadTrend()
      }} style={{ background: 'none', border: '1px solid var(--dt-border,#333)', borderRadius: 4, cursor: 'pointer',
        padding: '2px 8px', fontSize: 11, color: 'inherit', opacity: 0.85 }}>
        {trendOpen ? t('trendClose') : t('trendOpen')}
      </button>
      {trendOpen && <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6, fontSize: 11 }}>
        {(trend ?? []).map(row => {
          const max = Math.max(...(trend ?? []).map(item => item.cost), 0.0001)
          const width = Math.max(2, Math.round((row.cost / max) * 100))
          return <div key={row.day} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontFamily: 'monospace', opacity: 0.6, minWidth: 78 }}>{row.day}</span>
            <div style={{ flex: '1 1 0', background: 'rgba(255,255,255,.06)', borderRadius: 2, height: 12 }}>
              <div style={{ width: `${width}%`, height: '100%', background: '#3182ce', borderRadius: 2 }} />
            </div>
            <span style={{ minWidth: 78, textAlign: 'right' }}>${row.cost.toFixed(3)}</span>
            <span style={{ minWidth: 42, opacity: 0.55, textAlign: 'right' }}>{row.runs} {t('trendRuns')}</span>
          </div>
        })}
        {trend !== null && trend.length === 0 && <div style={{ opacity: 0.55 }}>—</div>}
      </div>}
    </div>

    {/* 治理周报：点开才生成/读取。 */}
    <div style={{ flexShrink: 0 }}>
      <button type="button" data-gov-weekly onClick={() => {
        const next = !weeklyOpen
        setWeeklyOpen(next)
        if (next && !weekly) void loadWeekly()
      }} style={{ background: 'none', border: '1px solid var(--dt-border,#333)', borderRadius: 4, cursor: 'pointer',
        padding: '2px 8px', fontSize: 11, color: 'inherit', opacity: 0.85 }}>
        {weeklyOpen ? t('weeklyClose') : t('weeklyOpen')}
      </button>
      {weeklyOpen && weeklyBusy && <div style={{ opacity: 0.6, marginTop: 6 }}>{t('weeklyBusy')}</div>}
      {weeklyOpen && !weeklyBusy && !weekly && <div style={{ opacity: 0.6, marginTop: 6 }}>{t('weeklyNone')}</div>}
      {weeklyOpen && !weeklyBusy && weekly && <pre style={{ margin: '6px 0 0', padding: 8, fontSize: 10, maxHeight: 340,
        overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'var(--dt-surface, rgba(255,255,255,.04))', borderRadius: 4 }}>{weekly.text}</pre>}
    </div>
  </div>
}

export function apply(ctx: Context): void {
  const anyCtx = ctx
  anyCtx.effect(() => (anyCtx.locale as LocaleLike).register(NS, { zh, en }), 'governance-panel: dictionaries')
  // 治理文案由服务端生成，全部是中文；前端若跟随宿主语言（默认英文）会中英混排。
  // 所以本面板固定用中文词典，保证「维度名 + 结论 + 说明」同一种语言。
  const t: Translate = key => zh[key] ?? String(key)
  anyCtx.slots.inject('main', () => anyCtx.slots.register(
    { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    () => <GovernancePanel t={t} />,
  ))
  // order 30 排在「派活」(20) 之后，两者互不相干。
  anyCtx.slots.inject('sidebar.panellist', () => anyCtx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => zh.panel, locale: NS,
  }, GovernanceIcon))
}
