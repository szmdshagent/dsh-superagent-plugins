/**
 * dsh-superagent-pane/guard —— worker 硬限制的独立插件条目。
 *
 * 为什么单列一个 entry 而不是塞进 pane 主插件：
 *   1. 插件页按 entry 列出，塞在别人内部就看不见它在跑，出问题也难排查；
 *   2. 守卫可以独立启停、独立回滚，不影响派活面板；
 *   3. 职责清楚：pane 负责界面与派活，guard 负责"worker 改外部状态必须经 cc-worker"。
 *
 * 它注册的是**全局 guard**（`ctx.tools.guard()`，不是 `agent.ctx.tools.guard()`），
 * 对本进程所有 agent 生效；守卫内部凭 `exec.agent.session.header.id` 的形状
 * `worker-<工单id>` 认出 Executor Session，主 Session、子代理、人的会话一律放行。
 */
import type { Context } from '@deepseek-ai/cordis'
import { installWorkerGuard } from './guard.ts'

// team/lane 只读视图随 guard 一起导出：面板与测试都从这里取，避免依赖未公开的内部模块。
export { laneDir, isValidLaneName, readTeamPlan, teamStatus, listTeamLanes } from './guard.ts'
export type { TeamPlan, TeamPlanEntry, TeamLane, TeamStatus } from './guard.ts'

export const name = 'dsh-superagent-pane-guard'
export const inject = ['tools']

/**
 * 装上硬限制守卫。
 *
 * `inject` 里声明 `tools` 而不是在 apply 里自己 inject：Cordis 会在该服务就绪时才调用 apply，
 * 服务缺失时这一条会显示为 pending，一眼能看出守卫没生效——这比静默降级安全。
 */
export function apply(ctx: Context): void {
  installWorkerGuard(ctx)
}
