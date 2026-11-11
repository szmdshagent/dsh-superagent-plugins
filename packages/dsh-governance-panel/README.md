# dsh-governance-panel — 执行治理面板（独立插件）

给 DSH superagent 加一个**完全独立**的侧边栏「治理」面板，把 cc-worker 执行层留下的痕迹
归纳成七个治理维度，一眼看出「哪里不对、为什么不贵、下一步该修什么」。

## 为什么是独立插件

| 约束 | 做法 |
|---|---|
| 官方升级 superagent 会整树覆盖（非 git 仓库） | 本包独立目录 `~/src/dsh-governance-panel`，升级碰不到 |
| 不能影响派活插件 `dsh-superagent-pane` | 零 import，独立路由 `/api/governance`、独立侧边栏图标 |
| 随时能撤 | `dsh plugin --profile superagent remove dsh-governance-panel` + 重启，执行层不受影响 |

**不引 `dsh-superagent`**，只依赖宿主服务 `webServer`（Node 侧）与 `slots`/`locale`（浏览器侧）。

## 七个治理维度

| 维度 | 数据源 | 抓什么 |
|---|---|---|
| 团队协作 | `.cc-worker/team-plan.json`、`lanes/<lane>/`、`shared/` | 按 lane 展示子任务完成/失败、token/成本/轮次/时长/交接切换、峰值并行、findings 与 `conflicts.md` |
| 交接闭环 | `.cc-worker/handoff-state.json` | `run_failed` / `unconsumed` / `extract_failed`，连续 2 次升级为严重 |
| 执行器 | `.cc-worker/stderr.log` | 按错误内容聚合；`unrecognized_model` 标为已知良性 |
| 预算纪律 | `budget-status.json` + `budget-ledger.jsonl` | 违规、重复调用 ≥3 次、`capped` 截断、无预算计划比例 |
| 成本 | 各工单 `budget-ledger.jsonl` | 单轮 ≥$1 注意、≥$5 严重、**≤3 步却 ≥$1 判为上下文爆炸** |
| 上下文 | `switch.log` + 台账 `act_cache_read` | 换会话 ≥2 次、单轮缓存读 ≥800K、单轮 ≥40 步 |
| 活性 | `.cc-worker/claude.pid` + 目录 mtime | 有 pid 但静默 >20 分钟（残留 pid）、5–20 分钟停滞观察 |

阈值集中在 `src/governance.ts` 的 `THRESHOLDS`，改口径只动一处。

## 接口

```
GET /api/governance                     # 七维度完整报告
GET /api/governance?dims=cost,budget    # 只要指定维度
GET /api/governance?ticket=<工单目录名>  # 只扫一个工单（验收取样/钻取）
GET /api/governance?weekly=1            # 附带治理周报（不存在则现场生成，最长 8s）
GET /api/governance?trend=1             # 附带近 7 天成本趋势
```

报告新增三个顶层字段：

- `lanes`：逐 lane 聚合（`ticket` / `lane` / `role` / `status` / `tokens` / `costUsd` / `runs` / `steps` / `durationMs` / `handoffSwitches`）。
- `team`：`present`、完成/失败/进行中计数、`totalCostUsd`、`totalTokens`、`peakParallelism`、`configuredParallelism`，以及按工单分组的 `teams[]`。
- `conflicts`：`shared/findings/*.md` 与 `shared/conflicts.md` 的识别结果（`conflictPaths`、`findingsFiles`、`blockedFindings`、`items[]`）。

只读：`POST` 一律 405。全部数据源是磁盘只读扫描，不碰数据库、不起进程。
单 main 工单（无 `lanes/`、无 `team-plan.json`）仍是 `lanes=[]`、`team.present=false`，不报错。

## 构建与部署

```bash
cd ~/src/dsh-governance-panel
pnpm install          # 首次
npx tsdown            # 双构建：lib/index.js (ESM) + lib/client.js (CJS)
systemctl --user restart dsh-superagent
```

安装 / 卸载：

```bash
dsh plugin --profile superagent add 'link:/home/szm/src/dsh-governance-panel'
dsh plugin --profile superagent remove dsh-governance-panel
```

## 踩过的坑

1. **Node 侧必须 `export const inject = ['webServer']`**，否则 apply 时抛
   `cannot get property "webServer" without inject`，插件静默不激活。
2. **`@deepseek-ai/cordis` 的 `Context` 已有 `logger`**，重复声明会 TS2687/TS2717。
3. **中文标识符不能带空格**（`有 worker 目录:` 是语法错误，要写 `有worker目录:`）。
4. **浏览器 bundle 的 banner id 必须是包名**，否则 `__ModuleLoader__` 挂不上。
5. **面板固定中文**：服务端治理文案是中文，前端若跟宿主语言（默认英文）会中英混排。

## 验证

- 接口：`curl http://127.0.0.1:3082/api/governance` → 200，七维度齐全
- 团队维度只读取样：

  ```bash
  cd /tmp && node --experimental-strip-types --input-type=module -e "
  const { govern } = await import('/home/szm/src/dsh-governance-panel/src/governance.ts');
  const r = govern(Date.now(), { ticket: 'code-governance-team-sync-0b80349ab1d2' });
  console.log(JSON.stringify({ lanes: r.lanes, team: r.team, conflicts: r.conflicts }, null, 2));
  "
  ```

- 浏览器：`~/cc-diag/verify-handoff-plugin/{probe.py,measure.py}`
  - `probe.py`：点开面板，断言根节点 / 七卡片 / 发现条目 / 周报展开
  - `measure.py`：注入 JS 实测七个卡片的真实宽高、是否横向溢出、文字是否被裁切
  - 两者均 PASS（1440×1000，Firefox headless）

## 归档与回滚

- 源码归档：`~/superagent-custom/handoff-panel/`
- 卸载：`dsh plugin --profile superagent remove dsh-governance-panel && systemctl --user restart dsh-superagent`
- 执行层数据（`handoff-state.json`、台账、事件流）**不受影响**，只是不再有这块 UI。
