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
// src/guard-entry.ts
const name = "dsh-superagent-pane-guard";
const inject = ["tools"];
/**
* 装上硬限制守卫。
*
* `inject` 里声明 `tools` 而不是在 apply 里自己 inject：Cordis 会在该服务就绪时才调用 apply，
* 服务缺失时这一条会显示为 pending，一眼能看出守卫没生效——这比静默降级安全。
*/
function apply(ctx) {
	installWorkerGuard(ctx);
}
export { apply, inject, name };
