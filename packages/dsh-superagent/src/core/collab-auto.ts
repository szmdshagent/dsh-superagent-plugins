/**
 * 协作 v2 的确定性自动组队：从工单文本提取写域、产物、thread 与时间信号，
 * 加权打分后用完全连接聚类决定一张新工单加入哪个自动组。
 *
 * 全部是词法规则，不调用 LLM/embedding；不读会话、不写工单。调用方（`Tickets.create`）
 * 负责在同一个 `repo.atomic` 里把结果写回工单。
 */
import { key } from './ids.ts'
import { latestReport } from './model.ts'
import type { Ticket } from './model.ts'
import { artifactPaths, domainKeys, isGenericPath } from './results.ts'

/** 自动组上限：人工组最多四张，自动组只到三张，先保守。 */
export const AUTO_GROUP_LIMIT = 3
/** 自动组存活时间；到期后由 Engine 的时钟回收。 */
export const AUTO_GROUP_TTL_MS = 2 * 60 * 60_000
/** 候选工单最近活动的窗口；更早的单不再参与自动聚类。 */
export const ACTIVITY_MS = 30 * 60_000
/** 写域 Jaccard 达到该值才计 0.40 分（报告里 ≥0.25 得到 6 组）。 */
const DOMAIN_MIN = 0.25
/** 自动成组阈值；0.15–0.30 是留给灰度 LLM 的区间，默认不动作。 */
const SCORE_THRESHOLD = 0.30
/** 灰度带下界：当前只记录信号、不成组。 */
const GRAY_LOW = 0.15
/** 标题完全相似时占 0.10；相似度从 0 线性升到该值。 */
const TITLE_FULL = 0.10
/** 标题短于该长度（去掉标点后的字符数）视为无信息，不计标题信号。 */
const TITLE_MIN_CHARS = 6
/** 时间邻近按 30 min 半衰。 */
const TIME_HALF_LIFE_MS = 30 * 60_000
/** 消费动词：下游文本出现上游产物且带这些词，才算依赖。 */
const CONSUMES = /(检查|确认|基于|汇总|写入|复用|用[^。\n]{0,8}结果|inspect|verify|confirm|based on|reuse|summari[sz]e|write|check)/i
/** 成员报告里明确说与组无关的自述；协议没有专门的字段，用报告文本作保守启发。 */
export const UNRELATED = /无关|不属于|unrelated|not related|different (?:work|task)/i

export interface CollabView {
  id: string
  title: string
  /** 计划文本：title + mandate.scope + execution.assignment，用于写域冲突检查。 */
  text: string
  /** 计划里的文件/路径，只有同时出现在两单计划里才构成写域冲突。 */
  writeScopes: string[]
  /** repo/模块/产物键，用于写域 Jaccard。 */
  domain: string[]
  /** ready 报告里的产物路径，用于识别“下游复用上游结果”。 */
  resultArtifacts: string[]
  threads: string[]
  updatedAt: string
}

export interface CandidateGroup {
  id: string
  auto: boolean
  expiresAt?: string
  /** 组内全部成员的计划视图，用于完全连接检查。 */
  members: CollabView[]
}

export interface AutoCandidate {
  view: CollabView
  group?: CandidateGroup
}

export interface PairAssessment {
  score: number
  /** `conflict` 是写域否决；`gray` 落在灰度带，默认不成组。 */
  band: 'group' | 'gray' | 'none' | 'conflict'
  signals: string[]
  domain: number
  title: number
  /** 依赖来源：显式引用工单，或“产物 + 消费动词”。 */
  dependency?: 'explicit' | 'artifact'
}

export interface AutoGroupPlan {
  group: string
  members: string[]
  expiresAt: string
  confidence: number
  signals: string[]
  /** 新工单要等待的同组成员。 */
  dependsOn: string[]
  /** 是否新建组；false 表示加入已有的自动组。 */
  created: boolean
}

const unique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))]
const normalized = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const words = (text: string): Set<string> => {
  const value = normalized(text)
  if (value.length < 2) return new Set()
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)))
}
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared++
  return shared / (a.size + b.size - shared)
}
const intersects = (a: readonly string[], b: readonly string[]): boolean => {
  const set = new Set(b)
  return a.some(value => set.has(value))
}

/**
 * 从一张工单构造自动组队视图。`threads` 由调用方从 origin triggers 解析后传入，
 * 保证模块本身不依赖仓储；报告只取最新一次 ready 报告，用于依赖识别。
 */
export function collabView(ticket: Ticket, threads: readonly string[]): CollabView {
  const plan = [ticket.title, ticket.mandate.scope, ticket.execution?.assignment ?? ''].join('\n')
  const report = latestReport(ticket)
  const summary = ticket.result ? report?.summary ?? '' : ''
  return {
    id: ticket.id,
    title: ticket.title,
    text: plan,
    // 通用裸文件名不参与写域冲突否决，否则 package.json/README.md 会挡住真正的模块级冲突判断。
    writeScopes: unique(artifactPaths(plan).filter(path => !isGenericPath(path))).slice(0, 16),
    domain: domainKeys(`${plan}\n${summary}`),
    resultArtifacts: unique(ticket.result?.artifacts ?? []).slice(0, 16),
    threads: unique([...threads]),
    updatedAt: ticket.updatedAt,
  }
}

/** 显式引用：工单 id、id 前缀，或足够长的标题。 */
function references(view: CollabView, other: CollabView): boolean {
  const text = view.text.toLowerCase()
  if (text.includes(other.id.toLowerCase()) || text.includes(other.id.toLowerCase().slice(0, 8))) return true
  const title = normalized(other.title)
  return title.length >= TITLE_MIN_CHARS && normalized(view.text).includes(title)
}

/** 产物依赖：下游文本提到上游 ready 报告的产物，并带有消费动词。 */
function consumes(view: CollabView): boolean {
  return CONSUMES.test(view.text)
}

/** 上游产物里能证明依赖的具体路径；通用裸文件名（package.json、README.md 等）不算。 */
const reusableArtifacts = (other: CollabView): string[] => other.resultArtifacts.filter(path => !isGenericPath(path))

function dependency(view: CollabView, other: CollabView): 'explicit' | 'artifact' | undefined {
  if (references(view, other)) return 'explicit'
  const text = view.text.toLowerCase()
  return reusableArtifacts(other).some(path => text.includes(path.toLowerCase())) && consumes(view) ? 'artifact' : undefined
}

/** 候选相关性预筛：同 thread、有共同写域键、显式引用或提到上游的具体产物。 */
function related(view: CollabView, other: CollabView): boolean {
  return intersects(view.threads, other.threads) || intersects(view.domain, other.domain) || references(view, other)
    || reusableArtifacts(other).some(path => view.text.toLowerCase().includes(path.toLowerCase()))
}

const round = (value: number): number => Math.round(value * 1_000) / 1_000

/**
 * 对两张工单打分。写域冲突是否决项；但真实的依赖引用（显式引用或产物 + 消费动词）
 * 优先于冲突，因为下游是读上游结果，不一定写同一文件，`dependsOn` 会记录等待关系。
 */
export function assessPair(view: CollabView, other: CollabView, now: string): PairAssessment {
  const dep = dependency(view, other)
  const domain = jaccard(new Set(view.domain), new Set(other.domain))
  const title = (normalized(view.title).length >= TITLE_MIN_CHARS && normalized(other.title).length >= TITLE_MIN_CHARS)
    ? jaccard(words(view.title), words(other.title)) : 0
  const age = Date.parse(now) - Date.parse(other.updatedAt)
  const time = Number.isFinite(age) && age >= 0 ? 0.10 * 0.5 ** (age / TIME_HALF_LIFE_MS) : 0
  const sharedThread = intersects(view.threads, other.threads)
  const conflict = intersects(view.writeScopes, other.writeScopes) && !dep
  // 至少一个强证据才允许成组：显式依赖，或真实路径/目录级写域 Jaccard 达标。
  // 仅标题相似 + 时间邻近 + 同 thread 最多 0.30 分，绝不成组，只落灰度带。
  const strong = !!dep || domain >= DOMAIN_MIN
  const signals: string[] = []
  if (domain >= DOMAIN_MIN) signals.push('domain')
  if (dep) signals.push('dependency')
  if (sharedThread) signals.push('thread')
  if (title > 0) signals.push('title')
  if (time > 0) signals.push('time')
  const score = round((domain >= DOMAIN_MIN ? 0.40 : 0) + (dep ? 0.30 : 0) + (sharedThread ? 0.10 : 0)
    + 0.10 * Math.min(1, title / TITLE_FULL) + time)
  const band: PairAssessment['band'] = conflict ? 'conflict' : strong && score >= SCORE_THRESHOLD ? 'group'
    : score >= GRAY_LOW ? 'gray' : 'none'
  return { score, band, signals, domain, title, ...(dep ? { dependency: dep } : {}) }
}

/** 只在最近 30 min 内有活动的 open 工单进入候选。 */
function recent(view: CollabView, now: string): boolean {
  const age = Date.parse(now) - Date.parse(view.updatedAt)
  return Number.isFinite(age) && age >= 0 && age <= ACTIVITY_MS
}

/**
 * 为一组与 `view` 相关的候选生成计划：
 * 1. 优先加入已有的自动组，要求与组内**所有人**都达到成组阈值（完全连接），且组未满三张；
 * 2. 否则与一张无组的相关工单新建自动组；
 * 3. 人工组永不参与自动合并；灰度带只返回分数，不成组。
 * 选择是确定性的：分数高者优先，同分按 id 排序。
 */
export function planAutoGroup(view: CollabView, candidates: readonly AutoCandidate[], now: string): AutoGroupPlan | undefined {
  const eligible = candidates.filter(candidate => recent(candidate.view, now) && related(view, candidate.view)
    && (!candidate.group || candidate.group.auto))
  // 已有自动组：逐成员检查完全连接，取最弱一条边作为置信度。
  const joins = new Map<string, { group: CandidateGroup; members: CollabView[]; pairs: PairAssessment[] }>()
  for (const candidate of eligible) {
    const group = candidate.group
    if (!group?.auto || group.members.length >= AUTO_GROUP_LIMIT) continue
    const pairs = group.members.map(member => assessPair(view, member, now))
    if (pairs.some(pair => pair.band !== 'group')) continue
    const weakest = Math.min(...pairs.map(pair => pair.score))
    const current = joins.get(group.id)
    const groupMembers = [...group.members]
    if (!current || weakest > Math.min(...current.pairs.map(pair => pair.score))) joins.set(group.id, { group, members: groupMembers, pairs })
  }
  const join = [...joins.values()].sort((a, b) =>
    Math.min(...b.pairs.map(pair => pair.score)) - Math.min(...a.pairs.map(pair => pair.score)) || a.group.id.localeCompare(b.group.id)).at(0)
  if (join) {
    const dependsOn = join.members.filter(member => assessPair(view, member, now).dependency).map(member => member.id)
    return { group: join.group.id, members: [...join.members.map(member => member.id), view.id],
      expiresAt: join.group.expiresAt ?? new Date(Date.parse(now) + AUTO_GROUP_TTL_MS).toISOString(),
      confidence: round(Math.min(...join.pairs.map(pair => pair.score))),
      signals: unique(join.pairs.flatMap(pair => pair.signals)), dependsOn, created: false }
  }
  // 无组的相关工单：取最强的一对新建组。
  const partners = eligible.filter(candidate => !candidate.group)
    .map(candidate => ({ candidate, pair: assessPair(view, candidate.view, now) }))
    .filter(item => item.pair.band === 'group')
    .sort((a, b) => b.pair.score - a.pair.score || a.candidate.view.id.localeCompare(b.candidate.view.id))
  const partner = partners[0]
  if (!partner) return undefined
  return { group: `auto-${key('collab-auto', partner.candidate.view.id).slice(0, 12)}`,
    members: [partner.candidate.view.id, view.id], expiresAt: new Date(Date.parse(now) + AUTO_GROUP_TTL_MS).toISOString(),
    confidence: partner.pair.score, signals: partner.pair.signals,
    dependsOn: partner.pair.dependency ? [partner.candidate.view.id] : [], created: true }
}