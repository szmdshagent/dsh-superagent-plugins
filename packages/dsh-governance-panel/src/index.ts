/**
 * dsh-governance-panel：执行治理面板（独立插件）。
 *
 * 职责：把 cc-worker / 派活引擎留在磁盘上的痕迹归纳成七个治理维度的报告，
 * 外加按需读/生成治理周报。**不参与派活、不注册 Source、不引 dsh-superagent**，所以：
 *   - 官方升级 superagent（整树覆盖，非 git）碰不到它；
 *   - 派活面板插件可以独立升级/回滚，不影响它；
 *   - 删掉这个包，superagent 照常运行，只是少了这块 UI。
 *
 * 数据源全部是只读文件，不碰数据库、不开新守护进程。
 */
import type { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { govern, spendTrend } from './governance.ts'

/** 必需服务：cordis 见到这个声明才会在 apply 之前把 ctx.webServer 装好。 */
export const inject = ['webServer']

/** 宿主 Web 服务：只注册一条精确路由。 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: any, res: any) => unknown }): () => void
    }
  }
}

/** 精确匹配：宿主 `/api` 前缀的 RPC 网关对无 cookie 请求回 401，精确表优先命中。 */
const ROUTE = '/api/governance'
/** 周报超过这个时长就现场重新生成。 */
const WEEKLY_TTL_MS = 86400_000
/** 单次返回的周报正文上限。 */
const WEEKLY_MAX_CHARS = 40000

const home = () => process.env.HOME ?? homedir()
const reportRoot = () => `${home()}/.dsh/state/superagent/reports`
const weeklyScript = () => `${home()}/cc-diag/handoff_weekly.py`

/** 读最近一份周报；不存在或过期时现场跑一次生成脚本。失败就当没有周报。 */
function readWeekly(now: number): { path: string; updated: string | null; text: string; generated: boolean } | null {
  const latest = `${reportRoot()}/handoff-weekly-latest.md`
  let stale = true
  let exists = false
  try { const stat = statSync(latest); exists = true; stale = now - stat.mtimeMs > WEEKLY_TTL_MS } catch { /* 不存在 */ }
  let generated = false
  if (stale) {
    try {
      execFileSync('/usr/bin/python3', [weeklyScript(), '--days', '7'], { timeout: 8000, stdio: 'ignore' })
      generated = !exists
    } catch { /* 脚本不存在或执行失败：沿用旧文件（如果有） */ }
  }
  try {
    const stat = statSync(latest)
    return {
      path: latest,
      updated: new Date(stat.mtimeMs).toISOString(),
      text: readFileSync(latest, 'utf8').slice(0, WEEKLY_MAX_CHARS),
      generated,
    }
  } catch { return null }
}

function sendJson(res: any, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

export function apply(ctx: Context): void {
  const handler = (req: any, res: any): unknown => {
    // 只读插件：不接受任何写操作。
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'read-only plugin' }); return }
    try {
      const now = Date.now()
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      const wantWeekly = url.searchParams.get('weekly') === '1'
      const wantTrend = url.searchParams.get('trend') === '1'
      // ?dims=handoff,cost 只回指定维度，前端可以按需拉，省得每次都算全部。
      const only = (url.searchParams.get('dims') ?? '').split(',').map(item => item.trim()).filter(Boolean)
      // ?ticket=<目录名> 只扫一个工单，便于面板钻取与验收取样。
      const ticket = (url.searchParams.get('ticket') ?? '').trim() || undefined
      const report = govern(now, { ticket })
      if (only.length > 0) {
        report.findings = report.findings.filter(item => only.includes(item.dimension))
        report.dimensions = report.dimensions.filter(item => only.includes(item.key))
      }
      sendJson(res, 200, {
        ...report,
        weekly: wantWeekly ? readWeekly(now) : null,
        trend: wantTrend ? spendTrend(now, 7) : null,
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-governance-panel: 治理扫描失败 %s', String(error))
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return undefined
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }), 'governance-panel: governance route')
}
