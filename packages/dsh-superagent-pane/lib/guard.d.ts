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
/** 本插件挂接的 tools 服务；类型在这里自行声明，不依赖主包未公开的内部类型。 */
type ToolsService = {
  guard(guard: (execution: Execution) => string | undefined): () => void;
};
declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService;
  }
}
/** team 计划里的一条分工。 */
type TeamPlanEntry = {
  lane: string;
  task: string;
};
/** `.cc-worker/team-plan.json` 的解析结果。 */
type TeamPlan = {
  /** 计划文件绝对路径。 */
  path: string;
  /** 文件是否存在。 */
  exists: boolean;
  /** 合法条目（lane 为 ccw1..ccwN 且 task 非空）。 */
  lanes: TeamPlanEntry[];
  /** 不合规条目，面板据此提示统筹重新分工。 */
  invalid: TeamPlanEntry[];
  /** 读取/JSON 解析失败的原因。 */
  error?: string;
};
/** 一个 lane 的面板视图。 */
type TeamLane = {
  lane: string;
  /** 分工描述：优先 task.txt，其次 team-plan.json。 */
  task?: string;
  /** pending=已分工未开跑；running=有活信号；done/failed=有 result.json。 */
  state: 'pending' | 'running' | 'done' | 'failed';
  ok?: boolean;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  error?: string;
  /** 是否写了 handoff.md（交接完成）。 */
  handoff: boolean;
  /** 最近一次执行活动时刻（毫秒），供面板/健康探测判断「多久没动作」。 */
  atMs?: number;
};
/** 工单的 team 状态：计划 + 每 lane 视图。 */
type TeamStatus = {
  plan: TeamPlan;
  lanes: TeamLane[];
};
/** lane 的状态根：main 与旧版一致，其它 lane 各自一个子目录。 */
declare function laneDir(ticketDir: string, lane?: string): string;
/** lane 名是否合法（与 cc-worker 的安全字符集一致）。 */
declare function isValidLaneName(lane: string): boolean;
/** 读 team-plan.json；文件缺失、不是数组或条目不合规都如实报告，不猜测。 */
declare function readTeamPlan(ticketDir: string): TeamPlan;
/**
 * 读工单的 team 状态：team-plan.json + 每个 lane 的 task.txt/result.json。
 *
 * lane 顺序以计划为准（ccw1、ccw2…），计划之外的目录（如 lead、手工 lane）排在后面。
 * 这样面板能直接按执行顺序展示存活/完成/失败，而不是靠目录名字典序。
 */
declare function teamStatus(ticketDir: string, now?: number): TeamStatus;
/** 只要每个 lane 的视图（面板/测试常用）。 */
declare function listTeamLanes(ticketDir: string, now?: number): TeamLane[];
declare const name = "dsh-superagent-pane-guard";
declare const inject: string[];
/**
 * 装上硬限制守卫。
 *
 * `inject` 里声明 `tools` 而不是在 apply 里自己 inject：Cordis 会在该服务就绪时才调用 apply，
 * 服务缺失时这一条会显示为 pending，一眼能看出守卫没生效——这比静默降级安全。
 */
declare function apply(ctx: Context): void;
export { type TeamLane, type TeamPlan, type TeamPlanEntry, type TeamStatus, apply, inject, isValidLaneName, laneDir, listTeamLanes, name, readTeamPlan, teamStatus };