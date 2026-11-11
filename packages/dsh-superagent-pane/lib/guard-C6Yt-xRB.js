import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// src/guard.ts
/** cc-worker 的绝对路径；worker 调它时整条命令放行。 */
const CC_WORKER = "/home/szm/.local/bin/cc-worker";
/**
* Worker 可以直接用的只读命令：命令链上每一段都必须以其中之一开头。
*
* 刻意不含 awk / sed / bash / sh / sudo / python / perl / systemctl —— 它们能用参数或子进程
* 写文件，属于实质执行工作，应该交给 cc-worker。名单宁可窄：误拒只是多一轮，误放就是硬限制被绕过。
*/
const READ_ONLY_CMDS = /* @__PURE__ */ new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"ls",
	"ll",
	"la",
	"find",
	"grep",
	"rg",
	"egrep",
	"fgrep",
	"stat",
	"wc",
	"file",
	"tree",
	"pwd",
	"echo",
	"printf",
	"sleep",
	"true",
	"false",
	"date",
	"whoami",
	"uname",
	"hostname",
	"ps",
	"df",
	"du",
	"free",
	"uptime",
	"cut",
	"sort",
	"uniq",
	"tr",
	"nl",
	"od",
	"xxd",
	"hexdump",
	"md5sum",
	"sha256sum",
	"sha1sum",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"which",
	"type",
	"id",
	"nproc",
	"locale",
	"seq",
	"expr",
	"diff",
	"cmp",
	"cd",
	"test",
	"jq",
	"journalctl",
	"pgrep",
	"ss",
	"lsof",
	"column"
]);
/** 任何位置出现都算写操作的动作。 */
const WRITE_OPS = /(^|[^0-9&])>>?\s*[^\s&]|\btee\b|\bsed\s+-i\b|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\bdd\b|\binstall\b|\bxargs\b|\bfind\b[^|]*?(?:-delete|-exec|-ok|-fprint)|\btruncate\b|\bln\b|\bunlink\b|\bshred\b|\bmkfifo\b|\bpatch\b|\btar\s+-?[a-z]*[cx]\b|\bunzip\b|\bgit\s+(?:reset|checkout|clean|stash)\b|\bwipe\b/;
/**
* 能直接落盘的工具：bash 被拦住以后，worker 会改用这些工具照样把文件写出来
* （2026-11-03 实测：write 工具成功创建了目标文件），所以必须在同一层拒掉。
*
* 用黑名单而不是白名单：worker 还持有 orchestrator_report / orchestrator_read / orchestrator_route
* 这类宿主内部工具，白名单漏掉任何一个都会让 worker 连"上报 blocked"都做不到，工单永远收不了尾。
*/
const FILE_WRITE_TOOLS = /* @__PURE__ */ new Set([
	"write",
	"edit",
	"pwsh",
	"notebook_edit",
	"apply_patch",
	"patch",
	"multiedit"
]);
/** 只写内存、不落盘的工具，别被下面的名字兜底误伤。 */
const MEMORY_ONLY_TOOLS = /* @__PURE__ */ new Set(["todo_write"]);
/** 兜底：将来升级新增的写类工具靠名字识别，避免又出现绕过口。 */
const FILE_WRITE_NAME = /(?:^|_)(?:write|edit|patch|apply|create|save|delete|remove|move|copy|rename|upload|append)(?:$|_)/;
const BASH_DENY = "Worker bash is read-only plus cc-worker. Delegate any change: /home/szm/.local/bin/cc-worker run \"<task>\" --dir <ticket dir>";
const TOOL_DENY = "Worker may not change files with this tool. Delegate the change: /home/szm/.local/bin/cc-worker run \"<task>\" --dir <ticket dir>";
/** Executor Session 的 id 形状；与主包 `worker-<工单 id>` 及 tidy.ts 的判定一致。 */
const WORKER_SESSION = /^worker-/;
/** 这个 agent 是不是 Executor Session（worker）。读不到身份时一律当 worker，宁可误拒。 */
function isWorker(agent) {
	const id = agent?.session?.header?.id;
	if (agent === void 0) return false;
	if (typeof id !== "string") return true;
	return WORKER_SESSION.test(id);
}
/** bash 命令是否只做只读查看，或整条委托给 cc-worker。 */
function bashVerdict(command) {
	const raw = command.trim();
	if (!raw) return void 0;
	if (raw.includes(CC_WORKER) || /^\s*cc-worker\b/.test(raw)) return void 0;
	const text = raw.replace(/2>&1/g, " ").replace(/&?>>?\/dev\/null/g, " ");
	if (/\$\(|`|\$\[/.test(text)) return BASH_DENY;
	if (WRITE_OPS.test(text)) return BASH_DENY;
	for (const part of text.split(/\|\||&&|[;|&\n]/)) {
		const seg = part.trim();
		if (!seg) continue;
		const lead = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
		const cmd = /^(?:\S*\/)?([A-Za-z_][A-Za-z0-9_.-]*)/.exec(lead)?.[1];
		if (!cmd || !READ_ONLY_CMDS.has(cmd)) return BASH_DENY;
	}
}
/** 一次工具调用的裁决：返回字符串即拒绝，返回 undefined 即放行。 */
function workerVerdict(execution) {
	const name = execution?.name;
	if (!name) return void 0;
	if (!isWorker(execution?.agent)) return void 0;
	if (name === "bash") {
		const command = (execution?.arguments)?.command;
		if (typeof command !== "string") return "bash needs a command string";
		return bashVerdict(command);
	}
	if (MEMORY_ONLY_TOOLS.has(name)) return void 0;
	return FILE_WRITE_TOOLS.has(name) || FILE_WRITE_NAME.test(name) ? TOOL_DENY : void 0;
}
/**
* 挂上全局 guard，返回卸载函数。
*
* 用 `ctx.inject(['tools'], ...)` 而不是直接 `ctx.tools`：tools 服务由 DSH 的插件提供，
* 加载顺序不保证；inject 回调会在服务就绪时调用，并在卸载时自动回收。
*/
function installWorkerGuard(ctx) {
	ctx.inject(["tools"], (scope) => {
		scope.effect(() => scope.tools.guard(workerVerdict), "pane: worker 硬限制");
	});
}
/** lane 名只允许安全字符；它来自目录名/计划，防止把奇怪目录当 lane。 */
const LANE_NAME = /^[A-Za-z0-9_-]+$/;
/** team 计划内的并行 lane 命名规范：ccw1、ccw2…… */
const TEAM_LANE = /^ccw([1-9][0-9]*)$/;
/** cc-worker 的并行上限；ccw5 以上不可能出现在 plan 的正常执行范围里。 */
const MAX_TEAM_LANES = 4;
/** 有执行痕迹但超过这么久没有新动作、又没写 result.json，判为失败而不是仍在跑。 */
const LANE_LIVE_MS = 6e5;
/** `.cc-worker` 根目录。 */
function ccRoot(dir) {
	return join(dir, ".cc-worker");
}
/** lane 的状态根：main 与旧版一致，其它 lane 各自一个子目录。 */
function laneDir(ticketDir, lane = "main") {
	return lane === "main" ? ccRoot(ticketDir) : join(ccRoot(ticketDir), "lanes", lane);
}
/** lane 名是否合法（与 cc-worker 的安全字符集一致）。 */
function isValidLaneName(lane) {
	return LANE_NAME.test(lane);
}
/** 读 team-plan.json；文件缺失、不是数组或条目不合规都如实报告，不猜测。 */
function readTeamPlan(ticketDir) {
	const path = join(ccRoot(ticketDir), "team-plan.json");
	const plan = {
		path,
		exists: existsSync(path),
		lanes: [],
		invalid: []
	};
	if (!plan.exists) return plan;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		plan.error = `team-plan.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
		return plan;
	}
	if (!Array.isArray(parsed)) {
		plan.error = "team-plan.json 不是 JSON 数组";
		return plan;
	}
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const raw = item;
		const lane = String(raw.lane ?? "").trim();
		const task = String(raw.task ?? "").replace(/\s+/g, " ").trim();
		if (!lane) continue;
		const entry = {
			lane,
			task
		};
		const match = TEAM_LANE.exec(lane);
		if (match && Number(match[1]) <= MAX_TEAM_LANES && task) plan.lanes.push(entry);
		else plan.invalid.push(entry);
	}
	return plan;
}
/** 读 lane 的 result.json（cc-worker run 的 stdout）；不存在或解析失败返回 undefined。 */
function readLaneResult(dir) {
	let text;
	try {
		text = readFileSync(join(dir, "result.json"), "utf-8").trim();
	} catch {
		return;
	}
	if (!text) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		const lines = text.split("\n");
		for (let i = lines.length - 1; i >= 0 && parsed === void 0; i--) try {
			parsed = JSON.parse(lines[i]);
		} catch {}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
	const raw = parsed;
	return {
		ok: raw.ok === true,
		costUsd: typeof raw.cost_usd === "number" ? raw.cost_usd : void 0,
		turns: typeof raw.num_turns === "number" ? raw.num_turns : void 0,
		sessionId: typeof raw.session_id === "string" ? raw.session_id : void 0,
		error: typeof raw.error === "string" ? raw.error : void 0
	};
}
/** lane 目录里 claude.pid 指向的进程是否还活着。 */
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
/** lane 最近一次执行活动时刻（毫秒）；task.txt 等“已分工”痕迹不算执行。 */
function laneActivity(dir) {
	let newest = 0;
	const consider = (file) => {
		try {
			newest = Math.max(newest, statSync(file).mtimeMs);
		} catch {}
	};
	for (const name of [
		"log.jsonl",
		"session_id",
		"result.json",
		"runs"
	]) consider(join(dir, name));
	return newest;
}
/** 读一个 lane 的 task.txt。 */
function laneTaskFile(dir) {
	try {
		return readFileSync(join(dir, "task.txt"), "utf-8").trim() || void 0;
	} catch {
		return;
	}
}
/** 枚举 `.cc-worker/lanes/` 下的 lane 目录（含 lead），只认安全名。 */
function laneDirs(ticketDir) {
	let entries = [];
	try {
		entries = readdirSync(join(ccRoot(ticketDir), "lanes"), { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.isDirectory() && LANE_NAME.test(entry.name)).map((entry) => entry.name).sort();
}
/** 汇总一个 lane 的存活/完成/失败。 */
function laneView(ticketDir, lane, planTask, now) {
	const dir = laneDir(ticketDir, lane);
	const result = readLaneResult(dir);
	const task = laneTaskFile(dir) ?? planTask;
	const handoff = existsSync(join(dir, "handoff.md"));
	const activity = laneActivity(dir);
	let sessionId;
	try {
		sessionId = readFileSync(join(dir, "session_id"), "utf-8").trim() || void 0;
	} catch {}
	let state;
	if (result) state = result.ok ? "done" : "failed";
	else if (laneAlive(dir)) state = "running";
	else state = activity > 0 || existsSync(join(dir, "session_id")) || existsSync(join(dir, "runs")) ? now - activity <= LANE_LIVE_MS ? "running" : "failed" : "pending";
	return {
		atMs: activity || void 0,
		lane,
		task,
		state,
		ok: result?.ok,
		costUsd: result?.costUsd,
		turns: result?.turns,
		sessionId: result?.sessionId ?? sessionId,
		error: result?.error,
		handoff
	};
}
/**
* 读工单的 team 状态：team-plan.json + 每个 lane 的 task.txt/result.json。
*
* lane 顺序以计划为准（ccw1、ccw2…），计划之外的目录（如 lead、手工 lane）排在后面。
* 这样面板能直接按执行顺序展示存活/完成/失败，而不是靠目录名字典序。
*/
function teamStatus(ticketDir, now = Date.now()) {
	const plan = readTeamPlan(ticketDir);
	const planTasks = new Map(plan.lanes.map((entry) => [entry.lane, entry.task]));
	const seen = /* @__PURE__ */ new Set();
	const lanes = [];
	for (const entry of plan.lanes) {
		if (seen.has(entry.lane)) continue;
		seen.add(entry.lane);
		lanes.push(laneView(ticketDir, entry.lane, entry.task, now));
	}
	for (const lane of laneDirs(ticketDir)) {
		if (seen.has(lane)) continue;
		lanes.push(laneView(ticketDir, lane, planTasks.get(lane), now));
	}
	return {
		plan,
		lanes
	};
}
/** 只要每个 lane 的视图（面板/测试常用）。 */
function listTeamLanes(ticketDir, now = Date.now()) {
	return teamStatus(ticketDir, now).lanes;
}
export { readTeamPlan as a, listTeamLanes as i, isValidLaneName as n, teamStatus as o, laneDir as r, installWorkerGuard as t };
