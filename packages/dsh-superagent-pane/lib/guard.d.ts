import { Context } from "@deepseek-ai/cordis";
declare const name = "dsh-superagent-pane-guard";
declare const inject: string[];
/**
 * 装上硬限制守卫。
 *
 * `inject` 里声明 `tools` 而不是在 apply 里自己 inject：Cordis 会在该服务就绪时才调用 apply，
 * 服务缺失时这一条会显示为 pending，一眼能看出守卫没生效——这比静默降级安全。
 */
declare function apply(ctx: Context): void;
export { apply, inject, name };