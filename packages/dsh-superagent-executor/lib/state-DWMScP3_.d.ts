declare namespace state_d_exports {
  export { LaneState, LaneSummary, RunSummary, costByLane, hasRuns, isValidLaneName, laneBase, laneSummary, laneTask, lastRun, listLaneSummaries, listLanes, listRuns, readLaneResult, recentFallbacks, sessionId, sessionLogBytes, tailLog, totalCost };
}
/** 一次 cc-worker 运行的摘要。 */
type RunSummary = {
  /** 归档文件路径。 */
  file: string;
  /** 本次运行的开始时刻（取自文件名）。 */
  startedAt: string;
  /** 本次花费，单位美元。 */
  costUsd: number;
  /** 轮数。 */
  turns: number;
  /** 会话累计读入的 token 数，用于判断续跑是否已经开始重放历史。 */
  cacheReadTokens: number;
  /** 成功与否。 */
  ok: boolean;
  /** 归档里是否有 result 事件：有就说明这一轮正常收尾（成功或失败），不是在跑。 */
  finished: boolean;
};
/** lane 的存活/终态。 */
type LaneState = 'idle' | 'running' | 'done' | 'failed';
/** 一个 lane 的聚合视图。 */
type LaneSummary = {
  /** lane 名：main、lead 或 ccw1..ccwN。 */
  lane: string;
  /** 状态根目录（main 是 .cc-worker，其它是 .cc-worker/lanes/<lane>）。 */
  dir: string;
  /** task.txt 里的一行任务描述（team 分工登记）。 */
  task?: string;
  /** 当前会话 id。 */
  sessionId?: string;
  /** 存活/完成/失败/未开始。 */
  state: LaneState;
  /** 该 lane 的历次运行，按时间从旧到新。 */
  runs: RunSummary[];
  /** 该 lane 累计花费（美元）。 */
  costUsd: number;
  /** 该 lane 累计轮数。 */
  turns: number;
  /** 该 lane 累计读入的缓存 token 数。 */
  cacheReadTokens: number;
  /** 最近一次运行/结果是否成功。 */
  ok: boolean;
  /** 最近一次运行的开始时刻（取自归档文件名）。 */
  startedAt?: string;
  /** result.json 的写入时刻（ISO）。 */
  endedAt?: string;
  /** 失败原因（result.json 或最后一条事件）。 */
  error?: string;
  /** result.json 里的最终回答（截断后的前缀，供面板提示）。 */
  result?: string;
};
/** result.json 是 cc-worker run 的 stdout，一行 JSON；解析失败返回 undefined。 */
type LaneResult = {
  ok: boolean;
  costUsd: number;
  turns: number;
  cacheReadTokens: number;
  sessionId?: string;
  result?: string;
  error?: string;
  raw: Record<string, unknown>;
};
/** lane 的状态根：main 与旧版完全一致，其它 lane 各占一个子目录。 */
declare function laneBase(ticketDir: string, lane?: string): string;
/**
 * 列出某个 lane 下所有归档运行，按开始时间从旧到新。
 *
 * 默认 main，保持旧调用不变；传 lane 时读 `.cc-worker/lanes/<lane>/runs`。
 */
declare function listRuns(ticketDir: string, lane?: string): RunSummary[];
/** 最近一次运行；没有归档时返回 undefined。 */
declare function lastRun(ticketDir: string, lane?: string): RunSummary | undefined;
/**
 * 枚举工单下出现过的 lane。
 *
 * 旧版只有 main（状态直接在 `.cc-worker/`）；team 运行后每个 lane 在 `lanes/` 下有一个目录。
 * 只要有任务登记或运行痕迹就纳入，便于面板显示「已分工但还没开跑」的 lane。
 */
declare function listLanes(ticketDir: string): string[];
/** 读 lane 的 result.json（cc-worker run 的 stdout）；不存在或不是对象时返回 undefined。 */
declare function readLaneResult(ticketDir: string, lane: string): LaneResult | undefined;
/** 读 lane 的 task.txt（team 分工登记）。 */
declare function laneTask(ticketDir: string, lane: string): string | undefined;
/** lane 名是否合法（面板/测试共用；与 cc-worker 的安全字符集一致）。 */
declare function isValidLaneName(lane: string): boolean;
/**
 * 汇总一个 lane：花费、轮数、存活/完成/失败。
 *
 * 判定顺序：
 *   1. result.json 存在 → ok 即 done，否则 failed；
 *   2. claude.pid 进程存活 → running；
 *   3. 有运行痕迹但无 result.json：最近 LIVE_MS 内有活动 → running，否则 failed（多半被超时/中止）；
 *   4. 只有 task.txt 等登记、从未开跑 → idle。
 */
declare function laneSummary(ticketDir: string, lane: string, now?: number): LaneSummary;
/** 工单下所有 lane（含 main）的聚合视图，按 main → ccwN → 其它 → lead 排序。 */
declare function listLaneSummaries(ticketDir: string, now?: number): LaneSummary[];
/** 当前会话 id；没有则 undefined。 */
declare function sessionId(ticketDir: string, lane?: string): string | undefined;
/** 会话日志（Claude Code 侧）的字节数，用于估算续跑会重放多少历史。 */
declare function sessionLogBytes(ticketDir: string, id: string, home?: string): number;
/** 工单目录下是否有任何 lane 的归档可读，用于判断这块工单是否用过 cc-worker。 */
declare function hasRuns(ticketDir: string): boolean;
/** 读取 fallback.log 的最后若干行，面板用来解释「为什么开了新会话」。 */
declare function recentFallbacks(ticketDir: string, limit?: number, lane?: string): string[];
/** 读取事件流尾部若干字节，供面板展示 worker 当前动作。 */
declare function tailLog(ticketDir: string, bytes?: number, lane?: string): string;
/**
 * 工单历史累计花费，用于单工单成本熔断。
 *
 * 2026-11-11 起按 lane 聚合：team 并行时每个 lane 各有一份 runs，
 * 只看 main 会低估成本，熔断就永远不会触发。
 */
declare function totalCost(ticketDir: string): number;
/** 按 lane 拆分的花费，面板展示「钱花在哪个 lane」。 */
declare function costByLane(ticketDir: string): Record<string, number>;
export { sessionLogBytes as _, hasRuns as a, totalCost as b, laneSummary as c, listLaneSummaries as d, listLanes as f, sessionId as g, recentFallbacks as h, costByLane as i, laneTask as l, readLaneResult as m, LaneSummary as n, isValidLaneName as o, listRuns as p, RunSummary as r, laneBase as s, LaneState as t, lastRun as u, state_d_exports as v, tailLog as y };