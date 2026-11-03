import { randomUUID } from "node:crypto";
import { z } from "zod";
import { key } from "dsh-superagent";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
	const file = latestEventFile(dir);
	if (!file) return {
		...empty,
		interruptRequested: existsSync(interruptPath(dir))
	};
	const { events, mtime } = readTail(dir, file);
	if (!events.length) return {
		...empty,
		present: true,
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
*/
function paneTrigger(conversation, text, sender = OWNER, mode = "dispatch") {
	const thread = mode === "chat" ? `${conversation}~chat` : conversation;
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
/** 找该对话线程上挂着僵尸 Assignment 的工单；没有则返回 undefined。 */
async function zombieOnThread(ctx, conversation) {
	const threadKey = `${SOURCE}:${conversation}`;
	try {
		for (const ticket of ctx.orchestrator?.store?.tickets?.open?.() ?? []) {
			if (!(Array.isArray(ticket?.threads) ? ticket.threads : []).some((entry) => entry?.key === threadKey)) continue;
			const health = ticketHealth(ticket, Date.now(), await collectExecutorSignals(ctx, ticket));
			if (health.health === "zombie") return {
				ticketId: String(ticket.id),
				detail: health.detail
			};
		}
	} catch {}
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
				let conversation = body.conversation;
				let rerouted;
				if (body.mode === "dispatch") {
					const zombie = await zombieOnThread(ctx, conversation);
					if (zombie) {
						const stamp = (/* @__PURE__ */ new Date()).toTimeString().slice(0, 5).replace(":", "");
						conversation = `${body.conversation.replace(/[^A-Za-z0-9_-]/g, "")}-r${stamp}`;
						rerouted = zombie.detail;
						ctx.logger?.warn?.("dsh-superagent-pane: 线程 %s 挂着僵尸工单 %s，已改投新线程 %s", body.conversation, zombie.ticketId, conversation);
					}
				}
				await wakeThreadSessions(ctx, conversation);
				const trigger = paneTrigger(conversation, body.text, OWNER, body.mode);
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
					thread: `${SOURCE}:${conversation}`,
					received,
					...rerouted ? {
						rerouted,
						originalConversation: body.conversation,
						conversation
					} : {}
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
		const followsThread = (ticket) => {
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
}
export { apply, inject, name, paneTrigger };
