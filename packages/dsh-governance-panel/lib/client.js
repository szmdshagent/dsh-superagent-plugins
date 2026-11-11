window.__ModuleLoader__.load({
	id: "dsh-governance-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/client.tsx
		/**
		* 执行治理面板（浏览器侧）：侧边栏一个「治理」图标，点开是一页只读看板。
		*
		* 刻意做成完全独立的插件：自己的图标、自己的面板、自己的路由，不引 pane 插件也不引 superagent。
		* 卸载本包后，superagent 与派活面板行为不变。
		*/
		const inject = ["slots", "locale"];
		const NS = "dshGovernancePanel";
		const PANEL_ID = "dsh-governance-panel";
		const API = "/api/governance";
		const DIM_LABEL = {
			team: "团队协作",
			handoff: "交接闭环",
			executor: "执行器",
			budget: "预算纪律",
			cost: "成本",
			context: "上下文",
			liveness: "活性"
		};
		const DIM_ORDER = [
			"team",
			"handoff",
			"executor",
			"budget",
			"cost",
			"context",
			"liveness"
		];
		const LANE_STATUS_TEXT = {
			pending: "未启动",
			running: "进行中",
			done: "完成",
			failed: "失败",
			unknown: "未知"
		};
		const LANE_STATUS_COLOR = {
			pending: "#888",
			running: "#3182ce",
			done: "#38a169",
			failed: "#e53e3e",
			unknown: "#d69e2e"
		};
		/** 时长格式：秒级以内保留一位小数，分钟级给 mm:ss。 */
		function formatDuration(ms) {
			if (!ms || ms < 0) return "—";
			const seconds = ms / 1e3;
			if (seconds < 60) return `${seconds.toFixed(1)}s`;
			return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
		}
		const SEV_COLOR = {
			critical: "#e53e3e",
			warn: "#d69e2e",
			info: "#718096"
		};
		const SEV_TEXT = {
			critical: "严重",
			warn: "注意",
			info: "提示"
		};
		const VERDICT_COLOR = {
			ok: "#38a169",
			watch: "#d69e2e",
			bad: "#e53e3e",
			unknown: "#888"
		};
		const VERDICT_TEXT = {
			ok: "正常",
			watch: "观察",
			bad: "有问题",
			unknown: "无数据"
		};
		const zh = {
			panel: "治理",
			title: "执行治理",
			refresh: "刷新",
			refreshing: "刷新中…",
			loading: "扫描中…",
			empty: "最近 7 天没有任何治理数据。",
			allOk: "七个维度全部正常，没有发现需要处理的问题。",
			scanned: "扫描",
			tickets: "个工单",
			runs: "轮台账",
			weeklyOpen: "治理周报 ▸",
			weeklyClose: "治理周报 ▾",
			weeklyNone: "还没有周报",
			weeklyBusy: "正在生成周报…",
			trendOpen: "成本趋势 ▸",
			trendClose: "成本趋势 ▾",
			trendDay: "日",
			trendCost: "成本",
			trendRuns: "轮数",
			metrics: "指标",
			evidence: "原始证据",
			details: "详情",
			collapse: "收起",
			spread: "展开",
			countSuffix: " 项",
			severities: "严重/注意/提示"
		};
		const en = {
			panel: "Governance",
			title: "Execution governance",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			loading: "Scanning…",
			empty: "No governance data in the last 7 days.",
			allOk: "All seven dimensions are healthy.",
			scanned: "Scanned",
			tickets: "tickets",
			runs: "ledger runs",
			weeklyOpen: "Weekly report ▸",
			weeklyClose: "Weekly report ▾",
			weeklyNone: "No report yet",
			weeklyBusy: "Generating…",
			trendOpen: "Cost trend ▸",
			trendClose: "Cost trend ▾",
			trendDay: "day",
			trendCost: "cost",
			trendRuns: "runs",
			metrics: "Metrics",
			evidence: "Evidence",
			details: "Details",
			collapse: "Collapse",
			spread: "Expand",
			countSuffix: " issues",
			severities: "critical/warn/info"
		};
		/** 与宿主其它插件一致的取数方式：令牌随页面 URL 而来。 */
		async function fetchReport(params) {
			const query = new URLSearchParams(params);
			const token = new URLSearchParams(window.location.search).get("token") ?? "";
			if (token) query.set("token", token);
			const response = await fetch(`${API}?${query.toString()}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		}
		/** 工单目录名去掉末位哈希，当标题用。 */
		function prettyName(name) {
			const [base, lane] = name.split("#");
			const title = base.replace(/-[0-9a-f]{12}$/, "") || base;
			return lane ? `${title} · lane ${lane}` : title;
		}
		/** 指标值格式化：金额保留两位，大数用千分位。 */
		function formatMetric(value) {
			if (value === null || value === void 0) return "—";
			if (typeof value === "string") return value;
			if (Number.isInteger(value)) return value.toLocaleString("en-US");
			return value.toFixed(4);
		}
		function GovernanceIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 24 24",
				width: "18",
				height: "18",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6l-8-3Z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "m9 12 2 2 4-4" })]
			});
		}
		/** 一条发现：默认两行摘要，点开看指标与证据。 */
		function FindingRow({ finding, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [showEvidence, setShowEvidence] = (0, react.useState)(false);
			const color = SEV_COLOR[finding.severity];
			const metrics = Object.entries(finding.metrics ?? {});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-gov-finding": finding.id,
				style: {
					border: "1px solid var(--dt-border,#333)",
					borderRadius: 6,
					borderLeft: `3px solid ${color}`,
					padding: "6px 9px",
					display: "flex",
					flexDirection: "column",
					gap: 4
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 6,
							alignItems: "baseline",
							minWidth: 0
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color,
									fontSize: 10,
									fontWeight: 700,
									flexShrink: 0
								},
								children: SEV_TEXT[finding.severity]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 10,
									opacity: .5,
									flexShrink: 0
								},
								children: DIM_LABEL[finding.dimension]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									fontWeight: 500,
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									flex: "1 1 0"
								},
								title: finding.title,
								children: finding.title
							}),
							(metrics.length > 0 || finding.detail) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setOpen((value) => !value),
								style: {
									flexShrink: 0,
									background: "none",
									border: "none",
									padding: 0,
									cursor: "pointer",
									color: "inherit",
									opacity: .6,
									textDecoration: "underline",
									fontSize: 11
								},
								children: open ? t("collapse") : t("details")
							})
						]
					}),
					finding.ticket && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 11,
							opacity: .55,
							fontFamily: "monospace"
						},
						children: prettyName(finding.ticket)
					}),
					open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						finding.detail && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								opacity: .8,
								lineHeight: 1.5
							},
							children: finding.detail
						}),
						metrics.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								gap: 12,
								flexWrap: "wrap",
								fontSize: 11,
								opacity: .75
							},
							children: metrics.map(([key, value]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { opacity: .6 },
									children: key
								}),
								" ",
								formatMetric(value)
							] }, key))
						}),
						finding.evidence && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => setShowEvidence((value) => !value),
							style: {
								background: "none",
								border: "none",
								padding: 0,
								cursor: "pointer",
								color: "inherit",
								opacity: .55,
								textDecoration: "underline",
								fontSize: 11
							},
							children: showEvidence ? t("collapse") : t("evidence")
						}), showEvidence && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							style: {
								margin: "4px 0 0",
								padding: 6,
								fontSize: 10,
								maxHeight: 160,
								overflow: "auto",
								whiteSpace: "pre-wrap",
								wordBreak: "break-word",
								background: "rgba(0,0,0,.25)",
								borderRadius: 4
							},
							children: finding.evidence
						})] })
					] })
				]
			});
		}
		/** 单个维度卡片：顶部是维度名与判定，下面是这个维度的发现。 */
		function DimensionCard({ dimension, findings, t }) {
			const [open, setOpen] = (0, react.useState)(dimension.critical > 0 || dimension.warn > 0);
			const color = VERDICT_COLOR[dimension.verdict];
			const metrics = Object.entries(dimension.metrics);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-gov-dim": dimension.key,
				style: {
					border: "1px solid var(--dt-border,#333)",
					borderRadius: 8,
					overflow: "hidden",
					flexShrink: 0
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					onClick: () => setOpen((value) => !value),
					style: {
						display: "flex",
						gap: 6,
						alignItems: "baseline",
						padding: "6px 9px",
						cursor: "pointer",
						background: "rgba(255,255,255,.03)",
						flexWrap: "wrap"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								opacity: .5,
								fontSize: 10
							},
							children: open ? "▾" : "▸"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								color,
								fontSize: 10,
								fontWeight: 700
							},
							children: "●"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							style: { fontSize: 12 },
							children: DIM_LABEL[dimension.key]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								color,
								fontSize: 11
							},
							children: VERDICT_TEXT[dimension.verdict]
						}),
						dimension.issues > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								fontSize: 11,
								opacity: .7
							},
							children: [dimension.critical > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { color: SEV_COLOR.critical },
								children: [
									"严重 ",
									dimension.critical,
									" "
								]
							}), dimension.warn > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { color: SEV_COLOR.warn },
								children: ["注意 ", dimension.warn]
							})]
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 5,
						padding: "7px 9px"
					},
					children: [
						metrics.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								gap: 12,
								flexWrap: "wrap",
								fontSize: 11,
								opacity: .7
							},
							children: metrics.map(([key, value]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { opacity: .6 },
									children: key
								}),
								" ",
								formatMetric(value)
							] }, key))
						}),
						findings.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								opacity: .5
							},
							children: t("allOk")
						}),
						findings.map((finding) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FindingRow, {
							finding,
							t
						}, finding.id))
					]
				})]
			});
		}
		/** team 计划与各 lane 的执行情况；没有 team 时整块不渲染。 */
		function TeamCard({ team, conflicts }) {
			if (!team.present) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-gov-team": true,
				style: {
					border: "1px solid var(--dt-border,#333)",
					borderRadius: 8,
					padding: "7px 9px",
					display: "flex",
					flexDirection: "column",
					gap: 5,
					flexShrink: 0
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8,
							alignItems: "baseline",
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: { fontSize: 12 },
								children: "团队协作"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 11,
									opacity: .75
								},
								children: [
									"计划 ",
									team.workerLanes,
									" 路 · 完成 ",
									team.done,
									" · 失败 ",
									team.failed,
									" · 进行中 ",
									team.running,
									" · 未启动 ",
									team.pending
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 11,
									opacity: .6,
									marginLeft: "auto"
								},
								children: [
									"成本 $",
									team.totalCostUsd.toFixed(4),
									" · token ",
									team.totalTokens.toLocaleString("en-US"),
									" · ",
									"峰值并行 ",
									team.peakParallelism
								]
							})
						]
					}),
					conflicts?.present && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 11,
							opacity: .65
						},
						children: [
							"共享区：findings ",
							conflicts.findingsFiles,
							" 份",
							conflicts.blockedFindings > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { color: SEV_COLOR.warn },
								children: [
									"（BLOCKED ",
									conflicts.blockedFindings,
									"）"
								]
							}),
							" · ",
							"冲突路径 ",
							conflicts.conflictPaths
						]
					}),
					team.teams.map((summary) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 3,
							borderTop: "1px solid var(--dt-border,#333)",
							paddingTop: 5
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								opacity: .7,
								fontFamily: "monospace"
							},
							children: prettyName(summary.ticket)
						}), summary.lanes.map((lane) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-gov-lane": `${summary.ticket}#${lane.lane}`,
							style: {
								display: "flex",
								gap: 7,
								alignItems: "baseline",
								flexWrap: "wrap",
								fontSize: 11
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										color: LANE_STATUS_COLOR[lane.status],
										fontWeight: 700,
										flexShrink: 0
									},
									children: ["● ", LANE_STATUS_TEXT[lane.status]]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontFamily: "monospace",
										flexShrink: 0
									},
									children: lane.lane
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										opacity: .5,
										flexShrink: 0
									},
									children: lane.role === "lead" ? "统筹" : lane.role === "worker" ? "子任务" : "lane"
								}),
								lane.task && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									title: lane.task,
									style: {
										opacity: .75,
										minWidth: 0,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										flex: "1 1 160px"
									},
									children: lane.task
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										opacity: .55,
										flexShrink: 0
									},
									children: [
										lane.runs,
										" 轮 · ",
										lane.steps,
										" 步 · $",
										lane.costUsd.toFixed(4),
										" · ",
										formatDuration(lane.durationMs),
										lane.handoffSwitches > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · 换会话 ", lane.handoffSwitches] })
									]
								})
							]
						}, `${summary.ticket}#${lane.lane}`))]
					}, summary.ticket))
				]
			});
		}
		function GovernancePanel({ t }) {
			const [report, setReport] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [weekly, setWeekly] = (0, react.useState)(null);
			const [weeklyOpen, setWeeklyOpen] = (0, react.useState)(false);
			const [weeklyBusy, setWeeklyBusy] = (0, react.useState)(false);
			const [trend, setTrend] = (0, react.useState)(null);
			const [trendOpen, setTrendOpen] = (0, react.useState)(false);
			/** 常规扫描：六个维度一次算完。 */
			const load = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					const next = await fetchReport({});
					setReport(next);
					setError(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			/** 周报与趋势都按需拉，避免每次进页面都跑脚本。 */
			const loadWeekly = (0, react.useCallback)(async () => {
				setWeeklyBusy(true);
				try {
					setWeekly((await fetchReport({ weekly: "1" })).weekly ?? null);
				} catch {} finally {
					setWeeklyBusy(false);
				}
			}, []);
			const loadTrend = (0, react.useCallback)(async () => {
				try {
					setTrend((await fetchReport({ trend: "1" })).trend ?? []);
				} catch {
					setTrend([]);
				}
			}, []);
			const findings = report?.findings ?? [];
			const byDimension = (key) => findings.filter((item) => item.dimension === key);
			const totalCritical = findings.filter((item) => item.severity === "critical").length;
			const totalWarn = findings.filter((item) => item.severity === "warn").length;
			const overallColor = report?.overall === "bad" ? SEV_COLOR.critical : report?.overall === "watch" ? SEV_COLOR.warn : "#38a169";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-gov-panel": true,
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%",
					gap: 8,
					padding: "10px 12px",
					fontSize: 12,
					overflowY: "auto",
					background: "var(--dt-panel-bg, #0b0f1a)",
					color: "var(--dt-text, #e5eaf6)"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8,
							alignItems: "center",
							flexShrink: 0
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							style: { fontSize: 14 },
							children: t("title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: busy,
							onClick: () => {
								setWeekly(null);
								setWeeklyOpen(false);
								load();
							},
							style: {
								marginLeft: "auto",
								fontSize: 11,
								padding: "2px 8px",
								cursor: busy ? "wait" : "pointer"
							},
							children: busy ? t("refreshing") : t("refresh")
						})]
					}),
					!report && !error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { opacity: .6 },
						children: t("loading")
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							color: SEV_COLOR.critical,
							fontFamily: "monospace",
							whiteSpace: "pre-wrap"
						},
						children: error
					}),
					report && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								gap: 10,
								alignItems: "baseline",
								flexWrap: "wrap",
								flexShrink: 0
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									color: overallColor,
									fontWeight: 700
								},
								children: ["● ", report.headline]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 10,
								fontSize: 11,
								opacity: .7,
								flexShrink: 0,
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: { color: totalCritical > 0 ? SEV_COLOR.critical : void 0 },
									children: ["严重 ", totalCritical]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: { color: totalWarn > 0 ? SEV_COLOR.warn : void 0 },
									children: ["注意 ", totalWarn]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["提示 ", findings.filter((item) => item.severity === "info").length] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: { marginLeft: "auto" },
									children: [
										t("scanned"),
										" ",
										report.scanned.tickets,
										" ",
										t("tickets"),
										(report.scanned.laneUnits ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
											" / ",
											report.scanned.laneUnits,
											" lane"
										] }),
										(report.scanned.teamTickets ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
											" / ",
											report.scanned.teamTickets,
											" team"
										] }),
										" / ",
										report.scanned.ledgerRuns,
										" ",
										t("runs")
									]
								})
							]
						}),
						report.team?.present && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TeamCard, {
							team: report.team,
							conflicts: report.conflicts
						}),
						report.dimensions.length > 0 && DIM_ORDER.filter((key) => report.dimensions.some((item) => item.key === key)).map((key) => {
							const dimension = report.dimensions.find((item) => item.key === key);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DimensionCard, {
								dimension,
								findings: byDimension(key),
								t
							}, key);
						}),
						findings.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { opacity: .6 },
							children: t("allOk")
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { flexShrink: 0 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							"data-gov-trend": true,
							onClick: () => {
								const next = !trendOpen;
								setTrendOpen(next);
								if (next && trend === null) loadTrend();
							},
							style: {
								background: "none",
								border: "1px solid var(--dt-border,#333)",
								borderRadius: 4,
								cursor: "pointer",
								padding: "2px 8px",
								fontSize: 11,
								color: "inherit",
								opacity: .85
							},
							children: trendOpen ? t("trendClose") : t("trendOpen")
						}), trendOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 2,
								marginTop: 6,
								fontSize: 11
							},
							children: [(trend ?? []).map((row) => {
								const max = Math.max(...(trend ?? []).map((item) => item.cost), 1e-4);
								const width = Math.max(2, Math.round(row.cost / max * 100));
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 6,
										alignItems: "center"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												fontFamily: "monospace",
												opacity: .6,
												minWidth: 78
											},
											children: row.day
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												flex: "1 1 0",
												background: "rgba(255,255,255,.06)",
												borderRadius: 2,
												height: 12
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
												width: `${width}%`,
												height: "100%",
												background: "#3182ce",
												borderRadius: 2
											} })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												minWidth: 78,
												textAlign: "right"
											},
											children: ["$", row.cost.toFixed(3)]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												minWidth: 42,
												opacity: .55,
												textAlign: "right"
											},
											children: [
												row.runs,
												" ",
												t("trendRuns")
											]
										})
									]
								}, row.day);
							}), trend !== null && trend.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { opacity: .55 },
								children: "—"
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { flexShrink: 0 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"data-gov-weekly": true,
								onClick: () => {
									const next = !weeklyOpen;
									setWeeklyOpen(next);
									if (next && !weekly) loadWeekly();
								},
								style: {
									background: "none",
									border: "1px solid var(--dt-border,#333)",
									borderRadius: 4,
									cursor: "pointer",
									padding: "2px 8px",
									fontSize: 11,
									color: "inherit",
									opacity: .85
								},
								children: weeklyOpen ? t("weeklyClose") : t("weeklyOpen")
							}),
							weeklyOpen && weeklyBusy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									opacity: .6,
									marginTop: 6
								},
								children: t("weeklyBusy")
							}),
							weeklyOpen && !weeklyBusy && !weekly && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									opacity: .6,
									marginTop: 6
								},
								children: t("weeklyNone")
							}),
							weeklyOpen && !weeklyBusy && weekly && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								style: {
									margin: "6px 0 0",
									padding: 8,
									fontSize: 10,
									maxHeight: 340,
									overflow: "auto",
									whiteSpace: "pre-wrap",
									wordBreak: "break-word",
									background: "var(--dt-surface, rgba(255,255,255,.04))",
									borderRadius: 4
								},
								children: weekly.text
							})
						]
					})
				]
			});
		}
		function apply(ctx) {
			const anyCtx = ctx;
			anyCtx.effect(() => anyCtx.locale.register(NS, {
				zh,
				en
			}), "governance-panel: dictionaries");
			const t = (key) => zh[key] ?? String(key);
			anyCtx.slots.inject("main", () => anyCtx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({})
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GovernancePanel, { t })));
			anyCtx.slots.inject("sidebar.panellist", () => anyCtx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 30,
				label: () => zh.panel,
				locale: NS
			}, GovernanceIcon));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
