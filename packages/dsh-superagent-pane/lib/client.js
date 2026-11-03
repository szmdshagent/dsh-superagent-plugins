window.__ModuleLoader__.load({
	id: "dsh-superagent-pane",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/ccpanel.tsx
		const STATE_TEXT = {
			none: "未委托",
			running: "执行中",
			thinking: "思考中",
			done: "已完成",
			error: "出错",
			stalled: "疑似卡死"
		};
		const STATE_COLOR = {
			none: "#888",
			running: "#38a169",
			thinking: "#3182ce",
			done: "#38a169",
			error: "#e53e3e",
			stalled: "#dd6b20"
		};
		/** 把毫秒压成「n 秒 / n 分钟」。 */
		function formatAge(ms) {
			if (ms === void 0) return "";
			if (ms < 6e4) return `${Math.max(1, Math.round(ms / 1e3))} 秒`;
			return `${Math.round(ms / 6e4)} 分钟`;
		}
		function CcPanel({ status, expanded, onToggle, onInterrupt, onClear, busy }) {
			if (!status || !status.present) return null;
			const color = STATE_COLOR[status.state];
			const steps = status.steps ?? [];
			const done = steps.filter((step) => step.done).length;
			const alertColor = status.alert === "critical" ? "#e53e3e" : status.alert === "warn" ? "#dd6b20" : void 0;
			const running = status.state === "running" || status.state === "thinking" || status.state === "stalled";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					marginTop: 4,
					borderTop: "1px dashed var(--dt-border, #333)",
					paddingTop: 5,
					fontSize: 11,
					display: "flex",
					flexDirection: "column",
					gap: 4
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 5,
							alignItems: "baseline",
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color,
									fontWeight: 600
								},
								children: "● Claude Code"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .8 },
								children: STATE_TEXT[status.state]
							}),
							steps.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { opacity: .6 },
								children: [
									"第 ",
									done,
									"/",
									steps.length,
									" 步"
								]
							}),
							status.ageMs !== void 0 && running && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { opacity: .6 },
								children: [
									"· ",
									formatAge(status.ageMs),
									"前有动作"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: onToggle,
								style: {
									marginLeft: "auto",
									background: "none",
									border: "none",
									padding: 0,
									color: "inherit",
									opacity: .65,
									cursor: "pointer",
									textDecoration: "underline",
									fontSize: 11
								},
								children: expanded ? "收起" : "展开"
							})
						]
					}),
					status.current && running && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							opacity: .85,
							fontFamily: "monospace",
							wordBreak: "break-all"
						},
						children: [status.current.tool, status.current.detail ? `：${status.current.detail.slice(0, 120)}` : ""]
					}),
					status.alertText && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							color: alertColor,
							fontWeight: 500
						},
						children: ["⚠ ", status.alertText]
					}),
					status.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							color: "#e53e3e",
							fontFamily: "monospace",
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							maxHeight: 80,
							overflowY: "auto"
						},
						children: status.error
					}),
					expanded && steps.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							maxHeight: 150,
							overflowY: "auto",
							display: "flex",
							flexDirection: "column",
							gap: 2,
							background: "rgba(0,0,0,.25)",
							padding: "5px 7px",
							borderRadius: 4
						},
						children: steps.slice(-20).map((step) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 5,
								opacity: step.done ? .65 : 1
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										color: step.done ? "#38a169" : "#dd6b20",
										minWidth: 14
									},
									children: step.done ? "✓" : "→"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { fontWeight: 500 },
									children: step.tool
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontFamily: "monospace",
										wordBreak: "break-all"
									},
									children: (step.detail ?? "").slice(0, 100)
								})
							]
						}, step.step))
					}),
					running && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [status.interruptRequested ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: "#dd6b20" },
						children: "已请求中止，等待 cc-worker 响应…"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						disabled: busy,
						onClick: onInterrupt,
						style: {
							fontSize: 11,
							padding: "2px 8px",
							cursor: busy ? "wait" : "pointer"
						},
						children: "中止执行"
					}), status.interruptRequested && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						disabled: busy,
						onClick: onClear,
						style: {
							fontSize: 11,
							padding: "2px 8px",
							marginLeft: 6,
							cursor: busy ? "wait" : "pointer"
						},
						children: "取消中止请求"
					})] })
				]
			});
		}
		// src/client.tsx
		/**
		* 浏览器侧插件入口：侧边栏「派活」面板——派活、读对话、看 worker 正在做什么。
		*
		* 它注册自己的 slot，而不是改 dsh-superagent 的面板，所以升级主包不会把它弄丢。与主包唯一的接触面，
		* 是本插件自己提供的 HTTP 路由，以及宿主公开的管理 API（工单列表）。
		*/
		const inject = ["slots", "locale"];
		const NS = "dshSuperagentPane";
		const PANEL_ID = "dsh-superagent-pane";
		/** 本插件自己的路由，位于面板的 API 前缀下。 */
		const API = "/orchestrator/api/pane";
		/** 宿主的管理 API（只读工单），与面板同源。 */
		const HOST_API = "/orchestrator/api";
		/** pane Source 的 Thread 键前缀，与 Node 侧一致。 */
		const THREAD_PREFIX = "pane:";
		/** 同源管理调用需要的头，面板每个请求都带；令牌随页面 URL 而来。 */
		function headers() {
			return {
				"x-orchestrator-request": "1",
				"content-type": "application/json"
			};
		}
		function token() {
			return new URLSearchParams(window.location.search).get("token") ?? "";
		}
		/** 发一个同源管理请求；`path` 为完整路径（令牌自动附加）。 */
		async function request(path, init) {
			const value = token();
			const url = `${path}${value ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(value)}` : ""}`;
			const response = await fetch(url, {
				...init,
				headers: {
					...headers(),
					...init?.headers ?? {}
				}
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
			return body;
		}
		/** 调本插件自己的路由。 */
		const call = (path, init) => request(`${API}${path}`, init);
		const zh = {
			panel: "派活",
			placeholder: "输入任务，回车发送（Shift+回车换行）",
			send: "发送",
			sending: "发送中…",
			conversation: "对话",
			empty: "还没有消息。输入一句话就能派活给 superagent。",
			failed: "发送失败：{error}",
			you: "你",
			agent: "智能体",
			newConversation: "新对话",
			statusWorking: "运行中",
			statusPerson: "等你处理",
			statusIdle: "待命",
			statusEnded: "已结束",
			stopTicket: "确认停止？",
			closeHintEnded: "关闭这张工单卡（不再显示）",
			closeHintOpen: "停止这张工单并收起：正在执行的 worker 会被中断",
			elapsedSec: "{n} 秒",
			elapsedMin: "{n} 分钟",
			elapsedHour: "{h} 小时 {m} 分",
			workPython: "运行 Python 脚本",
			workVideo: "处理视频",
			workScript: "运行脚本",
			workDeps: "安装依赖",
			workGit: "Git 操作",
			workSearch: "搜索内容",
			workDownload: "下载文件",
			workView: "查看文件",
			workFind: "查找文件",
			workFiles: "整理文件",
			workCommand: "执行命令",
			workRunning: "工作中",
			think: "正在思考…",
			thinkWith: "正在思考…（上一步：{what}）",
			waitAfter: "上一步：{what}，等待继续",
			waitNext: "等待下一步…",
			stalled: "{mins} 分钟没有新动作",
			waitingReply: "已送达 · 等待 worker 回复（{n} 条排队，已等 {time}）",
			waitingBusy: "已送达 · worker 正忙，你的消息在排队（已等 {time}）",
			waitingChat: "已送达 · 等待路由器回复（已等 {time}）",
			modeDispatch: "派活",
			modeChat: "对话",
			placeholderChat: "和路由器对话：问工单状态、闲聊、查设置（派活请用左侧「派活」）",
			chatBusyHint: "此对话有进行中的工单：「派活」消息会排给该工单，「对话」消息由路由器即时回复。",
			details: "详情",
			collapse: "收起",
			toolBash: "执行命令",
			toolRead: "读取文件",
			toolWrite: "写入文件",
			toolEdit: "编辑文件",
			toolGrep: "搜索内容",
			toolGlob: "查找文件",
			toolSearch: "联网搜索",
			toolFetch: "抓取网页",
			toolPlan: "更新计划",
			toolTask: "处理子任务",
			toolTicket: "查看工单",
			toolReport: "汇报进度",
			toolReply: "回复消息",
			toolAck: "确认消息",
			toolNote: "记录备注",
			toolStatus: "查询状态",
			toolRoute: "分派工作",
			toolJob: "等待命令输出",
			toolOrchestrator: "处理工单"
		};
		const en = {
			panel: "Dispatch",
			placeholder: "Type a task, Enter to send (Shift+Enter for a newline)",
			send: "Send",
			sending: "Sending…",
			conversation: "Conversation",
			empty: "No messages yet. Type a line to dispatch work to the superagent.",
			failed: "Send failed: {error}",
			you: "You",
			agent: "Agent",
			newConversation: "New conversation",
			statusWorking: "running",
			statusPerson: "needs you",
			statusIdle: "idle",
			statusEnded: "ended",
			stopTicket: "Stop it?",
			closeHintEnded: "Close this card (hide it from the panel)",
			closeHintOpen: "Stop this ticket and hide the card; a running worker will be interrupted",
			elapsedSec: "{n}s",
			elapsedMin: "{n} min",
			elapsedHour: "{h}h {m}m",
			workPython: "running a Python script",
			workVideo: "processing video",
			workScript: "running a script",
			workDeps: "installing dependencies",
			workGit: "git operations",
			workSearch: "searching content",
			workDownload: "downloading",
			workView: "reading files",
			workFind: "locating files",
			workFiles: "organizing files",
			workCommand: "running a command",
			workRunning: "working",
			think: "Thinking…",
			thinkWith: "Thinking…（last step: {what}）",
			waitAfter: "Last step: {what}, waiting",
			waitNext: "Waiting for the next step…",
			stalled: "no activity for {mins} min",
			waitingReply: "Delivered · waiting for the worker ({n} queued, {time} so far)",
			waitingBusy: "Delivered · the worker is busy; your message is queued ({time} so far)",
			waitingChat: "Delivered · waiting for the router ({time} so far)",
			modeDispatch: "Dispatch",
			modeChat: "Chat",
			placeholderChat: "Chat with the router: ticket status, questions, settings (use Dispatch on the left to assign work)",
			chatBusyHint: "This conversation has a running ticket: Dispatch messages join it; Chat messages are answered by the router right away.",
			details: "details",
			collapse: "hide",
			toolBash: "command",
			toolRead: "file read",
			toolWrite: "file write",
			toolEdit: "file edit",
			toolGrep: "content search",
			toolGlob: "file search",
			toolSearch: "web search",
			toolFetch: "web fetch",
			toolPlan: "plan",
			toolTask: "subtask",
			toolTicket: "ticket read",
			toolReport: "reporting",
			toolReply: "replying",
			toolAck: "ack",
			toolNote: "note",
			toolStatus: "status",
			toolRoute: "routing",
			toolJob: "waiting for job output",
			toolOrchestrator: "ticket ops"
		};
		/** 工具名到文案键的映射；未知工具直接显示原名。 */
		const TOOL_KEYS = {
			bash: "toolBash",
			read: "toolRead",
			write: "toolWrite",
			edit: "toolEdit",
			multi_edit: "toolEdit",
			grep: "toolGrep",
			glob: "toolGlob",
			web_search: "toolSearch",
			web_fetch: "toolFetch",
			todo_write: "toolPlan",
			task: "toolTask",
			orchestrator_read: "toolTicket",
			orchestrator_report: "toolReport",
			orchestrator_reply: "toolReply",
			orchestrator_ack: "toolAck",
			orchestrator_ticket_note: "toolNote",
			orchestrator_ticket_request_status: "toolStatus",
			orchestrator_route: "toolRoute"
		};
		function fill(text, values) {
			return text.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);
		}
		/** 时长说人话：<1 分钟按秒，之后按分钟，再往上按小时。 */
		function formatElapsed(t, ms) {
			const seconds = Math.max(0, Math.floor(ms / 1e3));
			if (seconds < 60) return fill(t("elapsedSec"), { n: String(seconds) });
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return fill(t("elapsedMin"), { n: String(minutes) });
			return fill(t("elapsedHour"), {
				h: String(Math.floor(minutes / 60)),
				m: String(minutes % 60)
			});
		}
		/** 把 bash 命令归类成一句人话，并顺带挑出好认的脚本名 / 文件名。 */
		function humanizeCommand(command) {
			const text = command.replace(/\s+/g, " ").trim();
			const script = /([\w.\-]+\.(?:py|sh|js|mjs|ts|rb|pl))\b/.exec(text)?.[1];
			const media = /([\w.\-]+\.(?:mp4|mkv|mov|avi|png|jpe?g|bmp|webp|csv|json|txt|md|log))\b/i.exec(text)?.[1];
			if (/\bpython3?\b/.test(text)) return {
				key: "workPython",
				name: script
			};
			if (/\bffmpeg\b|\bffprobe\b/.test(text)) return {
				key: "workVideo",
				name: media
			};
			if (/\bnode\b|\bpytest\b|\bpandas\b/.test(text)) return {
				key: "workScript",
				name: script
			};
			if (/\b(pip3?|npm|pnpm|yarn|apt-get|apt)\b/.test(text)) return { key: "workDeps" };
			if (/\bgit\b/.test(text)) return { key: "workGit" };
			if (/\b(grep|rg|ag)\b/.test(text)) return {
				key: "workSearch",
				name: quote(text)
			};
			if (/\b(curl|wget)\b/.test(text)) return { key: "workDownload" };
			if (/\b(cat|head|tail|less|wc|sed|awk)\b/.test(text)) return {
				key: "workView",
				name: media
			};
			if (/\b(find|ls|tree|du|stat)\b/.test(text)) return {
				key: "workFind",
				name: media
			};
			if (/\b(cp|mv|rm|mkdir|touch|rsync)\b/.test(text)) return { key: "workFiles" };
			return { key: "workCommand" };
		}
		/** 取命令里第一个被引号括起来的词（通常是 grep 的模式）。 */
		function quote(text) {
			return /['"]([^'"]{2,40})['"]/.exec(text)?.[1];
		}
		/** 工具的对象：文件类只留文件名；工单类不带对象；JSON 参数先展开第一个字符串字段。 */
		function toolTarget(tool, text) {
			if (!text) return void 0;
			if (tool?.startsWith("job_")) return void 0;
			if (tool?.startsWith("orchestrator_") && tool !== "orchestrator_reply" && tool !== "orchestrator_report") return void 0;
			if (text.startsWith("{") || text.startsWith("[")) try {
				const first = Object.values(JSON.parse(text)).find((value) => typeof value === "string");
				if (typeof first !== "string") return void 0;
				text = first;
			} catch {
				return;
			}
			if (tool === "read" || tool === "write" || tool === "edit" || tool === "multi_edit") {
				const base = text.replace(/\\/g, "/").split("/").filter(Boolean).pop();
				return base && base.length > 40 ? `${base.slice(0, 40)}…` : base;
			}
			return text.length > 48 ? `${text.slice(0, 48)}…` : text;
		}
		/** 工具名 → 人话短语；未知但成族的（job_*、orchestrator_*）走兜底。 */
		function toolPhrase(t, tool) {
			if (!tool) return t("workRunning");
			if (tool.startsWith("job_")) return t("toolJob");
			if (tool.startsWith("orchestrator_")) return t("toolOrchestrator");
			const key = TOOL_KEYS[tool];
			return key ? t(key) : tool;
		}
		function workSummary(t, activity) {
			const raw = (activity.text ?? "").trim();
			const flat = raw.replace(/\s+/g, " ");
			const stalled = activity.ageMs !== void 0 && activity.ageMs > 12e4 ? Math.max(1, Math.round(activity.ageMs / 6e4)) : void 0;
			const last = () => {
				if (activity.kind === "job") {
					const { key, name } = humanizeCommand(flat);
					return {
						phrase: t(key),
						detail: name
					};
				}
				if (activity.kind === "tool") return {
					phrase: toolPhrase(t, activity.tool),
					detail: toolTarget(activity.tool, flat)
				};
				if (activity.kind === "text") return { phrase: flat.length > 80 ? `${flat.slice(0, 80)}…` : flat };
				return { phrase: t("workRunning") };
			};
			if (activity.state === "running") return {
				...last(),
				stalled,
				raw
			};
			if (activity.state === "thinking") return {
				phrase: fill(t("thinkWith"), { what: last().phrase }),
				stalled,
				raw
			};
			if (activity.state === "waiting") return {
				phrase: fill(t("waitAfter"), { what: last().phrase }),
				stalled,
				raw
			};
			return {
				phrase: t("waitNext"),
				stalled,
				raw
			};
		}
		/** 状态条里的圆点：运行中呼吸闪烁，其余静态。 */
		const DOT_STYLE = `.dsh-pane-dot-running{animation:dsh-pane-pulse 1.6s ease-in-out infinite}@keyframes dsh-pane-pulse{0%,100%{opacity:1}50%{opacity:.35}}`;
		/** 对话上方的一条工单状态条：哪个工单、到哪一步、worker 此刻在做什么（说人话，详情可展开原始命令）。 */
		function TicketBar({ ticket, activity, t, ccStatus, ccExpanded, onToggleCc, onInterrupt, onClear, ccBusy, health, confirmStop, onClose }) {
			const [open, setOpen] = (0, react.useState)(false);
			const stage = ticket.stage ?? "ended";
			const zombie = health?.health === "zombie";
			const [expanded, setExpanded] = (0, react.useState)(stage === "working" || stage === "person");
			const [touched, setTouched] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (!touched) setExpanded(stage === "working" || stage === "person");
			}, [stage, touched]);
			const label = zombie ? "卡死 · 需处理" : stage === "working" ? t("statusWorking") : stage === "person" ? t("statusPerson") : stage === "idle" ? t("statusIdle") : t("statusEnded");
			const created = typeof ticket.createdAt === "string" ? Date.parse(ticket.createdAt) : 0;
			const elapsed = stage === "working" && created ? formatElapsed(t, Date.now() - created) : "";
			const work = stage === "working" && activity ? workSummary(t, activity) : null;
			const summary = (ticket.summary ?? "").replace(/\s+/g, " ").trim();
			const dot = zombie ? "#e53e3e" : stage === "working" ? "#38a169" : stage === "ended" ? "#888" : "#d69e2e";
			const compact = work ? `${work.phrase}${work.detail ? `（${work.detail}）` : ""}` : summary;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					border: "1px solid var(--dt-border, #333)",
					borderRadius: 6,
					padding: "7px 10px",
					fontSize: 12,
					background: "var(--dt-surface, rgba(255,255,255,.04))",
					display: "flex",
					flexDirection: "column",
					gap: 4
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						onClick: () => {
							setTouched(true);
							setExpanded((value) => !value);
						},
						style: {
							display: "flex",
							gap: 6,
							alignItems: "baseline",
							flexWrap: "wrap",
							cursor: "pointer"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									opacity: .5,
									fontSize: 10
								},
								children: expanded ? "▾" : "▸"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: stage === "working" ? "dsh-pane-dot-running" : "",
								style: {
									color: dot,
									fontSize: 10
								},
								children: "●"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: {
									fontWeight: 600,
									fontSize: 13,
									lineHeight: 1.3
								},
								children: ticket.title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									marginLeft: "auto",
									opacity: .65
								},
								children: [label, elapsed ? ` · ${elapsed}` : ""]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								title: stage === "ended" ? t("closeHintEnded") : t("closeHintOpen"),
								onClick: (event) => {
									event.stopPropagation();
									onClose();
								},
								style: {
									background: "none",
									border: "none",
									cursor: "pointer",
									padding: "0 2px",
									fontSize: 12,
									lineHeight: 1,
									color: confirmStop ? "#e53e3e" : "inherit",
									opacity: confirmStop ? 1 : .55
								},
								children: confirmStop ? t("stopTicket") : "×"
							})
						]
					}),
					!expanded && compact && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							opacity: .6,
							fontSize: 11,
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis"
						},
						children: compact
					}),
					expanded && work && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { opacity: .88 },
						children: [
							work.phrase,
							work.detail ? `（${work.detail}）` : "",
							work.stalled !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: "#d69e2e" },
								children: ` · ${fill(t("stalled"), { mins: String(work.stalled) })}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setOpen(!open),
								style: {
									background: "none",
									border: "none",
									padding: 0,
									marginLeft: 6,
									color: "inherit",
									opacity: .6,
									cursor: "pointer",
									textDecoration: "underline",
									fontSize: 11
								},
								children: open ? t("collapse") : t("details")
							})
						]
					}),
					expanded && open && work?.raw && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontFamily: "monospace",
							fontSize: 11,
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							maxHeight: 140,
							overflowY: "auto",
							background: "rgba(0,0,0,.25)",
							padding: "6px 8px",
							borderRadius: 4,
							opacity: .85
						},
						children: work.raw
					}),
					expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CcPanel, {
						status: ccStatus,
						expanded: ccExpanded,
						onToggle: onToggleCc,
						onInterrupt,
						onClear,
						busy: ccBusy
					}),
					zombie && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							color: "#e53e3e",
							fontSize: 11
						},
						children: ["⚠ ", health?.detail ?? "执行器卡死，新消息投进去出不来。建议停止该工单后重新派活。"]
					}),
					expanded && stage !== "working" && summary && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { opacity: .7 },
						children: summary.length > 160 ? `${summary.slice(0, 160)}…` : summary
					})
				]
			});
		}
		/** 派活面板：一次一个对话，打开期间轮询。 */
		function PanePanel({ t }) {
			const [conversation, setConversation] = (0, react.useState)("main");
			const [items, setItems] = (0, react.useState)([]);
			const [draft, setDraft] = (0, react.useState)("");
			const [mode, setMode] = (0, react.useState)("dispatch");
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [tickets, setTickets] = (0, react.useState)([]);
			const [activities, setActivities] = (0, react.useState)({});
			const [ccStatuses, setCcStatuses] = (0, react.useState)({});
			const [ccExpanded, setCcExpanded] = (0, react.useState)(false);
			const [ccBusy, setCcBusy] = (0, react.useState)(false);
			const [healths, setHealths] = (0, react.useState)({});
			const [confirmStop, setConfirmStop] = (0, react.useState)(null);
			const scrollRef = (0, react.useRef)(null);
			const load = (0, react.useCallback)(async () => {
				try {
					const body = await call(`/log/${encodeURIComponent(conversation)}`);
					setItems(Array.isArray(body?.items) ? body.items : []);
				} catch {}
			}, [conversation]);
			/** 读本对话的工单（进行中优先，全部显示）与每个运行中工单的实时动作。 */
			const pollStatus = (0, react.useCallback)(async () => {
				const thread = `${THREAD_PREFIX}${conversation}`;
				try {
					const hideList = await call("/hidden").catch(() => ({ ids: [] }));
					const hiddenIds = Array.isArray(hideList?.ids) ? hideList.ids : [];
					let list = ((await request(`${HOST_API}/tickets?state=open`))?.items ?? []).filter((item) => item.threads?.some((entry) => entry.key === thread));
					if (!list.length) {
						const latest = ((await request(`${HOST_API}/tickets?state=ended&limit=20`))?.items ?? []).filter((item) => item.threads?.some((entry) => entry.key === thread))[0];
						list = latest && !hiddenIds.includes(latest.id) ? [latest] : [];
					}
					setTickets(list);
					const next = {};
					for (const item of list) if (item.stage === "working" && item.sessionId) try {
						const info = await request(`${API}/activity/${encodeURIComponent(item.sessionId)}`);
						if (info?.activity) next[item.sessionId] = info.activity;
					} catch {}
					setActivities(next);
					const cc = {};
					for (const item of list) {
						if (!item.id) continue;
						try {
							const info = await request(`${API}/cc/${encodeURIComponent(item.id)}`);
							if (info?.cc) cc[item.id] = info.cc;
						} catch {}
					}
					setCcStatuses(cc);
					const hs = {};
					for (const item of list) {
						if (!item.id) continue;
						try {
							const info = await request(`${API}/health/${encodeURIComponent(item.id)}`);
							if (info?.health) hs[item.id] = info.health;
						} catch {}
					}
					setHealths(hs);
				} catch {}
			}, [conversation]);
			const lastOut = (() => {
				for (let index = items.length - 1; index >= 0; index--) if (items[index].direction === "out") return index;
				return -1;
			})();
			const pending = items.filter((item, index) => item.direction === "in" && index > lastOut);
			const waitingSince = pending.length ? Date.parse(pending[0].at) : 0;
			const working = tickets.some((ticket) => ticket.stage === "working");
			(0, react.useEffect)(() => {
				let live = true;
				load();
				const timer = setInterval(() => {
					if (live) load();
				}, pending.length > 0 ? 1200 : 2e3);
				return () => {
					live = false;
					clearInterval(timer);
				};
			}, [load, pending.length]);
			(0, react.useEffect)(() => {
				let live = true;
				pollStatus();
				const timer = setInterval(() => {
					if (live) pollStatus();
				}, 2500);
				return () => {
					live = false;
					clearInterval(timer);
				};
			}, [pollStatus]);
			(0, react.useEffect)(() => {
				const element = scrollRef.current;
				if (element) element.scrollTop = element.scrollHeight;
			}, [items]);
			/** 中止请求：写 interrupt 标记并立刻刷新一次。 */
			const ccCommand = (0, react.useCallback)(async (ticketId, action) => {
				setCcBusy(true);
				try {
					await call(`/cc/${encodeURIComponent(ticketId)}/${action}`, {
						method: "POST",
						body: "{}"
					});
					await pollStatus();
				} catch {} finally {
					setCcBusy(false);
				}
			}, [pollStatus]);
			/**
			* 关闭一张工单卡。已结束的直接收起（记进名单，不动工单）；进行中的先停止——两步确认，
			* 第一次点击变成「确认停止？」，5 秒没有下文自动还原，再点一次才真的停，避免误杀正在跑的 worker。
			* 停完立刻把 id 记进名单，否则它作为「最近一张已结束」会马上又冒出来。
			*/
			const closeTicket = (0, react.useCallback)(async (ticket) => {
				if ((ticket.stage ?? "ended") === "ended") {
					try {
						await call("/hide", {
							method: "POST",
							body: JSON.stringify({ ticketId: ticket.id })
						});
					} catch {}
					setConfirmStop(null);
					await pollStatus();
					return;
				}
				if (confirmStop !== ticket.id) {
					setConfirmStop(ticket.id);
					return;
				}
				setConfirmStop(null);
				try {
					await request(`${HOST_API}/tickets/${encodeURIComponent(ticket.id)}/stop`, {
						method: "POST",
						body: "{}"
					});
					await call("/hide", {
						method: "POST",
						body: JSON.stringify({ ticketId: ticket.id })
					});
				} catch {}
				await pollStatus();
			}, [confirmStop, pollStatus]);
			(0, react.useEffect)(() => {
				if (!confirmStop) return;
				const timer = setTimeout(() => setConfirmStop(null), 5e3);
				return () => clearTimeout(timer);
			}, [confirmStop]);
			const send = async () => {
				const text = draft.trim();
				if (!text || busy) return;
				setBusy(true);
				setError(null);
				try {
					await call("/message", {
						method: "POST",
						body: JSON.stringify({
							conversation,
							text,
							mode
						})
					});
					setDraft("");
					await load();
					pollStatus();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-pane-panel",
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%",
					gap: 8,
					padding: 12
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: DOT_STYLE }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8,
							alignItems: "center"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("conversation") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								value: conversation,
								onChange: (event) => setConversation(event.target.value.replace(/[^A-Za-z0-9_-]/g, "")),
								style: {
									flex: 1,
									padding: "4px 8px"
								},
								"aria-label": t("conversation")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => {
									setConversation(`c${Date.now()}`);
									setItems([]);
								},
								children: t("newConversation")
							})
						]
					}),
					tickets.map((ticket) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TicketBar, {
						ticket,
						activity: ticket.sessionId ? activities[ticket.sessionId] ?? null : null,
						t,
						ccStatus: ccStatuses[ticket.id] ?? null,
						ccExpanded,
						health: healths[ticket.id] ?? null,
						onToggleCc: () => setCcExpanded((value) => !value),
						ccBusy,
						onInterrupt: () => {
							ccCommand(ticket.id, "interrupt");
						},
						onClear: () => {
							ccCommand(ticket.id, "clear");
						},
						confirmStop: confirmStop === ticket.id,
						onClose: () => {
							closeTicket(ticket);
						}
					}, ticket.id)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						ref: scrollRef,
						style: {
							flex: 1,
							overflowY: "auto",
							display: "flex",
							flexDirection: "column",
							gap: 8,
							padding: 8,
							border: "1px solid var(--dt-border, #333)",
							borderRadius: 6
						},
						children: items.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { opacity: .6 },
							children: t("empty")
						}) : items.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								alignSelf: item.direction === "in" ? "flex-end" : "flex-start",
								maxWidth: "85%",
								padding: "6px 10px",
								borderRadius: 8,
								whiteSpace: "pre-wrap",
								wordBreak: "break-word",
								background: item.direction === "in" ? "var(--dt-accent, #2b6cb0)" : "var(--dt-surface, #2d2d2d)",
								color: item.direction === "in" ? "#fff" : "inherit"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 11,
									opacity: .7,
									marginBottom: 2
								},
								children: item.direction === "in" ? t("you") : `${t("agent")}${item.kind ? ` · ${item.kind}` : ""}`
							}), item.text]
						}, item.id))
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							color: "#e53e3e",
							fontSize: 12
						},
						children: fill(t("failed"), { error })
					}),
					pending.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							opacity: .75
						},
						children: (() => {
							const time = formatElapsed(t, Date.now() - waitingSince);
							if (pending[pending.length - 1]?.mode === "chat") return fill(t("waitingChat"), { time });
							return working ? fill(t("waitingBusy"), { time }) : fill(t("waitingReply"), {
								n: String(pending.length),
								time
							});
						})()
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8,
							alignItems: "stretch"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							value: draft,
							onChange: (event) => setDraft(event.target.value),
							placeholder: mode === "chat" ? t("placeholderChat") : t("placeholder"),
							rows: 3,
							onKeyDown: (event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									send();
								}
							},
							style: {
								flex: 1,
								resize: "vertical",
								padding: 8
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 6,
								justifyContent: "space-between"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									border: "1px solid var(--dt-border, #333)",
									borderRadius: 6,
									overflow: "hidden"
								},
								children: ["dispatch", "chat"].map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setMode(item),
									title: item === "chat" ? t("placeholderChat") : "",
									style: {
										padding: "3px 10px",
										fontSize: 12,
										border: "none",
										cursor: "pointer",
										background: mode === item ? "var(--dt-accent, #2b6cb0)" : "transparent",
										color: mode === item ? "#fff" : "inherit"
									},
									children: item === "dispatch" ? t("modeDispatch") : t("modeChat")
								}, item))
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: { padding: "6px 12px" },
								disabled: busy || !draft.trim(),
								onClick: () => {
									send();
								},
								children: busy ? t("sending") : t("send")
							})]
						})]
					}),
					mode === "chat" && working && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 11,
							opacity: .6
						},
						children: t("chatBusyHint")
					})
				]
			});
		}
		/** 侧边栏图标：纸飞机，内联绘制，插件不背图标依赖。 */
		function PlaneIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 24 24",
				width: "18",
				height: "18",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M22 2 11 13" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M22 2 15 22l-4-9-9-4Z" })]
			});
		}
		function apply(ctx) {
			const anyCtx = ctx;
			anyCtx.effect(() => anyCtx.locale.register(NS, {
				zh,
				en
			}), "pane: dictionaries");
			const t = anyCtx.locale.bind(NS);
			anyCtx.slots.inject("main", () => anyCtx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({})
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanePanel, { t: props.t ?? t })));
			anyCtx.slots.inject("sidebar.panellist", () => anyCtx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				label: () => t("panel"),
				locale: NS
			}, PlaneIcon));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
