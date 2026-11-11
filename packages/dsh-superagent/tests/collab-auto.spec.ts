import { describe, expect, it } from 'vitest'
import { assessPair, jaccard, planAutoGroup, type CollabView } from '../src/core/collab-auto.ts'
import { domainKeys } from '../src/core/results.ts'

const NOW = '2026-11-07T00:00:00.000Z'
const DMINUS = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString()

/** 构造一个可读的视图；默认标题彼此不同、无 any 写域。 */
function view(id: string, overrides: Partial<CollabView> = {}): CollabView {
  return { id, title: `Topic ${id}`, text: `Topic ${id}`, writeScopes: [], domain: [], resultArtifacts: [], threads: [],
    updatedAt: NOW, ...overrides }
}

describe('collab-auto signals', () => {
  it('counts a shared write domain as a strong signal', () => {
    const a = view('a', { domain: ['src/core/collab.ts', 'src/core'] })
    const b = view('b', { domain: ['src/core/collab.ts', 'src/core'] })
    const pair = assessPair(a, b, NOW)
    expect(pair.domain).toBe(1)
    expect(pair.band).toBe('group')
    expect(pair.signals).toEqual(expect.arrayContaining(['domain', 'time']))
    expect(pair.score).toBeGreaterThanOrEqual(0.30)
  })

  it('never groups on thread alone, even with 46 tickets on one thread', () => {
    let seed = 1
    const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed.toString(36) }
    const title = () => Array.from({ length: 10 }, noise).join('')
    const first = view('t0', { title: title(), threads: ['pane:main'] })
    for (let index = 1; index <= 46; index++) {
      const other = view(`t${index}`, { title: title(), threads: ['pane:main'] })
      const pair = assessPair(first, other, NOW)
      expect(pair.band, `thread-only pair ${index}`).not.toBe('group')
      expect(pair.score).toBeLessThan(0.30)
      expect(planAutoGroup(first, [{ view: other }], NOW)).toBeUndefined()
    }
  })

  it('ignores a short, information-free title', () => {
    // “Fix” 的中文/英文标题都太短，不能靠它把同 thread 的工单凑到成组阈值。
    const pair = assessPair(view('a', { title: 'Fix', threads: ['pane:main'] }),
      view('b', { title: 'Fix', threads: ['pane:main'] }), NOW)
    expect(pair.title).toBe(0)
    expect(pair.signals).not.toContain('title')
    expect(pair.score).toBeCloseTo(0.20, 3)
    expect(pair.band).not.toBe('group')
  })

  it('ignores generic bare filenames in domain keys', () => {
    // package.json / README.md / index.ts / tsconfig.json 这类仓库根通用名不足以证明同域。
    expect(domainKeys('Read README.md and package.json.')).toEqual([])
    expect(domainKeys('Read index.ts, tsconfig.json and pnpm-lock.yaml.')).toEqual([])
    expect(domainKeys('Read src/core/tickets.ts and docs/007-architecture.md.')).toEqual(expect.arrayContaining([
      'src/core/tickets.ts', 'tickets.ts', 'src/core', 'docs/007-architecture.md', 'docs']))
  })

  it('never groups on title similarity, time and a shared generic package.json basename', () => {
    // A/C 型：同一个只读模板、标题相似、时间相同，但只有 package.json 这个通用名。
    const a = view('aaaa1111bbbb2222cccc3333dddd4444', { title: '部署验证只读任务：读 README 要点与 package.json 核对', text: '只读 README.md 与 package.json。',
      domain: domainKeys('只读 README.md 与 package.json。') })
    const c = view('eeee5555ffff6666aaaa7777bbbb8888', { title: '部署验证只读任务：读 pane 的 package.json', text: '只读 package.json，给出 3 条依赖要点。',
      domain: domainKeys('只读 package.json，给出 3 条依赖要点。') })
    const pair = assessPair(c, a, NOW)
    expect(pair.signals).not.toContain('domain')
    expect(pair.band).not.toBe('group')
    expect(planAutoGroup(c, [{ view: a }], NOW)).toBeUndefined()
  })

  it('never groups on title, time and a shared thread even at the numeric threshold', () => {
    // 0.10 title + 0.10 time + 0.10 thread = 0.30，但没有显式依赖或真实写域，只能落灰度带。
    const a = view('a', { title: 'deployment verification read only task', text: 'alpha', threads: ['pane:main'] })
    const b = view('b', { title: 'deployment verification read only task', text: 'bravo', threads: ['pane:main'] })
    const pair = assessPair(a, b, NOW)
    expect(pair.score).toBeGreaterThanOrEqual(0.30)
    expect(pair.signals).toEqual(expect.arrayContaining(['title', 'time', 'thread']))
    expect(pair.band).toBe('gray')
    expect(planAutoGroup(a, [{ view: b }], NOW)).toBeUndefined()
  })

  it('treats an explicit ticket reference as a dependency and groups it', () => {
    const upstream = view('aaaa1111bbbb2222cccc3333dddd4444', { title: 'Update the widget parser' })
    const downstream = view('eeee5555ffff6666aaaa7777bbbb8888', { title: 'Follow up on Update the widget parser',
      text: 'Follow up on Update the widget parser and verify the output.' })
    const pair = assessPair(downstream, upstream, NOW)
    expect(pair.dependency).toBe('explicit')
    expect(pair.band).toBe('group')
    const plan = planAutoGroup(downstream, [{ view: upstream }], NOW)
    expect(plan).toMatchObject({ created: true, dependsOn: [upstream.id] })
  })

  it('treats an upstream artifact plus a consumption verb as a dependency', () => {
    const upstream = view('up', { resultArtifacts: ['src/core/report.json'] })
    const downstream = view('down', { text: 'Inspect src/core/report.json and summarize its numbers.' })
    expect(assessPair(downstream, upstream, NOW).dependency).toBe('artifact')
  })

  it('vetoes a write-domain conflict unless there is a real dependency', () => {
    const a = view('a', { writeScopes: ['src/core/tickets.ts'], domain: ['src/core/tickets.ts'] })
    const b = view('b', { writeScopes: ['src/core/tickets.ts'], domain: ['src/core/tickets.ts'] })
    expect(assessPair(a, b, NOW).band).toBe('conflict')
    expect(planAutoGroup(a, [{ view: b }], NOW)).toBeUndefined()
    // 下游只读上游产物时，依赖优先于冲突否决。
    const reader = view('cccc1111dddd2222eeee3333ffff4444', { title: 'Check the result of src/core/tickets.ts',
      text: 'Check the result of src/core/tickets.ts and confirm the fix.', writeScopes: ['src/core/tickets.ts'],
      domain: ['src/core/tickets.ts'], resultArtifacts: [] })
    const producer = view('9999aaaa8888bbbb7777cccc6666dddd', { title: 'Change src/core/tickets.ts',
      resultArtifacts: ['src/core/tickets.ts'], writeScopes: ['src/core/tickets.ts'], domain: ['src/core/tickets.ts'] })
    expect(assessPair(reader, producer, NOW).dependency).toBe('artifact')
    expect(assessPair(reader, producer, NOW).band).toBe('group')
  })

  it('keeps the gray band out of automatic grouping', () => {
    // 0.15 ≤ 分数 < 0.30 只记录，不成组；用弱标题相似度 + 同 thread + 时间构造。
    const a = view('a', { title: 'alpha widget', threads: ['t'] })
    const b = view('b', { title: 'bravo garden', threads: ['t'] })
    const pair = assessPair(a, b, NOW)
    expect(pair.score).toBeGreaterThanOrEqual(0.15)
    expect(pair.score).toBeLessThan(0.30)
    expect(pair.band).toBe('gray')
    expect(planAutoGroup(a, [{ view: b }], NOW)).toBeUndefined()
  })

  it('requires full connection to join an existing group', () => {
    const existingA = view('a', { domain: ['src/core/collab.ts', 'src/core'] })
    const existingB = view('b', { title: 'unrelated poetry', text: 'unrelated poetry', domain: ['docs/poetry.md'] })
    const group = { id: 'auto-x', auto: true, members: [existingA, existingB] }
    const candidate = view('c', { domain: ['src/core/collab.ts', 'src/core'] })
    expect(planAutoGroup(candidate, [{ view: existingA, group }], NOW)).toBeUndefined()
  })

  it('ages candidates out and halves the time signal every 30 minutes', () => {
    const fresh = assessPair(view('a'), view('b', { updatedAt: DMINUS(0) }), NOW)
    const half = assessPair(view('a'), view('b', { updatedAt: DMINUS(30) }), NOW)
    expect(half.score).toBeLessThan(fresh.score)
    expect(planAutoGroup(view('a'), [{ view: view('b', { updatedAt: DMINUS(31) }) }], NOW)).toBeUndefined()
  })

  it('computes Jaccard for overlapping sets and zero for empty ones', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 6)
    expect(jaccard(new Set(), new Set(['a']))).toBe(0)
  })
})