/**
 * dsh-superagent-executor —— worker 的执行层插件。
 *
 * 职责边界：
 *   - 本包管「何时调、参数对不对、预算够不够、跑成什么样」；
 *   - cc-worker 脚本管「怎么跑」（进程、会话、stream-json）。
 *
 * 两者都是同级 bundle，谁都不依赖 dsh-superagent 主包，因此升级主包不会丢。
 *
 * 当前提供：
 *   1. 参数硬约束（guard.ts）：cc-worker 调用必须带 --max-turns；team/lane 参数按 2026-11-11
 *      的新协作机制校验（--lane ccw1..ccwN、--workers 1..4、--task 非空、禁止 team 嵌套）；
 *   2. 成本熔断：工单累计花费超过阈值时拒绝再启动运行；累计值按 main + 各 lane 聚合，
 *      并行 lane 的花费不会被漏掉；
 *   3. 运行状态读取（state.ts）：面板可选地引用 ./state 拿数据，listLaneSummaries 输出
 *      每个 lane 的 存活/完成/失败、花费与轮数。
 */
import type { Context } from '@deepseek-ai/cordis'
import { installExecutorGuard, workerVerdict } from './guard.ts'
import { totalCost } from './state.ts'

/** 单工单累计成本上限（美元）。超过后拒绝再启动 cc-worker。 */
export const DEFAULT_TICKET_BUDGET_USD = 50

/** 执行层的运行配置。 */
export type ExecutorConfig = {
  /** 单工单累计成本上限；设为 0 关闭熔断。 */
  ticketBudgetUsd: number
}

/** 从环境变量读配置，缺失时用默认值。 */
export function config(): ExecutorConfig {
  const raw = process.env.DSH_EXECUTOR_TICKET_BUDGET_USD
  const parsed = raw === undefined ? NaN : Number(raw)
  return { ticketBudgetUsd: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TICKET_BUDGET_USD }
}

/**
 * 判断某工单是否已经超预算。
 *
 * 用累计花费而不是单次花费：单次便宜但跑几十次同样会烧穿，
 * 实测 `code-check-vm-memory` 22 次运行共 $171.86。
 */
export function overBudget(ticketDir: string, budget = config().ticketBudgetUsd): { over: boolean; spent: number } {
  if (budget <= 0) return { over: false, spent: 0 }
  const spent = totalCost(ticketDir)
  return { over: spent >= budget, spent }
}

export const name = 'dsh-superagent-executor'
export const inject = ['tools'] as const

/**
 * 安装执行层。
 *
 * `inject` 声明 `tools`：Cordis 会在该服务就绪时才调用 apply，
 * 缺失时这一条显示为 pending，一眼能看出约束没生效——比静默降级安全。
 */
export function apply(ctx: Context): void {
  installExecutorGuard(ctx)
}

export { installExecutorGuard, workerVerdict }
export * as state from './state.ts'
