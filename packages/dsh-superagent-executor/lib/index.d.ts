import { installExecutorGuard, workerVerdict } from "./guard.js";
import { v as state_d_exports } from "./state-DWMScP3_.js";
import { Context } from "@deepseek-ai/cordis";
/** 单工单累计成本上限（美元）。超过后拒绝再启动 cc-worker。 */
declare const DEFAULT_TICKET_BUDGET_USD = 50;
/** 执行层的运行配置。 */
type ExecutorConfig = {
  /** 单工单累计成本上限；设为 0 关闭熔断。 */
  ticketBudgetUsd: number;
};
/** 从环境变量读配置，缺失时用默认值。 */
declare function config(): ExecutorConfig;
/**
 * 判断某工单是否已经超预算。
 *
 * 用累计花费而不是单次花费：单次便宜但跑几十次同样会烧穿，
 * 实测 `code-check-vm-memory` 22 次运行共 $171.86。
 */
declare function overBudget(ticketDir: string, budget?: number): {
  over: boolean;
  spent: number;
};
declare const name = "dsh-superagent-executor";
declare const inject: readonly ["tools"];
/**
 * 安装执行层。
 *
 * `inject` 声明 `tools`：Cordis 会在该服务就绪时才调用 apply，
 * 缺失时这一条显示为 pending，一眼能看出约束没生效——比静默降级安全。
 */
declare function apply(ctx: Context): void;
export { DEFAULT_TICKET_BUDGET_USD, ExecutorConfig, apply, config, inject, installExecutorGuard, name, overBudget, state_d_exports as state, workerVerdict };