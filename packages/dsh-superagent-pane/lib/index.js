import { o as teamStatus } from "./guard-C6Yt-xRB.js";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { key } from "dsh-superagent";
import { join } from "node:path";
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
				pending = {
					step: steps.length + 1,
					tool: String(part.name ?? ""),
					detail: inputText(part.name, part.input),
					done: false
				};
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
/** 取目录下最新的 runs/<时间戳>.jsonl；没有则退回 log.jsonl。 */
function latestEventFile(dir) {
	const runDir = join(dir, ".cc-worker", "runs");
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
	const log = join(dir, ".cc-worker", "log.jsonl");
	return existsSync(log) ? log : void 0;
}
/** 增量读出事件尾部。 */
function readTail(dir, file) {
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
	let entry = cache.get(dir);
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
	cache.set(dir, entry);
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
	const { events, mtime } = readTail(dir, file);
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
/**
* 构造面板里一条消息的 Trigger。
*
* 两种模式对齐引擎语义：
* - `dispatch`（默认）：`addressed: 'mention'` → 已允许发送者的消息是 explicit，直接建单/追加给工单，权限完整。
* - `chat`：不带 addressed → 消息按准入表成为 inferred 候选，交给主 Session（router）分诊：它能直接答疑，
*   或按规则接下小活；不需要工单的问题不会再变成工单。
*
* 对话模式刻意走「影子线程」`<对话>~chat`：引擎的 gate 规定「线程有自己的工单时，一律消息归该工单」
* （followup 分支先于准入表生效），所以只要还在原线程上，对话消息就会被排进运行中工单的队列、router 收不到。
* 影子线程永不被工单订阅，router 任何时刻都能立刻接话；回复经 channel 地址仍回落到原对话显示。
*
* 派活模式**只在会话线程上的工单已卡死（zombie，永远接不了手）时**才走一条子线程（`<对话>~d<base36>`，
* 由调用方通过 `options.thread` 指定）：死工单仍占着订阅，fanout 会把消息并进去，而 intake 又因为
* followupOwners 非空永不排 Eval，这条消息就永远搁浅（2026-11-03 的 897f223d… 即此）。子线程上没有订阅者，
* 消息会进 Eval 由主 Session 分诊（可 attach 也可新建工单）。健康/待命的工单不触发改投：它对运行中工单的
* 正常跟进必须留在原线程，交给该工单的 worker 处理，否则会另起新工单、原工单永远收不到跟进。
* 无论走哪条线程，`channel` 始终指回原会话，回复仍显示在原对话里。
*/
function paneTrigger(conversation, text, sender = OWNER, mode = "dispatch", options = {}) {
	const thread = options.thread ?? (mode === "chat" ? `${conversation}~chat` : conversation);
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
		...mode === "chat" ? {} : { addressed: "mention" },
		at: (/* @__PURE__ */ new Date()).toISOString(),
		text,
		channel: {
			source: SOURCE,
			thread: `${SOURCE}:${thread}`,
			address: { conversation }
		},
		meta: { conversation }
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
const logKey = (conversation) => `pane-log:${conversation}`;
const hiddenKey = "pane-hidden";
function appendLog(source, conversation, entry) {
	const key = logKey(conversation);
	const next = [...(source.state.get(key) ?? []).filter((item) => item.id !== entry.id), entry].slice(-200);
	source.state.set(key, next);
}
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
/**
* 面板路由。
*
* `receive` 与 GitHub、Feishu 两个 Source 用的是同一个入口，所以面板消息走完全相同的路径：准入、路由、工单、worker。
*/
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
				const body = z.object({
					conversation: ConversationSchema,
					text: TextSchema,
					mode: z.enum(["dispatch", "chat"]).default("dispatch")
				}).parse(await readJson(req));
				const conversation = body.conversation;
				const diverted = body.mode === "dispatch" ? await divertDispatch(ctx, conversation) : void 0;
				await wakeThreadSessions(ctx, conversation);
				const trigger = paneTrigger(conversation, body.text, OWNER, body.mode, diverted ? { thread: diverted.thread } : {});
				appendLog(source, conversation, {
					id: trigger.id,
					direction: "in",
					at: trigger.at,
					text: trigger.text,
					mode: body.mode
				});
				const received = await source.receive(trigger);
				sendJson(res, 200, {
					triggerId: trigger.id,
					thread: `${SOURCE}:${trigger.threads[0].id}`,
					received,
					...diverted ? { diverted: diverted.reason } : {}
				});
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
				sendJson(res, 200, {
					conversation,
					thread: `${SOURCE}:${conversation}`,
					items: source.state.get(logKey(conversation)) ?? []
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/orchestrator/api/pane/hidden") {
				sendJson(res, 200, { ids: source.state.get(hiddenKey) ?? [] });
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
			sendJson(res, 404, { error: "Unknown pane operation" });
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
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
				if (entry.direction !== "in" || entry.mode !== "dispatch") continue;
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
}
export { apply, inject, name, paneTrigger };
