import { o as teamStatus } from "./guard-C6Yt-xRB.js";
import { n as logKey$1, t as appendLog$1 } from "./log-Co3EtYpg.js";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { key } from "dsh-superagent";
/** 增量读缓存；按目录键。 */
const cache = /* @__PURE__ */ new Map();
const CACHE_TTL_MS = 18e5;
/** 把工具输入压成一行可读文本。 */
function inputText(tool, input) {
	if (!input || typeof input !== "object") return void 0;
	const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description;
	if (typeof pick === "string") return pick.replace(/\s+/g, " ").trim();
}
/** 从事件尾部还原步骤列表与当前动作。 */
function describe(events) {
	const steps = [];
	let pending;
	let lastToolUseId = "";
	let error;
	let sessionId;
	let sawResult = false;
	let resultError = false;
	for (const event of events) {
		if (!sessionId && typeof event.session_id === "string") sessionId = event.session_id;
		if (event.type === "result") {
			sawResult = true;
			if (event.is_error) {
				resultError = true;
				error = String(event.result ?? "").slice(0, 500);
			}
			continue;
		}
		if (event.type === "assistant") {
			const content = event.message?.content ?? [];
			for (const part of content) if (part?.type === "tool_use") {
				if (pending) steps.push(pending);
				const id = String(part.id ?? "");
				pending = {
					step: steps.length + 1,
					tool: String(part.name ?? ""),
					detail: inputText(part.name, part.input),
					done: false,
					id
				};
				lastToolUseId = id;
			}
			continue;
		}
		if (event.type === "tool_progress") {
			const id = String(event.parent_tool_use_id ?? event.tool_use_id ?? "");
			const secs = typeof event.elapsed_time_seconds === "number" ? event.elapsed_time_seconds : void 0;
			if (!!pending && (!id || id === lastToolUseId || id === pending.id)) {
				if (secs !== void 0) pending.elapsedSec = secs;
			} else if (!pending) {
				pending = {
					step: steps.length + 1,
					tool: String(event.tool_name ?? "工具"),
					done: false,
					elapsedSec: secs
				};
				if (id) pending.id = id;
			}
			continue;
		}
		if (event.type === "system" && event.subtype === "task_started") {
			const id = String(event.tool_use_id ?? "");
			if (pending) {
				if (!pending.detail && event.description) pending.detail = event.description;
			} else {
				pending = {
					step: steps.length + 1,
					tool: "后台任务",
					detail: event.description,
					done: false
				};
				if (id) pending.id = id;
			}
			continue;
		}
		if (event.type === "system" && event.subtype === "task_notification") {
			if (pending && event.status === "completed") {
				pending.done = true;
				steps.push(pending);
				pending = void 0;
			}
			continue;
		}
		if (event.type === "user") {
			const content = event.message?.content ?? [];
			for (const part of content) {
				if (part?.type !== "tool_result") continue;
				if (pending) {
					pending.done = true;
					steps.push(pending);
					pending = void 0;
				}
				if (part.is_error && !error) error = (typeof part.content === "string" ? part.content : Array.isArray(part.content) ? part.content.map((item) => String(item?.text ?? "")).join(" ") : "").replace(/\s+/g, " ").slice(0, 500);
			}
		}
	}
	const current = pending;
	return {
		steps,
		current,
		state: sawResult ? resultError ? "error" : "done" : current ? "running" : "thinking",
		error,
		sessionId
	};
}
/** lane 名白名单：与 cc-worker 的校验一致，防路径注入（`..`、`/` 一律拒绝）。 */
const LANE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 把外部传入的 lane 归一成目录名；空 / main / 非法名字都按 main 处理（旧行为）。 */
function normalizeLane(lane) {
	const name = (lane ?? "").trim();
	if (!name || name === "main") return "main";
	return LANE_PATTERN.test(name) ? name : "main";
}
/**
* lane 的工作根目录。
*
* cc-worker `--lane` 的布局（2026-11-11）：
*   main → `<dir>/.cc-worker`
*   其它 → `<dir>/.cc-worker/lanes/<lane>`
* 所有 runs/log/stderr/interrupt/claude.pid 都在这个根下，不能写死 `.cc-worker`。
*/
function workerDir(dir, lane) {
	const name = normalizeLane(lane);
	return name === "main" ? join(dir, ".cc-worker") : join(dir, ".cc-worker", "lanes", name);
}
/** 取目录下最新的 runs/<时间戳>.jsonl；没有则退回 log.jsonl。 */
function latestEventFile(dir, lane) {
	const base = workerDir(dir, lane);
	const runDir = join(base, "runs");
	let newest;
	try {
		for (const name of readdirSync(runDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(runDir, name);
			try {
				const at = statSync(path).mtimeMs;
				if (!newest || at > newest.at) newest = {
					path,
					at
				};
			} catch {}
		}
	} catch {}
	if (newest) return newest.path;
	const log = join(base, "log.jsonl");
	return existsSync(log) ? log : void 0;
}
/** 增量读出事件尾部；缓存按事件文件路径分键，main 与各 lane 互不串。 */
function readTail(file) {
	let stat;
	try {
		stat = statSync(file);
	} catch {
		return {
			events: [],
			mtime: 0,
			size: 0
		};
	}
	const now = Date.now();
	let entry = cache.get(file);
	if (!entry || entry.file !== file || stat.size < entry.size) entry = {
		file,
		size: 0,
		tail: [],
		touched: now
	};
	entry.touched = now;
	let grown = stat.size - entry.size;
	if (grown > 0) {
		grown = Math.min(grown, 524288);
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(grown);
			const start = Math.max(0, stat.size - grown);
			readSync(fd, buffer, 0, grown, start);
			entry.tail = [...entry.tail, ...parseLines(buffer.toString("utf8"), start > 0)].slice(-120);
			entry.size = start + grown;
		} finally {
			closeSync(fd);
		}
	}
	for (const [id, item] of cache) if (item !== entry && now - item.touched > CACHE_TTL_MS) cache.delete(id);
	cache.set(file, entry);
	return {
		events: entry.tail,
		mtime: stat.mtimeMs,
		size: stat.size
	};
}
/** 按行解析；首行可能是半截（从中间开始读），丢掉。 */
function parseLines(text, partialHead) {
	const lines = text.split("\n");
	if (partialHead) lines.shift();
	const events = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed));
		} catch {}
	}
	return events;
}
/** 中断标记路径。 */
const interruptPath = (dir) => join(dir, ".cc-worker", "interrupt");
/** 请求中断：写标记，cc-worker 的旁路监视会杀掉 claude。 */
function requestInterrupt(dir) {
	try {
		writeFileSync(interruptPath(dir), (/* @__PURE__ */ new Date()).toISOString());
		return true;
	} catch {
		return false;
	}
}
/** 清除中断标记（新一轮开始前）。 */
function clearInterrupt(dir) {
	try {
		if (existsSync(interruptPath(dir))) {
			unlinkSync(interruptPath(dir));
			return true;
		}
	} catch {}
	return false;
}
/** 读 cc-worker 的 stderr.log 最后一条有意义的内容。 */
function stderrHint(dir) {
	const path = join(dir, ".cc-worker", "stderr.log");
	try {
		const stat = statSync(path);
		const length = Math.min(stat.size, 4096);
		if (!length) return void 0;
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, stat.size - length);
			const text = buffer.toString("utf8").trim();
			if (!text) return void 0;
			const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.includes("unrecognized_model"));
			return lines.length ? lines[lines.length - 1].slice(0, 300) : void 0;
		} finally {
			closeSync(fd);
		}
	} catch {
		return;
	}
}
/**
* 没有 main 事件流时，用 team lanes 推导一个整体状态。
*
* 否则纯 team 运行（lead/ccwN 各自写 lanes/<lane>/log.jsonl）会被面板当成「未委托」整个藏起来。
*/
function teamState(team) {
	if (!team.lanes.length) return team.plan.exists ? "thinking" : void 0;
	if (team.lanes.some((lane) => lane.state === "running")) return "running";
	if (team.lanes.some((lane) => lane.state === "failed")) return "error";
	if (team.lanes.every((lane) => lane.state === "done")) return "done";
	return "running";
}
/** 汇总一个工单目录的 CC 执行状态。 */
function readCcStatus(dir) {
	const empty = {
		present: false,
		state: "none",
		steps: [],
		interruptRequested: false,
		alert: "none"
	};
	if (!dir) return empty;
	const team = teamStatus(dir);
	const derived = teamState(team);
	const teamPresent = team.lanes.length > 0 || team.plan.exists;
	const file = latestEventFile(dir);
	if (!file) return {
		...empty,
		present: teamPresent,
		state: derived ?? empty.state,
		team,
		interruptRequested: existsSync(interruptPath(dir))
	};
	const { events, mtime } = readTail(file);
	if (!events.length) return {
		...empty,
		present: true,
		state: derived ?? empty.state,
		team,
		interruptRequested: existsSync(interruptPath(dir))
	};
	const described = describe(events);
	const ageMs = Math.max(0, Date.now() - mtime);
	const interruptRequested = existsSync(interruptPath(dir));
	let state = described.state;
	let alert = "none";
	let alertText;
	const settled = state === "done" || state === "error";
	if (!settled && ageMs > 36e5) {
		state = "done";
		alertText = `上次运行在 ${Math.round(ageMs / 6e4)} 分钟前中断，未留下结果`;
	} else if (!settled && ageMs > 6e5) {
		state = "stalled";
		alert = "critical";
		alertText = `Claude Code 已 ${Math.round(ageMs / 6e4)} 分钟没有任何输出，可能已挂死，建议中止并重跑`;
	} else if (!settled && ageMs > 12e4) {
		alert = "warn";
		alertText = `Claude Code 已 ${Math.round(ageMs / 6e4)} 分钟没有新动作，可能卡在某个命令上`;
	} else if (state === "error") {
		alert = "critical";
		alertText = "Claude Code 报告执行失败";
	}
	return {
		present: true,
		state,
		log: file.slice(dir.length + 1),
		sessionId: described.sessionId,
		steps: described.steps.slice(-30),
		current: described.current,
		ageMs,
		at: mtime,
		interruptRequested,
		alert,
		alertText,
		team,
		error: described.error ?? (state === "error" || alert === "critical" ? stderrHint(dir) : void 0)
	};
}
/** 探测一个工单目录的执行活跃度；目录缺失/无产物时返回空对象（不编造信号）。 */
function probeExecutor(dir) {
	const probe = {};
	if (!dir) return probe;
	try {
		const pid = Number(readFileSync(join(dir, ".cc-worker", "claude.pid"), "utf8").trim());
		if (Number.isInteger(pid) && pid > 1) try {
			if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("claude")) probe.alive = true;
		} catch {}
	} catch {}
	const file = latestEventFile(dir);
	if (file) try {
		probe.atMs = statSync(file).mtimeMs;
	} catch {}
	const team = teamStatus(dir);
	if (team.lanes.some((lane) => lane.state === "running")) probe.alive = true;
	for (const lane of team.lanes) if (lane.atMs && (probe.atMs === void 0 || lane.atMs > probe.atMs)) probe.atMs = lane.atMs;
	return probe;
}
/** 把时间戳（ISO 字符串或数字）解析成毫秒；解析不出来返回 undefined。 */
function toMs(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
/**
* 判定一张工单的真实健康度。
*
* 判定顺序：
*   1. 已结束 → ok（不归这里管）
*   2. 没有 assignment 或 pending → idle（正常排队）
*   3. assignment 已 ended / pending → 正常
*   4. assignment 仍是 running，但执行器已交回终态 report（waiting/blocked/failed/ready）→ working（等下一步）
*   5. 执行器仍在动（进程存活 / 事件文件刷新 / 会话新事件）→ working
*   6. 以上都不成立、且超过 ZOMBIE_MS 没有任何新投递或活动 → zombie
*/
function ticketHealth(ticket, now = Date.now(), signals) {
	if (!ticket || ticket.ended) return { health: "ok" };
	if (typeof ticket.assignments === "number") return {
		health: "working",
		detail: "列表视图只有计数，无法判断执行健康度"
	};
	const assignments = Array.isArray(ticket.assignments) ? ticket.assignments : [];
	const assignment = assignments.length ? assignments[assignments.length - 1] : void 0;
	if (!assignment) return {
		health: "idle",
		detail: "还没有开始执行"
	};
	const state = String(assignment.state ?? "");
	const assignmentId = String(assignment.id ?? "");
	const report = String(assignment.report?.state ?? "");
	if (state === "ended" || state === "pending") return {
		health: state === "pending" ? "idle" : "ok",
		assignmentState: state,
		assignmentId
	};
	const delivered = toMs(assignment.deliveredAt) ?? toMs(assignment.startedAt) ?? toMs(assignment.createdAt);
	const lastActive = Math.max(delivered ?? 0, signals?.atMs ?? 0);
	const silentMs = lastActive > 0 ? Math.max(0, now - lastActive) : void 0;
	const base = {
		assignmentState: state,
		assignmentId,
		silentMs
	};
	if (report === "waiting" || report === "blocked" || report === "failed" || report === "ready") return {
		...base,
		health: "working",
		detail: "已交回等待中，可继续投递"
	};
	const expired = silentMs !== void 0 && silentMs > 12e5;
	if (signals?.alive || !expired) return {
		...base,
		health: "working"
	};
	const mins = Math.round((silentMs ?? 0) / 6e4);
	return {
		...base,
		health: "zombie",
		detail: `执行器已 ${mins} 分钟没有任何动静，多半是卡死的僵尸任务；新消息会投进去出不来`
	};
}
// src/schedule.ts
/** KV 前缀：与面板日志的 `pane-log:` 并列，互不干扰。 */
const SCHEDULE_PREFIX = "pane-sched:";
/** 外部插件用普通字符串键即可（kv.ts 明确支持）。 */
const scheduleKey = (id) => `${SCHEDULE_PREFIX}${id}`;
const MINUTE = 6e4;
const DAY = 864e5;
/** 解析 HH:mm；非法返回 undefined。 */
function parseTime(time) {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
	if (!match) return void 0;
	return {
		hour: Number(match[1]),
		minute: Number(match[2])
	};
}
/** 本地某天的零点毫秒，向后偏移 offsetDays 天。 */
function localDayStart$1(ms, offsetDays = 0) {
	const date = new Date(ms);
	date.setDate(date.getDate() + offsetDays);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
/** 某天零点的本地 HH:mm 对应的时间戳。 */
function localAt(dayStartMs, hour, minute) {
	const date = new Date(dayStartMs);
	date.setHours(hour, minute, 0, 0);
	return date.getTime();
}
/**
* 从 fromMs 起算的下一次触发时间。
*
* - `every`：from + N 分钟；
* - `daily`：今天的时间还没到就是今天，否则明天；
* - `weekly`：向后最多找 7 天，命中第一个选中的星期；
* - `at`：一次性时间原样返回；调用方判断是否已过期。
*/
function nextOccurrence(spec, fromMs) {
	const from = Math.max(0, Math.floor(fromMs));
	switch (spec.kind) {
		case "every": return from + Math.max(1, Math.floor(spec.everyMinutes)) * MINUTE;
		case "daily": {
			const time = parseTime(spec.time);
			if (!time) return from + DAY;
			const today = localAt(localDayStart$1(from), time.hour, time.minute);
			return today > from ? today : localAt(localDayStart$1(from, 1), time.hour, time.minute);
		}
		case "weekly": {
			const time = parseTime(spec.time);
			if (!time) return from + 7 * DAY;
			const days = [...new Set(spec.weekdays.map((day) => Math.min(7, Math.max(1, Math.floor(day)))))].sort((a, b) => a - b);
			const todayIso = new Date(from).getDay() || 7;
			for (let offset = 0; offset <= 7; offset += 1) {
				const iso = (todayIso - 1 + offset) % 7 + 1;
				if (!days.includes(iso)) continue;
				const when = localAt(localDayStart$1(from, offset), time.hour, time.minute);
				if (when > from) return when;
			}
			return from + 7 * DAY;
		}
		case "at": {
			const when = Date.parse(spec.at);
			return Number.isFinite(when) ? when : from;
		}
	}
}
// src/index.ts
const name = "dsh-superagent-pane";
const inject = [
	"orchestrator",
	"sessionPersistence",
	"webServer",
	"workspaceRegistry"
];
/** Source id；Thread 键为 `pane:<对话>`。 */
const SOURCE = "pane";
/** 面板对话所属的唯一准入作用域。 */
const ROW = "panel";
/** 面板上报的发送者，代表持有面板令牌的人。 */
const OWNER = "owner";
const ConversationSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, "仅限字母、数字、- 和 _");
const TextSchema = z.string().trim().min(1).max(8e3);
const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** 定时派活的频率与请求体。 */
const ScheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间须为 HH:mm");
const ScheduleSpecSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("every"),
		everyMinutes: z.number().int().min(1).max(43200)
	}).strict(),
	z.object({
		kind: z.literal("daily"),
		time: ScheduleTimeSchema
	}).strict(),
	z.object({
		kind: z.literal("weekly"),
		weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
		time: ScheduleTimeSchema
	}).strict(),
	z.object({
		kind: z.literal("at"),
		at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "一次性时间须为 YYYY-MM-DDTHH:mm")
	}).strict()
]);
const ScheduleIdSchema = z.string().regex(/^[0-9a-f]{12,32}$/);
function paneTrigger(conversation, text, sender = OWNER, mode = "assign", options = {}) {
	const thread = options.thread ?? (mode === "chat" || mode === "note" ? `${conversation}~chat` : conversation);
	return {
		id: key("pane", thread, randomUUID()),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: thread
		}],
		actor: {
			source: SOURCE,
			id: sender
		},
		human: true,
		addressed: "mention",
		at: (/* @__PURE__ */ new Date()).toISOString(),
		text,
		channel: {
			source: SOURCE,
			thread: `${SOURCE}:${thread}`,
			address: { conversation }
		},
		meta: {
			conversation,
			paneMode: mode
		}
	};
}
/**
* 注册 Source kind 时拿到的 SourceContext。`channel.send` 只收到命令运行器，所以 kind 保留这个引用，
* 用它访问支撑对话记录的作用域 KV。
*/
let liveSource;
/** Source kind：一个作用域、没有配置项，回复本身就在本地。 */
const paneKind = {
	kind: SOURCE,
	title: {
		zh: "面板",
		en: "Panel"
	},
	description: {
		zh: "在面板的对话里输入消息即可派活；发了消息就有一个对话，不需要配置。",
		en: "Dispatch work by typing in a panel conversation; a conversation exists once a message names it, with nothing to configure."
	},
	schema: z.object({}).strict(),
	fields: [],
	health: ["pane"],
	scope: () => ({
		listened: true,
		observed: true,
		row: ROW
	}),
	channel: {
		allowed: () => true,
		send: async (_host, message) => {
			const conversation = message?.channel?.address?.conversation;
			if (liveSource && typeof conversation === "string" && conversation) appendLog(liveSource, conversation, {
				id: message.id,
				direction: "out",
				at: (/* @__PURE__ */ new Date()).toISOString(),
				text: String(message.text ?? ""),
				kind: message.kind
			});
			return "sent";
		},
		link: (address) => ({
			url: "",
			label: {
				zh: `面板对话 ${address.conversation ?? ""}`,
				en: `Panel conversation ${address.conversation ?? ""}`
			}
		})
	},
	policy: {
		schema: z.object({ allowed: z.array(z.object({
			id: z.string().trim().min(1).max(200),
			name: z.string().trim().max(100).optional()
		}).strict()).refine((users) => new Set(users.map((user) => user.id)).size === users.length, "发送者 id 不能重复").default([{
			id: OWNER,
			name: "我"
		}]) }).strict(),
		fields: [{
			key: "allowed",
			type: "rows",
			label: {
				zh: "能在面板里派活的人",
				en: "People who may dispatch from the panel"
			},
			columns: [{
				key: "id",
				type: "text",
				label: {
					zh: "发送者",
					en: "Sender"
				},
				pattern: "[A-Za-z0-9_-]+"
			}, {
				key: "name",
				type: "text",
				label: {
					zh: "名字",
					en: "Name"
				},
				optional: true
			}]
		}],
		explicit: {
			zh: "面板只给本团队使用。「派活」模式的消息是明确的请求（自动 explicit，不需要 @ 智能体），直接建单或追加给工单；「对话」模式的消息交给主 Session 分诊，能直接答疑或按规则接活。",
			en: "The panel is for this team only. Messages sent in Dispatch mode are explicit requests (no mention needed) and become or join tickets; messages sent in Chat mode are triaged by the main Session, which answers directly or accepts rule-matched work."
		},
		rows: () => [{
			id: ROW,
			label: {
				zh: "面板对话",
				en: "Panel conversations"
			},
			note: {
				zh: "全部消息",
				en: "Everything"
			},
			cells: {
				listedUnaddressed: true,
				unlistedAddressed: true,
				unlistedUnaddressed: true
			}
		}]
	}
};
/** 读取 JSON 请求体，超过 `limit` 字节即拒绝。 */
async function readJson(req, limit = 65536) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		if (size > limit) throw new Error("请求体过大");
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function sendJson(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(value));
}
/**
* 把消息累积进面板自己的对话记录。
*
* 领域层把入站 Trigger 与出站回执分开存放，而面板的读取接口不在本插件的可达面内，所以对话在这里镜像一份：
* 每个对话一条 KV 记录，设上限，避免长对话把存储撑爆。
*/
const logKey = logKey$1;
const hiddenKey = "pane-hidden";
/** 面板只显示 30 分钟内的收尾通知；更早的属于历史积压。 */
const NOTICE_MAX_AGE_MS = 18e5;
/** 旧版批量收尾通知的长度阈值：超过它的长通知是把几十张工单标题拼在一起，属于污染。 */
const NOTICE_MAX_CHARS = 240;
/** 人手动停止 / 放弃的收尾通知：不再保留在对话区。 */
const SILENT_NOTICE = /已结束：(stopped|dropped|已放弃)/;
/** 定时派活：每 20 秒扫一轮；晚到不超过 10 分钟才补跑，停机更久只记「错过」并推进到下一次。 */
const SCHEDULE_SWEEP_MS = 2e4;
const SCHEDULE_GRACE_MS = 6e5;
/**
* 对话日志统一走 ./log.ts 的共享实现：那边是 2000 条 / 40 万字符双上限并按 id 去重。
* 这里早先各自维护过一份 200 条上限的版本，两处实现互相覆盖、谁后写谁生效，
* 结果长对话被截到 200 条——批量收尾通知一涌进来就把真实消息挤掉。改为单一实现。
*/
const appendLog = appendLog$1;
/** 只读句柄缓存，键为会话 id；增量读取，避免每 2.5 秒轮询都全量解析长会话。 */
const openReads = /* @__PURE__ */ new Map();
/** 空闲这么久（毫秒）的句柄会被关闭，不让缓存无限占用文件。 */
const IDLE_CLOSE_MS = 6e5;
/** 把工具参数 JSON 压成一行可读文本，优先取命令 / 文件路径 / 检索词。 */
function toolText(args) {
	if (typeof args !== "string" || !args) return "";
	try {
		const parsed = JSON.parse(args);
		const value = parsed.command ?? parsed.file_path ?? parsed.path ?? parsed.pattern ?? parsed.query ?? parsed.url ?? parsed.description ?? parsed.text;
		return typeof value === "string" ? value : args;
	} catch {
		return args;
	}
}
/** 从事件尾部往回找最近一个有描述价值的动作。 */
function lastAction(tail) {
	for (let index = tail.length - 1; index >= 0; index--) {
		const event = tail[index];
		const data = event.data ?? {};
		if (event.type === "job/registered") return {
			kind: "job",
			tool: String(data.kind ?? ""),
			text: String(data.label ?? "")
		};
		if (event.type === "tool/call") return {
			kind: "tool",
			tool: String(data.name ?? ""),
			text: toolText(data.arguments)
		};
		if (event.type === "assistant/message") {
			const parts = data.message?.content ?? [];
			const text = parts.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n").trim();
			const call = parts.find((part) => part?.type === "tool-call");
			if (call) return {
				kind: "tool",
				tool: String(call.name ?? ""),
				text: toolText(call.arguments)
			};
			if (text) return {
				kind: "text",
				text
			};
		}
	}
}
/**
* 根据事件尾部判断 worker 状态，并配上一句「在做什么」。
*
* 状态语义：`running` 表示最后一步还没收尾（作业或工具调用仍在进行）；`thinking` 表示模型刚开口或刚进入
* 新步骤；`waiting` 表示上一步已收尾、正等下一步；`idle` 表示没有事件。
*/
function describeActivity(events, now) {
	const tail = events.slice(-80);
	if (!tail.length) return {
		state: "idle",
		kind: null
	};
	const last = tail[tail.length - 1];
	const at = typeof last.time === "number" ? last.time : void 0;
	const type = last.type ?? "";
	return {
		state: type === "job/registered" || type === "tool/call" ? "running" : type === "assistant/message" || type === "step/start" ? "thinking" : "waiting",
		...lastAction(tail) ?? { kind: null },
		at,
		ageMs: at === void 0 ? void 0 : now - at
	};
}
/** 丢弃并关闭一个缓存的只读句柄。 */
function dropRead(sessionId, entry) {
	openReads.delete(sessionId);
	entry.handle.close().catch(() => {});
}
/** 增量读取 worker 会话尾部事件，汇总成当前活动。 */
async function readActivity(persistence, sessionId) {
	const now = Date.now();
	let entry = openReads.get(sessionId);
	if (!entry) {
		entry = {
			handle: await persistence.open(sessionId, "read"),
			offset: 0,
			tail: [],
			touched: now
		};
		openReads.set(sessionId, entry);
	}
	entry.touched = now;
	let events;
	try {
		({events} = await entry.handle.read(entry.offset));
	} catch (error) {
		dropRead(sessionId, entry);
		throw error;
	}
	if (events.length) {
		entry.offset += events.length;
		entry.tail = [...entry.tail, ...events].slice(-80);
	}
	for (const [id, item] of openReads) if (item !== entry && now - item.touched > IDLE_CLOSE_MS) dropRead(id, item);
	return describeActivity(entry.tail, now);
}
/**
* 收集执行器活跃信号：.cc-worker 产物（进程存活 / 事件文件 mtime）+ worker 会话最后事件。
* 长任务执行期间 Assignment 的投递时间戳不再变化，靠这些信号把「还在跑」与「真僵尸」区分开。
*/
async function collectExecutorSignals(ctx, ticket) {
	const signals = {};
	try {
		const dir = String(ticket?.execution?.directory ?? "");
		if (dir) Object.assign(signals, probeExecutor(dir));
	} catch {}
	try {
		const sessionId = String(ticket?.sessionId ?? "");
		if (sessionId) {
			const activity = await readActivity(ctx.sessionPersistence, sessionId);
			const at = typeof activity?.at === "number" ? activity.at : void 0;
			if (at !== void 0) signals.atMs = Math.max(signals.atMs ?? 0, at);
		}
	} catch {}
	return signals;
}
/**
* 读一张工单目录下的协作 lane 状态。
*
* lane 布局（cc-worker --lane 引入，2026-11-11）：
*   <dir>/.cc-worker/{lock,session_id,...}             → lane = main（传统单 worker）
*   <dir>/.cc-worker/lanes/<name>/{lock,session_id,...} → lane = <name>（协作子 worker）
*
* 「在跑」的判据与面板其它地方一致：claude.pid 存在且该 pid 的命令行含 claude。
* 只读目录，不改任何东西；读不到就当没有 lane。
*/
function readLanes(dir) {
	if (!dir) return [];
	const out = [];
	const alive = (base) => {
		try {
			const pid = Number(readFileSync(join(base, "claude.pid"), "utf8").trim());
			if (!Number.isInteger(pid) || pid <= 0) return false;
			return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("claude");
		} catch {
			return false;
		}
	};
	const taskOf = (base) => {
		try {
			const text = readFileSync(join(base, "task.txt"), "utf8").replace(/\s+/g, " ").trim();
			return text ? text.slice(0, 160) : void 0;
		} catch {
			return;
		}
	};
	try {
		const root = join(dir, ".cc-worker");
		if (alive(root)) out.push({
			lane: "main",
			state: "running",
			task: taskOf(root)
		});
		for (const name of readdirSync(join(root, "lanes"), { withFileTypes: true })) {
			if (!name.isDirectory()) continue;
			const base = join(root, "lanes", name.name);
			out.push({
				lane: name.name,
				state: alive(base) ? "running" : "idle",
				task: taskOf(base)
			});
		}
	} catch {}
	return out;
}
/** 按 id 找工单（含已结束的）；读不到就返回 undefined。 */
function findTicket(ctx, ticketId) {
	try {
		const tickets = ctx.orchestrator?.store?.tickets;
		const hit = tickets?.get?.(ticketId);
		if (hit) return hit;
		for (const ticket of tickets?.list?.() ?? []) if (ticket?.id === ticketId) return ticket;
	} catch {}
}
/**
* 会话线程上仍占着订阅、但已经卡死（zombie）的工单。
*
* 引擎 intake 会对线程上每个订阅工单 fanout，model.ts 的 followupOwners 又把「仍存活且非 context」的接收者
* 当成裁决者，于是消息不进 Eval。健康工单的 worker 还能处理，消息应照常并进去；只有 zombie 工单是「占着
* 订阅却永远接不了手」，必须把派活消息改走子线程，否则会被并进死工单、永久搁浅
* （2026-11-03 的 897f223d… 即此：worker 读了不接，工单又一直没结束）。
*/
async function zombieTicketsOnThread(ctx, conversation) {
	const threadKey = `${SOURCE}:${conversation}`;
	const found = [];
	try {
		const thread = ctx.orchestrator?.store?.threads?.get?.(threadKey);
		const subscriptions = Array.isArray(thread?.subscriptions) ? thread.subscriptions : [];
		const context = Array.isArray(thread?.context) ? thread.context : [];
		for (const id of subscriptions) {
			if (context.includes(id)) continue;
			const ticket = ctx.orchestrator?.store?.tickets?.get?.(id);
			if (!ticket || ticket.ended) continue;
			const health = ticketHealth(ticket, Date.now(), await collectExecutorSignals(ctx, ticket));
			if (health.health !== "zombie") continue;
			found.push({
				ticketId: String(id),
				...health.detail ? { detail: health.detail } : {}
			});
		}
	} catch {}
	return found;
}
/**
* 派活消息是否需要改投子线程：**只有会话线程上存在 zombie 工单时**才改投。
* 健康/待命的工单仍按原样接管消息（它的 worker 会处理），不能被绕开成新工单。
* 子线程键 `<对话>~d<base36 时间戳>`：与 chat 的影子线程共享「永不被工单订阅」的性质，但保留派活的 explicit
* 语义，由主 Session 经 Eval 分诊。用毫秒时间戳转 base36 而不是 HHMMSS，避免同一秒内的第二条消息落进已经被
* 新工单订阅的子线程、再次被吞。对话名 schema 不允许 `~`，所以不会与用户自己的对话冲突。
*/
async function divertDispatch(ctx, conversation) {
	const zombies = await zombieTicketsOnThread(ctx, conversation);
	if (!zombies.length) return void 0;
	const thread = `${conversation}~d${Date.now().toString(36)}`;
	const first = zombies[0];
	return {
		thread,
		reason: `该对话的工单 ${first.ticketId} 已卡死（${first.detail ?? "无执行活动"}），消息改由路由器分诊，不会投进这个死工单`
	};
}
/** 面板自己的拒绝错误：带 HTTP 状态码，路由层原样回给前端（409 = 状态冲突，可换模式重试）。 */
var PaneRefusal = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.status = status;
	}
};
/**
* 给消息正文加一段模式约束。
*
* 为什么不靠引擎区分：三种模式在引擎里都是 explicit 请求（见 paneTrigger 注释），只有正文能告诉路由器
* 该建单、该并单还是只答话。约束放最前面并明确写「不要……」的边界，避免路由器按规则把闲聊变成工单。
*/
function composeText(mode, text) {
	if (mode === "note" || mode === "broadcast") return text;
	if (mode === "chat") return "【对话模式：只回答这个问题，不要新建工单、不要 attach 工单、不要派 worker、不要改代码。能直接答就直接答；需要动代码或长期工作的事，建议我用「派活」重发。重要：如果我重复问了同一个问题，说明我没看到你上次的回答——请把答案简短再说一遍，不要因为「已答过」而忽略。】\n" + text;
	return "【派活模式：这是我明确要你去做的任务。若它是本对话进行中工单的补充/追问/修正，就 attach 给那张工单的 worker 继续做；若要动代码、要交付结果、且没有可接手的工单，就新建工单并派给 worker。只答疑、不动代码的问题请直接回答，不必建单。】\n" + text;
}
/**
* 面板路由。
*
* `receive` 与 GitHub、Feishu 两个 Source 用的是同一个入口，所以面板消息走完全相同的路径：准入、路由、工单、worker。
*/
/** 把引擎的 reason（`{code, values?}` 数组）渲染成一句可读文本。 */
function reasonText(reason) {
	if (typeof reason === "string") return reason;
	if (!Array.isArray(reason)) return "";
	return reason.slice(0, 2).map((item) => {
		if (typeof item === "string") return item;
		const code = String(item?.code ?? "");
		const values = item?.values && typeof item.values === "object" ? item.values : {};
		const text = typeof values.text === "string" && values.text ? values.text : "";
		if (text) return text;
		if (code === "routed") return `转交工单 ${String(values.ticket ?? "").slice(0, 8)}`;
		if (code === "startedTicket") return `该工单已在处理 ${String(values.ticket ?? "").slice(0, 8)}`;
		if (code === "forwarded") return "已转交给该线程上的工单 worker";
		if (code === "said") return "";
		return code;
	}).filter(Boolean).join("；");
}
/** 这张工单当前挂在哪些线程上（面板按线程过滤用）。 */
function threadKeysOf(ctx, ticketId) {
	try {
		return (ctx?.orchestrator?.store?.read?.subscribedThreads?.() ?? []).filter((thread) => Array.isArray(thread?.subscriptions) && thread.subscriptions.includes(ticketId)).map((thread) => ({ key: String(thread?.key ?? "") })).filter((item) => item.key);
	} catch {
		return [];
	}
}
/** 工单当前阶段压成面板能直接显示的短状态。 */
function ticketStageOf(ticket) {
	if (ticket?.ended) return "ended";
	return (typeof ticket?.stage === "string" ? ticket.stage : "") || "working";
}
/** 广播单次最多投递的工单数：关键词过宽时不要把全部工单一次打醒。 */
const BROADCAST_MAX = 20;
/**
* 广播前缀：`@广播[关键词] 正文`。也接受 `@broadcast[...]` 与全角括号；
* 关键词可用逗号/顿号分隔多个，任一命中即投；`[全部]`/`[all]` 表示不筛选。
* 匹配口径是「标题 + 执行器任务正文」的子串（忽略大小写）。
*/
const BROADCAST_PATTERN = /^@(?:广播|broadcast)\s*[\[［【(（]\s*([^\]］】)）]{1,80}?)\s*[\]］】)）]\s*([\s\S]*)$/i;
/** 工单侧参与文字匹配的内容：标题 + 执行器收到的任务正文。 */
function ticketMatchText(ticket) {
	return `${typeof ticket?.title === "string" ? ticket.title : ""}\n${typeof ticket?.execution?.assignment === "string" ? ticket.execution.assignment : ""}`.toLowerCase();
}
const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
/** 以本地零点为基准偏移天数。 */
function localDayStart(now, offsetDays = 0) {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	day.setDate(day.getDate() + offsetDays);
	return day.getTime();
}
/**
* 正文里的时间限定词 → 工单创建时间窗。命中后从正文移除，避免「昨晚」被当成普通关键词。
* 顺序即优先级（「昨晚」必须排在「昨天」前面）。
*/
const TIME_RULES = [
	{
		re: /(?:最近|近|过去)\s*(\d+)\s*(?:天|日)/,
		describe: (now, match) => {
			const days = Math.max(1, Math.min(30, Number(match[1]) || 1));
			return {
				label: `最近 ${days} 天`,
				from: now.getTime() - days * DAY_MS,
				to: now.getTime()
			};
		}
	},
	{
		re: /(?:最近|近|过去)\s*(\d+)\s*(?:小时|钟头)/,
		describe: (now, match) => {
			const hours = Math.max(1, Math.min(72, Number(match[1]) || 1));
			return {
				label: `最近 ${hours} 小时`,
				from: now.getTime() - hours * HOUR_MS,
				to: now.getTime()
			};
		}
	},
	{
		re: /昨晚|昨夜|昨天晚上/,
		describe: (now) => ({
			label: "昨晚（昨天 00:00-今天 06:00）",
			from: localDayStart(now, -1),
			to: localDayStart(now, 0) + 6 * HOUR_MS
		})
	},
	{
		re: /前天/,
		describe: (now) => ({
			label: "前天",
			from: localDayStart(now, -2),
			to: localDayStart(now, -1)
		})
	},
	{
		re: /昨天|昨日/,
		describe: (now) => ({
			label: "昨天",
			from: localDayStart(now, -1),
			to: localDayStart(now, 0)
		})
	},
	{
		re: /今早|今晨|早上|上午/,
		describe: (now) => ({
			label: "今天上午",
			from: localDayStart(now, 0),
			to: localDayStart(now, 0) + 12 * HOUR_MS
		})
	},
	{
		re: /下午/,
		describe: (now) => ({
			label: "今天下午",
			from: localDayStart(now, 0) + 12 * HOUR_MS,
			to: localDayStart(now, 0) + 18 * HOUR_MS
		})
	},
	{
		re: /今天|今日|刚才|刚刚/,
		describe: (now) => ({
			label: "今天",
			from: localDayStart(now, 0),
			to: now.getTime()
		})
	},
	{
		re: /本周|这周|这个星期/,
		describe: (now) => {
			const monday = new Date(now);
			monday.setHours(0, 0, 0, 0);
			monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
			return {
				label: "本周",
				from: monday.getTime(),
				to: now.getTime()
			};
		}
	},
	{
		re: /上周|上个星期/,
		describe: (now) => {
			const monday = new Date(now);
			monday.setHours(0, 0, 0, 0);
			monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
			return {
				label: "上周",
				from: monday.getTime() - 7 * DAY_MS,
				to: monday.getTime()
			};
		}
	}
];
new RegExp([
	...[
		"所有",
		"全部",
		"每张",
		"每个",
		"继续",
		"接着",
		"然后",
		"处理",
		"完成",
		"未完成",
		"没完成",
		"运行中",
		"进行中",
		"还没结束",
		"没有结束",
		"工单",
		"任务",
		"工作",
		"相关",
		"问题",
		"内容",
		"东西",
		"事情",
		"一下",
		"一些",
		"帮忙",
		"帮我",
		"我们",
		"你们",
		"他们",
		"她们",
		"它们",
		"这里",
		"那里",
		"这个",
		"那个",
		"这些",
		"那些",
		"哪张",
		"哪个",
		"关于",
		"针对",
		"按照",
		"根据",
		"需要",
		"应该",
		"可以",
		"直接",
		"一起",
		"同时",
		"自动",
		"尽快",
		"优先",
		"清楚",
		"明白",
		"情况",
		"状态",
		"结果"
	],
	"的",
	"了",
	"吗",
	"呢",
	"吧",
	"啊",
	"哦",
	"着",
	"过",
	"把",
	"给",
	"和",
	"与",
	"及",
	"在",
	"对",
	"从",
	"到",
	"是",
	"我",
	"你",
	"要",
	"就",
	"也",
	"都",
	"再",
	"还",
	"没",
	"不",
	"有",
	"这",
	"那",
	"个",
	"张",
	"些"
].join("|"), "g");
/**
* 选出广播的目标工单。
* - 显式 `@广播[a,b]`：直接用给定词；`[全部]/[all]` 不筛；
* - 广播模式：先剥掉时间词和「所有/全部」等限定词，再从正文提取技术词；
* - 时间词只筛工单创建时间（createdAt），不参与文字匹配；
* - 一个技术词都没提取到 → 全量投；提取到但零命中 → 定向广播没有对象，不投。
*/
function selectBroadcastTargets(tickets, text, explicitKeyword) {
	const now = /* @__PURE__ */ new Date();
	let rest = text;
	let timeLabel;
	let fromMs;
	let toMs;
	for (const rule of TIME_RULES) {
		const match = rest.match(rule.re);
		if (!match) continue;
		const info = rule.describe(now, match);
		timeLabel = info.label;
		fromMs = info.from;
		toMs = info.to;
		rest = rest.replace(rule.re, " ");
		break;
	}
	const allKeyword = /^(?:全部|所有|all|every|\*)$/i.test(explicitKeyword.trim());
	allKeyword || /(?:所有|全部|每张|每个)/.test(rest);
	rest = rest.replace(/所有|全部|每张|每个|未完成|没完成|还没结束|没有结束|运行中|进行中|在跑|还在跑/g, " ");
	const tokens = allKeyword ? [] : explicitKeyword.trim() ? explicitKeyword.split(/[,，、;；\s]+/).map((word) => word.trim().toLowerCase()).filter(Boolean) : [];
	if (fromMs === void 0 || toMs === void 0) {
		fromMs = now.getTime() - 12 * HOUR_MS;
		toMs = now.getTime();
		timeLabel = "最近 12 小时";
	}
	const inWindow = (ticket) => {
		if (fromMs === void 0 || toMs === void 0) return true;
		const at = Date.parse(String(ticket?.createdAt ?? ""));
		return Number.isNaN(at) ? true : at >= fromMs && at < toMs;
	};
	const scoped = tickets.filter(inWindow);
	const contentOf = /* @__PURE__ */ new Map();
	for (const ticket of scoped) contentOf.set(ticket.id, ticketMatchText(ticket));
	const hits = /* @__PURE__ */ new Map();
	for (const token of tokens) {
		const set = /* @__PURE__ */ new Set();
		for (const [id, content] of contentOf) if (content.includes(token)) set.add(id);
		hits.set(token, set);
	}
	const textMatched = tokens.length ? scoped.filter((ticket) => tokens.some((token) => hits.get(token).has(ticket.id))) : scoped;
	const anyHit = tokens.length === 0 || tokens.some((token) => hits.get(token).size > 0);
	const live = textMatched.filter((ticket) => !ticket.ended || ticket.ended.by !== "human");
	const stopped = textMatched.filter((ticket) => !!ticket.ended && ticket.ended.by === "human");
	return {
		targets: live,
		criteria: {
			tokens,
			timeLabel,
			mode: allKeyword ? "all" : explicitKeyword.trim() ? "explicit" : "auto"
		},
		autoAll: tokens.length === 0,
		noMatch: tokens.length > 0 && !anyHit,
		matchedTotal: textMatched.length,
		ended: textMatched.length - live.length,
		stopped: stopped.length
	};
}
/**
* 广播消息：先按时间窗与关键词筛出目标，再逐单投递。
*
* 为什么不能复用普通 `source.receive`：同一会话线程上多张 live 工单会让 intake 判定 `ambiguous`，
* 整条消息一张都不投（这正是「一条共同消息所有工单都不响应」的根因）；而一条 Trigger 也只能 attach
* 给一张工单。所以这里为每张工单各建一条独立 Trigger，落在线程 `pane:t<工单id>`（该工单的意见会话，
* 不是共享的会话线程），再直接调用引擎的 `attach` 把消息作为 Input 交给它——与路由器
* `orchestrator_route attach` 走同一条路径，不经过 Eval、不依赖模型分诊。`channel` 仍指回用户发消息
* 的原对话，worker 的回复会显示在那里。
*/
async function broadcastByTitle(ctx, conversation, keyword, text) {
	const store = ctx?.orchestrator?.store;
	const engine = ctx?.orchestrator?.engine;
	if (typeof store?.tickets?.list !== "function" || typeof store?.triggers?.save !== "function" || typeof engine?.attach !== "function") throw new Error("宿主未提供广播所需的工单/引擎接口");
	const selection = selectBroadcastTargets(store.tickets.list().filter((ticket) => typeof ticket?.id === "string" && ticket.id && typeof ticket?.title === "string"), text, keyword);
	const targets = [...selection.targets].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))).slice(0, BROADCAST_MAX);
	const scope = [selection.criteria.timeLabel ? `时间窗「${selection.criteria.timeLabel}」` : "", selection.criteria.tokens.length ? `关键词「${selection.criteria.tokens.join("、")}」` : ""].filter(Boolean).join(" + ") || "最近 12 小时";
	const delivered = [];
	const failed = [];
	for (const ticket of targets) {
		const title = String(ticket.title).trim();
		const trigger = paneTrigger(conversation, `【广播给工单「${title}」(${ticket.id})：这条消息按${scope}筛选后同时投给了多张工单，请按本工单的上下文处理，不要新建工单】
${text}`, OWNER, "note", { thread: `t${ticket.id}` });
		try {
			store.triggers.save(trigger);
			engine.attach(ticket.id, trigger.id, `面板广播（${scope}）`);
			delivered.push({
				ticketId: ticket.id,
				title
			});
		} catch (error) {
			failed.push({
				ticketId: ticket.id,
				title,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return {
		keyword,
		criteria: selection.criteria,
		autoAll: selection.autoAll,
		noMatch: selection.noMatch,
		matched: selection.matchedTotal,
		ended: selection.ended,
		stopped: selection.stopped,
		overLimit: selection.targets.length - targets.length,
		delivered,
		failed
	};
}
/** 读出全部定时任务，按下次触发时间升序；扫描与面板列表共用同一份校验。 */
function readSchedules(state) {
	const items = [];
	for (const key of state.keys("pane-sched:") ?? []) {
		const record = state.get(key);
		if (record && typeof record.id === "string" && typeof record.conversation === "string" && typeof record.text === "string" && record.spec && typeof record.nextAtMs === "number") items.push(record);
	}
	return items.sort((a, b) => a.nextAtMs - b.nextAtMs);
}
/** 写入一条任务；同 id 覆盖。 */
function writeSchedule(state, record) {
	state.set(scheduleKey(record.id), record);
}
/** 删除一条任务（state.set 传 undefined 即删行）。 */
function deleteSchedule(state, id) {
	state.set(scheduleKey(id), void 0);
}
/**
* 面板发送与定时派活的唯一实现。抽出来是为了让定时器与 HTTP 路由走**完全相同**的一条路：
* 广播展开、僵尸改投、投递前解档、Trigger 构造、对话日志，一处改动两边同时生效。
*
* 定时来源会在入站日志上标 `status: 'scheduled'`，面板据此显示「定时」徽标。
*/
async function dispatchPaneMessage(ctx, body, origin = "panel") {
	const mode = body.mode === "dispatch" ? "assign" : body.mode;
	const source = ctx.orchestrator.context({
		kind: SOURCE,
		health: ["pane"]
	});
	const matched = mode === "assign" ? BROADCAST_PATTERN.exec(body.text) : null;
	if (mode === "broadcast" || matched) {
		const keyword = matched ? matched[1].trim() : "";
		const content = (matched ? matched[2] : body.text).trim();
		if (mode === "assign" && !keyword) throw new Error("广播关键词不能为空：请写成 @广播[关键词] 正文");
		if (!content) throw new Error(mode === "broadcast" ? "广播内容不能为空" : "广播内容不能为空：请写成 @广播[关键词] 正文");
		const result = await broadcastByTitle(ctx, body.conversation, keyword, content);
		const at = (/* @__PURE__ */ new Date()).toISOString();
		const basis = [result.criteria.timeLabel ? `时间窗「${result.criteria.timeLabel}」` : "", result.criteria.tokens.length ? `关键词「${result.criteria.tokens.join("、")}」` : ""].filter(Boolean).join(" + ");
		const notice = result.delivered.length ? `已广播给 ${result.delivered.length} 张工单：${result.delivered.map((item) => `「${item.title}」`).join("、")}` + (result.criteria.mode === "all" ? "（范围内全部工单）" : basis ? `（筛选依据：${basis}）` : "") + (result.autoAll ? `（${basis || "默认范围"}内全部工单，含已结束可唤醒的）` : "") + (result.stopped ? `；另有 ${result.stopped} 张已被人停止、无法唤醒，未投递` : "") + (result.ended ? `；另有 ${result.ended} 张不符合条件，未投递` : "") + (result.overLimit ? `；超过单次上限 ${result.overLimit} 张未投递` : "") + (result.failed.length ? `；投递失败 ${result.failed.length} 张：${result.failed.map((item) => `「${item.title}」`).join("、")}` : "") : result.noMatch ? `没有工单匹配${basis ? `（${basis}）` : ""}，未广播` : result.matched ? `范围内的 ${result.matched} 张工单都已结束且无法唤醒${result.stopped ? `（其中 ${result.stopped} 张被人停止）` : ""}，未广播` : `${basis || "最近 12 小时"}内没有符合条件的工单，未广播`;
		appendLog(source, body.conversation, {
			id: `broadcast-${randomUUID()}`,
			direction: "in",
			at,
			text: body.text,
			mode: "broadcast",
			...origin === "schedule" ? { status: "scheduled" } : {}
		});
		appendLog(source, body.conversation, {
			id: `broadcast-notice-${randomUUID()}`,
			direction: "out",
			at,
			text: notice,
			kind: "broadcast"
		});
		return {
			broadcast: true,
			thread: `${SOURCE}:${body.conversation}`,
			received: result.delivered.length ? "stored" : "none",
			notice,
			...result
		};
	}
	const conversation = body.conversation;
	const diverted = mode === "assign" ? await divertDispatch(ctx, conversation) : void 0;
	await wakeThreadSessions(ctx, conversation);
	const trigger = paneTrigger(conversation, composeText(mode, body.text), OWNER, mode, diverted ? { thread: diverted.thread } : {});
	appendLog(source, conversation, {
		id: trigger.id,
		direction: "in",
		at: trigger.at,
		text: body.text,
		mode,
		...origin === "schedule" ? { status: "scheduled" } : {}
	});
	const received = await source.receive(trigger);
	return {
		triggerId: trigger.id,
		thread: `${SOURCE}:${trigger.threads[0].id}`,
		received,
		mode,
		...diverted ? { diverted: diverted.reason } : {}
	};
}
/** 到点扫描：晚到 10 分钟内补跑，停机更久只记录「错过」并推进；单条异常不打断其它任务。 */
async function runDueSchedules(ctx) {
	const state = (liveSource ?? ctx.orchestrator?.context({
		kind: SOURCE,
		health: ["pane"]
	}))?.state;
	if (!state?.keys) return;
	const now = Date.now();
	for (const record of readSchedules(state)) {
		if (!record.enabled || record.nextAtMs > now) continue;
		const overdue = now - record.nextAtMs;
		if (overdue > SCHEDULE_GRACE_MS) {
			record.lastAt = new Date(now).toISOString();
			record.lastResult = `错过：服务停机约 ${Math.max(1, Math.round(overdue / 6e4))} 分钟，未执行`;
			if (record.spec.kind === "at") record.enabled = false;
			else record.nextAtMs = nextOccurrence(record.spec, now);
			writeSchedule(state, record);
			continue;
		}
		try {
			const outcome = await dispatchPaneMessage(ctx, {
				conversation: record.conversation,
				text: record.text,
				mode: record.mode
			}, "schedule");
			record.lastAt = new Date(now).toISOString();
			record.lastResult = outcome?.broadcast ? String(outcome.notice ?? "已广播") : "已派发";
		} catch (error) {
			record.lastAt = new Date(now).toISOString();
			record.lastResult = `失败：${error instanceof Error ? error.message : String(error)}`;
		}
		if (record.spec.kind === "at") record.enabled = false;
		else record.nextAtMs = nextOccurrence(record.spec, now);
		writeSchedule(state, record);
	}
}
function paneHandler(ctx) {
	return async (req, res) => {
		if (req.headers["x-orchestrator-request"] !== "1") {
			sendJson(res, 403, { error: "Same-origin management request required" });
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		const source = ctx.orchestrator.context({
			kind: SOURCE,
			health: ["pane"]
		});
		try {
			if (req.method === "POST" && url.pathname === "/orchestrator/api/pane/message") {
				sendJson(res, 200, await dispatchPaneMessage(ctx, z.object({
					conversation: ConversationSchema,
					text: TextSchema,
					mode: z.enum([
						"dispatch",
						"chat",
						"broadcast",
						"assign",
						"note"
					]).default("dispatch")
				}).parse(await readJson(req)), "panel"));
				return;
			}
			const activityMatch = /^\/orchestrator\/api\/pane\/activity\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
			if (req.method === "GET" && activityMatch) {
				const sessionId = SessionIdSchema.parse(activityMatch[1]);
				sendJson(res, 200, {
					sessionId,
					activity: await readActivity(ctx.sessionPersistence, sessionId)
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/orchestrator/api/pane/conversations") {
				const conversations = [];
				for (const key of source.state.keys("pane-log:")) {
					const name = String(key).slice(9);
					if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
					const entries = source.state.get(logKey(name)) ?? [];
					if (!entries.length) continue;
					const last = entries[entries.length - 1];
					conversations.push({
						name,
						count: entries.length,
						lastAt: last.at
					});
				}
				conversations.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
				sendJson(res, 200, { conversations: conversations.slice(0, 50) });
				return;
			}
			const logMatch = /^\/orchestrator\/api\/pane\/log\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
			if (req.method === "GET" && logMatch) {
				const conversation = logMatch[1];
				const entries = source.state.get(logKey(conversation)) ?? [];
				const store = ctx.orchestrator?.store;
				const annotated = entries.map((entry) => {
					if (entry.direction !== "in") return entry;
					try {
						const disposition = store?.triggers?.disposition?.(entry.id);
						if (!disposition) return entry;
						const out = { ...entry };
						const decisionId = String(disposition.decisionId ?? "");
						if (decisionId && typeof store?.decisions?.get === "function") {
							const decision = store.decisions.get(decisionId);
							if (decision) {
								out.decision = {
									kind: decision.kind,
									reason: reasonText(decision.reason)
								};
								const ticketId = String(decision.ticketId ?? "");
								const ticket = ticketId && typeof store?.tickets?.get === "function" ? store.tickets.get(ticketId) : void 0;
								if (ticket) out.outcome = ticket.ended ? String(ticket.ended.outcome ?? "ended") : ticketStageOf(ticket);
							}
						} else if (disposition.evalId) out.decision = { kind: "evaluating" };
						return out;
					} catch {
						return entry;
					}
				});
				sendJson(res, 200, {
					conversation,
					thread: `${SOURCE}:${conversation}`,
					items: annotated
				});
				return;
			}
			const cleanMatch = /^\/orchestrator\/api\/pane\/log\/([A-Za-z0-9_-]+)\/clean$/.exec(url.pathname);
			if (req.method === "POST" && cleanMatch) {
				const conversation = cleanMatch[1];
				const entries = source.state.get(logKey(conversation)) ?? [];
				const since = Date.now() - NOTICE_MAX_AGE_MS;
				const polluted = (entry) => {
					if (entry.direction === "in") return false;
					if (entry.kind !== "notice" && entry.kind !== "broadcast") return false;
					const text = String(entry.text ?? "");
					if (text.length > NOTICE_MAX_CHARS || SILENT_NOTICE.test(text)) return true;
					return !(Date.parse(String(entry.at ?? "")) >= since);
				};
				const kept = entries.filter((entry) => !polluted(entry));
				if (kept.length !== entries.length) source.state.set(logKey(conversation), kept);
				sendJson(res, 200, {
					conversation,
					removed: entries.length - kept.length,
					kept: kept.length
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/orchestrator/api/pane/tickets") {
				const state = url.searchParams.get("state") === "ended" ? "ended" : "open";
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30) || 30, 1), 200);
				const store = ctx.orchestrator?.store;
				const all = state === "ended" ? (store?.tickets?.list?.() ?? []).filter((t) => !!t?.ended) : store?.tickets?.open?.() ?? [];
				all.sort((a, b) => String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")));
				const unreadOf = (ticket) => {
					const inputs = Array.isArray(ticket?.inputs) ? ticket.inputs : [];
					const ids = /* @__PURE__ */ new Set();
					for (const item of inputs) if (!item?.readAt && item?.id) ids.add(String(item.id));
					else if (!item?.readAt) ids.add(`idx:${ids.size}`);
					for (const id of Array.isArray(ticket?.undelivered) ? ticket.undelivered : []) ids.add(String(id));
					return ids.size;
				};
				sendJson(res, 200, {
					items: all.slice(0, limit).map((ticket) => ({
						id: ticket.id,
						title: ticket.title,
						stage: ticketStageOf(ticket),
						state: ticket.ended ? "ended" : "open",
						ended: ticket.ended,
						createdAt: ticket.createdAt,
						updatedAt: ticket.updatedAt,
						summary: typeof ticket?.assignments?.slice?.(-1)?.[0]?.report?.summary === "string" ? ticket.assignments.slice(-1)[0].report.summary : "",
						sessionId: Array.isArray(ticket?.assignments) && ticket.assignments.some((a) => a?.startedAt) ? `worker-${ticket.id}` : "",
						inputs: Array.isArray(ticket?.inputs) ? ticket.inputs.length : 0,
						undelivered: Array.isArray(ticket?.undelivered) ? ticket.undelivered.length : 0,
						unread: unreadOf(ticket),
						threads: threadKeysOf(ctx, ticket.id)
					})),
					total: all.length
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/orchestrator/api/pane/hidden") {
				sendJson(res, 200, { ids: source.state.get(hiddenKey) ?? [] });
				return;
			}
			if (req.method === "GET" && url.pathname === "/orchestrator/api/pane/crew") {
				const tickets = ctx.orchestrator?.store?.tickets;
				const live = [];
				try {
					for (const ticket of tickets?.list?.() ?? []) {
						const assignments = Array.isArray(ticket.assignments) ? ticket.assignments : [];
						const last = assignments.length ? assignments[assignments.length - 1] : void 0;
						const state = String(last?.state ?? "idle");
						const lanes = readLanes(String(ticket.execution?.directory ?? ""));
						const ended = !!ticket?.ended;
						if (ended && lanes.length === 0) continue;
						live.push({
							ticketId: String(ticket.id),
							title: String(ticket.title ?? "").slice(0, 80),
							assignment: state,
							working: !ended && state === "running",
							sessionId: typeof ticket.sessionId === "string" ? ticket.sessionId : void 0,
							lanes
						});
					}
				} catch {}
				const active = live.filter((item) => item.working).length;
				const workers = live.reduce((sum, item) => sum + item.lanes.filter((lane) => lane.state === "running").length, 0);
				sendJson(res, 200, {
					tickets: live.length,
					active,
					queued: live.filter((item) => item.assignment === "pending").length,
					workers,
					items: live.sort((a, b) => Number(b.working) - Number(a.working))
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/orchestrator/api/pane/hide") {
				const body = z.object({ ticketId: z.string().regex(/^[A-Za-z0-9_-]+$/) }).parse(await readJson(req));
				const next = [...(source.state.get(hiddenKey) ?? []).filter((id) => id !== body.ticketId), body.ticketId].slice(-200);
				source.state.set(hiddenKey, next);
				sendJson(res, 200, {
					hidden: true,
					count: next.length
				});
				return;
			}
			const healthMatch = /^\/orchestrator\/api\/pane\/health\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
			if (req.method === "GET" && healthMatch) {
				const ticket = findTicket(ctx, healthMatch[1]);
				if (!ticket) {
					sendJson(res, 404, { error: "ticket not found" });
					return;
				}
				const signals = await collectExecutorSignals(ctx, ticket);
				sendJson(res, 200, {
					ticketId: healthMatch[1],
					stage: ticket.stage ?? null,
					health: ticketHealth(ticket, Date.now(), signals)
				});
				return;
			}
			const ccMatch = /^\/orchestrator\/api\/pane\/cc\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
			if (req.method === "GET" && ccMatch) {
				const ticketId = ccMatch[1];
				const ticket = findTicket(ctx, ticketId);
				if (!ticket) {
					sendJson(res, 404, { error: "ticket not found" });
					return;
				}
				const dir = String(ticket.execution?.directory ?? "");
				if (!dir) {
					sendJson(res, 200, {
						ticketId,
						directory: "",
						cc: {
							present: false,
							state: "none",
							steps: [],
							interruptRequested: false,
							alert: "none"
						}
					});
					return;
				}
				sendJson(res, 200, {
					ticketId,
					directory: dir,
					cc: readCcStatus(dir)
				});
				return;
			}
			const ccStop = /^\/orchestrator\/api\/pane\/cc\/([A-Za-z0-9_-]+)\/(interrupt|clear)$/.exec(url.pathname);
			if (req.method === "POST" && ccStop) {
				const ticket = findTicket(ctx, ccStop[1]);
				if (!ticket) {
					sendJson(res, 404, { error: "ticket not found" });
					return;
				}
				const dir = String(ticket.execution?.directory ?? "");
				if (!dir) {
					sendJson(res, 400, { error: "ticket has no execution directory" });
					return;
				}
				const ok = ccStop[2] === "interrupt" ? requestInterrupt(dir) : clearInterrupt(dir);
				sendJson(res, 200, {
					ticketId: ccStop[1],
					action: ccStop[2],
					ok
				});
				return;
			}
			if (url.pathname === "/orchestrator/api/pane/schedules" && req.method === "GET") {
				const wanted = url.searchParams.get("conversation") ?? "";
				sendJson(res, 200, {
					items: readSchedules(source.state).filter((item) => !wanted || item.conversation === wanted),
					now: Date.now()
				});
				return;
			}
			if (url.pathname === "/orchestrator/api/pane/schedules" && req.method === "POST") {
				const body = z.object({
					conversation: ConversationSchema,
					text: TextSchema,
					mode: z.enum([
						"dispatch",
						"chat",
						"broadcast",
						"assign",
						"note"
					]).default("dispatch"),
					spec: ScheduleSpecSchema
				}).parse(await readJson(req));
				const now = Date.now();
				const nextAtMs = nextOccurrence(body.spec, now);
				if (body.spec.kind === "at" && nextAtMs <= now) throw new Error("指定时间已经过去，请改到将来");
				const record = {
					id: randomUUID().replace(/-/g, ""),
					conversation: body.conversation,
					text: body.text,
					mode: body.mode,
					spec: body.spec,
					enabled: true,
					createdAt: new Date(now).toISOString(),
					nextAtMs
				};
				writeSchedule(source.state, record);
				sendJson(res, 200, { schedule: record });
				return;
			}
			const scheduleMatch = /^\/orchestrator\/api\/pane\/schedules\/([0-9a-f]{12,32})\/(toggle|run|delete)$/.exec(url.pathname);
			if (req.method === "POST" && scheduleMatch) {
				const id = ScheduleIdSchema.parse(scheduleMatch[1]);
				const action = scheduleMatch[2];
				const record = source.state.get(scheduleKey(id));
				if (!record) {
					sendJson(res, 404, { error: "没有这条定时任务" });
					return;
				}
				if (action === "toggle") {
					const body = z.object({ enabled: z.boolean() }).parse(await readJson(req));
					if (body.enabled && record.nextAtMs <= Date.now()) {
						if (record.spec.kind === "at") throw new Error("指定时间已经过去，不能再启用；请重新创建");
						record.nextAtMs = nextOccurrence(record.spec, Date.now());
					}
					record.enabled = body.enabled;
					writeSchedule(source.state, record);
					sendJson(res, 200, { schedule: record });
					return;
				}
				if (action === "delete") {
					deleteSchedule(source.state, id);
					sendJson(res, 200, {
						deleted: true,
						id
					});
					return;
				}
				const outcome = await dispatchPaneMessage(ctx, {
					conversation: record.conversation,
					text: record.text,
					mode: record.mode
				}, "schedule");
				record.lastAt = (/* @__PURE__ */ new Date()).toISOString();
				record.lastResult = outcome?.broadcast ? String(outcome.notice ?? "已广播") : "已派发";
				if (record.spec.kind === "at") record.enabled = false;
				writeSchedule(source.state, record);
				sendJson(res, 200, {
					schedule: record,
					outcome
				});
				return;
			}
			sendJson(res, 404, { error: "Unknown pane operation" });
		} catch (error) {
			sendJson(res, error instanceof PaneRefusal ? error.status : 400, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/** 自愈检查间隔；一次只是内存数组查找，代价可忽略。 */
const UNARCHIVE_SWEEP_MS = 3e4;
/** 搁浅消息自愈：检查间隔、工单「失去接手能力」多久内才重投、pane-log 最长回溯、每轮上限、每轮最多扫多少个对话。 */
const STRANDED_SWEEP_MS = 3e4;
/**
* 重投窗口的基准是「占用它的工单失去接手能力的时间」（工单 ended.at，或僵尸工单的当前时间），
* **不是消息发送时间**。旧实现按 `entry.at` 算窗口，导致「消息发出很久、但工单刚刚才结束/卡死」的消息
* 永远进不了窗口——这正是 897f223d… 永久丢失的原因（发送于 16:32，工单次日 03:20 才结束）。
*/
const STRANDED_WINDOW_MS = 36e5;
/** pane-log 条目的最长回溯：发送时间解析不出来、或早于这个年龄的条目不参与自愈。 */
const STRANDED_MAX_AGE_MS = 6048e5;
const STRANDED_MAX_PER_SWEEP = 3;
const STRANDED_RECOVERED_TEXT = "这条消息之前被并进了运行中的工单但一直没被接手，已重新交给路由器分诊。";
/** 需要保护的会话：主 Session + 所有活跃工单的 worker 会话（都被归档过就一定有东西停摆）。 */
function protectedSessions(ctx) {
	const ids = [];
	try {
		if (typeof ctx.orchestrator?.masterId === "string" && ctx.orchestrator.masterId) ids.push(ctx.orchestrator.masterId);
	} catch {}
	try {
		for (const ticket of ctx.orchestrator?.store?.tickets?.open?.() ?? []) {
			const sid = typeof ticket?.sessionId === "string" && ticket.sessionId ? ticket.sessionId : typeof ticket?.id === "string" && ticket.id ? `worker-${ticket.id}` : "";
			if (sid) ids.push(sid);
		}
	} catch {}
	return ids;
}
/** 一次自愈扫描：发现受保护会话被归档就立刻取消归档，并如实记日志。 */
async function unarchiveSweep(ctx) {
	for (const id of protectedSessions(ctx)) {
		if (!ctx.workspaceRegistry.archivedSessionIds.includes(id)) continue;
		await ctx.workspaceRegistry.unarchiveSession(id);
		ctx.logger?.info?.("dsh-superagent-pane: 已自动取消归档会话 %s（被归档的会话无法运行任何回合，会让派活链路静默瘫痪）", id);
	}
}
/**
* 投递前先手解档：把该对话线程相关工单的 worker 会话从归档里解出来。
*
* 与自愈扫描同因：收尾插件（tidy）会把已结束工单的 worker 会话归档（并以 stopActivity 终止残留活动），
* 归档会话跑不了任何回合——对它的迟到投递只会让回合约 40ms 内以 blocked 结束、消息被消费后无人再唤醒，
* 表现为「跟进已结束工单，但工单永远停在 idle」。面板是跟进已结束工单的主要入口，所以在把 trigger
* 交给引擎之前先解档，让回合真的能开跑。筛选口径对齐引擎 intake 的 fanout：线程上所有跟随该线程的
* 工单（`follows`，兼容读 `threads` 形状），跳过人停的（对它们消息本来就不投，见 `resumes` 条件）。
*/
async function wakeThreadSessions(ctx, conversation) {
	try {
		const registry = ctx.workspaceRegistry;
		const archived = registry?.archivedSessionIds ?? [];
		if (!archived.length) return;
		const threadKey = `${SOURCE}:${conversation}`;
		const triggersRepo = ctx.orchestrator?.store?.triggers;
		const triggerMatches = (ticket) => {
			const triggerId = ticket?.origin?.triggerId;
			if (!triggerId || typeof triggersRepo?.get !== "function") return false;
			const trigger = triggersRepo.get(triggerId);
			return (Array.isArray(trigger?.threads) ? trigger.threads : []).some((ref) => `${ref?.source}:${ref?.id}` === threadKey);
		};
		const followsThread = (ticket) => {
			if (triggerMatches(ticket)) return true;
			if ((Array.isArray(ticket?.follows) ? ticket.follows : []).some((entry) => entry?.thread === threadKey)) return true;
			return (Array.isArray(ticket?.threads) ? ticket.threads : []).some((entry) => entry?.key === threadKey);
		};
		const tickets = ctx.orchestrator?.store?.tickets;
		const seen = /* @__PURE__ */ new Set();
		const all = [...tickets?.open?.() ?? [], ...tickets?.list?.() ?? []];
		for (const ticket of all) {
			const id = String(ticket?.id ?? "");
			if (!id || seen.has(id)) continue;
			seen.add(id);
			if (ticket?.ended?.by === "human") continue;
			if (!followsThread(ticket)) continue;
			const sessionId = `worker-${id}`;
			if (!archived.includes(sessionId)) continue;
			await registry.unarchiveSession(sessionId);
			ctx.logger?.info?.("dsh-superagent-pane: 投递前已解档会话 %s（跟进已结束工单需要唤醒它的 worker 会话）", sessionId);
		}
	} catch {}
}
/**
* 搁浅消息自愈：把「并进了工单、但工单已结束/卡死、worker 从未接手」的派活消息重新交给路由器。
*
* 触发条件仅为 disposition 中有 fanout、无 evalId/decisionId/requeued/acked，且 fanout 里所有工单都已结束或被
* 判定为 zombie。只要还有一张工单存活且非 zombie，就跳过：它仍可能接手，提前重投会制造重复工单。
* `reevaluate` 会把 trigger 标记 requeued，followupOwners 因此返回空，主 Session 的 accept 不会再被
* workerDecides 挡住（core/part.ts）。每轮最多处理 3 条，任何单条失败都不影响其它条目。
*
* 窗口按「工单失去接手能力的时间」算：`latestLostAt` = 各 fanout 工单里最晚的那个时刻（已 ended 取
* `ended.at`，僵尸工单取当前时间）。只有它落在最近 `STRANDED_WINDOW_MS` 内才重投——这样工单刚结束的消息
* 能被救回，而重启时不会把几小时前甚至几天前的死消息一次性全部重投。消息本身的发送时间只用来做
* `STRANDED_MAX_AGE_MS` 的兜底回溯上限。
*/
async function recoverStranded(ctx) {
	const source = liveSource;
	const store = ctx.orchestrator?.store;
	const engine = ctx.orchestrator?.engine;
	if (!source?.state?.keys || typeof store?.triggers?.get !== "function" || typeof store?.triggers?.disposition !== "function" || typeof engine?.reevaluate !== "function") return;
	const tickets = store.tickets;
	const now = Date.now();
	const cutoff = now - STRANDED_WINDOW_MS;
	const oldest = now - STRANDED_MAX_AGE_MS;
	let handled = 0;
	const keys = [...source.state.keys("pane-log:") ?? []].slice(-100);
	for (const logKeyValue of keys) {
		if (handled >= STRANDED_MAX_PER_SWEEP) break;
		const entries = source.state.get(logKeyValue) ?? [];
		for (let index = entries.length - 1; index >= 0 && handled < STRANDED_MAX_PER_SWEEP; index--) {
			const entry = entries[index];
			try {
				if (entry.direction !== "in" || !["dispatch", "assign"].includes(String(entry.mode))) continue;
				const sentAt = entry.at ? Date.parse(entry.at) : NaN;
				if (!Number.isFinite(sentAt) || sentAt < oldest) continue;
				const trigger = store.triggers.get(entry.id);
				if (!trigger) continue;
				const disposition = store.triggers.disposition(entry.id);
				if (!disposition || disposition.evalId || disposition.decisionId || disposition.requeued || disposition.acked?.length) continue;
				const fanout = Array.isArray(disposition.fanout) ? disposition.fanout : [];
				if (!fanout.length) continue;
				const returned = (disposition.handbacks ?? []).map((item) => String(item?.ticketId ?? ""));
				if (fanout.every((id) => returned.includes(id))) continue;
				let viable = false;
				let latestLostAt = Number.NEGATIVE_INFINITY;
				for (const ticketId of fanout) {
					const ticket = tickets?.get?.(ticketId);
					if (!ticket) continue;
					if (ticket.ended) {
						const endedAt = Date.parse(String(ticket.ended.at ?? ""));
						if (Number.isFinite(endedAt)) latestLostAt = Math.max(latestLostAt, endedAt);
						continue;
					}
					if (ticketHealth(ticket, now, await collectExecutorSignals(ctx, ticket)).health !== "zombie") {
						viable = true;
						break;
					}
					latestLostAt = Math.max(latestLostAt, now);
				}
				if (viable) continue;
				if (!(latestLostAt >= cutoff)) continue;
				handled += 1;
				if (engine.reevaluate(entry.id) !== true) continue;
				const address = trigger.channel?.address?.conversation;
				const conversation = typeof address === "string" && address ? address : logKeyValue.slice(9);
				appendLog(source, conversation, {
					id: `recovered:${entry.id}`,
					direction: "out",
					at: (/* @__PURE__ */ new Date()).toISOString(),
					text: STRANDED_RECOVERED_TEXT,
					kind: "recovered"
				});
				ctx.logger?.info?.("dsh-superagent-pane: 已重新入队搁浅消息 %s（对话 %s）", entry.id, conversation);
			} catch (error) {
				ctx.logger?.warn?.("dsh-superagent-pane: 搁浅消息检查失败 %s", String(error));
			}
		}
	}
}
/**
* 读 /proc/meminfo（可选 /proc/loadavg），算面板小部件要的内存指标。
*
* 口径与 mem-watch.py、云厂商监控一致：usage_pct = (MemTotal - MemAvailable) / MemTotal * 100。
* 与 `free` 的 used 不同——`free` 扣掉了可回收的 SReclaimable，数值会偏低。
* 只读、无副作用；任何读取失败由调用方兜成 500 JSON。
*/
function readSysMem() {
	const fields = {};
	for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
		const at = line.indexOf(":");
		if (at < 0) continue;
		const value = Number.parseFloat(line.slice(at + 1).trim());
		if (Number.isFinite(value)) fields[line.slice(0, at).trim()] = value;
	}
	const total = fields.MemTotal ?? 0;
	const available = fields.MemAvailable ?? 0;
	const swapTotal = fields.SwapTotal ?? 0;
	const swapFree = fields.SwapFree ?? 0;
	const round1 = (n) => Math.round(n * 10) / 10;
	let load1 = null;
	try {
		const parsed = Number.parseFloat(readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/)[0] ?? "");
		if (Number.isFinite(parsed)) load1 = parsed;
	} catch {}
	return {
		mem_total_mb: round1(total / 1024),
		mem_available_mb: round1(available / 1024),
		usage_pct: total > 0 ? round1((total - available) / total * 100) : 0,
		swap_pct: swapTotal > 0 ? round1((swapTotal - swapFree) / swapTotal * 100) : null,
		load1
	};
}
/** GET /api/sys-mem —— 只读；失败也回 JSON，不把异常抛到宿主。 */
const sysMemHandler = (req, res) => {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.setHeader("allow", "GET, HEAD");
		sendJson(res, 405, { error: "Method not allowed" });
		return;
	}
	try {
		sendJson(res, 200, readSysMem());
	} catch (error) {
		sendJson(res, 500, { error: `无法读取 /proc/meminfo: ${String(error)}` });
	}
};
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(paneKind), "pane: source kind");
	ctx.effect(() => {
		const source = ctx.orchestrator.context({
			kind: SOURCE,
			health: ["pane"]
		});
		liveSource = source;
		const timer = setTimeout(() => {
			source.report("pane", {
				state: "ready",
				detail: "Panel conversations accept messages"
			});
		}, 0);
		return () => {
			clearTimeout(timer);
			liveSource = void 0;
		};
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/orchestrator/api/pane",
		handler: paneHandler(ctx)
	}), "pane: dispatch route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/sys-mem",
		handler: sysMemHandler
	}), "pane: sys-mem route");
	ctx.effect(() => {
		let busy = false;
		const sweep = () => {
			if (busy) return;
			busy = true;
			unarchiveSweep(ctx).catch((error) => {
				ctx.logger?.warn?.("dsh-superagent-pane: 自动解档检查失败 %s", String(error));
			}).finally(() => {
				busy = false;
			});
		};
		const boot = setTimeout(sweep, 0);
		const timer = setInterval(sweep, UNARCHIVE_SWEEP_MS);
		return () => {
			clearTimeout(boot);
			clearInterval(timer);
		};
	}, "pane: unarchive self-heal");
	ctx.effect(() => {
		let busy = false;
		const sweep = () => {
			if (busy) return;
			busy = true;
			recoverStranded(ctx).catch((error) => {
				ctx.logger?.warn?.("dsh-superagent-pane: 搁浅消息自愈检查失败 %s", String(error));
			}).finally(() => {
				busy = false;
			});
		};
		const boot = setTimeout(sweep, 0);
		const timer = setInterval(sweep, STRANDED_SWEEP_MS);
		return () => {
			clearTimeout(boot);
			clearInterval(timer);
		};
	}, "pane: stranded recovery");
	ctx.effect(() => {
		let busy = false;
		const sweep = () => {
			if (busy) return;
			busy = true;
			runDueSchedules(ctx).catch((error) => {
				ctx.logger?.warn?.("dsh-superagent-pane: 定时派活检查失败 %s", String(error));
			}).finally(() => {
				busy = false;
			});
		};
		const boot = setTimeout(sweep, 2e3);
		const timer = setInterval(sweep, SCHEDULE_SWEEP_MS);
		return () => {
			clearTimeout(boot);
			clearInterval(timer);
		};
	}, "pane: scheduled dispatch");
}
export { apply, inject, name, paneTrigger };
