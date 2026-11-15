import { Context } from "@deepseek-ai/cordis";
interface RunnerConfig {
  /** 允许的工作目录根；--dir 必须在其下，防止会话串到别的工单。 */
  workRoot: string;
  /** claude 可执行文件，默认取 PATH 里的 claude。 */
  claudeBin: string;
  /** 是否跳过权限审批。默认 false；设为 true 等于允许无人值守执行任意命令，由部署方自行承担。 */
  skipPermissions?: boolean;
  /** 额外的 claude 参数（如 --model、MCP 配置）。 */
  extraArgs?: string[];
  defaultTimeoutS: number;
  defaultMaxTurns: number;
  /** 宿主进程 pid；给了就在它消失时收掉 claude（父死子亡）。 */
  hostPid?: number;
}
interface RunRequest {
  task: string;
  dir: string;
  lane?: string;
  fresh?: boolean;
  model?: string;
  timeoutS?: number;
  maxTurns?: number;
  /** 放行理由，写进结果供事后审计。 */
  why?: string;
}
interface RunResult {
  ok: boolean;
  result?: string;
  sessionId?: string;
  costUsd?: number;
  durationS?: number;
  log?: string;
  error?: string;
  code?: number | null;
  timedOut?: boolean;
  interrupted?: boolean;
}
/** 状态根：main 与 lanes/<name> 分开，各自独立会话。 */
declare function stateBase(dir: string, lane?: string): string;
/** 校验目录：必须在 workRoot 之下，lane 名只允许安全字符。 */
declare function validateRequest(req: RunRequest, config: RunnerConfig): void;
/** 拼 claude 命令行参数。审批跳过只在配置显式开启时出现。 */
declare function buildClaudeArgs(req: RunRequest, mode: 'new' | 'resume', sid: string, config: RunnerConfig): string[];
/** 从 stream-json 事件流里取最后一条 result 事件。 */
declare function parseStreamLog(text: string): {
  result?: string;
  sessionId?: string;
  costUsd?: number;
};
/** 执行一次任务；永不抛异常，失败以 ok:false 返回。 */
declare function runClaude(config: RunnerConfig, req: RunRequest, signal?: AbortSignal): Promise<RunResult>;
declare const name = "dsh-cc-worker";
declare const inject: string[];
/** 插件配置；全部可在 cordis.patch.yml 的 config 里覆盖。 */
interface Config {
  /** 允许的工作目录根。默认 ~/.dsh/state/superagent/work。 */
  workRoot?: string;
  /** claude 可执行文件，默认 PATH 里的 claude。 */
  claudeBin?: string;
  /** 是否跳过权限审批。默认 false；无人值守部署才设为 true。 */
  skipPermissions?: boolean;
  /** 额外 claude 参数。 */
  extraArgs?: string[];
  defaultTimeoutS?: number;
  defaultMaxTurns?: number;
  /** 同时在跑的任务上限。 */
  maxConcurrent?: number;
  /** 设为路径时改调本机 cc-worker 脚本，获得该脚本特有的 cctrim / team / handoff 能力。 */
  legacyScript?: string;
  /** 设为 true 时在 /tmp/dsh-cc-worker.loaded 写一条加载标记，便于确认插件已挂载。 */
  loadMarker?: boolean;
}
declare function apply(ctx: Context, config?: Config): void;
export { Config, type RunRequest, type RunResult, type RunnerConfig, apply, buildClaudeArgs, inject, name, parseStreamLog, runClaude, stateBase, validateRequest };