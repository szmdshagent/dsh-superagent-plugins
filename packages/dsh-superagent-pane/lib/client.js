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
		const LANE_TEXT = {
			pending: "等待",
			running: "执行中",
			done: "完成",
			failed: "失败"
		};
		const LANE_COLOR = {
			pending: "#888",
			running: "#38a169",
			done: "#38a169",
			failed: "#e53e3e"
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
			const teamLanes = status.team?.lanes ?? [];
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
					teamLanes.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 2
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { opacity: .75 },
								children: [
									"Team ",
									teamLanes.length,
									" 路：完成 ",
									teamLanes.filter((lane) => lane.state === "done").length,
									teamLanes.some((lane) => lane.state === "failed") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: { color: "#e53e3e" },
										children: ["，失败 ", teamLanes.filter((lane) => lane.state === "failed").length]
									}),
									teamLanes.some((lane) => lane.state === "running") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: { color: "#38a169" },
										children: ["，执行中 ", teamLanes.filter((lane) => lane.state === "running").length]
									})
								]
							}),
							expanded && teamLanes.map((lane) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 5,
									alignItems: "baseline",
									flexWrap: "wrap"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											color: LANE_COLOR[lane.state],
											fontWeight: 600,
											minWidth: 42
										},
										children: lane.lane
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { color: LANE_COLOR[lane.state] },
										children: LANE_TEXT[lane.state]
									}),
									lane.task && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											opacity: .7,
											wordBreak: "break-all"
										},
										children: lane.task.slice(0, 100)
									}),
									lane.turns !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: { opacity: .55 },
										children: [lane.turns, " 轮"]
									}),
									lane.costUsd !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: { opacity: .55 },
										children: ["$", lane.costUsd.toFixed(2)]
									}),
									lane.handoff && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { opacity: .55 },
										children: "已交接"
									}),
									lane.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											color: "#e53e3e",
											wordBreak: "break-all"
										},
										children: lane.error.slice(0, 100)
									})
								]
							}, lane.lane)),
							status.team?.plan?.error && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { color: "#dd6b20" },
								children: ["team 计划解析失败：", status.team.plan.error]
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
		const inject = [
			"slots",
			"locale",
			"layout"
		];
		const NS = "dshSuperagentPane";
		const PANEL_ID = "dsh-superagent-pane";
		/** 本插件自己的路由，位于面板的 API 前缀下。 */
		const API = "/orchestrator/api/pane";
		/** 宿主的管理 API（只读工单），与面板同源。 */
		const HOST_API = "/orchestrator/api";
		/** pane Source 的 Thread 键前缀，与 Node 侧一致。 */
		const THREAD_PREFIX = "pane:";
		/** 没有进行中工单时，面板保留多少张已结束工单卡供人工评审。 */
		const REVIEW_KEEP = 8;
		/** 已结束工单卡最多保留多久：更早收尾的工单用户早就知道了，不该继续占着面板。 */
		const REVIEW_WINDOW_MS = 18e5;
		/** 不再展示的结束方式：人手动停的、放弃的——这些是用户主动了结的，留在面板上只会碍眼。 */
		const SILENT_OUTCOMES = /* @__PURE__ */ new Set(["stopped", "dropped"]);
		/** 旧版批量收尾通知的长度上限：超过它的历史长通知（几十张工单标题拼成的一段）不再显示。 */
		const NOTICE_MAX_CHARS = 240;
		/** 已收尾通知的结局文本：人手动停止 / 放弃的，不再在对话区出现。 */
		const SILENT_NOTICE = /已结束：(stopped|dropped|已放弃)/;
		/** 派活面板选中态的持久键：记住本标签页里用户是不是停在派活界面。
		*  宿主的全局面板选中态只存在内存里：派活插件的客户端 bundle 热更新（HMR）会先注销它的 main 槽注册、
		*  稍后重新注册，布局插件在注销那一瞬把选中态清回会话界面，重新注册后不会自动恢复；整页刷新同样会
		*  重置布局。两者都表现为「正在派活界面，却被意外切到主界面」。把选中态记下来，重载插件后补回去。 */
		const SELECTED_KEY = "dsh-superagent-pane/selected-panel";
		/** 读「本标签页里刚才停在派活界面」的标记；sessionStorage 不可用（隐私模式）时当作没有。 */
		function rememberedSelection() {
			try {
				return window.sessionStorage.getItem(SELECTED_KEY) === "1";
			} catch {
				return false;
			}
		}
		/** 写选中标记。写不进去就算了，不能影响面板本身。 */
		function rememberSelection(selected) {
			try {
				window.sessionStorage.setItem(SELECTED_KEY, selected ? "1" : "0");
			} catch {}
		}
		/** 派活面板当前对话的持久键：面板卸载重挂、整页刷新后要回到用户刚才所在的对话，
		*  否则会退回 main——新建对话里派出的工单卡看起来就像“消失”了（工单其实还挂在 pane:<对话> 上）。 */
		const CONVERSATION_KEY = "dsh-superagent-pane/conversation";
		/** 本标签页新建、宿主里可能还没有任何记录的对话名（点 + 之后、派活之前）。 */
		const NEW_CONVERSATIONS_KEY = "dsh-superagent-pane/new-conversations";
		/** 用户在派活面板里删掉的对话名。删的是「下拉里的入口」，宿主里的消息与线程一条都不动；
		*  存 localStorage（跨刷新、跨标签页生效），上限 200 条，按名字去重。 */
		const REMOVED_CONVERSATIONS_KEY = "dsh-superagent-pane/removed-conversations";
		/** 对话名允许的字符集，与宿主线程键、pane-log 键一致。 */
		const NAME_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
		/** 每张工单的意见会话前缀：t<工单id>。这个线程没有订阅者，消息不会广播给同对话的其它工单。 */
		const COMMENT_PREFIX = "t";
		function commentConversation(ticketId) {
			return COMMENT_PREFIX + ticketId;
		}
		function isCommentConversation(name) {
			return /^t[0-9a-f]{8,32}$/i.test(name);
		}
		/** 读上次停留的对话名；没存过、存的内容非法、sessionStorage 不可用时都当作没有。 */
		function rememberedConversation() {
			try {
				const value = window.sessionStorage.getItem(CONVERSATION_KEY);
				return value && NAME_PATTERN.test(value) ? value : null;
			} catch {
				return null;
			}
		}
		/** 记住当前对话名。写不进去就算了，不能影响面板本身。 */
		function rememberConversation(name) {
			try {
				if (NAME_PATTERN.test(name)) window.sessionStorage.setItem(CONVERSATION_KEY, name);
			} catch {}
		}
		/** 读本标签页新建过的对话名（最多 20 条）；解析失败或内容非法就当作没有。 */
		function rememberedNewConversations() {
			try {
				const parsed = JSON.parse(window.sessionStorage.getItem(NEW_CONVERSATIONS_KEY) ?? "[]");
				return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string" && NAME_PATTERN.test(name)).slice(0, 20) : [];
			} catch {
				return [];
			}
		}
		/** 记住本标签页新建过的对话名。写不进去就算了，不能影响面板本身。 */
		function rememberNewConversations(names) {
			try {
				window.sessionStorage.setItem(NEW_CONVERSATIONS_KEY, JSON.stringify(names.slice(0, 20)));
			} catch {}
		}
		/** 读用户删掉的对话名；localStorage 不可用（隐私模式）、JSON 坏掉、内容非法时都当作没有。 */
		function rememberedRemovedConversations() {
			try {
				const parsed = JSON.parse(window.localStorage.getItem(REMOVED_CONVERSATIONS_KEY) ?? "[]");
				return Array.isArray(parsed) ? [...new Set(parsed.filter((name) => typeof name === "string" && NAME_PATTERN.test(name)))].slice(-200) : [];
			} catch {
				return [];
			}
		}
		/** 记住删掉的对话名（新的排在末尾，超上限丢最旧的）。写不进去就算了，不能影响面板本身。 */
		function rememberRemovedConversations(names) {
			try {
				window.localStorage.setItem(REMOVED_CONVERSATIONS_KEY, JSON.stringify([...new Set(names)].slice(-200)));
			} catch {}
		}
		/** 展开态的持久化键与上限：宿主按 lib/client.js 的 mtime 热替换时会重新执行本模块，
		*  模块级 Set 会被清零；同步一份到 sessionStorage，重载后按 id 恢复展开态。 */
		const EXPANDED_STORAGE_KEY = "dsh-pane-expanded-tickets";
		const EXPANDED_LIMIT = 200;
		/** 从 sessionStorage 读回已展开的 id；没存过、JSON 坏掉、隐私模式不可用时都当作没有。 */
		function readExpandedTickets() {
			try {
				const parsed = JSON.parse(window.sessionStorage.getItem(EXPANDED_STORAGE_KEY) ?? "[]");
				return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string").slice(-200) : [];
			} catch {
				return [];
			}
		}
		/** 把当前已展开的 id 按 FIFO 顺序写回 sessionStorage；写不进去就算了，不能影响面板本身。 */
		function persistExpandedTickets() {
			try {
				window.sessionStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...EXPANDED_TICKETS]));
			} catch {}
		}
		/** 用户展开过的工单卡 id：存模块级 Set，不用组件 state。
		*  轮询每 2.5 秒换掉 tickets 数组、宿主重渲染导致组件重挂时，展开态都不会丢；
		*  只有用户自己收起（toggle）或关闭（×）该卡时才移除。模块重载时从 sessionStorage 恢复。 */
		const EXPANDED_TICKETS = new Set(readExpandedTickets());
		/** 记/忘一张卡的展开态；上限 200 条，超出丢最旧的，避免长期运行无限增长。 */
		function rememberExpandedTicket(id, value) {
			if (value) {
				EXPANDED_TICKETS.add(id);
				while (EXPANDED_TICKETS.size > EXPANDED_LIMIT) {
					const oldest = EXPANDED_TICKETS.values().next().value;
					if (typeof oldest === "string") EXPANDED_TICKETS.delete(oldest);
				}
			} else EXPANDED_TICKETS.delete(id);
			persistExpandedTickets();
		}
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
			conversationNewAt: "新对话 {time}",
			deleteConversation: "删除当前对话",
			confirmDelete: "确认删除？",
			deleteHint: "从下拉里删掉这个对话（宿主里的消息不删）",
			deleteMainBlocked: "main 对话不能删除",
			deleteBusyBlocked: "这个对话还有进行中的工单，不能删除",
			statusWorking: "运行中",
			statusPerson: "等你处理",
			statusIdle: "待命",
			statusEnded: "已结束",
			stopTicket: "确认停止？",
			closeHintEnded: "关闭这张工单卡（不再显示）",
			closeHintOpen: "停止这张工单并收起：正在执行的 worker 会被中断",
			commentOnTicket: "给这张工单提意见",
			commentPlaceholder: "给这张工单提意见，会转交给它的 worker（回车发送，Shift+回车换行）",
			commentSend: "发意见",
			commentSending: "发送中…",
			commentSent: "已发给这张工单",
			commentFailed: "意见发送失败：{error}",
			commentOpenConversation: "打开这张工单的意见会话",
			commentLabel: "工单意见 · {name}",
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
			modeBroadcast: "广播",
			placeholderChat: "和路由器对话：问工单状态、闲聊、查设置。只回答，不建工单、不改代码。",
			placeholderBroadcast: "广播：直接写正文。默认投给最近 12 小时内创建的所有工单（含已结束的，会被唤醒继续干活）",
			broadcastHint: "广播模式：默认范围是最近 12 小时内创建的所有工单，已结束的也会被唤醒继续处理（被人手动停止的除外）。想换范围就写时间词：最近N小时/最近N天、昨晚、昨天、今天、本周；写「所有/全部」则不限时间。",
			chatBusyHint: "「对话」只回答问题：不建工单、不派 worker、不改代码。要动工单请用「派活」。",
			divertedHint: "这条派活消息没进卡死的工单，改由路由器分诊：{reason}",
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
			toolOrchestrator: "处理工单",
			scheduleOpen: "定时派活",
			scheduleTitle: "定时派活",
			scheduleHint: "到点自动把内容发进任务里的对话；服务停机时不补跑，错过会记在任务上。",
			scheduleTextPlaceholder: "到点要派出去的任务…",
			scheduleKind: "频率",
			kindEvery: "每隔",
			kindDaily: "每天",
			kindWeekly: "每周",
			kindOnce: "一次",
			scheduleEvery: "间隔",
			minutesUnit: "分钟",
			scheduleTime: "时间",
			scheduleWeekdays: "星期",
			scheduleAt: "执行时间",
			scheduleAtRequired: "请先选择执行时间",
			scheduleMode: "方式",
			scheduleAdd: "添加定时任务",
			scheduleAdding: "添加中…",
			scheduleEmpty: "当前对话还没有定时任务。",
			scheduleNext: "下次 {time}",
			schedulePaused: "已暂停",
			scheduleLast: "上次 {time}：{result}",
			scheduleRun: "立即执行",
			scheduleRunning: "执行中…",
			scheduleRunDone: "已立即执行",
			scheduleToggleOff: "暂停",
			scheduleToggleOn: "启用",
			scheduleDelete: "删除",
			scheduleConfirmDelete: "确认删除？",
			scheduleCreated: "已创建定时任务",
			scheduleFailed: "操作失败：{error}",
			scheduleClose: "关闭",
			weekday1: "一",
			weekday2: "二",
			weekday3: "三",
			weekday4: "四",
			weekday5: "五",
			weekday6: "六",
			weekday7: "日",
			badgeScheduled: "定时",
			usageOpen: "打开用量统计",
			usageClose: "收起用量统计",
			usageTitle: "用量统计",
			usageToday: "今日",
			usageWeek: "近 7 天",
			usageTrend: "近 7 天趋势",
			usageCalls: "{n} 次调用",
			usageByModel: "按模型",
			usageEmpty: "用量数据暂不可用",
			usageCache: "缓存",
			usageCacheRead: "读",
			usageCacheWrite: "写",
			usageCacheWriteUnreported: "—",
			usageCacheWriteZeroHint: "当前上游通道不返回缓存写入计数（DeepSeek 无缓存写入计费）",
			usageHitRate: "命中"
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
			conversationNewAt: "New conversation {time}",
			deleteConversation: "Delete current conversation",
			confirmDelete: "Delete it?",
			deleteHint: "Remove this conversation from the list (its messages stay on the host)",
			deleteMainBlocked: "The main conversation cannot be deleted",
			deleteBusyBlocked: "This conversation still has a running ticket and cannot be deleted",
			statusWorking: "running",
			statusPerson: "needs you",
			statusIdle: "idle",
			statusEnded: "ended",
			stopTicket: "Stop it?",
			closeHintEnded: "Close this card (hide it from the panel)",
			closeHintOpen: "Stop this ticket and hide the card; a running worker will be interrupted",
			commentOnTicket: "Comment on this ticket",
			commentPlaceholder: "Comment on this ticket; it is handed to its worker (Enter sends)",
			commentSend: "Send comment",
			commentSending: "Sending…",
			commentSent: "Sent to this ticket",
			commentFailed: "Comment failed: {error}",
			commentOpenConversation: "Open this ticket comment thread",
			commentLabel: "Ticket comments · {name}",
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
			modeBroadcast: "Broadcast",
			placeholderChat: "Chat with the router: ticket status, questions, settings. It answers only; no tickets, no code changes.",
			placeholderBroadcast: "Broadcast: just type the message. By default it reaches every ticket created in the last 12 hours (ended ones are woken up and continue)",
			broadcastHint: "Broadcast mode: the default scope is every ticket created in the last 12 hours, including ended tickets, which are woken up to continue (except ones a person stopped). Add a time phrase to change it: last N hours / last N days, last night, yesterday, today, this week; write \"all\" for no time limit.",
			chatBusyHint: "Chat only answers: it creates no tickets, dispatches no worker and changes no code. Use Dispatch to work on tickets.",
			divertedHint: "This dispatch message did not go into the stuck ticket; the router is triaging it instead: {reason}",
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
			toolOrchestrator: "ticket ops",
			scheduleOpen: "Scheduled dispatch",
			scheduleTitle: "Scheduled dispatch",
			scheduleHint: "The text is sent into its conversation at the set time. Missed runs while the host was down are recorded, not replayed.",
			scheduleTextPlaceholder: "The task to dispatch when due…",
			scheduleKind: "Frequency",
			kindEvery: "Every",
			kindDaily: "Daily",
			kindWeekly: "Weekly",
			kindOnce: "Once",
			scheduleEvery: "Every",
			minutesUnit: "min",
			scheduleTime: "Time",
			scheduleWeekdays: "Days",
			scheduleAt: "Run at",
			scheduleAtRequired: "Pick a run time first",
			scheduleMode: "Mode",
			scheduleAdd: "Add schedule",
			scheduleAdding: "Adding…",
			scheduleEmpty: "No schedules in this conversation yet.",
			scheduleNext: "Next {time}",
			schedulePaused: "paused",
			scheduleLast: "Last {time}: {result}",
			scheduleRun: "Run now",
			scheduleRunning: "Running…",
			scheduleRunDone: "Ran now",
			scheduleToggleOff: "Pause",
			scheduleToggleOn: "Enable",
			scheduleDelete: "Delete",
			scheduleConfirmDelete: "Delete it?",
			scheduleCreated: "Schedule created",
			scheduleFailed: "Failed: {error}",
			scheduleClose: "Close",
			weekday1: "Mon",
			weekday2: "Tue",
			weekday3: "Wed",
			weekday4: "Thu",
			weekday5: "Fri",
			weekday6: "Sat",
			weekday7: "Sun",
			badgeScheduled: "scheduled",
			usageOpen: "Open usage stats",
			usageClose: "Hide usage stats",
			usageTitle: "Usage",
			usageToday: "Today",
			usageWeek: "Last 7 days",
			usageTrend: "Last 7 days trend",
			usageCalls: "{n} calls",
			usageByModel: "By model",
			usageEmpty: "Usage data is unavailable",
			usageCache: "Cache",
			usageCacheRead: "read",
			usageCacheWrite: "write",
			usageCacheWriteUnreported: "—",
			usageCacheWriteZeroHint: "The current upstream channel does not report cache writes (DeepSeek has no cache-write billing)",
			usageHitRate: "hit"
		};
		/** 工单上"收到却没被读"的条数；由服务端按 inputs 的 readAt 算出后随列表下发。 */
		function unreadCount(ticket) {
			const n = Number(ticket.unread ?? 0);
			return Number.isFinite(n) && n > 0 ? n : 0;
		}
		/** 入站消息的裁决徽标：只标"需要人留意"的情形；正常建单/转交不打标。 */
		function decisionBadge(item) {
			const kind = item.decision?.kind;
			const reason = String(item.decision?.reason ?? "");
			if (!kind) return "";
			if (reason.startsWith("转交工单") || reason.includes("已在处理")) return "";
			if (kind === "ignore") return "未执行";
			if (kind === "unavailable") return "未处理";
			if (kind === "stop") return "已停止";
			if (kind === "evaluating") return "待分诊";
			return "";
		}
		/**
		* lane 的显示名：统一叫 ccwN。
		* 历史 lane 目录名是 w1/w2（2026-11-11 之前的演示），显示时映射成 ccw1/ccw2，
		* 不改磁盘目录，避免破坏已有记录；新起的 lane 直接命名 ccwN。
		*/
		function laneLabel(name) {
			const match = /^w(\d+)$/.exec(name);
			return match ? `ccw${match[1]}` : name;
		}
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
		/** 插件开发期自测/探针会话的命名（probe、selftest、demo、cc-*、c-test*、routertest、ui 等）。
		*  数据一条都不删，只在下拉里隐藏，免得测试会话淹掉用户自己的对话；去掉这条过滤即可恢复显示。 */
		const TEST_CONVERSATION = /^(probe\d*|selftest\d*|demo\d*|cc(?:-[A-Za-z0-9_-]+)?|health-test-\d+|rev9-test-\d+|c-test[A-Za-z0-9_-]*|routertest|ui)$/i;
		/** 对话下拉的显示文案：自动生成的新对话名（c+时间戳）翻成「新对话 MM-DD HH:mm」，其余直显。 */
		function conversationLabel(t, name) {
			const hit = /^c(\d{10,13})$/.exec(name);
			if (!hit) return name;
			const date = new Date(Number(hit[1]));
			const pad = (n) => String(n).padStart(2, "0");
			const time = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
			return fill(t("conversationNewAt"), { time });
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
		function TicketBar({ ticket, activity, t, ccStatus, ccExpanded, onToggleCc, onInterrupt, onClear, ccBusy, health, confirmStop, onClose, onComment, onOpenComment, crew }) {
			const [open, setOpen] = (0, react.useState)(false);
			const stage = ticket.stage ?? "ended";
			const zombie = health?.health === "zombie";
			const [expanded, setExpanded] = (0, react.useState)(() => EXPANDED_TICKETS.has(ticket.id));
			const setCardExpanded = (next) => {
				rememberExpandedTicket(ticket.id, next);
				setExpanded(next);
			};
			const cardRef = (0, react.useRef)(null);
			const label = zombie ? "卡死 · 需处理" : stage === "working" ? t("statusWorking") : stage === "person" ? t("statusPerson") : stage === "idle" ? t("statusIdle") : t("statusEnded");
			const created = typeof ticket.createdAt === "string" ? Date.parse(ticket.createdAt) : 0;
			const elapsed = stage === "working" && created ? formatElapsed(t, Date.now() - created) : "";
			const work = stage === "working" && activity ? workSummary(t, activity) : null;
			const summary = (ticket.summary ?? "").replace(/\s+/g, " ").trim();
			const dot = zombie ? "#e53e3e" : stage === "working" ? "#38a169" : stage === "ended" ? "#888" : "#d69e2e";
			const compact = work ? `${work.phrase}${work.detail ? `（${work.detail}）` : ""}` : summary;
			const toggle = () => {
				const next = !expanded;
				setCardExpanded(next);
				if (next) requestAnimationFrame(() => cardRef.current?.scrollIntoView({ block: "nearest" }));
			};
			const [commentDraft, setCommentDraft] = (0, react.useState)("");
			const [commentState, setCommentState] = (0, react.useState)("idle");
			const [commentError, setCommentError] = (0, react.useState)("");
			const commentRef = (0, react.useRef)(null);
			const submitComment = async () => {
				const text = commentDraft.trim();
				if (!text || commentState === "busy" || !onComment) return;
				setCommentState("busy");
				setCommentError("");
				try {
					await onComment(ticket, text);
					setCommentDraft("");
					setCommentState("ok");
				} catch (failure) {
					setCommentState("error");
					setCommentError(failure instanceof Error ? failure.message : String(failure));
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: cardRef,
				"data-ticket-id": ticket.id,
				style: {
					border: "1px solid var(--dt-border, #333)",
					borderRadius: 6,
					padding: expanded ? "7px 10px" : "4px 9px",
					fontSize: 12,
					background: "var(--dt-surface, rgba(255,255,255,.04))",
					display: "flex",
					flexDirection: "column",
					gap: expanded ? 4 : 0,
					flexShrink: 0
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						onClick: toggle,
						"aria-expanded": expanded,
						style: {
							display: "flex",
							gap: 6,
							alignItems: "baseline",
							flexWrap: expanded ? "wrap" : "nowrap",
							cursor: "pointer",
							minWidth: 0
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									opacity: .5,
									fontSize: 10,
									flexShrink: 0
								},
								children: expanded ? "▾" : "▸"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: stage === "working" ? "dsh-pane-dot-running" : "",
								style: {
									color: dot,
									fontSize: 10,
									flexShrink: 0
								},
								children: "●"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								title: ticket.title,
								style: {
									fontWeight: 600,
									fontSize: 13,
									lineHeight: 1.25,
									flex: "0 1 auto",
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: expanded ? "normal" : "nowrap"
								},
								children: ticket.title
							}),
							(() => {
								const lanes = crew ?? [];
								if (lanes.length === 0) return null;
								const running = lanes.filter((lane) => lane.state === "running").length;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-pane-ticket-crew": ticket.id,
									title: `这张工单下有 ${lanes.length} 个 cc-worker（${running} 个在跑）：` + lanes.map((lane) => `${laneLabel(lane.lane)} ${lane.state === "running" ? "运行中" : "空闲"}${lane.task ? " — " + lane.task : ""}`).join("；"),
									style: {
										fontSize: 11,
										fontWeight: 700,
										padding: "1px 8px",
										borderRadius: 10,
										flexShrink: 0,
										letterSpacing: .3,
										lineHeight: 1.5,
										border: running > 0 ? "1px solid #4a9eff" : "1px solid #555",
										background: running > 0 ? "#1d4ed8" : "#3a3a3a",
										color: running > 0 ? "#fff" : "#ccc",
										boxShadow: running > 0 ? "0 0 0 2px rgba(74,158,255,.25)" : "none"
									},
									children: [
										"👥 协作 ",
										lanes.length,
										running > 0 ? ` · ${running} 在跑` : ""
									]
								});
							})(),
							!expanded && compact && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								title: compact,
								style: {
									fontSize: 11,
									opacity: .6,
									flex: "1 1 0",
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								},
								children: compact
							}),
							unreadCount(ticket) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								title: "这张工单收到了消息但 worker 没读过；工单结束时仍未读，说明消息没被处理就关门了",
								style: {
									fontSize: 10,
									padding: "0 4px",
									borderRadius: 3,
									flexShrink: 0,
									background: (ticket.stage ?? "ended") === "ended" ? "#7a1f1f" : "#6b4c00",
									color: (ticket.stage ?? "ended") === "ended" ? "#ffb4b4" : "#ffd88a"
								},
								children: ["未读 ", unreadCount(ticket)]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									marginLeft: "auto",
									opacity: .65,
									whiteSpace: "nowrap",
									flexShrink: 0
								},
								children: [label, elapsed ? ` · ${elapsed}` : ""]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"data-pane-ticket-comment": ticket.id,
								"aria-label": t("commentOnTicket"),
								title: t("commentOnTicket"),
								onClick: (event) => {
									event.stopPropagation();
									setCardExpanded(true);
									requestAnimationFrame(() => commentRef.current?.focus());
								},
								style: {
									background: "none",
									border: "1px solid var(--dt-border, #333)",
									borderRadius: 4,
									cursor: "pointer",
									padding: "0 4px",
									fontSize: 11,
									lineHeight: 1.35,
									flexShrink: 0,
									color: "inherit",
									opacity: .65
								},
								children: "✎"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								title: stage === "ended" ? t("closeHintEnded") : t("closeHintOpen"),
								onClick: (event) => {
									event.stopPropagation();
									rememberExpandedTicket(ticket.id, false);
									onClose();
								},
								style: {
									background: "none",
									border: "none",
									cursor: "pointer",
									padding: "0 2px",
									fontSize: 12,
									lineHeight: 1,
									flexShrink: 0,
									color: confirmStop ? "#e53e3e" : "inherit",
									opacity: confirmStop ? 1 : .55
								},
								children: confirmStop ? t("stopTicket") : "×"
							})
						]
					}),
					expanded && (crew ?? []).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-pane-ticket-crew-detail": ticket.id,
						style: {
							marginTop: 2,
							padding: "6px 9px",
							borderRadius: 6,
							background: "rgba(74, 158, 255, 0.12)",
							borderLeft: "3px solid #4a9eff",
							display: "flex",
							flexDirection: "column",
							gap: 3
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 12,
								fontWeight: 700,
								color: "#7cb8ff",
								letterSpacing: .2
							},
							children: [
								"👥 协作分工 · ",
								(crew ?? []).length,
								" 个 cc-worker"
							]
						}), (crew ?? []).map((lane) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 6,
								alignItems: "baseline",
								fontSize: 11.5,
								minWidth: 0
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flexShrink: 0,
										fontSize: 9,
										color: lane.state === "running" ? "#38a169" : "#777"
									},
									children: "●"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flexShrink: 0,
										width: 58,
										fontWeight: 600,
										fontFamily: "monospace",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										color: lane.state === "running" ? "#9ae6b4" : "#aaa"
									},
									title: lane.lane,
									children: laneLabel(lane.lane)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flexShrink: 0,
										fontSize: 10,
										padding: "0 5px",
										borderRadius: 3,
										background: lane.state === "running" ? "#1f4d33" : "#333",
										color: lane.state === "running" ? "#9ae6b4" : "#999"
									},
									children: lane.state === "running" ? "运行中" : "空闲"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										minWidth: 0,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										color: "#ddd"
									},
									title: lane.task ?? "该 lane 没有登记任务",
									children: lane.task ?? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: { opacity: .45 },
										children: "未登记任务"
									})
								})
							]
						}, lane.lane))]
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
					expanded && summary && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						title: summary,
						"data-pane-ticket-summary": ticket.id,
						style: {
							opacity: .7,
							whiteSpace: "normal",
							overflowWrap: "anywhere",
							maxHeight: 260,
							overflowY: "auto",
							overscrollBehavior: "contain",
							scrollbarWidth: "thin"
						},
						children: summary
					}),
					expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-pane-ticket-comment-box": ticket.id,
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4,
							borderTop: "1px solid var(--dt-border, #333)",
							paddingTop: 5
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 4,
									alignItems: "flex-end"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									ref: commentRef,
									"data-pane-ticket-comment-input": ticket.id,
									value: commentDraft,
									rows: 1,
									placeholder: t("commentPlaceholder"),
									"aria-label": t("commentPlaceholder"),
									disabled: commentState === "busy",
									onChange: (event) => {
										setCommentDraft(event.target.value);
										if (commentState === "ok" || commentState === "error") setCommentState("idle");
									},
									onKeyDown: (event) => {
										if (event.key === "Enter" && !event.shiftKey) {
											event.preventDefault();
											submitComment();
										}
									},
									style: {
										flex: "1 1 0",
										minWidth: 0,
										minHeight: 26,
										maxHeight: 110,
										resize: "vertical",
										fontSize: 12,
										padding: "3px 6px",
										border: "1px solid var(--dt-border, #333)",
										borderRadius: 6,
										background: "var(--dt-surface, #2d2d2d)",
										color: "inherit"
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									"data-pane-ticket-comment-send": ticket.id,
									"aria-label": t("commentSend"),
									title: t("commentSend"),
									disabled: commentState === "busy" || !commentDraft.trim(),
									onClick: (event) => {
										event.stopPropagation();
										submitComment();
									},
									style: {
										flexShrink: 0,
										height: 26,
										padding: "0 8px",
										fontSize: 12,
										lineHeight: 1,
										borderRadius: 6,
										border: "1px solid var(--dt-border, #333)",
										background: commentState === "busy" || !commentDraft.trim() ? "transparent" : "var(--dt-accent, #2b6cb0)",
										color: commentState === "busy" || !commentDraft.trim() ? "inherit" : "#fff",
										cursor: commentState === "busy" || !commentDraft.trim() ? "not-allowed" : "pointer"
									},
									children: commentState === "busy" ? t("commentSending") : t("commentSend")
								})]
							}),
							commentState === "ok" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								"data-pane-ticket-comment-status": ticket.id,
								style: {
									fontSize: 11,
									color: "#38a169",
									display: "flex",
									gap: 6,
									alignItems: "baseline"
								},
								children: [t("commentSent"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									"data-pane-ticket-comment-open": ticket.id,
									"aria-label": t("commentOpenConversation"),
									title: t("commentOpenConversation"),
									onClick: (event) => {
										event.stopPropagation();
										setCommentState("idle");
										onOpenComment?.(ticket);
									},
									style: {
										background: "none",
										border: "none",
										padding: 0,
										fontSize: 11,
										color: "inherit",
										opacity: .75,
										cursor: "pointer",
										textDecoration: "underline"
									},
									children: t("commentOpenConversation")
								})]
							}),
							commentState === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								"data-pane-ticket-comment-status": ticket.id,
								style: {
									fontSize: 11,
									color: "#e53e3e"
								},
								children: fill(t("commentFailed"), { error: commentError })
							})
						]
					})
				]
			});
		}
		/** 本机 mem-watch.py 的只读内存接口（已带 CORS）。 */
		/** 首选同源接口：由插件宿主半注册，任何客户端都能访问。 */
		const WIDGET_MEM_API = "/api/sys-mem";
		/** 兜底：本机 mem-watch（只有浏览器跑在本虚拟机内才通）。 */
		const WIDGET_MEM_API_FALLBACK = "http://127.0.0.1:8099/api/mem";
		const WIDGET_MEM_MS = 2e3;
		const WIDGET_MEM_TIMEOUT_MS = 1e3;
		/** token 轮询与内存错开半秒，避免同一拍打两个接口。 */
		const WIDGET_TOKEN_MS = 2500;
		const WIDGET_TOKEN_DELAY_MS = 500;
		/** 今天 00:00（本地时区），与 dsh-token-live 的「今日」口径一致。 */
		function widgetStartOfDay(now) {
			const d = new Date(now);
			d.setHours(0, 0, 0, 0);
			return d.getTime();
		}
		/** <70 绿 / 70–85 黄 / ≥85 红。 */
		function widgetMemColor(pct) {
			if (pct >= 85) return "#f87171";
			if (pct >= 70) return "#fbbf24";
			return "#34d399";
		}
		/** token 累计用「万/亿」缩写，避免把卡片撑宽。 */
		function widgetCompact(n) {
			if (!Number.isFinite(n) || n <= 0) return "0";
			if (n >= 1e8) return `${(n / 1e8).toFixed(2).replace(/\.?0+$/, "")}亿`;
			if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, "")}万`;
			return String(Math.round(n));
		}
		/** 速率：≥1000 用 k，否则最多一位小数。 */
		function widgetRate(n) {
			if (!Number.isFinite(n) || n < 0) return "0";
			if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
			if (n >= 10) return String(Math.round(n));
			return n.toFixed(1).replace(/\.0$/, "");
		}
		/**
		* 读一次内存指标，两条路按顺序降级：
		*   1. 同源 GET /api/sys-mem（插件宿主半注册，任何客户端都能访问）
		*   2. 本机 mem-watch：http://127.0.0.1:8099/api/mem（仅浏览器跑在本虚拟机内才通）
		* 每条都带 1 秒超时；全部失败返回 null（调用方显示「内存 —」）。
		*/
		async function fetchWidgetMemOnce(url, credentials) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), WIDGET_MEM_TIMEOUT_MS);
				try {
					const res = await fetch(url, {
						cache: "no-store",
						credentials,
						signal: controller.signal
					});
					if (!res.ok) return null;
					const body = await res.json();
					if (!body || typeof body.usage_pct !== "number") return null;
					return {
						usage_pct: Number(body.usage_pct),
						mem_total_mb: Number(body.mem_total_mb ?? 0),
						mem_available_mb: Number(body.mem_available_mb ?? 0),
						swap_pct: typeof body.swap_pct === "number" ? Number(body.swap_pct) : null
					};
				} finally {
					clearTimeout(timer);
				}
			} catch {
				return null;
			}
		}
		/** 先同源，再退回本机 8099。 */
		async function fetchWidgetMem() {
			const same = await fetchWidgetMemOnce(WIDGET_MEM_API, "same-origin");
			if (same !== null) return same;
			return fetchWidgetMemOnce(WIDGET_MEM_API_FALLBACK, "omit");
		}
		/** 同源查今日 token；请求形态与 dsh-token-live 完全一致（不带自定义鉴权头）。 */
		async function fetchWidgetToken(now) {
			try {
				const res = await fetch("/api/usage/query", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						from: widgetStartOfDay(now),
						to: now,
						fill: false,
						granularity: "day"
					})
				});
				if (!res.ok) return null;
				if ((res.headers.get("content-type") || "").indexOf("application/json") === -1) return null;
				const body = await res.json();
				if (!body || body.ok !== true) return null;
				const total = body.value && body.value.total;
				if (!total || typeof total.totalTokens !== "number") return null;
				return {
					tokens: total.totalTokens,
					calls: typeof total.calls === "number" ? total.calls : 0
				};
			} catch {
				return null;
			}
		}
		/** 缓存命中率：inputTokens 为 0（或无数据）时显示「—」，避免除零误导。 */
		function widgetHitRate(inputTokens, cacheReadTokens) {
			if (!Number.isFinite(inputTokens) || inputTokens <= 0) return "—";
			return `${Math.round(cacheReadTokens / (inputTokens + cacheReadTokens) * 100)}%`;
		}
		/** 用量浮层的分组块：块间细分隔线 + 11px 弱化小标题，块内结构由调用方决定。 */
		function UsageSection({ group, title, first, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-pane-usage-group": group,
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 3,
					marginTop: first === true ? 2 : 8,
					paddingTop: first === true ? 0 : 8,
					borderTop: first === true ? "none" : "1px solid rgba(140, 140, 140, 0.7)"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontSize: 11,
						lineHeight: 1.3,
						opacity: .6
					},
					children: title
				}), children]
			});
		}
		/**
		* 缓存行：今日 / 近 7 天共用，data-* 留给浏览器验证抓真实数值。
		* 用固定列宽 + tabular-nums 把「读 / 写 / 命中」三对齐，两个时期块之间不会错位。
		*/
		function UsageCacheRow({ period, t, inputTokens, cacheReadTokens, cacheWriteTokens }) {
			const rate = widgetHitRate(inputTokens, cacheReadTokens);
			const writeReported = Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0;
			const writeHint = writeReported ? void 0 : t("usageCacheWriteZeroHint");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-pane-usage-cache": period,
				"data-cache-read": cacheReadTokens,
				"data-cache-write": cacheWriteTokens,
				"data-cache-write-reported": writeReported,
				"data-hit-rate": rate,
				style: {
					display: "grid",
					gridTemplateColumns: "40px 1fr 1fr 54px",
					columnGap: 4,
					alignItems: "baseline",
					marginTop: 3,
					paddingTop: 3,
					borderTop: "1px solid rgba(140, 140, 140, 0.25)",
					fontSize: 10,
					lineHeight: 1.4,
					fontVariantNumeric: "tabular-nums"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							opacity: .7,
							whiteSpace: "nowrap"
						},
						children: t("usageCache")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: { whiteSpace: "nowrap" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { opacity: .6 },
							children: [t("usageCacheRead"), " "]
						}), widgetCompact(cacheReadTokens)]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: { whiteSpace: "nowrap" },
						title: writeHint,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { opacity: .6 },
							children: [t("usageCacheWrite"), " "]
						}), writeReported ? widgetCompact(cacheWriteTokens) : t("usageCacheWriteUnreported")]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							whiteSpace: "nowrap",
							textAlign: "right"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { opacity: .6 },
							children: [t("usageHitRate"), " "]
						}), rate]
					})
				]
			});
		}
		/** 单个时期的统计块：主行 token 总量，次行调用数与费用，第三行缓存明细。 */
		function UsagePeriodBlock({ period, t, label, tokens, calls, cost, symbol, inputTokens, cacheReadTokens, cacheWriteTokens, first }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(UsageSection, {
				group: period,
				title: label,
				first,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "baseline",
						justifyContent: "space-between",
						gap: 8
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							fontSize: 14,
							fontWeight: 600,
							lineHeight: 1.2,
							fontVariantNumeric: "tabular-nums"
						},
						children: [widgetCompact(tokens), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								marginLeft: 2,
								fontSize: 10,
								fontWeight: 400,
								opacity: .55
							},
							children: "tok"
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							fontSize: 10,
							lineHeight: 1.4,
							opacity: .65,
							textAlign: "right",
							fontVariantNumeric: "tabular-nums"
						},
						children: [
							fill(t("usageCalls"), { n: String(calls) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .6 },
								children: " · "
							}),
							widgetCost(cost, symbol)
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageCacheRow, {
					period,
					t,
					inputTokens,
					cacheReadTokens,
					cacheWriteTokens
				})]
			});
		}
		/** 费用格式化：小额保留 3 位，1 以上两位，大额取整。 */
		function widgetCost(n, symbol) {
			if (!Number.isFinite(n) || n <= 0) return `${symbol}0`;
			return `${symbol}${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3)}`;
		}
		/**
		* 拉近 7 天用量：同一个 /api/usage/query，返回 daily（逐日）与 byModel（按模型）。
		* 只读、无副作用；失败返回 null，视图降级成「暂不可用」。
		*/
		async function fetchUsageOverview(now) {
			try {
				const res = await fetch("/api/usage/query", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						from: widgetStartOfDay(now) - 5184e5,
						to: now,
						fill: true,
						granularity: "day"
					})
				});
				if (!res.ok) return null;
				if ((res.headers.get("content-type") || "").indexOf("application/json") === -1) return null;
				const body = await res.json();
				if (!body || body.ok !== true || !body.value) return null;
				const bucket = (raw) => ({
					key: String(raw?.key ?? ""),
					calls: Number(raw?.calls ?? 0),
					totalTokens: Number(raw?.totalTokens ?? 0),
					cost: Number(raw?.cost ?? 0),
					inputTokens: Number(raw?.inputTokens ?? 0),
					cacheReadTokens: Number(raw?.cacheReadTokens ?? 0),
					cacheWriteTokens: Number(raw?.cacheWriteTokens ?? 0)
				});
				const rawDays = (Array.isArray(body.value.daily) ? body.value.daily : []).map(bucket);
				const todayKey = new Date(now).toLocaleDateString("sv-SE");
				const dayByKey = new Map(rawDays.map((item) => [item.key, item]));
				const days = [];
				for (let offset = 6; offset >= 0; offset -= 1) {
					const key = (/* @__PURE__ */ new Date(widgetStartOfDay(now) - offset * 864e5)).toLocaleDateString("sv-SE");
					days.push(dayByKey.get(key) ?? {
						key,
						calls: 0,
						totalTokens: 0,
						cost: 0,
						inputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0
					});
				}
				return {
					today: dayByKey.get(todayKey) ?? null,
					days,
					weekTokens: days.reduce((sum, item) => sum + item.totalTokens, 0),
					weekCost: days.reduce((sum, item) => sum + item.cost, 0),
					weekCalls: days.reduce((sum, item) => sum + item.calls, 0),
					weekInputTokens: days.reduce((sum, item) => sum + item.inputTokens, 0),
					weekCacheReadTokens: days.reduce((sum, item) => sum + item.cacheReadTokens, 0),
					weekCacheWriteTokens: days.reduce((sum, item) => sum + item.cacheWriteTokens, 0),
					models: (Array.isArray(body.value.byModel) ? body.value.byModel : []).map(bucket).filter((item) => item.totalTokens > 0).sort((a, b) => b.totalTokens - a.totalTokens),
					symbol: typeof body.value.currency?.symbol === "string" ? body.value.currency.symbol : ""
				};
			} catch {
				return null;
			}
		}
		/**
		* 近 7 天 token 柱状图：纯 div 实现，不引新依赖。
		* 柱高按窗口内最大值归一，零用量保留 2px 底边；每根柱的 title 给出日期与当天 token 数。
		*/
		function UsageBars({ days }) {
			const max = Math.max(1, ...days.map((day) => day.totalTokens));
			const todayKey = days.length > 0 ? days[days.length - 1].key : "";
			const barArea = 46;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				"data-pane-usage-chart": "",
				style: {
					display: "flex",
					alignItems: "flex-end",
					gap: 5,
					height: 60,
					marginTop: 4
				},
				children: days.map((day) => {
					const height = day.totalTokens > 0 ? Math.max(6, Math.round(day.totalTokens / max * barArea)) : 1;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-pane-usage-bar": "",
						"data-day": day.key,
						"data-tokens": day.totalTokens,
						title: `${day.key} · ${day.totalTokens.toLocaleString()} tokens`,
						style: {
							flex: 1,
							minWidth: 0,
							height: "100%",
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "flex-end",
							gap: 3
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
							width: "100%",
							height,
							borderRadius: 2,
							background: day.key === todayKey ? "#93c5fd" : "#5b8def",
							opacity: day.totalTokens > 0 ? 1 : .2
						} }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: 9,
								lineHeight: 1,
								opacity: .55,
								whiteSpace: "nowrap"
							},
							children: day.key.slice(5).replace("-", "/")
						})]
					}, day.key);
				})
			});
		}
		/** 右上角两行小卡片；每 2 秒轮询，卸载时清理定时器。点一下展开/收起用量统计。 */
		function PaneStatusWidget({ t }) {
			const [mem, setMem] = (0, react.useState)(null);
			const [token, setToken] = (0, react.useState)(null);
			/** 展开的用量统计面板；只在展开时拉数据，直接复用上面的 /api/usage/query。 */
			const [open, setOpen] = (0, react.useState)(false);
			const [usage, setUsage] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (!open) return;
				let alive = true;
				const load = () => {
					fetchUsageOverview(Date.now()).then((next) => {
						if (alive) setUsage(next);
					});
				};
				load();
				const timer = setInterval(load, 15e3);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [open]);
			(0, react.useEffect)(() => {
				let alive = true;
				let memTimer = null;
				let tokenTimer = null;
				let tokenBoot = null;
				let previous = null;
				const tickMem = () => {
					fetchWidgetMem().then((next) => {
						if (alive) setMem(next);
					});
				};
				const tickToken = () => {
					const at = Date.now();
					fetchWidgetToken(at).then((next) => {
						if (!alive || next === null) return;
						let rate = null;
						if (previous !== null) {
							const dt = (at - previous.at) / 1e3;
							const delta = next.tokens - previous.tokens;
							if (dt > 0 && delta >= 0) rate = delta / dt;
						}
						previous = {
							tokens: next.tokens,
							at
						};
						setToken({
							tokens: next.tokens,
							rate
						});
					});
				};
				tickMem();
				memTimer = setInterval(tickMem, WIDGET_MEM_MS);
				tokenBoot = setTimeout(() => {
					tickToken();
					tokenTimer = setInterval(tickToken, WIDGET_TOKEN_MS);
				}, WIDGET_TOKEN_DELAY_MS);
				return () => {
					alive = false;
					if (memTimer !== null) clearInterval(memTimer);
					if (tokenTimer !== null) clearInterval(tokenTimer);
					if (tokenBoot !== null) clearTimeout(tokenBoot);
				};
			}, []);
			const memTitle = mem ? `已用 ${((mem.mem_total_mb - mem.mem_available_mb) / 1024).toFixed(2)} GiB / 总量 ${(mem.mem_total_mb / 1024).toFixed(2)} GiB · 可用 ${(mem.mem_available_mb / 1024).toFixed(2)} GiB · Swap ${mem.swap_pct === null ? "n/a" : `${mem.swap_pct.toFixed(1)}%`}` : "内存数据暂不可用";
			const tokenTitle = token ? `今日 ${token.tokens.toLocaleString()} tokens` + (token.rate === null ? "" : ` · ${widgetRate(token.rate)} tok/s`) : "token 数据暂不可用";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-testid": "pane-status-widget",
				style: {
					position: "absolute",
					top: 6,
					right: 12,
					zIndex: 5,
					pointerEvents: "auto",
					display: "flex",
					flexDirection: "row",
					alignItems: "center",
					gap: 6,
					maxWidth: 260,
					padding: "4px 8px",
					borderRadius: 8,
					border: "0.5px solid var(--dsw-alias-border-l3, #4b5563)",
					background: "var(--dsw-alias-bg-layer-2, rgba(20, 20, 20, 0.6))",
					fontSize: 11,
					lineHeight: 1.35,
					fontVariantNumeric: "tabular-nums",
					whiteSpace: "nowrap"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					"data-pane-usage": "",
					"aria-expanded": open,
					"aria-label": open ? t("usageClose") : t("usageOpen"),
					title: open ? t("usageClose") : t("usageOpen"),
					onClick: () => setOpen((value) => !value),
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						margin: 0,
						padding: 0,
						background: "none",
						border: "none",
						color: "inherit",
						font: "inherit",
						fontVariantNumeric: "tabular-nums",
						cursor: "pointer"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							title: memTitle,
							style: { color: mem ? widgetMemColor(mem.usage_pct) : "var(--dsw-alias-label-tertiary, #888)" },
							children: ["内存 ", mem ? `${mem.usage_pct.toFixed(1)}%` : "—"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							title: tokenTitle,
							style: { color: "var(--dsw-alias-label-tertiary, #888)" },
							children: token ? `今日 ${widgetCompact(token.tokens)}tok${token.rate === null ? "" : ` · ${widgetRate(token.rate)}/s`}` : "token —"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": true,
							style: {
								opacity: .6,
								fontSize: 9
							},
							children: open ? "▲" : "▼"
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					"data-pane-usage-panel": "",
					role: "region",
					"aria-label": t("usageTitle"),
					style: {
						position: "absolute",
						top: "calc(100% + 6px)",
						right: 0,
						width: 290,
						boxSizing: "border-box",
						padding: "8px 10px",
						display: "flex",
						flexDirection: "column",
						gap: 0,
						whiteSpace: "normal",
						textAlign: "left",
						borderRadius: 8,
						border: "0.5px solid var(--dsw-alias-border-l3, #4b5563)",
						background: "var(--dsw-alias-bg-layer-2, #1b1b1b)",
						boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
						fontSize: 11
					},
					children: usage === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { opacity: .7 },
						children: t("usageEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								alignItems: "baseline",
								marginBottom: 2
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("usageTitle") })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsagePeriodBlock, {
							period: "today",
							t,
							first: true,
							label: t("usageToday"),
							tokens: usage.today?.totalTokens ?? 0,
							calls: usage.today?.calls ?? 0,
							cost: usage.today?.cost ?? 0,
							symbol: usage.symbol,
							inputTokens: usage.today?.inputTokens ?? 0,
							cacheReadTokens: usage.today?.cacheReadTokens ?? 0,
							cacheWriteTokens: usage.today?.cacheWriteTokens ?? 0
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsagePeriodBlock, {
							period: "week",
							t,
							label: t("usageWeek"),
							tokens: usage.weekTokens,
							calls: usage.weekCalls,
							cost: usage.weekCost,
							symbol: usage.symbol,
							inputTokens: usage.weekInputTokens,
							cacheReadTokens: usage.weekCacheReadTokens,
							cacheWriteTokens: usage.weekCacheWriteTokens
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageSection, {
							group: "trend",
							title: t("usageTrend"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBars, { days: usage.days })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageSection, {
							group: "models",
							title: t("usageByModel"),
							children: usage.models.slice(0, 5).map((model, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								"data-pane-usage-model-row": model.key,
								style: {
									display: "grid",
									gridTemplateColumns: "minmax(0, 1fr) 68px 36px",
									columnGap: 6,
									alignItems: "baseline",
									lineHeight: 1.5,
									fontVariantNumeric: "tabular-nums",
									paddingTop: index === 0 ? 0 : 4,
									paddingBottom: 3,
									borderTop: index === 0 ? "none" : "1px solid rgba(140, 140, 140, 0.45)"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										title: model.key,
										style: {
											minWidth: 0,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										},
										children: model.key
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											textAlign: "right",
											whiteSpace: "nowrap"
										},
										children: [widgetCompact(model.totalTokens), "tok"]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											textAlign: "right",
											whiteSpace: "nowrap",
											opacity: .6
										},
										children: usage.weekTokens > 0 ? `${(model.totalTokens / usage.weekTokens * 100).toFixed(0)}%` : "—"
									})
								]
							}, model.key))
						})
					] })
				})]
			});
		}
		/** 派活面板：一次一个对话，打开期间轮询。 */
		function PanePanel({ t }) {
			const [conversation, setConversation] = (0, react.useState)(() => rememberedConversation() ?? "main");
			/** 宿主里的 pane: 线程（对话清单，按最近活动倒序）、本标签页新建且宿主还没落地的对话名，
			*  以及从进行中工单反推出来的 pane 会话名。 */
			const [conversations, setConversations] = (0, react.useState)([]);
			const [extraConversations, setExtraConversations] = (0, react.useState)(() => rememberedNewConversations());
			/** 从 open 工单的 threads[].key 反推的会话名：有任务的会话即使不在宿主线程清单里，也不能从下拉消失。 */
			const [ticketConversations, setTicketConversations] = (0, react.useState)([]);
			const [items, setItems] = (0, react.useState)([]);
			const [draft, setDraft] = (0, react.useState)("");
			const [mode, setMode] = (0, react.useState)("assign");
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			/** 每张工单的协作 lane 明细（/crew）：直接显示在各自工单卡上，不再走右上角汇总。 */
			const [crew, setCrew] = (0, react.useState)(null);
			const [tickets, setTickets] = (0, react.useState)([]);
			const [activities, setActivities] = (0, react.useState)({});
			const [ccStatuses, setCcStatuses] = (0, react.useState)({});
			const [ccExpanded, setCcExpanded] = (0, react.useState)(false);
			const [ccBusy, setCcBusy] = (0, react.useState)(false);
			const [healths, setHealths] = (0, react.useState)({});
			/** 用户在面板里删掉（只是从下拉隐藏）的对话名，持久在 localStorage。 */
			const [removedConversations, setRemovedConversations] = (0, react.useState)(() => rememberedRemovedConversations());
			/** 正在等第二次点击确认删除的对话名；5 秒没有下文自动还原。 */
			const [confirmRemove, setConfirmRemove] = (0, react.useState)(null);
			/** 删除被拒绝时的可见提示（不进发送失败的 error，两者文案不同）。 */
			const [removeNotice, setRemoveNotice] = (0, react.useState)("");
			/** 定时派活弹窗是否打开。 */
			const [schedulesOpen, setSchedulesOpen] = (0, react.useState)(false);
			const [confirmStop, setConfirmStop] = (0, react.useState)(null);
			/** 上一次发送被服务端分流时的原因；下次发送或切换对话即清除。 */
			const [divertedNotice, setDivertedNotice] = (0, react.useState)("");
			const scrollRef = (0, react.useRef)(null);
			const pinnedRef = (0, react.useRef)(true);
			/** 记录用户当前位置：贴底就是「跟随」，往上翻历史就解除跟随，不再被拽回底部。 */
			const onScroll = (0, react.useCallback)(() => {
				const element = scrollRef.current;
				if (element) pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 16;
			}, []);
			(0, react.useEffect)(() => {
				rememberConversation(conversation);
			}, [conversation]);
			(0, react.useEffect)(() => {
				rememberNewConversations(extraConversations);
			}, [extraConversations]);
			(0, react.useEffect)(() => {
				rememberRemovedConversations(removedConversations);
			}, [removedConversations]);
			(0, react.useEffect)(() => {
				pinnedRef.current = true;
			}, [conversation]);
			(0, react.useEffect)(() => {
				let alive = true;
				const tick = () => {
					call("/crew").then((next) => {
						if (!alive) return;
						const body = next;
						if (body && Array.isArray(body.items)) setCrew(body);
					}).catch(() => {});
				};
				tick();
				const timer = setInterval(tick, 5e3);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			(0, react.useEffect)(() => {
				setDivertedNotice("");
			}, [conversation]);
			const load = (0, react.useCallback)(async () => {
				try {
					const body = await call(`/log/${encodeURIComponent(conversation)}`);
					const since = Date.now() - REVIEW_WINDOW_MS;
					setItems((Array.isArray(body?.items) ? body.items : []).filter((item) => {
						if (item.kind !== "notice") return true;
						const text = String(item.text ?? "");
						if (text.length > NOTICE_MAX_CHARS || SILENT_NOTICE.test(text)) return false;
						return Date.parse(String(item.at ?? "")) >= since;
					}));
				} catch {}
			}, [conversation]);
			/** 读 pane 对话清单：宿主线程（pane: 前缀去掉即对话名）与本插件 KV 里记过的对话（/conversations，
			*  能补回只有 ~chat 影子线程、宿主没有 base 线程的名字）。两路各自失败互不影响，合并时同名取较新的 lastAt；
			*  都读不到就保持现状，不打扰用户。 */
			const loadConversations = (0, react.useCallback)(async () => {
				const [threads, logged] = await Promise.allSettled([request(`${HOST_API}/threads?filter=all&limit=1000`), call("/conversations")]);
				const merged = /* @__PURE__ */ new Map();
				if (threads.status === "fulfilled") {
					for (const item of Array.isArray(threads.value?.items) ? threads.value.items : []) if (typeof item?.key === "string" && item.key.startsWith(THREAD_PREFIX)) merged.set(item.key.slice(5), String(item.lastAt ?? item.createdAt ?? ""));
				}
				if (logged.status === "fulfilled") {
					for (const item of Array.isArray(logged.value?.conversations) ? logged.value.conversations : []) if (typeof item?.name === "string") {
						const lastAt = String(item.lastAt ?? "");
						if (!(merged.get(item.name) ?? "") || lastAt.localeCompare(merged.get(item.name) ?? "") > 0) merged.set(item.name, lastAt);
					}
				}
				if (threads.status === "rejected" && logged.status === "rejected") return;
				setConversations([...merged].map(([name, lastAt]) => ({
					name,
					lastAt
				})).filter((item) => item.name && !item.name.includes("~") && /^[A-Za-z0-9_-]+$/.test(item.name)));
			}, []);
			(0, react.useEffect)(() => {
				let live = true;
				loadConversations();
				const timer = setInterval(() => {
					if (live) loadConversations();
				}, 1e4);
				return () => {
					live = false;
					clearInterval(timer);
				};
			}, [loadConversations]);
			/** 下拉选项：清单按最近活动倒序，再补本标签页新建的、当前对话和 main，按名字去重。
			*  开发期测试会话从清单里跳过；本标签页新建的、当前选中的和 main 永不隐藏。
			*  用户删掉的对话同样跳过——但如果它还有进行中的工单，仍然保留（隐藏它会连工单卡一起看不到）。 */
			const conversationOptions = (() => {
				const names = [...conversations].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).map((item) => item.name);
				const keep = /* @__PURE__ */ new Set([
					...extraConversations,
					conversation,
					"main"
				]);
				const removed = new Set(removedConversations);
				const busy = new Set(ticketConversations);
				const seen = /* @__PURE__ */ new Set();
				return [
					...names,
					...extraConversations,
					...ticketConversations,
					conversation,
					"main"
				].filter((name) => name && !(TEST_CONVERSATION.test(name) && !keep.has(name))).filter((name) => !(removed.has(name) && !busy.has(name))).filter((name) => !seen.has(name) && seen.add(name));
			})();
			/** 当前对话还有进行中的工单吗：ticketConversations 由 open 工单反推，tickets 里也可能有 working/person 的卡。
			*  有就不许删——删掉下拉入口会把正在跑的工单卡一并藏起来。 */
			const conversationBusy = ticketConversations.includes(conversation) || tickets.some((ticket) => (ticket.stage ?? "ended") !== "ended");
			const canDeleteConversation = conversation !== "main" && !conversationBusy;
			const confirmingRemove = confirmRemove === conversation;
			const deleteBlockedHint = conversation === "main" ? t("deleteMainBlocked") : conversationBusy ? t("deleteBusyBlocked") : t("deleteHint");
			/** 删除当前对话：两段式确认；第一次点击只把按钮变成「确认删除？」，5 秒后自动还原。
			*  确认后把名字记进 localStorage、从下拉移除，并切回 main 清空消息区。 */
			const removeConversation = (0, react.useCallback)(async (name) => {
				if (name === "main" || !NAME_PATTERN.test(name)) return;
				if (confirmRemove !== name) {
					setConfirmRemove(name);
					setRemoveNotice("");
					return;
				}
				setConfirmRemove(null);
				if (ticketConversations.includes(name) || tickets.some((ticket) => (ticket.stage ?? "ended") !== "ended")) {
					setRemoveNotice(t("deleteBusyBlocked"));
					return;
				}
				setRemovedConversations((previous) => [...previous.filter((item) => item !== name), name]);
				setExtraConversations((previous) => previous.filter((item) => item !== name));
				setConversation("main");
				setItems([]);
				setRemoveNotice("");
			}, [
				confirmRemove,
				ticketConversations,
				tickets,
				t
			]);
			(0, react.useEffect)(() => {
				if (!confirmRemove) return;
				const timer = setTimeout(() => setConfirmRemove(null), 5e3);
				return () => clearTimeout(timer);
			}, [confirmRemove]);
			(0, react.useEffect)(() => {
				if (conversation === "main" || !removedConversations.includes(conversation)) return;
				if (ticketConversations.includes(conversation)) return;
				setConversation("main");
				setItems([]);
			}, [
				conversation,
				removedConversations,
				ticketConversations
			]);
			/** 读本对话的工单（进行中优先，全部显示）与每个运行中工单的实时动作。 */
			const pollStatus = (0, react.useCallback)(async () => {
				const thread = `${THREAD_PREFIX}${conversation}`;
				const onThread = (item) => item.threads?.some((entry) => typeof entry.key === "string" && (entry.key === thread || entry.key.startsWith(`${thread}~`)));
				try {
					const hideList = await call("/hidden").catch(() => ({ ids: [] }));
					const hiddenIds = Array.isArray(hideList?.ids) ? hideList.ids : [];
					const open = await call("/tickets?state=open&limit=200").catch(() => ({ items: [] }));
					const derived = /* @__PURE__ */ new Set();
					for (const item of open?.items ?? []) for (const entry of Array.isArray(item?.threads) ? item.threads : []) if (typeof entry?.key === "string" && entry.key.startsWith(THREAD_PREFIX)) {
						const name = entry.key.slice(5).split("~")[0];
						if (NAME_PATTERN.test(name)) derived.add(name);
					}
					setTicketConversations([...derived].sort());
					let list = (open?.items ?? []).filter(onThread);
					if (!list.length) {
						const since = Date.now() - REVIEW_WINDOW_MS;
						list = ((await call("/tickets?state=ended&limit=30").catch(() => ({ items: [] })))?.items ?? []).filter(onThread).filter((item) => !hiddenIds.includes(item.id)).filter((item) => {
							if (unreadCount(item) > 0) return true;
							const at = Date.parse(String(item.ended?.at ?? item.updatedAt ?? ""));
							return Number.isFinite(at) && at >= since && !SILENT_OUTCOMES.has(String(item.ended?.outcome ?? ""));
						}).slice(0, REVIEW_KEEP);
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
				if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
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
					const sent = await call("/message", {
						method: "POST",
						body: JSON.stringify({
							conversation,
							text,
							mode
						})
					});
					setDraft("");
					setDivertedNotice(typeof sent?.diverted === "string" ? sent.diverted : "");
					pinnedRef.current = true;
					await load();
					loadConversations();
					pollStatus();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			};
			/** 把「给某张工单的意见」发到这张工单专属的意见会话 t<id>：该线程没有工单订阅，消息不会广播给同对话其它工单，
			*  只走 Eval → 路由器按文本里的工单 id 挂到那一张。 */
			const commentOnTicket = (0, react.useCallback)(async (ticket, text) => {
				const composed = `【给工单「${ticket.title}」(${ticket.id}) 的意见，请交给该工单的 worker，不要新建工单】\n${text}`;
				const sent = await call("/message", {
					method: "POST",
					body: JSON.stringify({
						conversation: commentConversation(ticket.id),
						text: composed,
						mode: "note"
					})
				});
				setDivertedNotice(typeof sent?.diverted === "string" ? sent.diverted : "");
				pinnedRef.current = true;
				await load();
				loadConversations();
				pollStatus();
			}, [
				load,
				loadConversations,
				pollStatus
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-pane-panel",
				style: {
					position: "relative",
					display: "flex",
					flexDirection: "column",
					height: "100%",
					boxSizing: "border-box",
					gap: 8,
					padding: "36px 12px 12px"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: DOT_STYLE }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PaneStatusWidget, { t }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 6,
							alignItems: "center",
							fontSize: 12,
							minWidth: 0
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									opacity: .65,
									flexShrink: 0
								},
								children: t("conversation")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								className: "dsh-pane-conversation",
								"data-pane-conversation": "",
								value: conversation,
								"aria-label": t("conversation"),
								title: t("conversation"),
								onChange: (event) => {
									setConversation(event.target.value);
									setItems([]);
								},
								style: {
									flex: "0 1 auto",
									minWidth: 0,
									maxWidth: 220,
									height: 24,
									fontSize: 12,
									padding: "0 4px",
									border: "1px solid var(--dt-border,#333)",
									borderRadius: 6,
									background: "var(--dt-surface,#2d2d2d)",
									color: "inherit",
									cursor: "pointer"
								},
								children: conversationOptions.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: name,
									children: isCommentConversation(name) ? fill(t("commentLabel"), { name: tickets.find((item) => item.id === name.slice(1))?.title ?? name.slice(1, 9) }) : conversationLabel(t, name)
								}, name))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-label": t("newConversation"),
								title: t("newConversation"),
								onClick: () => {
									const name = `c${Date.now()}`;
									setExtraConversations((previous) => [name, ...previous.filter((item) => item !== name)].slice(0, 20));
									setConversation(name);
									setItems([]);
								},
								style: {
									height: 24,
									padding: "0 8px",
									fontSize: 14,
									lineHeight: 1,
									flexShrink: 0
								},
								children: "+"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"data-pane-delete-conversation": conversation,
								"aria-label": t("deleteConversation"),
								title: canDeleteConversation ? t("deleteHint") : deleteBlockedHint,
								disabled: !canDeleteConversation,
								onClick: () => {
									removeConversation(conversation);
								},
								style: {
									height: 24,
									padding: "0 8px",
									fontSize: 12,
									lineHeight: 1,
									flexShrink: 0,
									color: confirmingRemove ? "#e53e3e" : "inherit",
									opacity: confirmingRemove ? 1 : canDeleteConversation ? .7 : .35,
									cursor: canDeleteConversation ? "pointer" : "not-allowed"
								},
								children: confirmingRemove ? t("confirmDelete") : "×"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"data-pane-schedules": "",
								"aria-label": t("scheduleOpen"),
								title: t("scheduleOpen"),
								onClick: () => setSchedulesOpen(true),
								style: {
									height: 24,
									padding: "0 8px",
									fontSize: 12,
									lineHeight: 1,
									flexShrink: 0,
									opacity: .75,
									cursor: "pointer"
								},
								children: "⏰"
							})
						]
					}),
					tickets.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-pane-tickets",
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 6,
							flex: "0 1 auto",
							minHeight: 0,
							overflowY: "auto"
						},
						children: tickets.map((ticket) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TicketBar, {
							ticket,
							crew: crew?.items.find((item) => item.ticketId === ticket.id)?.lanes,
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
							onComment: commentOnTicket,
							onOpenComment: (ticket) => {
								setConversation(commentConversation(ticket.id));
								setItems([]);
							},
							confirmStop: confirmStop === ticket.id,
							onClose: () => {
								closeTicket(ticket);
							}
						}, ticket.id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						ref: scrollRef,
						onScroll,
						style: {
							flex: "1 1 0",
							minHeight: 220,
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
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 11,
									opacity: .7,
									marginBottom: 2
								},
								children: [
									item.direction === "in" ? t("you") : `${t("agent")}${item.kind ? ` · ${item.kind}` : ""}`,
									item.direction === "in" && item.status === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											marginLeft: 6,
											padding: "0 5px",
											borderRadius: 3,
											background: "#2f4f37",
											color: "#9ae6b4",
											fontSize: 10
										},
										children: t("badgeScheduled")
									}),
									item.direction === "in" && decisionBadge(item) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										title: item.decision?.reason ?? "",
										style: {
											marginLeft: 6,
											padding: "0 5px",
											borderRadius: 3,
											background: "#8a5a00",
											color: "#ffd88a",
											fontSize: 10
										},
										children: decisionBadge(item)
									})
								]
							}), item.text]
						}, item.id))
					}),
					divertedNotice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 11,
							opacity: .7
						},
						children: fill(t("divertedHint"), { reason: divertedNotice })
					}),
					removeNotice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "alert",
						"data-pane-remove-notice": "",
						style: {
							color: "#e53e3e",
							fontSize: 12
						},
						children: removeNotice
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
							placeholder: mode === "chat" ? t("placeholderChat") : mode === "broadcast" ? t("placeholderBroadcast") : t("placeholder"),
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
								children: [
									"assign",
									"broadcast",
									"chat"
								].map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setMode(item),
									title: item === "chat" ? t("placeholderChat") : item === "broadcast" ? t("placeholderBroadcast") : "",
									style: {
										padding: "3px 10px",
										fontSize: 12,
										border: "none",
										cursor: "pointer",
										background: mode === item ? "var(--dt-accent, #2b6cb0)" : "transparent",
										color: mode === item ? "#fff" : "inherit"
									},
									children: item === "assign" ? t("modeDispatch") : item === "broadcast" ? t("modeBroadcast") : t("modeChat")
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
					mode === "chat" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 11,
							opacity: .6
						},
						children: t("chatBusyHint")
					}),
					mode === "broadcast" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 11,
							opacity: .6
						},
						children: t("broadcastHint")
					}),
					schedulesOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SchedulePanel, {
						t,
						conversation,
						onClose: () => setSchedulesOpen(false)
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
			const layout = anyCtx.layout;
			let restore = rememberedSelection();
			anyCtx.slots.inject("main", () => {
				const registration = anyCtx.slots.register({
					name: "main",
					key: PANEL_ID,
					locale: NS,
					inject: () => ({})
				}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanePanel, { t: props.t ?? t }));
				if (restore && layout?.panelInfo?.getSnapshot().activePanelId == null) {
					restore = false;
					try {
						layout.selectPanel(PANEL_ID);
					} catch {}
				}
				return registration;
			});
			anyCtx.slots.inject("sidebar.panellist", () => anyCtx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				label: () => t("panel"),
				locale: NS
			}, PlaneIcon));
			anyCtx.effect(() => {
				if (!layout?.panelInfo?.subscribe) return () => {};
				const sync = () => {
					const active = layout.panelInfo.getSnapshot().activePanelId;
					if (active === PANEL_ID) rememberSelection(true);
					else if (active !== null) rememberSelection(false);
					else if (anyCtx.slots.entries("main").some((entry) => entry.options?.key === PANEL_ID)) rememberSelection(false);
				};
				const off = layout.panelInfo.subscribe(sync);
				sync();
				return () => {
					off();
				};
			}, "pane: remember selected panel");
		}
		/** 定时派活弹窗：管理当前对话的定时任务（列表 + 新建 + 启停 / 立即执行 / 删除）。 */
		function SchedulePanel({ t, conversation, onClose }) {
			const [items, setItems] = (0, react.useState)([]);
			const [text, setText] = (0, react.useState)("");
			const [kind, setKind] = (0, react.useState)("daily");
			const [time, setTime] = (0, react.useState)("09:00");
			const [weekdays, setWeekdays] = (0, react.useState)([1]);
			const [minutes, setMinutes] = (0, react.useState)("30");
			const [at, setAt] = (0, react.useState)(() => {
				const date = new Date(Date.now() + 36e5);
				const pad = (value) => String(value).padStart(2, "0");
				return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
			});
			const [mode, setMode] = (0, react.useState)("assign");
			const [busy, setBusy] = (0, react.useState)(false);
			const [runBusy, setRunBusy] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const [confirmId, setConfirmId] = (0, react.useState)(null);
			const load = (0, react.useCallback)(async () => {
				try {
					const body = await call("/schedules");
					setItems(Array.isArray(body?.items) ? body.items : []);
				} catch {}
			}, []);
			(0, react.useEffect)(() => {
				load();
				const timer = setInterval(() => {
					load();
				}, 5e3);
				return () => clearInterval(timer);
			}, [load]);
			(0, react.useEffect)(() => {
				if (!confirmId) return;
				const timer = setTimeout(() => setConfirmId(null), 5e3);
				return () => clearTimeout(timer);
			}, [confirmId]);
			const summary = (spec) => {
				if (spec.kind === "every") return `${t("kindEvery")} ${spec.everyMinutes} ${t("minutesUnit")}`;
				if (spec.kind === "daily") return `${t("kindDaily")} ${spec.time}`;
				if (spec.kind === "weekly") return `${t("kindWeekly")} ${spec.weekdays.map((day) => t(`weekday${day}`)).join("、")} ${spec.time}`;
				return `${t("kindOnce")} ${spec.at.replace("T", " ")}`;
			};
			/** 列表里的时间都按浏览器本地时间显示；主机与浏览器通常同一台机器。 */
			const formatWhen = (ms) => {
				const date = new Date(ms);
				const pad = (value) => String(value).padStart(2, "0");
				return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
			};
			const fail = (failure) => setError(failure instanceof Error ? failure.message : String(failure));
			const add = async () => {
				if (!text.trim() || busy) return;
				setBusy(true);
				setError("");
				setNotice("");
				try {
					const spec = kind === "daily" ? {
						kind,
						time
					} : kind === "weekly" ? {
						kind,
						weekdays: weekdays.length ? [...weekdays].sort((a, b) => a - b) : [1],
						time
					} : kind === "every" ? {
						kind,
						everyMinutes: Math.max(1, Math.min(43200, Math.floor(Number(minutes) || 0)))
					} : {
						kind,
						at
					};
					if (spec.kind === "at" && !spec.at) throw new Error(t("scheduleAtRequired"));
					await call("/schedules", {
						method: "POST",
						body: JSON.stringify({
							conversation,
							text: text.trim(),
							mode,
							spec
						})
					});
					setText("");
					setNotice(t("scheduleCreated"));
					await load();
				} catch (failure) {
					fail(failure);
				} finally {
					setBusy(false);
				}
			};
			const toggle = async (record) => {
				setError("");
				setNotice("");
				try {
					await call(`/schedules/${record.id}/toggle`, {
						method: "POST",
						body: JSON.stringify({ enabled: !record.enabled })
					});
					await load();
				} catch (failure) {
					fail(failure);
				}
			};
			const run = async (record) => {
				if (runBusy) return;
				setRunBusy(record.id);
				setError("");
				setNotice("");
				try {
					await call(`/schedules/${record.id}/run`, {
						method: "POST",
						body: "{}"
					});
					setNotice(t("scheduleRunDone"));
					await load();
				} catch (failure) {
					fail(failure);
				} finally {
					setRunBusy("");
				}
			};
			const remove = async (record) => {
				if (confirmId !== record.id) {
					setConfirmId(record.id);
					return;
				}
				setConfirmId(null);
				setError("");
				setNotice("");
				try {
					await call(`/schedules/${record.id}/delete`, {
						method: "POST",
						body: "{}"
					});
					await load();
				} catch (failure) {
					fail(failure);
				}
			};
			const inputStyle = {
				padding: "2px 4px",
				fontSize: 12,
				border: "1px solid var(--dt-border,#333)",
				borderRadius: 4,
				background: "var(--dt-surface,#2d2d2d)",
				color: "inherit"
			};
			const buttonStyle = {
				padding: "3px 8px",
				fontSize: 12
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					position: "fixed",
					inset: 0,
					zIndex: 60,
					background: "rgba(0,0,0,.45)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: 12
				},
				onClick: onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					onClick: (event) => event.stopPropagation(),
					style: {
						width: "min(640px, 96vw)",
						maxHeight: "86vh",
						overflowY: "auto",
						background: "var(--dt-surface, #222)",
						border: "1px solid var(--dt-border, #333)",
						borderRadius: 10,
						padding: 14,
						display: "flex",
						flexDirection: "column",
						gap: 10
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
									style: { fontSize: 14 },
									children: t("scheduleTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										opacity: .6
									},
									children: conversation
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: onClose,
									style: {
										...buttonStyle,
										marginLeft: "auto"
									},
									children: t("scheduleClose")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								opacity: .6
							},
							children: t("scheduleHint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 8,
								border: "1px solid var(--dt-border, #333)",
								borderRadius: 8,
								padding: 10
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									value: text,
									onChange: (event) => setText(event.target.value),
									rows: 2,
									placeholder: t("scheduleTextPlaceholder"),
									style: {
										resize: "vertical",
										padding: 6,
										fontSize: 12
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 8,
										flexWrap: "wrap",
										alignItems: "center",
										fontSize: 12
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
											t("scheduleKind"),
											" ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												value: kind,
												onChange: (event) => setKind(event.target.value),
												style: inputStyle,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "daily",
														children: t("kindDaily")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "weekly",
														children: t("kindWeekly")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "every",
														children: t("kindEvery")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "at",
														children: t("kindOnce")
													})
												]
											})
										] }),
										kind === "every" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
											t("scheduleEvery"),
											" ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "number",
												min: 1,
												max: 43200,
												value: minutes,
												onChange: (event) => setMinutes(event.target.value),
												style: {
													...inputStyle,
													width: 72
												}
											}),
											" ",
											t("minutesUnit")
										] }),
										(kind === "daily" || kind === "weekly") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
											t("scheduleTime"),
											" ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "time",
												value: time,
												onChange: (event) => setTime(event.target.value),
												style: inputStyle
											})
										] }),
										kind === "weekly" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												display: "flex",
												gap: 4,
												alignItems: "center"
											},
											children: [t("scheduleWeekdays"), [
												1,
												2,
												3,
												4,
												5,
												6,
												7
											].map((day) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												style: {
													display: "inline-flex",
													alignItems: "center",
													gap: 1
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: weekdays.includes(day),
													onChange: () => setWeekdays((previous) => previous.includes(day) ? previous.filter((item) => item !== day) : [...previous, day].sort((a, b) => a - b))
												}), t(`weekday${day}`)]
											}, day))]
										}),
										kind === "at" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
											t("scheduleAt"),
											" ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "datetime-local",
												value: at,
												onChange: (event) => setAt(event.target.value),
												style: inputStyle
											})
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
											t("scheduleMode"),
											" ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												value: mode,
												onChange: (event) => setMode(event.target.value),
												style: inputStyle,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "dispatch",
														children: t("modeDispatch")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "broadcast",
														children: t("modeBroadcast")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "chat",
														children: t("modeChat")
													})
												]
											})
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											onClick: () => {
												add();
											},
											disabled: busy || !text.trim(),
											style: {
												...buttonStyle,
												marginLeft: "auto"
											},
											children: busy ? t("scheduleAdding") : t("scheduleAdd")
										})
									]
								}),
								notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 11,
										color: "#9ae6b4"
									},
									children: notice
								}),
								error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										color: "#e53e3e",
										fontSize: 11
									},
									children: fill(t("scheduleFailed"), { error })
								})
							]
						}),
						items.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								opacity: .6
							},
							children: t("scheduleEmpty")
						}) : items.map((record) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 4,
								border: "1px solid var(--dt-border, #333)",
								borderRadius: 8,
								padding: 9,
								opacity: record.enabled ? 1 : .6
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 6,
										alignItems: "center",
										flexWrap: "wrap",
										fontSize: 11
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												padding: "1px 6px",
												borderRadius: 3,
												border: "1px solid var(--dt-border,#333)"
											},
											children: summary(record.spec)
										}),
										record.conversation !== conversation && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: { opacity: .6 },
											children: record.conversation
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												opacity: .7,
												marginLeft: "auto"
											},
											children: record.enabled ? fill(t("scheduleNext"), { time: formatWhen(record.nextAtMs) }) : t("schedulePaused")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 12,
										whiteSpace: "pre-wrap",
										wordBreak: "break-word"
									},
									children: record.text
								}),
								record.lastAt && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 11,
										opacity: .6
									},
									children: fill(t("scheduleLast"), {
										time: formatWhen(Date.parse(record.lastAt)),
										result: record.lastResult ?? ""
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 6,
										justifyContent: "flex-end"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											onClick: () => {
												run(record);
											},
											disabled: runBusy === record.id,
											style: buttonStyle,
											children: runBusy === record.id ? t("scheduleRunning") : t("scheduleRun")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											onClick: () => {
												toggle(record);
											},
											style: buttonStyle,
											children: record.enabled ? t("scheduleToggleOff") : t("scheduleToggleOn")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											onClick: () => {
												remove(record);
											},
											style: {
												...buttonStyle,
												color: confirmId === record.id ? "#e53e3e" : "inherit"
											},
											children: confirmId === record.id ? t("scheduleConfirmDelete") : t("scheduleDelete")
										})
									]
								})
							]
						}, record.id))
					]
				})
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
