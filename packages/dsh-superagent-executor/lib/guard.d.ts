import { Context } from "@deepseek-ai/cordis";
/** 工具调用的最小形状；只用得到名字与参数。 */
type Execution = {
  name?: string;
  arguments?: unknown;
  agent?: AgentLike;
} | undefined;
/** agent 的最小形状：只读 session.header.id。 */
type AgentLike = {
  session?: {
    header?: {
      id?: unknown;
    };
  };
};
/** 本插件挂接的 tools 服务；类型自行声明，不依赖主包未公开的内部类型。 */
type ToolsService = {
  guard(guard: (execution: Execution) => string | undefined): () => void;
};
declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService;
  }
}
/**
 * 把命令行切成词，够用于识别参数。
 *
 * 不追求完整 shell 语义：只要能把 `--dir /x --max-turns 40` 切成
 * `['--dir','/x','--max-turns','40']` 即可。引号内的空格保留。
 */
declare function words(command: string): string[];
/**
 * 命令行里是否**执行**了 cc-worker。
 *
 * 只看命令位置（首词，或 `|`、`&&`、`;`、`||` 之后，或 env/sudo/time 等前缀之后），
 * 不看到名字就算——否则 `cat /tmp/cc-worker`、`grep pattern cc-worker` 会被误判成调用，
 * 从而被要求带 --max-turns。
 */
declare function ccWorkerIndex(command: string): number;
/**
 * 命令行里是否**执行**了 cc-worker。见 {@link ccWorkerIndex}。
 */
declare function invokesCcWorker(command: string): boolean;
/**
 * 校验一条 cc-worker 命令行；返回拒绝理由，或 undefined 表示放行。
 *
 * 先确认这条命令**确实在调用** cc-worker 再校验参数：否则 `ls -la`、
 * `cat /tmp/cc-worker.log` 这类只是提到名字的命令会被误拒。
 *
 * 2026-11-11 起 cc-worker 支持 team/lane 协作，参数校验同步扩展：
 *   - `--lane` 只能是 main、lead 或 ccw1..ccwN（N 不超过 --workers，默认上限 4）；
 *   - `--workers` 必须是 1..4 的整数；
 *   - `--task` 必须带非空任务描述；
 *   - team 不能嵌套（CC_TEAM_DEPTH 已置位时拒绝）。
 */
declare function ccWorkerVerdict(command: string): string | undefined;
/** 一次工具调用的裁决：返回字符串即拒绝，返回 undefined 即放行。 */
declare function workerVerdict(execution: Execution): string | undefined;
/**
 * 挂上全局 guard，返回卸载函数。
 *
 * 用 `ctx.inject(['tools'], ...)` 而不是直接 `ctx.tools`：tools 服务由 DSH 的插件提供，
 * 加载顺序不保证；inject 回调会在服务就绪时调用，并在卸载时自动回收。
 */
declare function installExecutorGuard(ctx: Context): void;
/** 插件条目：name 与 inject 直接导出，供 bundle patch 引用。 */
declare const name = "dsh-superagent-executor-guard";
declare const inject: readonly ["tools"];
declare function apply(ctx: Context): void;
export { apply, ccWorkerIndex, ccWorkerVerdict, inject, installExecutorGuard, invokesCcWorker, name, words, workerVerdict };