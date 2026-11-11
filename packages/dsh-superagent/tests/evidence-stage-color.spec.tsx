// @vitest-environment jsdom
// 临时证据用例：用同一 Ticket fixture 分别按旧/新 stage 推导渲染真实执行页，导出 HTML 供截图。
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { it, expect } from 'vitest'
import { at, mount, remount, usePanel } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'
import { ticketStage as ticketStageAfter, type Ticket } from '../src/core/index.ts'
import { ticketStage as ticketStageBefore } from '../src/core/stage-before.ts'

usePanel()
const OUT = '/tmp/evidence-render'
mkdirSync(OUT, { recursive: true })

// 与真实场景一致：worker 在 10:00 报告 waiting，10:05 收到新的 Input（deliveredAt 不早于报告时间）。
const fixture: Ticket = {
  id: 't-evidence', title: '修复登录页回归', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  channels: [], createdAt: '2026-11-06T09:55:00Z', updatedAt: '2026-11-06T10:05:00Z',
  origin: { triggerId: 'e1', triggerIds: ['e1'] },
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-06T09:58:00Z',
    report: { state: 'waiting', summary: '已完成首轮修改，等待新的输入', at: '2026-11-06T10:00:00Z' },
    deliveredAt: '2026-11-06T10:05:00Z' }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-11-06T10:05:00Z', human: true }],
  undelivered: [],
}

const theme = readFileSync('/tmp/design-platform.css', 'utf8')
// 仓库真实的客户端样式表（含 .dt-list/.dt-ticket/.dt-stage 的布局与状态色）。
const clientCss = readFileSync(`${process.cwd()}/src/client/client.css`, 'utf8')
const frame = (rowHtml: string, caption: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${theme}</style>
<style>${clientCss}</style>
<style>
html,body{margin:0;padding:24px;background:var(--dsw-alias-bg-base);font-family:var(--dsh-font-family-text-default,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif);}
.evidence-caption{font:600 13px/1.6 var(--dsh-font-family-text-default,sans-serif);color:var(--dsw-alias-label-primary);margin:0 0 12px;}
.evidence-wrap{max-width:720px;}
.evidence-wrap .dt-list{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;}
</style>
</head><body><div class="evidence-wrap"><p class="evidence-caption">${caption}</p><ul class="dt-list">${rowHtml}</ul></div></body></html>`

const row = (stage: ReturnType<typeof ticketStageAfter>) => ticketSummary({ id: fixture.id, title: fixture.title,
  summary: '已完成首轮修改，等待新的输入', updatedAt: fixture.updatedAt,
  threads: [{ key: 'github:42', source: 'github', title: '#42 Fix login', url: 'https://github.com/acme/widgets/pull/42',
    facts: { number: { value: '#42' }, ci: { label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true } } }] }, stage)

function capture(name: string, caption: string) {
  // 取真实渲染出的工单行 DOM（不是重画），单独包进 .dt-list 以便截图。
  const li = [...document.querySelectorAll<HTMLElement>('.dt-list > .dt-ticket')]
    .find(element => element.textContent?.includes(fixture.title))
  if (!li) throw new Error('ticket row not rendered')
  writeFileSync(`${OUT}/${name}.html`, frame(li.outerHTML, caption))
  const mark = li.querySelector('.dt-ticket-stage .dt-stage')
  return { label: mark?.textContent, state: mark?.getAttribute('data-state') }
}

it('renders before and after evidence', async () => {
  expect(ticketStageBefore(fixture)).toEqual({ stage: 'idle' })
  expect(ticketStageAfter(fixture)).toEqual({ stage: 'working' })
  at({ page: 'execution' })
  server.tickets.open = [row(ticketStageBefore(fixture))]
  await mount()
  expect(capture('before', 'Before（Tedeoner main@b113ba3c，旧推导）：完成报告 waiting 后又有 Input 送达，仍显示「等待新触发」')).toEqual(
    { label: '等待新触发', state: 'idle' })
  server.tickets.open = [row(ticketStageAfter(fixture))]
  await remount()
  expect(capture('after', 'After（本分支，新推导）：同一 fixture 下显示「执行中」，worker 已重新进入运行状态')).toEqual(
    { label: '执行中', state: 'ongoing' })
})