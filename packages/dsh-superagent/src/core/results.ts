/**
 * L1 结果卡：工单 ready 时把报告截成一张不超过 300 token 的只读卡片，按 repo/模块/产物路径索引，
 * 供同域新工单在首次 assignment 里直接复用，不新建会话、不额外唤醒、不调用 LLM。
 */
import type { ResultCard, Ticket } from './model.ts'

/** 每张卡的展示字符上限，按中文约 1 token/字符留出余量，保证卡片本身不超过 300 token。 */
const CONCLUSION_CHARS = 140
const TITLE_CHARS = 80
const ARTIFACTS = 4
const NUMBERS = 4
const ARTIFACT_CHARS = 80
const KEY_CHARS = 120
/** 结果卡注入时最多带 3 张，避免把新工单的首次上下文撑大。 */
export const RESULT_CARDS = 3
/** 生成索引时最多保留的键数；键只用于确定性匹配，不进入投递文本。 */
const KEYS = 16

/** 像仓库内文件路径的片段，必须带扩展名，避免把普通句子里的斜杠词当成产物。 */
const PATH = /(?:\.{0,2}\/)?(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]+\.[A-Za-z0-9]{1,10}\b/g
/** 不带目录的产物文件名。 */
const FILE = /\b[A-Za-z0-9_@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|kt|kts|rb|yaml|yml|toml|css|scss|html|sql|csv|txt|sh|zip|log|svg|png|jpe?g)\b/gi
/** GitHub URL 中的仓库键 `owner/repo`。 */
const REPO = /(?:https?:\/\/)?(?:[\w-]+\.)?github\.com\/([\w.-]+)\/([\w.-]+)/gi
const NUMBER = /(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?\s?(?:%|ms|s|m|h|kb|mb|gb|k|m|x)?/gi
/** 这些路径是编排器资源名，不是仓库产物。 */
const RESOURCE_PREFIXES = ['ticket/', 'trigger/', 'decision/', 'thread/', 'group/', 'settings/', 'prompts/', 'event/', 'task/', 'observation/']
/** 这些目录或文件名过于常见，只保留完整路径键，不用裸文件名匹配。 */
const GENERIC = new Set(['src', 'lib', 'app', 'test', 'tests', 'core', 'dist', 'build', 'node_modules', 'index', 'readme', 'license',
  'package', 'package-lock', 'pnpm-lock', 'tsconfig', 'jsconfig', 'vitest.config', 'tsdown.config'])
/** 通用产物文件名：只出现在裸文件名位置时不足以证明两张工单同域（README.md、package.json、index.ts 等）。 */
const GENERIC_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'readme.md', 'readme.txt', 'readme', 'license', 'license.md', 'changelog.md', 'contributing.md',
  'tsconfig.json', 'jsconfig.json', 'vitest.config.ts', 'tsdown.config.ts', 'index.ts', 'index.tsx', 'index.js',
  'index.jsx', 'index.mjs', 'index.cjs', 'dockerfile', 'makefile', '.gitignore', '.npmrc', '.editorconfig'])
/** GitHub repo 键的前缀：注入结果卡时 repo 级相同不够，还要同目录/模块或显式引用。 */
export const REPO_KEY = 'repo:'

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
const unique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))]

/** 归一化一条路径，去掉引号包裹、开头的 `./` 和结尾标点。 */
function normalizePath(value: string): string {
  const path = value.replace(/^["'`(<[]+|[)"'`>\],.;:]+$/g, '').replace(/^\.\//, '').replace(/\\/g, '/')
  return path.replace(/[),;:]+$/, '')
}

/** 从文本里截取仓库路径和裸文件名；跳过 URL、资源名和 node_modules。 */
export function artifactPaths(text: string): string[] {
  const matches = [...text.matchAll(PATH)]
  const ranges = matches.map(match => [match.index, match.index! + match[0]!.length] as const)
  const found = matches.map(match => normalizePath(match[0]))
  for (const match of text.matchAll(FILE)) {
    const start = match.index!, end = start + match[0]!.length
    // 只收独立的裸文件名；落在某个完整路径里的文件名已经由 PATH 收过。
    if (ranges.some(([from, to]) => start >= from && end <= to)) continue
    found.push(normalizePath(match[0]))
  }
  return unique(found.filter(path => path.length >= 5 && path.length <= 200 && !path.includes('://')
    && !path.startsWith('github.com/') && !path.includes('..') && !path.startsWith('#') && !path.includes('node_modules')
    && !RESOURCE_PREFIXES.some(prefix => path.startsWith(prefix)))).slice(0, ARTIFACTS)
}

/** 裸文件名是否是通用产物名；带目录的路径不算通用，仍能证明某个具体文件。 */
export function isGenericPath(path: string): boolean {
  const normalizedPath = normalizePath(path)
  if (normalizedPath.includes('/')) return false
  const base = normalizedPath.toLowerCase()
  const stem = base.replace(/\.[^.]+$/, '')
  return GENERIC_FILES.has(base) || GENERIC.has(base) || GENERIC.has(stem)
}

/** 路径带来的模块键：完整路径、裸文件名（非通用名）和目录；通用裸文件名不产生任何键。 */
function artifactKeys(path: string): string[] {
  // package.json/README.md 这类通用裸名只说明“读了仓库根文件”，不能当作同域证据。
  if (isGenericPath(path)) return []
  const keys = [path]
  const slash = path.lastIndexOf('/')
  const base = slash < 0 ? path : path.slice(slash + 1)
  const stem = base.replace(/\.[^.]+$/, '').toLowerCase()
  if (slash > 0 && !GENERIC.has(stem) && !isGenericPath(base)) keys.push(base)
  if (slash > 0) {
    const directory = path.slice(0, slash)
    const last = directory.split('/').at(-1)!.toLowerCase()
    // 单段通用目录（src、core、app）不构成模块证据；多段目录（src/core）即使末段通用也算具体模块。
    if (directory.length >= 4 && (directory.includes('/') || !GENERIC.has(last))) keys.push(directory)
  }
  return keys
}

/** 目录/完整文件路径键；`repo:` 前缀的仓库键不算模块级证据。 */
export const isModuleKey = (key: string): boolean => !key.startsWith(REPO_KEY) && key.includes('/')

/**
 * 从一段文本提取匹配键：GitHub repo、产物完整路径、非通用文件名和模块目录。
 * 只用确定性词法，不做相似度、不调 LLM；宁可少匹配，避免把无关工单的结论注入新单。
 */
export function domainKeys(text: string): string[] {
  const keys = artifactPaths(text).flatMap(artifactKeys)
  for (const match of text.matchAll(REPO)) {
    const [owner, repo] = [match[1]!, match[2]!]
    // 仓库键单独加前缀，便于区分“同 repo”和“同目录/模块”；注入结果卡时前者不够。
    keys.push(`${REPO_KEY}${owner}/${repo}`)
    if (repo.length >= 4 && !GENERIC.has(repo.toLowerCase())) keys.push(repo)
  }
  return unique(keys.map(key => key.toLowerCase()).filter(key => key.length >= 4 && key.length <= KEY_CHARS)).slice(0, KEYS)
}

/** 一句话结论：第一行、去掉列表符号，截到第一个句末标点或字符上限。 */
function conclusion(summary: string): string {
  const line = summary.split(/\r?\n/).map(part => part.replace(/^[\s>*#-]+/, '').trim()).find(Boolean) ?? ''
  // 句号只有后接空白或行尾时才算句末，避免把 `ticket.tsx` 从扩展名处截断。
  const sentence = line.match(/^.*?(?:[。！？!?]|\.(?=\s|$))/) ?.[0] ?? line
  return collapse(sentence).slice(0, CONCLUSION_CHARS)
}

/** 关键数字：从报告中提取去重后的百分比、计数和时间，最多 4 个。 */
function numbers(summary: string): string[] {
  return unique([...summary.matchAll(NUMBER)].map(match => collapse(match[0]))).slice(0, NUMBERS)
}

/**
 * 从一张 ready 报告生成结果卡。只截取报告文本与其中出现的产物路径，不读会话、不调用模型；
 * `keys` 是同一份文本的确定性索引键，供 `matchResultCards` 使用。
 */
export function resultCard(ticket: Pick<Ticket, 'id' | 'title'>, report: { summary: string; at: string }): ResultCard {
  const artifacts = artifactPaths(report.summary)
  return { ticketId: ticket.id, title: collapse(ticket.title).slice(0, TITLE_CHARS), conclusion: conclusion(report.summary),
    artifacts: artifacts.map(path => path.slice(0, ARTIFACT_CHARS)), numbers: numbers(report.summary), at: report.at,
    keys: domainKeys(report.summary) }
}

/** 查询里是否显式引用了这张卡片的工单 id（完整 id 或其 8 位前缀）。 */
function referencesCard(query: string, ticketId: string): boolean {
  const text = query.toLowerCase(), id = ticketId.toLowerCase()
  return id.length >= 8 && (text.includes(id) || text.includes(id.slice(0, 8)))
}

/**
 * 命中同域结果卡：必须共享模块级键（带目录的完整路径或目录），或查询显式引用了该工单 id。
 * 通用裸文件名（package.json、README.md、index.ts 等）与仅同 repo 的 GitHub 键都不足以注入。
 */
export function matchResultCards(tickets: readonly Pick<Ticket, 'id' | 'result'>[], query: string, limit = RESULT_CARDS): ResultCard[] {
  const wanted = new Set(domainKeys(query))
  return tickets.flatMap(ticket => {
    if (!ticket.result) return []
    const sharedModule = ticket.result.keys.some(key => isModuleKey(key) && wanted.has(key))
    return sharedModule || referencesCard(query, ticket.id) ? [ticket.result] : []
  }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

/** 把结果卡排成一条 note：结论、产物、关键数字和只读入口；不包含完整报告。 */
export function resultCardNote(cards: readonly ResultCard[]): string {
  const lines = cards.map(card => {
    const parts = [`- ${card.ticketId} (${card.at.slice(0, 16)}): ${card.title}`]
    if (card.conclusion) parts.push(`  ${card.conclusion}`)
    if (card.artifacts.length) parts.push(`  paths: ${card.artifacts.join(', ')}`)
    if (card.numbers.length) parts.push(`  numbers: ${card.numbers.join(', ')}`)
    parts.push(`  read: ticket/${card.ticketId}/result`)
    return parts.join('\n')
  })
  return `Result cards from ready same-domain tickets (context only; read the linked ticket before reusing):\n${lines.join('\n')}`
}