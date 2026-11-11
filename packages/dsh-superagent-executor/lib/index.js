import { installExecutorGuard, workerVerdict } from "./guard.js";
import { _ as totalCost, h as state_exports } from "./state-Bhzf87mC.js";
// src/index.ts
/** 单工单累计成本上限（美元）。超过后拒绝再启动 cc-worker。 */
const DEFAULT_TICKET_BUDGET_USD = 50;
/** 从环境变量读配置，缺失时用默认值。 */
function config() {
	const raw = process.env.DSH_EXECUTOR_TICKET_BUDGET_USD;
	const parsed = raw === void 0 ? NaN : Number(raw);
	return { ticketBudgetUsd: Number.isFinite(parsed) && parsed >= 0 ? parsed : 50 };
}
/**
* 判断某工单是否已经超预算。
*
* 用累计花费而不是单次花费：单次便宜但跑几十次同样会烧穿，
* 实测 `code-check-vm-memory` 22 次运行共 $171.86。
*/
function overBudget(ticketDir, budget = config().ticketBudgetUsd) {
	if (budget <= 0) return {
		over: false,
		spent: 0
	};
	const spent = totalCost(ticketDir);
	return {
		over: spent >= budget,
		spent
	};
}
const name = "dsh-superagent-executor";
const inject = ["tools"];
/**
* 安装执行层。
*
* `inject` 声明 `tools`：Cordis 会在该服务就绪时才调用 apply，
* 缺失时这一条显示为 pending，一眼能看出约束没生效——比静默降级安全。
*/
function apply(ctx) {
	installExecutorGuard(ctx);
}
export { DEFAULT_TICKET_BUDGET_USD, apply, config, inject, installExecutorGuard, name, overBudget, state_exports as state, workerVerdict };
