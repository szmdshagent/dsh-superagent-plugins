import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
// src/governance.ts
/**
* 治理引擎：把 cc-worker / 派活引擎留在磁盘上的痕迹，归纳成若干「治理维度」。
*
* 设计约束：
*   - **纯只读**：只 stat/read，不改任何文件，不起进程（周报生成由调用方决定）。
*   - **单点失败不扩散**：任何工单、任何文件的解析失败都只跳过那一项。
*   - **维度正交**：交接闭环、执行器健康、预算纪律、成本、上下文、活性各自独立，
*     一个问题只归到一个主维度，避免同一现象在多处重复计数。
*
* 全部数据源都是 cc-worker 既有产物，新增维度不需要改执行层。
*/
/** 阈值集中在这里，改口径只需要动这一处。 */
const THRESHOLDS = {
	/** 单次 run 成本超过这个值算贵（美元）。 */
	runCostWarn: 1,
	runCostCritical: 5,
	/**
	* 单轮**真实上下文**超过这个值才算膨胀（token）。
	*
	* 口径必须是「最后一次 API 调用的 input + cache_read」，也就是 `context_size`
	* （cc-worker 按 usage 去重后取的最大值），**不能**用 `act_cache_read`：
	* 后者是一轮内所有 API 调用的累计，正常一轮 20+ 步天然是窗口的十几倍。
	* 2026-11-11 实测：code-yongshi-mag-gap 那轮台账 act_cache_read=2,530,048，
	* 而 runlog 里单次调用峰值只有 150,253；全量 615 行 context_size 最大 392,005，
	* 超过 400K 声明窗口的一行为零。旧阈值 800K 打在累计值上，误报 148 条。
	*/
	contextSizeWarn: 32e4,
	/** 单次 run 的步数超过这个值说明任务发散。 */
	stepsWarn: 40,
	/** 步数达到这个值就算「长跑一轮」：总价高可能只是因为干得多，要看每步成本。 */
	efficientLongSteps: 20,
	/** 每步成本低于这个值（美元）的长轮属正常吞吐，不按「单轮成本高」报警。取全量 p95≈$0.26。 */
	costPerStepWarn: .3,
	/** 重复同一命令达到这个次数算纪律问题。 */
	duplicateWarn: 3,
	/** 交接连续异常达到这个次数升级为 critical。 */
	handoffStreakCritical: 2,
	/** 运行中的工单多久没动静算停滞（毫秒）。 */
	stallWarnMs: 3e5,
	stallCriticalMs: 12e5,
	/** 只统计最近多久的数据。 */
	freshMs: 6048e5,
	/** 工单最近多久还有活动（或进程仍存活）才算「仍在进行」，否则异常只作历史审计。
	*  cc-worker 运行期间会持续追加 runs/*.jsonl，30 分钟没有任何写入即视为没有 run 在跑。 */
	activeWindowMs: 18e5,
	/** 额度类汇总的窗口（今日）。 */
	todayRunsMax: 400
};
const home$1 = () => process.env.HOME ?? homedir();
const workRoot = () => `${home$1()}/.dsh/state/superagent/work`;
/** 读取 JSON 文件，失败返回 null（调用方不必 try）。 */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
/** 读取文本文件前 N 字节，失败返回空串。 */
function readHead(path, bytes = 4096) {
	try {
		return readFileSync(path, "utf8").slice(0, bytes);
	} catch {
		return "";
	}
}
/** 读全文。只用于小文件（switch.log 十几 KB 级）；大文件请用 readHead/readTail。 */
function readFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
/** 读取文本文件后 N 字节（runlog 尾部才是 result 事件），失败返回空串。 */
function readTail(path, bytes = 524288) {
	try {
		const fd = openSync(path, "r");
		try {
			const size = statSync(path).size;
			const start = Math.max(0, size - bytes);
			const buffer = Buffer.alloc(size - start);
			readSync(fd, buffer, 0, buffer.length, start);
			return buffer.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}
/** 读 jsonl 的每一行；坏行跳过。 */
function readJsonl(path, limit = 5e3) {
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const lines = text.split("\n");
	const start = Math.max(0, lines.length - limit);
	const rows = [];
	for (let i = start; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {}
	}
	return rows;
}
/** 文件修改时间（毫秒），不存在返回 0。 */
function mtimeMs(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
/** 按一个状态根（main 或某条 lane）读成扫描条目。 */
function makeScan(name, lane, dir, workerDir, at) {
	return {
		name,
		lane,
		key: lane ? `${name}#${lane}` : name,
		dir,
		workerDir,
		at,
		handoff: workerDir ? readJson(`${workerDir}/handoff-state.json`) : null,
		budget: workerDir ? readJson(`${workerDir}/budget-status.json`) : null,
		stderr: workerDir ? readHead(`${workerDir}/stderr.log`, 2e3).trim() : "",
		ledger: workerDir ? readJsonl(`${workerDir}/budget-ledger.jsonl`, 400) : []
	};
}
function scanTickets(now, onlyTicket) {
	let names = [];
	try {
		names = readdirSync(workRoot());
	} catch {
		return [];
	}
	if (onlyTicket) names = names.filter((name) => name === onlyTicket);
	const out = [];
	for (const name of names) {
		const dir = `${workRoot()}/${name}`;
		const dirAt = mtimeMs(dir);
		if (!dirAt) continue;
		const cc = `${dir}/.cc-worker`;
		const ccAt = mtimeMs(cc);
		const mainAt = Math.max(dirAt, ccAt, mtimeMs(`${cc}/handoff-state.json`), mtimeMs(`${cc}/budget-status.json`));
		if (now - mainAt <= THRESHOLDS.freshMs) out.push(makeScan(name, "", dir, ccAt ? cc : null, mainAt));
		if (!ccAt) continue;
		let lanes = [];
		try {
			lanes = readdirSync(`${cc}/lanes`, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)).map((entry) => entry.name);
		} catch {}
		for (const lane of lanes) {
			const workerDir = `${cc}/lanes/${lane}`;
			const at = Math.max(dirAt, mtimeMs(workerDir), mtimeMs(`${workerDir}/handoff-state.json`), mtimeMs(`${workerDir}/budget-status.json`));
			if (now - at > THRESHOLDS.freshMs) continue;
			out.push(makeScan(name, lane, dir, workerDir, at));
		}
	}
	return out;
}
/** pid 是否仍存活。收尾后残留的 pid 文件不能当成「还在跑」。 */
function pidAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/**
* 工单是否仍在进行：进程活着，或者最近 activeWindowMs 内还有文件活动。
* 已结束工单的历史异常仍保留在审计里，但不再占用「需立刻处理」的严重名额。
*/
function isActiveTicket(scan, now) {
	if (scan.workerDir) {
		if (pidAlive(Number(readHead(`${scan.workerDir}/claude.pid`, 32).trim()))) return true;
	}
	return now - scan.at <= THRESHOLDS.activeWindowMs;
}
/** 统计一个工单换过几次会话（switch.log 里 cctrim switch 的行数）。 */
function switchCount(workerDir) {
	if (!workerDir) return 0;
	return (readFile(`${workerDir}/switch.log`).match(/cctrim .*switch to/g) ?? []).length;
}
/** 交接异常的中文说明，键来自 handoff_state.py 的 anomalies。 */
const HANDOFF_TEXT = {
	run_failed: "本轮执行失败，没有产出可用结果",
	unconsumed: "上一轮写入的交接没有被下一轮读走",
	extract_failed: "模型没有按模板输出交接段，提取为空或过短"
};
function handoffFindings(scans, now) {
	const findings = [];
	for (const scan of scans) {
		const state = scan.handoff;
		if (!state) continue;
		const anomalies = Array.isArray(state.anomalies) ? state.anomalies : [];
		if (anomalies.length === 0) continue;
		const streak = Number(state.streak ?? 0);
		const active = isActiveTicket(scan, now);
		const severity = active ? streak >= THRESHOLDS.handoffStreakCritical ? "critical" : "warn" : "info";
		for (const code of anomalies) findings.push({
			dimension: "handoff",
			severity,
			id: `handoff:${code}:${scan.key}`,
			title: `${active ? "" : "历史遗留："}${HANDOFF_TEXT[code] ?? `交接异常：${code}`}`,
			detail: active ? `连续 ${streak} 次未恢复。交接契约的作用是让下一轮不必重读历史，持续失败等于每轮都在烧重复的 token。` : `工单已结束（最后活动 ${new Date(scan.at).toISOString()}），这次失败不会再影响后续轮次；保留作审计，不计入「需立刻处理」。`,
			ticket: scan.key,
			metrics: {
				异常码: code,
				连续次数: streak,
				注入: Number(state.injected ?? 0),
				消费: Number(state.consumed ?? 0),
				提取成功: Number(state.extract_ok ?? 0)
			},
			evidence: typeof state.extract === "string" ? state.extract : void 0,
			at: typeof state.updated === "string" ? state.updated : void 0
		});
	}
	return findings;
}
/** 已知的良性告警：只影响 SDK 侧标注，不影响执行结果，不必天天报红。 */
const BENIGN_STDERR = [/unrecognized_model/];
/**
* 台账里的 `cost_usd` 来自 Claude Code 的 `result.total_cost_usd`，是**同一 session 的累计成本**：
* resume 一轮就会把整段会话重新报一次。直接相加等于同一笔钱被数很多遍，
* 所以这里按 `session_id` 做差分，得到「这一轮真正新增的成本」。
*
* 差分只在同一 session 内成立：累计值只增不减；一旦变小（换了新基线或换了会话）就按原始值计。
*/
/**
* 从 runlog 里找同一 session 更早一轮的 `total_cost_usd`，作为「面板台账外的」累计基线。
*
* 为什么需要：面板只扫各工单 `.cc-worker/budget-ledger.jsonl`，而台账可能只保留了该 session
* 最后几轮（实测量：long-dsh 的 session 有 13 轮 result，本地台账只剩 10 行，更早的高价轮不在台账里）。
* 缺了更早的行，面板就把整段会话累计当成这一轮的成本（$30.23 实为 $0.69）。
* runlog 每轮都留，是这个基线最完整的来源。
*/
/** runlog 基线缓存：同一 (目录, run, session) 只解析一次；文件 mtime 变了才重算。 */
const baselineCache = /* @__PURE__ */ new Map();
function baselineFromRunlog(scan, run, session) {
	const dir = scan.workerDir ? `${scan.workerDir}/runs` : "";
	if (!dir) return null;
	const key = `${dir}\u0000${run}\u0000${session}\u0000${mtimeMs(`${dir}/${run}`)}`;
	const hit = baselineCache.get(key);
	if (hit !== void 0) return hit;
	const value = baselineFromRunlogUncached(dir, run, session);
	if (baselineCache.size > 500) baselineCache.clear();
	baselineCache.set(key, value);
	return value;
}
/**
* 三档 token 的计价权重（input : cacheRead : output = 10 : 1 : 50）。
*
* 只用于**比例**，不需要绝对值：即使换模型/换价目，只要三档单价比例不变，折算就成立；
* 比例变了也只是 `cost_usd` 本身不准，不引入额外误差。数值来自 9 个 cost-state 快照的
* 最小二乘反解（deepseek 实为 $5 / $0.5 / $25 per M，比例正是 10:1:50）。
*/
const TOKEN_WEIGHT = {
	input: 10,
	cacheRead: 1,
	output: 50
};
/** 用 token 量算相对权重；三档都取自同一份 usage 的同一统计口径。 */
function tokenWeight(input, cacheRead, output) {
	return input * TOKEN_WEIGHT.input + cacheRead * TOKEN_WEIGHT.cacheRead + output * TOKEN_WEIGHT.output;
}
/**
* 「累计 / 本轮」权重比的容忍上限，与 `isInheritedSession` 的 8 倍同源。
* 超过它说明这一轮只占整段历史的零头，无法区分「同会话正常多轮」与「继承了别人的历史」。
*/
const MAX_BASELINE_RATIO = 8;
/**
* 从一条 `result` 事件折出「本轮开始时的会话累计成本」。
*
* 依据（2026-11-10 实测，token-usage-plugin-ad419acced89）：
* - `result.modelUsage` 是整段 session 的累计 token，`result.usage` 只是**本轮**增量。
*   实测 18091520 - 3909888 === 14181632，与 transcript 中上一条 `cost-state` 快照逐位相等。
* - `total_cost_usd` 对 token 是线性的。所以按 token 比例就能把累计金额折算到「本轮开始」那个点：
*   baseline = total_cost_usd × 权重(累计 − 本轮) / 权重(累计)
* - `TOKEN_WEIGHT` 只以**比例**进入这个式子（分子分母同乘），改单价不影响结果，
*   **不要**把单价同步到配置或当成账目口径。
*
* 三个防护，任一命中返回 null（宁可退回旧行为，也不凭空造基线）：
* - 缺 `modelUsage` / `usage`，或累计权重非正 → 无从折算；
* - 累计 < 本轮（任一档）→ `modelUsage` 不是整段累计（例如只写了本轮），硬算会得负值；
* - 累计权重 > 本轮权重 × 8 → 这一轮相对整段历史太小，典型是 abtopup 那种把 52MB 会话文件
*   `cp` 成新 sid 起头的克隆（实测 161 倍）。此时折出来的小增量会把「继承历史」伪装成
*   「本轮很便宜」，所以放弃折算，交给 `isInheritedSession` 走未校准路径。
*/
function baselineOfResult(ev, cost) {
	const usage = ev?.usage;
	const modelUsage = ev?.modelUsage;
	if (!usage || !modelUsage || typeof modelUsage !== "object") return null;
	if (!Number.isFinite(cost) || cost <= 0) return null;
	let cumInput = 0;
	let cumCacheRead = 0;
	let cumOutput = 0;
	for (const item of Object.values(modelUsage)) {
		cumInput += Number(item?.inputTokens) || 0;
		cumCacheRead += Number(item?.cacheReadInputTokens) || 0;
		cumOutput += Number(item?.outputTokens) || 0;
	}
	const curInput = Number(usage.input_tokens) || 0;
	const curCacheRead = Number(usage.cache_read_input_tokens) || 0;
	const curOutput = Number(usage.output_tokens) || 0;
	if (cumInput < curInput || cumCacheRead < curCacheRead || cumOutput < curOutput) return null;
	const wCum = tokenWeight(cumInput, cumCacheRead, cumOutput);
	const wCur = tokenWeight(curInput, curCacheRead, curOutput);
	if (!(wCum > 0) || wCur < 0) return null;
	if (wCur > 0 && wCum > wCur * MAX_BASELINE_RATIO) return null;
	const baseline = cost * (wCum - wCur) / wCum;
	if (!Number.isFinite(baseline) || baseline <= 0 || baseline >= cost) return null;
	return baseline;
}
/** 目录级索引缓存：一次解析该工单所有 runlog 的 result 事件，按 run 名 → session 取值。 */
const runCostIndexCache = /* @__PURE__ */ new Map();
function runCostIndex(dir) {
	let stamp = 0;
	try {
		stamp = statSync(dir).mtimeMs;
	} catch {
		return /* @__PURE__ */ new Map();
	}
	const cached = runCostIndexCache.get(dir);
	if (cached && cached.stamp === stamp) return cached.index;
	const index = /* @__PURE__ */ new Map();
	let names = [];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
	} catch {
		return index;
	}
	for (const name of names) {
		const text = readTail(`${dir}/${name}`);
		for (const line of text.split("\n")) {
			if (!line.includes("\"result\"")) continue;
			let ev;
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			if (ev?.type !== "result") continue;
			const session = String(ev?.session_id ?? "");
			const cost = Number(ev?.total_cost_usd);
			if (!session || !Number.isFinite(cost)) continue;
			const cacheRead = Number(ev?.usage?.cache_read_input_tokens) || 0;
			let perSession = index.get(name);
			if (!perSession) {
				perSession = /* @__PURE__ */ new Map();
				index.set(name, perSession);
			}
			perSession.set(session, {
				cost,
				cacheRead,
				baseline: baselineOfResult(ev, cost)
			});
		}
	}
	if (runCostIndexCache.size > 200) runCostIndexCache.clear();
	runCostIndexCache.set(dir, {
		stamp,
		index
	});
	return index;
}
/**
* 本轮单次 API 调用的上下文峰值（input + cache_read），即「这一轮的上下文真的有多大」。
*
* 不能直接用 result.usage.cache_read_input_tokens：它是一轮内所有调用的累计
* （实测 24 次调用求和与它逐位相等），拿它和 400K 窗口比必然虚高十几倍。
* 也不能用台账 act_cache_read：那是同一口径的累计值。
* 唯一的真实口径是逐条 assistant 事件的 usage，按 message.id 去重（同一条消息会拆成
* thinking/text 多个事件，usage 相同），取最大值。
*
* 代价：要读整个 runlog（实测 0.1–2MB/轮）。按「路径 + mtime」缓存，同一次扫描只算一次。
*/
const turnContextCache = /* @__PURE__ */ new Map();
function getTurnContextPeak(scan, run, session) {
	const dir = scan.workerDir ? `${scan.workerDir}/runs` : "";
	if (!dir || !run || !session) return null;
	const path = `${dir}/${run}`;
	const stamp = mtimeMs(path);
	if (!stamp) return null;
	const key = `${path}\u0000${session}\u0000${stamp}`;
	const hit = turnContextCache.get(key);
	if (hit !== void 0) return hit;
	let peak = null;
	const seen = /* @__PURE__ */ new Set();
	for (const line of readFile(path).split("\n")) {
		if (!line.includes("\"assistant\"")) continue;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev?.type !== "assistant") continue;
		if (String(ev?.session_id ?? session) !== session) continue;
		const usage = ev?.message?.usage ?? ev?.usage;
		if (!usage) continue;
		const id = String(ev?.message?.id ?? "");
		if (id) {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		const total = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0);
		if (total > (peak ?? 0)) peak = total;
	}
	if (turnContextCache.size > 400) turnContextCache.clear();
	turnContextCache.set(key, peak);
	return peak;
}
function baselineFromRunlogUncached(dir, run, session) {
	const index = runCostIndex(dir);
	const names = [...index.keys()].filter((name) => name < run).sort();
	let best = null;
	for (const name of names) {
		const facts = index.get(name).get(session);
		if (facts !== void 0) best = facts.cost;
	}
	return best;
}
/**
* 从本轮自己的 runlog 里求「本轮开始时的累计成本」，用于同 session 没有更早 result 时补基线。
*
* 依据（2026-11-10 实测，token-usage-plugin-ad419acced89）：
* - `result.modelUsage` 是整段 session 的累计 token，`result.usage` 只是**本轮**增量。
*   实测 18091520 - 3909888 === 14181632，与 transcript 中上一条 `cost-state` 快照逐位相等。
* - `total_cost_usd` 对 token 是线性的，且三档 token 的单价比例在本机模型下恒定。
*   用 9 个 `cost-state` 快照最小二乘反解出 input:cacheRead:output = 10:1:50，
*   回算各快照误差 < $0.00001。所以按同一比例就能把累计金额折算到「本轮开始」那个点：
*   baseline = total_cost_usd × 权重(累计 - 本轮) / 权重(累计)
*
* 为什么不用读 transcript：本机 816 个 session 共 1.3GB，全扫一遍 21 秒，面板扛不住；
* 而 runlog 的 result 事件里已有全部所需数据，零额外 IO。
*/
function baselineFromRunUsage(dir, run, session) {
	const facts = runSessionFacts(dir, run, session);
	if (!facts) return null;
	return facts.baseline;
}
/** 取某个 run 里某个 session 的 result 事实；复用 `runCostIndex` 的目录级缓存，不额外读盘。 */
function runSessionFacts(dir, run, session) {
	if (!dir || !run || !session) return null;
	return runCostIndex(dir).get(run)?.get(session) ?? null;
}
/**
* 本轮 runlog 里的**整轮累计**缓存读（result.usage.cache_read_input_tokens）；无 runlog 返回 null。
*
* 名字里的 perTurn 指「这一轮」，不是「单次调用」：该字段是一轮内所有 API 调用的累加
* （实测 24 次调用求和与之逐位相等）。仅用于 `isInheritedSession` 的「累计 vs 单次」之比，
* 单次上下文请用 `getTurnContextPeak`。
*/
function perTurnCacheReadFromRunlog(scan, run, session) {
	const dir = scan.workerDir ? `${scan.workerDir}/runs` : "";
	if (!dir) return null;
	const facts = runCostIndex(dir).get(run)?.get(session);
	const value = Number(facts?.cacheRead) || 0;
	return value > 0 ? value : null;
}
/** 单轮上下文理论天花板：声明窗口 400K，留 1.5 倍余量给 1M 窗口模型。 */
const MAX_ROUND_CACHE_READ = 4e6;
/**
* 判断一行台账的累计缓存读里是否混进了「不属于本轮」的历史。
*
* 背景：abtopup 那单是把 52MB 的 long-dsh 会话文件 `cp` 成新 sid 起的头（脚本 /home/szm/cc-diag/ab-topup.sh:12），
* 首轮就把 42.4M 缓存整体重放，花掉 $29.73。这类行的 `baseline_source=none`（找不到同 session 更早 result），
* 但 `baseline_source=none` 本身不足以判定——正常新开会话的首轮也都是 none。
*
* 判据拿「本轮自己的累计规模」当分母，不能拿 `context_size`（早期台账常为空）：
* - 首选 runlog 的 `result.usage.cache_read_input_tokens`：它是**本轮**所有调用的汇总，
*   与 `act_cache_read_cum` 同源同量级；两者相差 8 倍以上说明这一行混进了别的会话。
*   注意它**不是**单次上下文（2026-11-11 复核：24 次调用求和与它逐位相等），
*   所以只用于这个比值，不与上下文窗口比较。
* - runlog 缺失时退回台账 `context_size × context_rereads`（本轮上下文 × 本轮调用次数），超 4 倍判继承；
*   正常情况下 cum 与它同量级（p90≈1.0 倍），4 倍已是明显异常。
* - 两者都没有时才退回绝对上限 4M。
*
* 旧实现只比 `context_size` 单值 8 倍，把「长跑一轮把上下文读了 80 次」的正常行（cum 天然几十倍）
* 全判成继承会话，导致今日「未校准金额」被虚增到 $217.72（实际只有 $16.99）。
*/
function isInheritedSession(scan, row) {
	if (String(row?.cloned_from ?? "").length > 0) return true;
	if (String(row?.baseline_source ?? "") !== "none") return false;
	const cum = Number(row?.act_cache_read_cum) || 0;
	if (cum <= 0) return false;
	const session = String(row?.session_id ?? "");
	const run = String(row?.run ?? "");
	const perTurn = session && run ? perTurnCacheReadFromRunlog(scan, run, session) : null;
	if (perTurn) return cum > perTurn * 8;
	const ctx = Number(row?.context_size) || 0;
	const rereads = Number(row?.context_rereads) || 0;
	if (ctx > 0 && rereads > 0) return cum > ctx * rereads * 4;
	if (ctx > 0) return cum > ctx * 8;
	return cum >= MAX_ROUND_CACHE_READ;
}
function trueCostRows(scans) {
	const items = scans.flatMap((scan) => scan.ledger.map((row) => ({
		scan,
		row
	})));
	items.sort((a, b) => String(a.row?.ts ?? "").localeCompare(String(b.row?.ts ?? "")));
	const lastBySession = /* @__PURE__ */ new Map();
	const out = [];
	for (const item of items) {
		const raw = Number(item.row?.cost_usd ?? 0) || 0;
		const session = String(item.row?.session_id ?? "");
		const before = lastBySession.get(session);
		let cost = before !== void 0 && raw >= before ? raw - before : raw;
		let calibrated = true;
		let recoveredBase = 0;
		if (before === void 0) {
			const run = String(item.row?.run ?? "");
			const dir = item.scan.workerDir ? `${item.scan.workerDir}/runs` : "";
			const base = !session || !run ? null : baselineFromRunlog(item.scan, run, session) ?? baselineFromRunUsage(dir, run, session);
			if (base !== null && base > 0 && raw >= base) {
				cost = raw - base;
				if (cost < 0) cost = 0;
				recoveredBase = base;
			}
			if (isInheritedSession(item.scan, item.row)) calibrated = false;
		}
		lastBySession.set(session, raw);
		out.push({
			scan: item.scan,
			row: item.row,
			cost,
			calibrated,
			recoveredBase
		});
	}
	return out;
}
/** 压成单行并截断，避免把 2KB 的任务描述塞进面板/JSON。 */
function shortText(value, max = 400) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** 读 team-plan.json；不存在返回 present=false，存在但格式不对返回 error。 */
function readTeamPlan(ticketDir) {
	const path = `${ticketDir}/.cc-worker/team-plan.json`;
	const exists = mtimeMs(path) > 0;
	const raw = exists ? readJson(path) : null;
	if (!Array.isArray(raw)) return {
		present: false,
		path,
		lanes: [],
		error: exists ? "team-plan.json 不是合法的 JSON 数组" : null
	};
	const lanes = [];
	for (const item of raw.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		const lane = String(item.lane ?? "").trim();
		const task = String(item.task ?? "").replace(/\s+/g, " ").trim();
		if (!/^[A-Za-z0-9_-]+$/.test(lane) || !task) continue;
		lanes.push({
			lane,
			task
		});
	}
	return {
		present: lanes.length > 0,
		path,
		lanes,
		error: raw.length > 0 && lanes.length === 0 ? "team-plan.json 有内容但没有合法的 lane/task 条目" : null
	};
}
/** 解析台账/交接里的时间戳；坏值返回 0。 */
function parseTime(value) {
	if (typeof value !== "string" || !value) return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}
function isoAt(ms) {
	return ms > 0 ? new Date(ms).toISOString() : null;
}
/** runs/20261111-231152.jsonl → 本地时间毫秒；不是该格式返回 0。 */
function runStartMs(name) {
	const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
	if (!match) return 0;
	const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime();
	return Number.isFinite(at) ? at : 0;
}
/**
* 逐 lane 聚合 token / 成本 / 轮次 / 时长 / 交接切换。
*
* 只读 `.cc-worker/lanes/<lane>/`：budget-ledger.jsonl 是逐轮主数据源，
* result.json 是单轮兜底（lane 刚起步、台账还没写时）。成本复用 trueCostRows 的
* session 差分，不在这里另造一套口径。
*/
function buildLaneExecutions(scans, now, costRows = trueCostRows(scans)) {
	const costByKey = /* @__PURE__ */ new Map();
	for (const item of costRows) {
		const entry = costByKey.get(item.scan.key) ?? {
			cost: 0,
			uncalibratedRuns: 0
		};
		entry.cost += item.cost + item.recoveredBase;
		if (!item.calibrated) entry.uncalibratedRuns++;
		costByKey.set(item.scan.key, entry);
	}
	const byTicket = /* @__PURE__ */ new Map();
	for (const scan of scans) {
		const list = byTicket.get(scan.name) ?? [];
		list.push(scan);
		byTicket.set(scan.name, list);
	}
	const roleRank = {
		worker: 0,
		other: 1,
		lead: 2
	};
	const out = [];
	for (const [ticket, ticketScans] of byTicket) {
		const dir = ticketScans[0].dir;
		const plan = readTeamPlan(dir);
		const planMap = new Map(plan.lanes.map((item) => [item.lane, item.task]));
		const scanByLane = new Map(ticketScans.filter((scan) => scan.lane).map((scan) => [scan.lane, scan]));
		let laneDirs = [];
		try {
			laneDirs = readdirSync(`${dir}/.cc-worker/lanes`, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)).map((entry) => entry.name);
		} catch {}
		for (const lane of /* @__PURE__ */ new Set([...planMap.keys(), ...laneDirs])) {
			const laneDir = `${dir}/.cc-worker/lanes/${lane}`;
			const laneMtime = mtimeMs(laneDir);
			const exists = laneMtime > 0;
			if (!exists && !planMap.has(lane)) continue;
			if (!planMap.has(lane) && exists && now - laneMtime > THRESHOLDS.freshMs) continue;
			const scan = scanByLane.get(lane) ?? null;
			const resultPath = `${laneDir}/result.json`;
			const resultMtime = mtimeMs(resultPath);
			const result = resultMtime > 0 ? readJson(resultPath) : null;
			const alive = pidAlive(Number(readHead(`${laneDir}/claude.pid`, 32).trim()));
			const role = lane === "lead" ? "lead" : planMap.has(lane) ? "worker" : "other";
			const leadFinished = role === "lead" && scan?.handoff?.status === "green" && Number(scan.handoff.run_ok ?? 0) > 0;
			let status;
			if (!exists) status = "pending";
			else if (alive) status = "running";
			else if (result && typeof result.ok === "boolean") status = result.ok ? "done" : "failed";
			else if (leadFinished) status = "done";
			else status = "unknown";
			const rows = scan?.ledger ?? [];
			let input = 0;
			let cacheRead = 0;
			let output = 0;
			let steps = 0;
			let contextPeak = 0;
			for (const row of rows) {
				input += Number(row?.act_input ?? 0) || 0;
				cacheRead += Number(row?.act_cache_read ?? 0) || 0;
				output += Number(row?.act_output ?? 0) || 0;
				steps += Number(row?.act_steps ?? 0) || 0;
				contextPeak = Math.max(contextPeak, Number(row?.context_size ?? 0) || 0);
			}
			const resultTokens = result?.tokens;
			if (rows.length === 0 && resultTokens) {
				input = Number(resultTokens.input ?? 0) || 0;
				cacheRead = Number(resultTokens.cache_read ?? 0) || 0;
				output = Number(resultTokens.output ?? 0) || 0;
			}
			const facts = scan ? costByKey.get(scan.key) : void 0;
			const startedCandidates = [];
			for (const row of rows) {
				const at = parseTime(row?.ts);
				if (at) startedCandidates.push(at);
			}
			let runNames = [];
			try {
				runNames = readdirSync(`${laneDir}/runs`);
			} catch {}
			for (const name of runNames) {
				const at = runStartMs(name);
				if (at) startedCandidates.push(at);
			}
			if (exists) try {
				const birth = statSync(laneDir).birthtimeMs;
				if (birth) startedCandidates.push(birth);
			} catch {}
			const startedMs = startedCandidates.length ? Math.min(...startedCandidates) : 0;
			const endedCandidates = [resultMtime, mtimeMs(`${laneDir}/handoff.md`)];
			for (const row of rows) {
				const at = parseTime(row?.ts);
				if (at) endedCandidates.push(at);
			}
			const lastRecordedMs = Math.max(...endedCandidates, 0);
			const endedMs = status === "running" || status === "unknown" ? now : lastRecordedMs;
			const durationMs = startedMs > 0 && endedMs >= startedMs ? endedMs - startedMs : null;
			const lastActivity = Math.max(scan?.at ?? 0, resultMtime, lastRecordedMs, laneMtime);
			const plannedTask = planMap.get(lane);
			out.push({
				ticket,
				lane,
				role,
				task: plannedTask ? shortText(plannedTask, 400) : exists ? shortText(readHead(`${laneDir}/task.txt`, 2e3), 400) || null : null,
				status,
				resultOk: result && typeof result.ok === "boolean" ? result.ok : null,
				error: result && result.ok === false ? shortText(String(result.error ?? result.result ?? "执行失败"), 300) : (status === "failed" || status === "unknown") && scan?.stderr ? shortText(scan.stderr, 300) : null,
				runs: Math.max(rows.length, result ? 1 : 0),
				steps,
				turns: Number(result?.num_turns ?? 0) || 0,
				tokens: {
					input,
					cacheRead,
					output,
					total: input + cacheRead + output
				},
				costUsd: Number((facts?.cost ?? 0).toFixed(6)),
				uncalibratedRuns: facts?.uncalibratedRuns ?? 0,
				contextPeak,
				handoffSwitches: switchCount(exists ? laneDir : null),
				handoffAnomalies: Array.isArray(scan?.handoff?.anomalies) ? scan.handoff.anomalies.length : 0,
				handoffStatus: typeof scan?.handoff?.status === "string" ? scan.handoff.status : null,
				startedAt: isoAt(startedMs),
				endedAt: isoAt(endedMs),
				durationMs,
				lastActivity: isoAt(lastActivity)
			});
		}
	}
	return out.sort((a, b) => a.ticket.localeCompare(b.ticket) || roleRank[a.role] - roleRank[b.role] || a.lane.localeCompare(b.lane, void 0, { numeric: true }));
}
/** 峰值并行度：按各 lane 的起止时间做事件扫描；缺时间的 lane 不参与。 */
function peakParallelism(lanes) {
	const events = [];
	for (const lane of lanes) {
		const start = parseTime(lane.startedAt);
		const end = parseTime(lane.endedAt);
		if (!start || !end || end <= start) continue;
		events.push({
			at: start,
			delta: 1
		}, {
			at: end,
			delta: -1
		});
	}
	events.sort((a, b) => a.at - b.at || a.delta - b.delta);
	let current = 0;
	let peak = 0;
	for (const event of events) {
		current += event.delta;
		if (current > peak) peak = current;
	}
	return peak;
}
/** 汇总团队报告：只看有 team-plan 的工单；无计划时 present=false。 */
function buildTeamReport(lanes, scans, now) {
	const ticketDirs = /* @__PURE__ */ new Map();
	for (const scan of scans) if (!ticketDirs.has(scan.name)) ticketDirs.set(scan.name, scan.dir);
	const teams = [];
	for (const [ticket, dir] of ticketDirs) {
		const plan = readTeamPlan(dir);
		if (!plan.present) continue;
		const planSet = new Set(plan.lanes.map((item) => item.lane));
		const ticketLanes = lanes.filter((lane) => lane.ticket === ticket && (lane.role === "lead" || planSet.has(lane.lane)));
		const workers = ticketLanes.filter((lane) => planSet.has(lane.lane));
		const statusOf = (status) => workers.filter((lane) => lane.status === status).length;
		const ticketStarted = ticketLanes.map((lane) => parseTime(lane.startedAt)).filter(Boolean);
		const ticketEnded = ticketLanes.map((lane) => parseTime(lane.endedAt)).filter(Boolean);
		const ongoing = workers.some((lane) => lane.status === "running" || lane.status === "pending" || lane.status === "unknown");
		const startedMs = ticketStarted.length ? Math.min(...ticketStarted) : 0;
		const endedMs = ongoing || !ticketEnded.length ? 0 : Math.max(...ticketEnded);
		teams.push({
			ticket,
			planPath: plan.path,
			planError: plan.error,
			workerLanes: plan.lanes.length,
			done: statusOf("done"),
			failed: statusOf("failed"),
			running: statusOf("running"),
			pending: statusOf("pending"),
			unknown: statusOf("unknown"),
			totalCostUsd: Number(ticketLanes.reduce((sum, lane) => sum + lane.costUsd, 0).toFixed(4)),
			totalRuns: ticketLanes.reduce((sum, lane) => sum + lane.runs, 0),
			totalTokens: ticketLanes.reduce((sum, lane) => sum + lane.tokens.total, 0),
			configuredParallelism: plan.lanes.length,
			peakParallelism: peakParallelism(workers),
			currentParallelism: workers.filter((lane) => lane.status === "running").length,
			startedAt: isoAt(startedMs),
			endedAt: ongoing ? null : isoAt(endedMs),
			durationMs: startedMs > 0 && endedMs > 0 ? endedMs - startedMs : startedMs > 0 && ongoing ? now - startedMs : null,
			lanes: ticketLanes
		});
	}
	teams.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
	const allStarted = teams.map((team) => parseTime(team.startedAt)).filter(Boolean);
	const allEnded = teams.map((team) => parseTime(team.endedAt)).filter(Boolean);
	const anyOngoing = teams.some((team) => team.endedAt === null && team.workerLanes > 0);
	const startedMs = allStarted.length ? Math.min(...allStarted) : 0;
	const endedMs = anyOngoing || !allEnded.length ? 0 : Math.max(...allEnded);
	return {
		present: teams.length > 0,
		tickets: teams.length,
		lanes: teams.reduce((sum, team) => sum + team.lanes.length, 0),
		workerLanes: teams.reduce((sum, team) => sum + team.workerLanes, 0),
		done: teams.reduce((sum, team) => sum + team.done, 0),
		failed: teams.reduce((sum, team) => sum + team.failed, 0),
		running: teams.reduce((sum, team) => sum + team.running, 0),
		pending: teams.reduce((sum, team) => sum + team.pending, 0),
		unknown: teams.reduce((sum, team) => sum + team.unknown, 0),
		totalCostUsd: Number(teams.reduce((sum, team) => sum + team.totalCostUsd, 0).toFixed(4)),
		totalRuns: teams.reduce((sum, team) => sum + team.totalRuns, 0),
		totalTokens: teams.reduce((sum, team) => sum + team.totalTokens, 0),
		configuredParallelism: teams.reduce((sum, team) => sum + team.configuredParallelism, 0),
		peakParallelism: teams.reduce((peak, team) => Math.max(peak, team.peakParallelism), 0),
		currentParallelism: teams.reduce((sum, team) => sum + team.currentParallelism, 0),
		startedAt: isoAt(startedMs),
		endedAt: anyOngoing ? null : isoAt(endedMs),
		durationMs: startedMs > 0 && endedMs > 0 ? endedMs - startedMs : startedMs > 0 && anyOngoing ? now - startedMs : null,
		teams
	};
}
/**
* findings 里的 BLOCKED 必须落在行首状态位（允许 `-`/`*`/`>`/`**` 前缀），
* 不能在正文里提一句 BLOCKED 就报警——治理报告自己也会引用这个词。
*/
function isBlockedFinding(text) {
	return /^\s{0,3}(?:[-*>]\s*)?\*{0,2}\s*BLOCKED\b/im.test(text);
}
/** 识别 shared/findings/*.md 与 shared/conflicts.md。 */
function buildConflictReport(scans) {
	const ticketDirs = /* @__PURE__ */ new Map();
	for (const scan of scans) if (!ticketDirs.has(scan.name)) ticketDirs.set(scan.name, scan.dir);
	const items = [];
	for (const [ticket, dir] of ticketDirs) {
		const shared = `${dir}/.cc-worker/shared`;
		const conflictsPath = `${shared}/conflicts.md`;
		const conflictsText = readFile(conflictsPath).trim();
		if (conflictsText) {
			const paths = [];
			const lanes = /* @__PURE__ */ new Set();
			for (const line of conflictsText.split("\n")) {
				const match = /^-\s+`([^`]+)`\s+←\s+(.+)$/.exec(line.trim());
				if (!match) continue;
				paths.push(match[1]);
				for (const lane of match[2].split(",").map((value) => value.trim()).filter(Boolean)) lanes.add(lane);
			}
			const stat = statSafe(conflictsPath);
			items.push({
				ticket,
				kind: "conflicts",
				path: conflictsPath,
				lane: null,
				lanes: [...lanes].sort(),
				paths,
				blocked: false,
				bytes: stat.size,
				modifiedAt: isoAt(stat.mtimeMs),
				excerpt: shortText(conflictsText, 600)
			});
		}
		let files = [];
		try {
			files = readdirSync(`${shared}/findings`, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
		} catch {}
		for (const file of files) {
			const path = `${shared}/findings/${file}`;
			const text = readFile(path);
			const stat = statSafe(path);
			items.push({
				ticket,
				kind: "findings",
				path,
				lane: file.replace(/\.md$/, ""),
				lanes: [file.replace(/\.md$/, "")],
				paths: [],
				blocked: isBlockedFinding(text),
				bytes: stat.size,
				modifiedAt: isoAt(stat.mtimeMs),
				excerpt: shortText(text, 400)
			});
		}
	}
	const tickets = [...new Set(items.map((item) => item.ticket))].sort();
	return {
		present: items.length > 0,
		conflictPaths: items.filter((item) => item.kind === "conflicts").reduce((sum, item) => sum + item.paths.length, 0),
		findingsFiles: items.filter((item) => item.kind === "findings").length,
		blockedFindings: items.filter((item) => item.kind === "findings" && item.blocked).length,
		tickets,
		items
	};
}
/** stat 的容错版：不存在时返回零值。 */
function statSafe(path) {
	try {
		const stat = statSync(path);
		return {
			size: stat.size,
			mtimeMs: stat.mtimeMs
		};
	} catch {
		return {
			size: 0,
			mtimeMs: 0
		};
	}
}
/** 工单是否仍在进行：任一扫描单元活跃，或某条 lane 报告 running。 */
function activeTicketSet(scans, lanes, now) {
	const set = /* @__PURE__ */ new Set();
	for (const scan of scans) if (isActiveTicket(scan, now)) set.add(scan.name);
	for (const lane of lanes) if (lane.status === "running") set.add(lane.ticket);
	return set;
}
/**
* team 维度告警：计划完成/失败、共享 findings、conflicts.md。
*
* 严重度口径与其它维度一致：仍在进行的工单才占 warn；已结束工单降为 info 审计。
*/
function teamFindings(lanes, team, conflicts, scans, now) {
	const findings = [];
	const active = activeTicketSet(scans, lanes, now);
	for (const summary of team.teams) {
		const isActive = active.has(summary.ticket);
		if (summary.planError) findings.push({
			dimension: "team",
			severity: "warn",
			id: `team:plan:${summary.ticket}`,
			title: "team-plan.json 解析失败或没有合法子任务",
			detail: "统筹 lane 没有写出可用的 lane/task 计划，子任务可能被降级为单 worker 直跑。",
			ticket: summary.ticket,
			metrics: { 计划lane数: summary.workerLanes },
			evidence: summary.planError
		});
		findings.push({
			dimension: "team",
			severity: "info",
			id: `team:summary:${summary.ticket}`,
			title: `team 计划 ${summary.workerLanes} 路：完成 ${summary.done}、失败 ${summary.failed}、进行中 ${summary.running}、未启动 ${summary.pending}`,
			detail: `含 lead 共 ${summary.lanes.length} 条 lane；团队成本 $${summary.totalCostUsd.toFixed(4)}，轮次 ${summary.totalRuns}，token ${summary.totalTokens}，峰值并行 ${summary.peakParallelism} 路。`,
			ticket: summary.ticket,
			metrics: {
				计划lane数: summary.workerLanes,
				完成: summary.done,
				失败: summary.failed,
				进行中: summary.running,
				未启动: summary.pending,
				状态未知: summary.unknown,
				团队总成本: summary.totalCostUsd,
				总轮次: summary.totalRuns,
				总token: summary.totalTokens,
				峰值并行: summary.peakParallelism
			}
		});
		for (const lane of summary.lanes) {
			if (lane.role !== "worker") continue;
			if (lane.status === "failed") findings.push({
				dimension: "team",
				severity: isActive ? "warn" : "info",
				id: `team:lane-failed:${summary.ticket}:${lane.lane}`,
				title: `${isActive ? "" : "历史遗留："}子任务 ${lane.lane} 执行失败`,
				detail: isActive ? "该 lane 的 result.json 报 ok=false，团队结果是残缺的，需要看 stderr/交接单决定是否重跑。" : "工单已结束，这个子任务的失败已成为既定缺口，只作审计。",
				ticket: summary.ticket,
				metrics: {
					lane: lane.lane,
					成本: lane.costUsd,
					轮次: lane.runs
				},
				evidence: lane.error ?? void 0,
				at: lane.endedAt ?? void 0
			});
			else if (lane.status === "unknown") findings.push({
				dimension: "team",
				severity: "info",
				id: `team:lane-unknown:${summary.ticket}:${lane.lane}`,
				title: `子任务 ${lane.lane} 状态未知（无 result，进程已退出）`,
				detail: "lane 目录存在但没有可解析的 result.json，可能是被中断或还在收尾。",
				ticket: summary.ticket,
				metrics: {
					lane: lane.lane,
					轮次: lane.runs
				},
				evidence: lane.error ?? void 0,
				at: lane.lastActivity ?? void 0
			});
		}
	}
	if (team.tickets === 0 && team.lanes > 0) findings.push({
		dimension: "team",
		severity: "info",
		id: "team:no-plan",
		title: `发现 ${team.lanes} 条 lane，但没有可用的 team-plan.json`,
		detail: "这些 lane 按独立执行单元统计，但无法判断计划内应有多少子任务、哪些未启动。",
		metrics: { lane数: team.lanes }
	});
	for (const item of conflicts.items) {
		if (item.kind !== "conflicts") continue;
		const isActive = active.has(item.ticket);
		findings.push({
			dimension: "team",
			severity: isActive ? "warn" : "info",
			id: `team:conflicts:${item.ticket}`,
			title: `${isActive ? "" : "历史遗留："}共享区检测到 ${item.paths.length} 处路径冲突`,
			detail: "多个 lane 在交接单的「改动文件」段落里声明了同一路径，需要统筹裁决；这是文本比对结果，可能有误报。",
			ticket: item.ticket,
			metrics: {
				冲突路径: item.paths.length,
				涉及lane: item.lanes.join(",")
			},
			evidence: item.excerpt,
			at: item.modifiedAt ?? void 0
		});
	}
	for (const item of conflicts.items) {
		if (item.kind !== "findings" || !item.blocked) continue;
		const isActive = active.has(item.ticket);
		findings.push({
			dimension: "team",
			severity: isActive ? "warn" : "info",
			id: `team:blocked:${item.ticket}:${item.lane}`,
			title: `${isActive ? "" : "历史遗留："}子任务 ${item.lane} 在共享区标记 BLOCKED`,
			detail: "该 lane 自报被阻塞；如果需要它继续产出，应由统筹解除阻塞或改派。",
			ticket: item.ticket,
			metrics: {
				文件: item.path,
				字节: item.bytes
			},
			evidence: item.excerpt,
			at: item.modifiedAt ?? void 0
		});
	}
	if (conflicts.findingsFiles > 0) {
		const lanesCovered = new Set(conflicts.items.filter((item) => item.kind === "findings" && item.lane).map((item) => `${item.ticket}#${item.lane}`));
		findings.push({
			dimension: "team",
			severity: "info",
			id: "team:findings",
			title: `共享区有 ${conflicts.findingsFiles} 份 findings，覆盖 ${lanesCovered.size} 个 lane`,
			detail: "findings 是 lane 之间避免重复劳动的中间结论；数量长期为 0 说明共享区没有被用起来。",
			metrics: {
				findings文件: conflicts.findingsFiles,
				覆盖lane: lanesCovered.size,
				BLOCKED: conflicts.blockedFindings
			}
		});
	}
	const doneWorkers = lanes.filter((lane) => lane.role === "worker" && lane.status === "done");
	const covered = new Set(conflicts.items.filter((item) => item.kind === "findings" && item.lane).map((item) => `${item.ticket}#${item.lane}`));
	const missing = doneWorkers.filter((lane) => !covered.has(`${lane.ticket}#${lane.lane}`));
	if (missing.length > 0) findings.push({
		dimension: "team",
		severity: "info",
		id: "team:findings-missing",
		title: `${missing.length} 个已完成子任务没有写 shared findings`,
		detail: "子 worker 完成后应写一条 findings/<lane>.md，供后续 lane 和汇总阶段复用。",
		metrics: {
			缺少findings: missing.length,
			已完成子任务: doneWorkers.length
		},
		ticket: missing.length === 1 ? `${missing[0].ticket}` : void 0
	});
	return findings;
}
/** 本机时区的日期键（YYYY-MM-DD）。台账 ts 不带时区，用 UTC 会错位 8 小时。 */
function localDayKey(at) {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
/**
* 「近 N 天」窗口包含的日期键集合（含今天，共 N 天）。
*
* 成本维度与趋势图必须共用这一个定义：早先成本维度只累加、不按日期过滤，
* 而 scanTickets 只按「工单目录 7 天内还有动静」筛选，工单里更早的台账行会一起进来——
* 于是「近7天成本」比趋势图各天之和高出一截（2026-11-10 实测多算 15 行 11-03 的 $9.28）。
*/
function windowDays(now, days) {
	const set = /* @__PURE__ */ new Set();
	for (let i = days - 1; i >= 0; i--) set.add(localDayKey(now - i * 864e5));
	return set;
}
/** 把一个 stderr 归成「一条规则」的标识：取第一行并把数字/路径替换掉，避免同一条错误千变万化。 */
function stderrKey(text) {
	return text.split("\n")[0].trim().replace(/\d+/g, "#").replace(/\/[^\s]+/g, "/#").slice(0, 120);
}
/**
* 执行器维度**按错误类型聚合**，不按工单铺。
* 67 个工单都报同一句 unrecognized_model 时，用户需要知道的是「有一个全局配置问题」，
* 而不是 67 条一模一样的条目。
*/
function executorFindings(scans) {
	const byKey = /* @__PURE__ */ new Map();
	for (const scan of scans) {
		if (!scan.stderr) continue;
		const key = stderrKey(scan.stderr);
		if (!key) continue;
		const benign = BENIGN_STDERR.some((pattern) => pattern.test(scan.stderr));
		const entry = byKey.get(key) ?? {
			message: scan.stderr.split("\n")[0].trim(),
			tickets: [],
			benign
		};
		entry.tickets.push(scan.key);
		byKey.set(key, entry);
	}
	const findings = [];
	for (const [key, entry] of byKey) {
		const count = entry.tickets.length;
		findings.push({
			dimension: "executor",
			severity: entry.benign ? "info" : "warn",
			id: `executor:${key}`,
			title: entry.benign ? `已知良性告警，${count} 个工单出现过（可忽略）` : `执行器报错，${count} 个工单出现过`,
			detail: entry.benign ? "unrecognized_model 只是 Claude Code 对模型名的 SDK 侧标注，不影响执行结果。如果哪天它开始伴随失败，再升级处理。" : "同一句报错跨多个工单出现，通常来自全局配置（模型名、端点、凭据），不是单个任务的问题。",
			ticket: count === 1 ? entry.tickets[0] : void 0,
			metrics: {
				命中工单数: count,
				良性: entry.benign ? "是" : "否"
			},
			evidence: entry.message.slice(0, 600)
		});
	}
	return findings;
}
function budgetFindings(scans, now) {
	const findings = [];
	let noPlan = 0;
	let dupRuns = 0;
	let capped = 0;
	for (const scan of scans) {
		const status = scan.budget;
		if (status) {
			const violation = status.violation;
			const duplicates = Array.isArray(status.duplicates) ? status.duplicates : [];
			const planned = Number(status.planned_steps ?? 0);
			const used = Number(status.steps_used ?? 0);
			if (violation) {
				const active = isActiveTicket(scan, now);
				findings.push({
					dimension: "budget",
					severity: active ? "critical" : "info",
					id: `budget:violation:${scan.key}`,
					title: `${active ? "" : "历史遗留："}预算违规：${String(violation).slice(0, 80)}`,
					detail: active ? "硬闸门已记录违规，本轮可能被提前终止。" : `工单已结束（最后活动 ${new Date(scan.at).toISOString()}），这次违规不会再影响后续轮次；保留作审计，不计入「需立刻处理」。`,
					ticket: scan.key,
					metrics: {
						计划步数: planned,
						实际步数: used
					},
					at: typeof status.ts === "string" ? status.ts : void 0
				});
			}
			if (duplicates.length >= THRESHOLDS.duplicateWarn) {
				dupRuns++;
				findings.push({
					dimension: "budget",
					severity: "warn",
					id: `budget:duplicate:${scan.key}`,
					title: `重复调用同一命令 ${duplicates.length} 次`,
					detail: "重复执行既烧 token 又说明任务在原地打转，通常是上一步结果没被正确读取。",
					ticket: scan.key,
					metrics: {
						重复次数: duplicates.length,
						实际步数: used
					},
					evidence: duplicates.slice(0, 5).join("\n")
				});
			}
			if (planned > 0 && used > planned * 2) findings.push({
				dimension: "budget",
				severity: "info",
				id: `budget:overshoot:${scan.key}`,
				title: `步数超计划 ${(used / planned).toFixed(1)} 倍`,
				detail: "该工单的预算校准系数会因此上调，属于自学习而非故障。",
				ticket: scan.key,
				metrics: {
					计划步数: planned,
					实际步数: used
				}
			});
		}
		for (const row of scan.ledger) {
			if (row?.capped) {
				capped++;
				const latestRun = scan.ledger.reduce((best, cur) => String(cur?.ts ?? "") >= String(best?.ts ?? "") ? cur : best, scan.ledger[0]);
				const isLatestRun = String(row?.run ?? "") === String(latestRun?.run ?? "");
				const active = isActiveTicket(scan, now);
				const current = isLatestRun && active;
				findings.push({
					dimension: "budget",
					severity: current ? "warn" : "info",
					id: `budget:capped:${scan.key}:${String(row.run ?? "")}`,
					title: `${current ? "" : "历史遗留："}本轮触到硬上限被截断`,
					detail: current ? "capped=true 意味着本次结果可能不完整，需要看是否是 --max-turns 或重复调用触发的。" : `工单已结束或该轮不是最新一轮（最后活动 ${new Date(scan.at).toISOString()}）：这次截断不会再影响后续轮次，只作审计，不占「值得看一眼」名额。`,
					ticket: scan.key,
					metrics: {
						步数: Number(row.act_steps ?? 0),
						成本: Number(row.cost_usd ?? 0)
					},
					at: typeof row.ts === "string" ? row.ts : void 0
				});
			}
			if (row?.plan_found === false) noPlan++;
		}
	}
	const runs = scans.reduce((sum, scan) => sum + scan.ledger.length, 0);
	if (runs > 0 && noPlan > 0) findings.push({
		dimension: "budget",
		severity: "info",
		id: "budget:noplan",
		title: `${noPlan}/${runs} 轮没有预算计划`,
		detail: "BUDGET_PLAN 是可选的，只用于事后校准。比例长期偏高说明执行层没在按计划走。",
		metrics: {
			无计划轮数: noPlan,
			总轮数: runs,
			重复命中: dupRuns,
			被截断: capped
		}
	});
	return findings;
}
function costFindings(scans, now, precomputed) {
	const findings = [];
	const todayKey = localDayKey(now);
	const window = windowDays(now, 7);
	let worst = null;
	let todayCalCost = 0;
	let todayCalRuns = 0;
	let todayUncalCost = 0;
	let todayUncalRuns = 0;
	let todayRecovered = 0;
	let windowRecovered = 0;
	let windowCalCost = 0;
	let windowCalRuns = 0;
	let windowUncalCost = 0;
	let windowUncalRuns = 0;
	let uncalibratedCost = 0;
	let uncalibratedRuns = 0;
	let historyRuns = 0;
	let historyCost = 0;
	const historyTickets = /* @__PURE__ */ new Set();
	const costRows = precomputed ?? trueCostRows(scans);
	const latestRunByTicket = /* @__PURE__ */ new Map();
	for (const { scan, row } of costRows) {
		if (row?.cost_usd === null || row?.cost_usd === void 0) continue;
		const ts = String(row?.ts ?? "");
		const current = latestRunByTicket.get(scan.key);
		if (!current || ts >= current.ts) latestRunByTicket.set(scan.key, {
			run: String(row?.run ?? ""),
			ts
		});
	}
	for (const { scan, row, cost, calibrated, recoveredBase } of costRows) {
		const cacheDelta = Number(row?.act_cache_read ?? row?.act_cache_read_cum ?? 0) || 0;
		const cacheCum = Number(row?.act_cache_read_cum ?? row?.act_cache_read ?? 0) || 0;
		const inputCum = Number(row?.act_input_cum ?? 0) || 0;
		const outputCum = Number(row?.act_output_cum ?? 0) || 0;
		const cache = cacheDelta;
		const ts = String(row?.ts ?? "");
		const dayKey = ts.slice(0, 10);
		const isToday = dayKey === todayKey;
		const inWindow = window.has(dayKey);
		if (recoveredBase > 0 && inWindow) windowRecovered += recoveredBase;
		if (recoveredBase > 0 && isToday) todayRecovered += recoveredBase;
		if (!calibrated) {
			if (inWindow) {
				uncalibratedCost += cost;
				uncalibratedRuns++;
				windowUncalCost += cost;
				windowUncalRuns++;
			}
			if (isToday) {
				todayUncalCost += cost;
				todayUncalRuns++;
			}
			continue;
		}
		if (isToday) {
			todayCalCost += cost;
			todayCalRuns++;
		}
		if (!inWindow) continue;
		windowCalCost += cost;
		windowCalRuns++;
		if (!worst || cost > worst.cost) worst = {
			cost,
			ticket: scan.key,
			run: String(row?.run ?? ""),
			cache
		};
		if (cost < THRESHOLDS.runCostWarn) continue;
		const isLatest = latestRunByTicket.get(scan.key)?.run === String(row?.run ?? "");
		if (!isLatest) {
			historyRuns++;
			historyCost += cost;
			historyTickets.add(scan.key);
			continue;
		}
		const steps = Number(row?.act_steps ?? 0);
		const bloat = steps > 0 && steps <= 3;
		const overLimit = cost >= THRESHOLDS.runCostCritical;
		const active = isActiveTicket(scan, now);
		const critical = overLimit && active;
		const perStep = steps > 0 ? cost / steps : Infinity;
		const efficientLong = steps >= THRESHOLDS.efficientLongSteps && perStep < THRESHOLDS.costPerStepWarn;
		const severity = efficientLong || !active ? "info" : critical ? "critical" : "warn";
		const bloatDiagnosis = cacheCum >= 1e7 ? `只有 ${steps} 次工具调用，但本轮累计缓存读 ${(cacheCum / 1e6).toFixed(1)}M，几乎一定是首轮把超大上下文整个读入。这是最该先切断的成本形态。` : inputCum >= 5e5 ? `只有 ${steps} 次工具调用，但内部累计输入 ${Math.round(inputCum / 1e3)}K、输出 ${Math.round(outputCum / 1e3)}K：成本来自多次内部轮次，而不是单次巨型上下文。` : `只有 ${steps} 次工具调用却花了 $${cost.toFixed(2)}，单轮成本与产出不匹配，值得确认是否做了不必要的长上下文重读。`;
		findings.push({
			dimension: "cost",
			severity,
			id: `cost:run:${scan.key}:${String(row?.run ?? "")}`,
			title: `${active ? "" : "历史遗留："}${bloat ? `仅 ${steps} 步就花了 $${cost.toFixed(2)}${overLimit ? `，超过 $${THRESHOLDS.runCostCritical}` : ""}` : overLimit ? `单轮成本 $${cost.toFixed(2)}，超过 $${THRESHOLDS.runCostCritical}` : `单轮成本 $${cost.toFixed(2)}`}`,
			detail: !isLatest ? `这是历史轮（该工单最新一轮是 ${latestRunByTicket.get(scan.key)?.run ?? "未知"}），后续轮次已覆盖它的状态，钱已花掉、无法再处理；只作复盘，不占「需立刻处理/值得看一眼」名额。` : efficientLong ? `${steps} 步共花 $${cost.toFixed(2)}，每步 $${perStep.toFixed(2)}，低于常规线 $${THRESHOLDS.costPerStepWarn}：总价高来自工作量大，不是上下文重放或成本失控，属正常吞吐。` : !active ? `工单已结束（该 run 结束于 ${ts || "未知时间"}），这笔钱已经花掉、无法再处理；保留作复盘，不计入「需立刻处理」。` : bloat ? bloatDiagnosis : critical ? "高价 run 一般是上下文过大或 resume 重放历史。看 cache_read 是否同时被打满。" : "高于常规单轮成本（$1 起）但低于 $5 严重线，值得看一眼是不是不必要的长上下文。",
			ticket: scan.key,
			metrics: {
				成本: Number(cost.toFixed(4)),
				每步成本: Number.isFinite(perStep) ? Number(perStep.toFixed(4)) : null,
				缓存读: cache,
				累计缓存读: cacheCum,
				累计输入: inputCum,
				输出: outputCum,
				步数: steps
			},
			at: ts || void 0
		});
	}
	if (uncalibratedRuns > 0) findings.push({
		dimension: "cost",
		severity: "info",
		id: "cost:uncalibrated",
		title: `另有 ${uncalibratedRuns} 轮没有会话基线，累计金额 $${uncalibratedCost.toFixed(2)} 已计入总花费、不参与单轮均值`,
		detail: "这些台账行的 baseline_source=none：cc-worker 在同目录的 runlog/台账里找不到同一 session 的更早 result，无法把会话累计成本折成单轮增量（典型是新开会话的首轮、克隆会话、或 runlog 已清理）。它们的钱确实花了，所以按台账 ts 计入今日/近7天总额；但 cost 是会话累计值，拿去做单轮均值或最贵单轮会重现修好前的虚高，所以只从单轮指标里排除。",
		metrics: {
			未校准轮数: uncalibratedRuns,
			未校准金额: Number(uncalibratedCost.toFixed(4))
		}
	});
	if (historyRuns > 0) findings.push({
		dimension: "cost",
		severity: "info",
		id: "cost:history",
		title: `历史轮（非最新一轮）${historyRuns} 轮合计 $${historyCost.toFixed(2)}，已折叠不再逐条报`,
		detail: `这 ${historyRuns} 轮分布在 ${historyTickets.size} 个工单，都不是各自工单的最新一轮：后续轮次已经覆盖了它们的运行状态，这些钱已经花掉、无法再处理，只作复盘。金额仍计入「近7天成本」总额；逐条展开请查对应工单的 budget-ledger.jsonl。`,
		metrics: {
			历史轮数: historyRuns,
			历史轮金额: Number(historyCost.toFixed(4)),
			涉及工单数: historyTickets.size
		}
	});
	return {
		findings,
		metrics: {
			今日成本: Number((todayCalCost + todayUncalCost + todayRecovered).toFixed(4)),
			今日轮数: todayCalRuns + todayUncalRuns,
			今日已校准: Number((todayCalCost + todayRecovered).toFixed(4)),
			今日未校准: Number(todayUncalCost.toFixed(4)),
			近7天成本: Number((windowCalCost + windowUncalCost + windowRecovered).toFixed(4)),
			近7天轮数: windowCalRuns + windowUncalRuns,
			近7天已校准: Number((windowCalCost + windowRecovered).toFixed(4)),
			近7天未校准: Number(windowUncalCost.toFixed(4)),
			历史基线补齐: Number(windowRecovered.toFixed(4)),
			单轮均值: windowCalRuns ? Number((windowCalCost / windowCalRuns).toFixed(4)) : 0,
			最贵单轮: worst ? Number(worst.cost.toFixed(4)) : 0,
			最贵单轮工单: worst ? worst.ticket : null,
			未校准金额: Number(uncalibratedCost.toFixed(4)),
			未校准轮数: uncalibratedRuns
		}
	};
}
function contextFindings(scans, now) {
	const findings = [];
	let historyCacheRuns = 0;
	let historyCacheTickets = /* @__PURE__ */ new Set();
	let liveSwitches = 0;
	let staleSwitchTickets = 0;
	for (const scan of scans) {
		const latest = scan.ledger.length ? scan.ledger.reduce((best, row) => String(row?.ts ?? "") >= String(best?.ts ?? "") ? row : best, scan.ledger[0]) : null;
		const latestRun = String(latest?.run ?? "");
		const active = isActiveTicket(scan, now);
		const reason = scan.workerDir ? readHead(`${scan.workerDir}/switch-reason`, 200).trim() : "";
		const count = switchCount(scan.workerDir);
		if (count >= 2) {
			if (active) {
				liveSwitches++;
				findings.push({
					dimension: "context",
					severity: "warn",
					id: `context:switch:${scan.key}`,
					title: `同一工单换会话 ${count} 次`,
					detail: `频繁换会话说明上下文持续膨胀。换会话本身省 token，但过于频繁意味着每个会话都没跑完就撑爆了。当前判定：工单仍在进行（最后活动 ${new Date(scan.at).toISOString()}）。`,
					ticket: scan.key,
					metrics: { 换会话次数: count },
					evidence: reason || void 0
				});
			} else staleSwitchTickets++;
		}
		for (const row of scan.ledger) {
			const run = String(row?.run ?? "");
			const session = String(row?.session_id ?? "");
			const fromLedger = Number(row?.context_size) || 0;
			const cache = fromLedger > 0 ? fromLedger : getTurnContextPeak(scan, run, session) ?? 0;
			const steps = Number(row?.act_steps ?? 0);
			if (cache >= THRESHOLDS.contextSizeWarn) {
				if (run !== latestRun || !active) {
					historyCacheRuns++;
					historyCacheTickets.add(scan.key);
					continue;
				}
				findings.push({
					dimension: "context",
					severity: "warn",
					id: `context:cache:${scan.key}:${run}`,
					title: `单轮上下文 ${Math.round(cache / 1e3)}K，接近窗口上限`,
					detail: `本轮真实上下文（最后一次 API 调用的 input + cache_read）${Math.round(cache / 1e3)}K，超过告警线 ${Math.round(THRESHOLDS.contextSizeWarn / 1e3)}K。声明窗口 400K，余量已不多，下一轮 resume 会整段重放，应在该轮结束前写入交接并换会话。`,
					ticket: scan.key,
					metrics: {
						单轮上下文: cache,
						步数: steps,
						累计缓存读: Number(row?.act_cache_read ?? 0) || 0
					},
					at: typeof row.ts === "string" ? row.ts : void 0
				});
			}
			if (steps >= THRESHOLDS.stepsWarn) findings.push({
				dimension: "context",
				severity: "info",
				id: `context:steps:${scan.key}:${run}`,
				title: `单轮 ${steps} 步`,
				detail: "步数偏多的轮次，工具输出累积是上下文膨胀的主要来源。",
				ticket: scan.key,
				metrics: { 步数: steps },
				at: typeof row.ts === "string" ? row.ts : void 0
			});
		}
	}
	if (historyCacheRuns > 0) findings.push({
		dimension: "context",
		severity: "info",
		id: "context:history",
		title: `历史轮 ${historyCacheRuns} 次上下文逼近上限，已折叠不再逐条报`,
		detail: `涉及 ${historyCacheTickets.size} 个工单的历史轮或已结束工单：后续轮次已覆盖其运行状态，且工单不在运行中，这些记录无法再处理，只作复盘。告警线按单轮真实上下文（context_size）判 ${Math.round(THRESHOLDS.contextSizeWarn / 1e3)}K，不再用一轮内累计缓存读。`,
		metrics: {
			历史轮数: historyCacheRuns,
			涉及工单数: historyCacheTickets.size
		}
	});
	if (staleSwitchTickets > 0) findings.push({
		dimension: "context",
		severity: "info",
		id: "context:switch-history",
		title: `${staleSwitchTickets} 个已结束工单换过多次会话，已折叠`,
		detail: "工单已结束，换会话次数只反映历史运行形态；仍计入「换会话合计」指标，不再占「值得看一眼」名额。",
		metrics: {
			已结束工单数: staleSwitchTickets,
			进行中工单数: liveSwitches
		}
	});
	return findings;
}
/**
* 「运行中」的判定不能只看 handoff-state 的 updated：收尾轮不写状态。
* 用 worker 目录里最新文件的 mtime 作为「最后有动静」的近似，再结合 claude.pid 是否还活着。
*/
function livenessFindings(scans, now) {
	const findings = [];
	for (const scan of scans) {
		if (!scan.workerDir) continue;
		const pidText = readHead(`${scan.workerDir}/claude.pid`, 32).trim();
		const pid = Number(pidText);
		const hasPid = Number.isFinite(pid) && pid > 0;
		const alive = hasPid && pidAlive(pid);
		const silentMs = now - scan.at;
		if (hasPid && silentMs > THRESHOLDS.stallCriticalMs) findings.push({
			dimension: "liveness",
			severity: alive ? "warn" : "info",
			id: `liveness:stale:${scan.key}`,
			title: alive ? `进程 ${pid} 仍存活但已 ${Math.round(silentMs / 6e4)} 分钟没动静` : `残留 pid 文件（进程 ${pid} 已退出），已 ${Math.round(silentMs / 6e4)} 分钟无新动作`,
			detail: alive ? "进程还在但长时间没有新动作，可能卡在单个工具调用里，需要确认是否真的要继续等。" : "进程已经退出，只是 pid 文件没被清理；不需要处理，属于收尾残留。",
			ticket: scan.key,
			metrics: {
				pid,
				进程存活: alive ? "是" : "否",
				静默分钟: Math.round(silentMs / 6e4)
			},
			at: new Date(scan.at).toISOString()
		});
		else if (silentMs > THRESHOLDS.stallWarnMs && silentMs <= THRESHOLDS.stallCriticalMs) findings.push({
			dimension: "liveness",
			severity: "info",
			id: `liveness:idle:${scan.key}`,
			title: `${Math.round(silentMs / 6e4)} 分钟无新动作`,
			detail: "处于停滞观察窗口内。长任务在单个工具里耗时不写文件，因此短时静默是正常的。",
			ticket: scan.key,
			metrics: { 静默分钟: Math.round(silentMs / 6e4) }
		});
	}
	return findings;
}
/**
* 跑一次完整治理扫描。
* @param now 当前时间（毫秒），测试可注入。
* @param options.ticket 只扫一个工单目录（验收取样/面板钻取）；默认全量。
*/
function govern(now = Date.now(), options = {}) {
	const scans = scanTickets(now, options.ticket);
	const ticketCount = new Set(scans.map((scan) => scan.name)).size;
	const costRows = trueCostRows(scans);
	const lanes = buildLaneExecutions(scans, now, costRows);
	const team = buildTeamReport(lanes, scans, now);
	const conflicts = buildConflictReport(scans);
	const handoff = handoffFindings(scans, now);
	const executor = executorFindings(scans);
	const budget = budgetFindings(scans, now);
	const { findings: cost, metrics: costMetrics } = costFindings(scans, now, costRows);
	const context = contextFindings(scans, now);
	const switchTotal = scans.reduce((sum, scan) => sum + switchCount(scan.workerDir), 0);
	const liveness = livenessFindings(scans, now);
	const teamIssues = teamFindings(lanes, team, conflicts, scans, now);
	const findings = [
		...teamIssues,
		...handoff,
		...executor,
		...budget,
		...cost,
		...context,
		...liveness
	];
	const severityRank = {
		critical: 0,
		warn: 1,
		info: 2
	};
	const order = [
		"team",
		"handoff",
		"executor",
		"budget",
		"cost",
		"context",
		"liveness"
	];
	findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || order.indexOf(a.dimension) - order.indexOf(b.dimension) || String(b.at ?? "").localeCompare(String(a.at ?? "")));
	const groups = {
		team: teamIssues,
		handoff,
		executor,
		budget,
		cost,
		context,
		liveness
	};
	const dimensionMetrics = {
		team: team.present || conflicts.present || team.lanes > 0 ? {
			团队工单: team.tickets,
			计划lane数: team.workerLanes,
			完成: team.done,
			失败: team.failed,
			进行中: team.running,
			未启动: team.pending,
			团队总成本: team.totalCostUsd,
			总轮次: team.totalRuns,
			峰值并行: team.peakParallelism,
			findings文件: conflicts.findingsFiles,
			冲突路径: conflicts.conflictPaths
		} : {},
		handoff: {
			有交接记录: scans.filter((scan) => scan.handoff).length,
			工单数: ticketCount
		},
		executor: {
			有错误日志: scans.filter((scan) => scan.stderr).length,
			工单数: ticketCount
		},
		budget: {
			台账轮数: scans.reduce((sum, scan) => sum + scan.ledger.length, 0),
			有预算状态: scans.filter((scan) => scan.budget).length
		},
		cost: costMetrics,
		context: {
			换会话合计: switchTotal,
			有台账工单: scans.filter((scan) => scan.ledger.length > 0).length
		},
		liveness: { 有worker目录: scans.filter((scan) => scan.workerDir).length }
	};
	const dimensions = order.map((key) => {
		const list = groups[key];
		const critical = list.filter((item) => item.severity === "critical").length;
		const warn = list.filter((item) => item.severity === "warn").length;
		return {
			key,
			issues: critical + warn,
			critical,
			warn,
			metrics: dimensionMetrics[key],
			verdict: critical > 0 ? "bad" : warn > 0 ? "watch" : Object.keys(dimensionMetrics[key]).length ? "ok" : "unknown"
		};
	});
	const totalCritical = findings.filter((item) => item.severity === "critical").length;
	const totalWarn = findings.filter((item) => item.severity === "warn").length;
	const overall = totalCritical > 0 ? "bad" : totalWarn > 0 ? "watch" : "ok";
	const headline = overall === "ok" ? `七个维度全绿（${ticketCount} 个工单${team.present ? `，${team.workerLanes} 条 lane` : ""}，${costMetrics["近7天轮数"] ?? 0} 轮）` : `${totalCritical} 项需立刻处理，${totalWarn} 项值得看一眼`;
	return {
		generatedAt: new Date(now).toISOString(),
		overall,
		headline,
		dimensions,
		findings,
		lanes,
		team,
		conflicts,
		scanned: {
			tickets: ticketCount,
			laneUnits: scans.filter((scan) => scan.lane).length,
			withWorkerDir: scans.filter((scan) => scan.workerDir).length,
			withHandoffState: scans.filter((scan) => scan.handoff).length,
			ledgerRuns: scans.reduce((sum, scan) => sum + scan.ledger.length, 0),
			teamTickets: team.tickets
		}
	};
}
/** 全局台账的按日汇总，用于「今日/本周成本」趋势。前端可以不要，路由按需提供。 */
function spendTrend(now = Date.now(), days = 7) {
	const rows = trueCostRows(scanTickets(now));
	const buckets = /* @__PURE__ */ new Map();
	for (const day of windowDays(now, days)) buckets.set(day, {
		cost: 0,
		runs: 0
	});
	for (const { row, cost, recoveredBase } of rows) {
		const bucket = buckets.get(String(row?.ts ?? "").slice(0, 10));
		if (!bucket) continue;
		bucket.cost += cost + recoveredBase;
		bucket.runs++;
	}
	return [...buckets.entries()].map(([day, value]) => ({
		day,
		cost: Number(value.cost.toFixed(4)),
		runs: value.runs
	}));
}
// src/index.ts
/** 必需服务：cordis 见到这个声明才会在 apply 之前把 ctx.webServer 装好。 */
const inject = ["webServer"];
/** 精确匹配：宿主 `/api` 前缀的 RPC 网关对无 cookie 请求回 401，精确表优先命中。 */
const ROUTE = "/api/governance";
/** 周报超过这个时长就现场重新生成。 */
const WEEKLY_TTL_MS = 864e5;
/** 单次返回的周报正文上限。 */
const WEEKLY_MAX_CHARS = 4e4;
const home = () => process.env.HOME ?? homedir();
const reportRoot = () => `${home()}/.dsh/state/superagent/reports`;
const weeklyScript = () => `${home()}/cc-diag/handoff_weekly.py`;
/** 读最近一份周报；不存在或过期时现场跑一次生成脚本。失败就当没有周报。 */
function readWeekly(now) {
	const latest = `${reportRoot()}/handoff-weekly-latest.md`;
	let stale = true;
	let exists = false;
	try {
		const stat = statSync(latest);
		exists = true;
		stale = now - stat.mtimeMs > WEEKLY_TTL_MS;
	} catch {}
	let generated = false;
	if (stale) try {
		execFileSync("/usr/bin/python3", [
			weeklyScript(),
			"--days",
			"7"
		], {
			timeout: 8e3,
			stdio: "ignore"
		});
		generated = !exists;
	} catch {}
	try {
		const stat = statSync(latest);
		return {
			path: latest,
			updated: new Date(stat.mtimeMs).toISOString(),
			text: readFileSync(latest, "utf8").slice(0, WEEKLY_MAX_CHARS),
			generated
		};
	} catch {
		return null;
	}
}
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(text);
}
function apply(ctx) {
	const handler = (req, res) => {
		if (req.method !== "GET") {
			sendJson(res, 405, { error: "read-only plugin" });
			return;
		}
		try {
			const now = Date.now();
			const url = new URL(String(req.url ?? "/"), "http://localhost");
			const wantWeekly = url.searchParams.get("weekly") === "1";
			const wantTrend = url.searchParams.get("trend") === "1";
			const only = (url.searchParams.get("dims") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
			const report = govern(now, { ticket: (url.searchParams.get("ticket") ?? "").trim() || void 0 });
			if (only.length > 0) {
				report.findings = report.findings.filter((item) => only.includes(item.dimension));
				report.dimensions = report.dimensions.filter((item) => only.includes(item.key));
			}
			sendJson(res, 200, {
				...report,
				weekly: wantWeekly ? readWeekly(now) : null,
				trend: wantTrend ? spendTrend(now, 7) : null
			});
		} catch (error) {
			ctx.logger?.warn?.("dsh-governance-panel: 治理扫描失败 %s", String(error));
			sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE,
		handler
	}), "governance-panel: governance route");
}
export { apply, inject };
