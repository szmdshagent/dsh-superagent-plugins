import { t as __exportAll } from "./rolldown-runtime-D8jQpDG7.js";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// src/state.ts
/**
* cc-worker 运行状态的只读视图。
*
* 数据源全部来自工单目录下的 `.cc-worker/`，不依赖 dsh-superagent 的任何内部字段，
* 因此换 stateDir、升级主包都不会失效。
*
* 单 lane（main，旧行为）：
*   <dir>/.cc-worker/session_id      当前续跑的 Claude Code 会话 id
*   <dir>/.cc-worker/log.jsonl       本次运行的事件流（stream-json）
*   <dir>/.cc-worker/runs/*.jsonl    历次运行的归档
*   <dir>/.cc-worker/fallback.log    续跑守卫的裁决记录
*   <dir>/.cc-worker/interrupt       面板置入的中断标记
*
* team/lane（2026-11-11 起）：
*   <dir>/.cc-worker/team-plan.json  统筹写下的子任务计划 [{lane,task}]
*   <dir>/.cc-worker/lanes/<lane>/   每个 lane 各自一份 session_id/log.jsonl/runs/result.json/task.txt/handoff.md
*
* 成本与轮数必须按 lane 聚合：只看 main 会把并行 lane 的花费漏掉，预算熔断因此形同虚设。
*/
var state_exports = /* @__PURE__ */ __exportAll({
	costByLane: () => costByLane,
	hasRuns: () => hasRuns,
	isValidLaneName: () => isValidLaneName,
	laneBase: () => laneBase,
	laneSummary: () => laneSummary,
	laneTask: () => laneTask,
	lastRun: () => lastRun,
	listLaneSummaries: () => listLaneSummaries,
	listLanes: () => listLanes,
	listRuns: () => listRuns,
	readLaneResult: () => readLaneResult,
	recentFallbacks: () => recentFallbacks,
	sessionId: () => sessionId,
	sessionLogBytes: () => sessionLogBytes,
	tailLog: () => tailLog,
	totalCost: () => totalCost
});
/** 超过这个时间没有新动作、又没写 result.json 的 lane，判为失败而不是仍在跑。 */
const LIVE_MS = 6e5;
/** lane 名只允许安全字符；它来自目录名，防止把奇怪目录当成 lane。 */
const LANE_NAME = /^[A-Za-z0-9_-]+$/;
/** lane 的状态根：main 与旧版完全一致，其它 lane 各占一个子目录。 */
function laneBase(ticketDir, lane = "main") {
	return lane === "main" ? join(ticketDir, ".cc-worker") : join(ticketDir, ".cc-worker", "lanes", lane);
}
/** 从 stream-json 归档里解出 result 事件；文件不完整或没有 result 时返回 undefined。 */
function readResult(file) {
	let text;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line || !line.includes("\"result\"")) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "result") return event;
		} catch {
			continue;
		}
	}
}
/** 把一条 result 事件归一成 RunSummary 的指标部分。 */
function metrics(event) {
	if (!event) return {
		costUsd: 0,
		turns: 0,
		cacheReadTokens: 0,
		ok: false,
		finished: false
	};
	let cacheReadTokens = 0;
	const usage = event.modelUsage;
	if (usage && typeof usage === "object") {
		for (const entry of Object.values(usage)) if (entry && typeof entry === "object") {
			const n = entry.cacheReadInputTokens;
			if (typeof n === "number") cacheReadTokens += n;
		}
	}
	const turns = event.num_turns;
	return {
		costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0,
		turns: typeof turns === "number" ? turns : 0,
		cacheReadTokens,
		ok: event.is_error !== true,
		finished: true
	};
}
/**
* 列出某个 lane 下所有归档运行，按开始时间从旧到新。
*
* 默认 main，保持旧调用不变；传 lane 时读 `.cc-worker/lanes/<lane>/runs`。
*/
function listRuns(ticketDir, lane = "main") {
	const dir = join(laneBase(ticketDir, lane), "runs");
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const runs = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dir, name);
		const event = readResult(file);
		runs.push({
			file,
			startedAt: name.replace(/\.jsonl$/, ""),
			...metrics(event)
		});
	}
	return runs;
}
/** 最近一次运行；没有归档时返回 undefined。 */
function lastRun(ticketDir, lane = "main") {
	const runs = listRuns(ticketDir, lane);
	return runs.length ? runs[runs.length - 1] : void 0;
}
/**
* 枚举工单下出现过的 lane。
*
* 旧版只有 main（状态直接在 `.cc-worker/`）；team 运行后每个 lane 在 `lanes/` 下有一个目录。
* 只要有任务登记或运行痕迹就纳入，便于面板显示「已分工但还没开跑」的 lane。
*/
function listLanes(ticketDir) {
	const lanes = [];
	const root = join(ticketDir, ".cc-worker");
	try {
		if (readdirSync(root).some((name) => name === "runs" || name === "log.jsonl" || name === "session_id" || name === "task.txt")) lanes.push("main");
	} catch {
		return lanes;
	}
	let entries = [];
	try {
		entries = readdirSync(join(root, "lanes"), { withFileTypes: true });
	} catch {}
	for (const entry of entries) if (entry.isDirectory() && LANE_NAME.test(entry.name)) lanes.push(entry.name);
	return lanes.sort(compareLanes);
}
/** 排序：main 最前，ccwN 按编号升序，lead 最后，其它按字母序。 */
function compareLanes(a, b) {
	const rank = (lane) => {
		if (lane === "main") return [
			0,
			0,
			""
		];
		const m = /^ccw(\d+)$/.exec(lane);
		if (m) return [
			1,
			Number(m[1]),
			""
		];
		if (lane === "lead") return [
			3,
			0,
			""
		];
		return [
			2,
			0,
			lane
		];
	};
	const [ra, na, sa] = rank(a);
	const [rb, nb, sb] = rank(b);
	return ra - rb || na - nb || sa.localeCompare(sb);
}
/** 读 lane 的 result.json（cc-worker run 的 stdout）；不存在或不是对象时返回 undefined。 */
function readLaneResult(ticketDir, lane) {
	const file = join(laneBase(ticketDir, lane), "result.json");
	let text;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return;
	}
	const trimmed = text.trim();
	if (!trimmed) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		const lines = trimmed.split("\n");
		for (let i = lines.length - 1; i >= 0 && parsed === void 0; i--) try {
			parsed = JSON.parse(lines[i]);
		} catch {}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
	const raw = parsed;
	const tokens = raw.tokens && typeof raw.tokens === "object" ? raw.tokens : void 0;
	return {
		ok: raw.ok === true,
		costUsd: typeof raw.cost_usd === "number" ? raw.cost_usd : 0,
		turns: typeof raw.num_turns === "number" ? raw.num_turns : 0,
		cacheReadTokens: typeof tokens?.cache_read === "number" ? tokens.cache_read : 0,
		sessionId: typeof raw.session_id === "string" ? raw.session_id : void 0,
		result: typeof raw.result === "string" ? raw.result : void 0,
		error: typeof raw.error === "string" ? raw.error : void 0,
		raw
	};
}
/** 读 lane 的 task.txt（team 分工登记）。 */
function laneTask(ticketDir, lane) {
	try {
		return readFileSync(join(laneBase(ticketDir, lane), "task.txt"), "utf-8").trim() || void 0;
	} catch {
		return;
	}
}
/** lane 名是否合法（面板/测试共用；与 cc-worker 的安全字符集一致）。 */
function isValidLaneName(lane) {
	return LANE_NAME.test(lane);
}
/** lane 目录里 claude.pid 指向的进程是否还活着（跑完 cc-worker 会删掉 pid 文件）。 */
function laneAlive(dir) {
	let pid;
	try {
		pid = Number(readFileSync(join(dir, "claude.pid"), "utf-8").trim());
	} catch {
		return false;
	}
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf-8").includes("claude");
	} catch {
		return false;
	}
}
/**
* lane 最近一次**执行**活动时刻（毫秒）；没有执行痕迹返回 0。
*
* 不把 task.txt 算进来：那只是「已分工」，还没开跑的 lane 不能显示成 running。
*/
function laneActivity(dir, runs) {
	let newest = 0;
	const consider = (file) => {
		try {
			newest = Math.max(newest, statSync(file).mtimeMs);
		} catch {}
	};
	for (const name of [
		"log.jsonl",
		"session_id",
		"result.json"
	]) consider(join(dir, name));
	for (const run of runs) consider(run.file);
	return newest;
}
/**
* 汇总一个 lane：花费、轮数、存活/完成/失败。
*
* 判定顺序：
*   1. result.json 存在 → ok 即 done，否则 failed；
*   2. claude.pid 进程存活 → running；
*   3. 有运行痕迹但无 result.json：最近 LIVE_MS 内有活动 → running，否则 failed（多半被超时/中止）；
*   4. 只有 task.txt 等登记、从未开跑 → idle。
*/
function laneSummary(ticketDir, lane, now = Date.now()) {
	const dir = laneBase(ticketDir, lane);
	const runs = listRuns(ticketDir, lane);
	const result = readLaneResult(ticketDir, lane);
	const latest = runs.length ? runs[runs.length - 1] : void 0;
	const ranCost = runs.reduce((sum, run) => sum + run.costUsd, 0);
	const ranTurns = runs.reduce((sum, run) => sum + run.turns, 0);
	const ranCache = runs.reduce((sum, run) => sum + run.cacheReadTokens, 0);
	const task = laneTask(ticketDir, lane);
	const session = sessionId(ticketDir, lane) ?? result?.sessionId;
	let state;
	let ok = latest?.ok ?? false;
	if (result) {
		state = result.ok ? "done" : "failed";
		ok = result.ok;
	} else if (latest?.finished) {
		state = latest.ok ? "done" : "failed";
		ok = latest.ok;
	} else if (laneAlive(dir)) {
		state = "running";
		ok = latest?.ok ?? false;
	} else {
		const activity = laneActivity(dir, runs);
		const started = runs.length > 0 || existsSync(join(dir, "log.jsonl")) || existsSync(join(dir, "session_id"));
		if (started && activity && now - activity <= LIVE_MS) state = "running";
		else if (started) {
			state = "failed";
			ok = false;
		} else {
			state = "idle";
			ok = false;
		}
	}
	const costUsd = runs.length ? ranCost : result?.costUsd ?? 0;
	const turns = runs.length ? ranTurns : result?.turns ?? 0;
	const cacheReadTokens = runs.length ? ranCache : result?.cacheReadTokens ?? 0;
	let endedAt;
	try {
		endedAt = new Date(statSync(join(dir, "result.json")).mtimeMs).toISOString();
	} catch {}
	return {
		lane,
		dir,
		task,
		sessionId: session,
		state,
		runs,
		costUsd,
		turns,
		cacheReadTokens,
		ok,
		startedAt: latest?.startedAt,
		endedAt,
		error: result?.error,
		result: result?.result ? result.result.slice(0, 500) : void 0
	};
}
/** 工单下所有 lane（含 main）的聚合视图，按 main → ccwN → 其它 → lead 排序。 */
function listLaneSummaries(ticketDir, now = Date.now()) {
	return listLanes(ticketDir).map((lane) => laneSummary(ticketDir, lane, now));
}
/** 当前会话 id；没有则 undefined。 */
function sessionId(ticketDir, lane = "main") {
	try {
		return readFileSync(join(laneBase(ticketDir, lane), "session_id"), "utf-8").trim() || void 0;
	} catch {
		return;
	}
}
/** 会话日志（Claude Code 侧）的字节数，用于估算续跑会重放多少历史。 */
function sessionLogBytes(ticketDir, id, home = process.env.HOME ?? "") {
	const project = join(home, ".claude", "projects", ticketDir.replace(/\//g, "-"));
	try {
		return statSync(join(project, id + ".jsonl")).size;
	} catch {
		return 0;
	}
}
/** 工单目录下是否有任何 lane 的归档可读，用于判断这块工单是否用过 cc-worker。 */
function hasRuns(ticketDir) {
	return listLanes(ticketDir).some((lane) => listRuns(ticketDir, lane).length > 0);
}
/** 读取 fallback.log 的最后若干行，面板用来解释「为什么开了新会话」。 */
function recentFallbacks(ticketDir, limit = 5, lane = "main") {
	try {
		return readFileSync(join(laneBase(ticketDir, lane), "fallback.log"), "utf-8").trim().split("\n").filter(Boolean).slice(-limit);
	} catch {
		return [];
	}
}
/** 读取事件流尾部若干字节，供面板展示 worker 当前动作。 */
function tailLog(ticketDir, bytes = 65536, lane = "main") {
	const file = join(laneBase(ticketDir, lane), "log.jsonl");
	let fd;
	try {
		const size = statSync(file).size;
		const start = Math.max(0, size - bytes);
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(Math.min(bytes, size - start));
		readSync(fd, buffer, 0, buffer.length, start);
		return buffer.toString("utf-8");
	} catch {
		return "";
	} finally {
		if (fd !== void 0) try {
			closeSync(fd);
		} catch {}
	}
}
/**
* 工单历史累计花费，用于单工单成本熔断。
*
* 2026-11-11 起按 lane 聚合：team 并行时每个 lane 各有一份 runs，
* 只看 main 会低估成本，熔断就永远不会触发。
*/
function totalCost(ticketDir) {
	return listLaneSummaries(ticketDir).reduce((sum, lane) => sum + lane.costUsd, 0);
}
/** 按 lane 拆分的花费，面板展示「钱花在哪个 lane」。 */
function costByLane(ticketDir) {
	const out = {};
	for (const lane of listLaneSummaries(ticketDir)) out[lane.lane] = lane.costUsd;
	return out;
}
export { totalCost as _, laneSummary as a, listLaneSummaries as c, readLaneResult as d, recentFallbacks as f, tailLog as g, state_exports as h, laneBase as i, listLanes as l, sessionLogBytes as m, hasRuns as n, laneTask as o, sessionId as p, isValidLaneName as r, lastRun as s, costByLane as t, listRuns as u };
