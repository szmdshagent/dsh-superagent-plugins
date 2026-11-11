# team / lane / handoff / shared 协作架构

本文描述 DSH superagent 的「派活 → 执行 → 观察」三层协作机制：一个工单可以由多个并行 worker 分头执行，各自有独立的会话、锁、预算与交接单，最后汇总裁决。文档对应本仓库的四个包与 `cc-worker` 执行脚本。<br>This document describes how a ticket is split across parallel workers, each with its own session, lock, budget and handoff, and how the results are merged.

## 1. 组件与职责

| 层 / Layer | 组件 / Component | 目录 / Directory | 职责 / Responsibility |
|---|---|---|---|
| 派活 / Dispatch | `dsh-superagent-pane` | `packages/dsh-superagent-pane` | 侧边栏派活面板：发任务、枚举 lane、展示存活/完成/失败；不执行模型调用。 |
| 业务 / Agent | `dsh-superagent` | `packages/dsh-superagent` | 工单、策略、订阅、卡片与运行时；决定「做什么」，不决定「怎么跑进程」。 |
| 执行 / Execution | `dsh-superagent-executor` | `packages/dsh-superagent-executor` | 调用前硬校验（`--max-turns`、`--lane`、`team` 嵌套、lane 命名）、成本熔断、运行状态聚合。 |
| 脚本 / Runner | `cc-worker` | `packages/dsh-superagent-executor/cc-worker/cc-worker` | 真正启动 Claude Code：分配/恢复会话、拿锁、写日志、做 handoff、跑 team 三阶段。仓库内是快照，运行副本仍是 `~/.local/bin/cc-worker`。 |
| 治理 / Governance | `dsh-governance-panel` | `packages/dsh-governance-panel` | 独立侧边栏面板，只读 `.cc-worker/` 痕迹，输出交接、执行器、预算、成本、上下文、活性六个维度。 |

依赖方向是单向的：pane / governance 只读状态文件；executor 只做工具守卫与状态聚合；`cc-worker` 不 import 任何插件。升级主包不会删掉执行层与治理层。

## 2. 状态目录布局

所有协作状态都在工单目录的 `.cc-worker/` 下（`$DIR` 即工单目录，下称状态根）：

```
$DIR/.cc-worker/
├── session_id              # main lane 当前会话 id（旧布局，保持兼容）
├── log.jsonl               # main lane 本次事件流（stream-json）
├── runs/                   # main lane 历次运行归档
├── team-plan.json          # 统筹阶段产出的子任务计划
├── team-summary.json       # 汇总阶段结果
├── conflicts.md            # 自动冲突检测：各 lane 改动路径重叠
├── lanes/
│   ├── lead/               # 统筹与汇总专用 lane
│   │   ├── session_id
│   │   ├── log.jsonl
│   │   ├── handoff.md
│   │   └── ...
│   └── ccw1/               # 子任务 lane（ccw1、ccw2、…）
│       ├── session_id      # 每 lane 独立会话，可 --resume
│       ├── task.txt        # 本 lane 的分工描述（面板展示）
│       ├── runs/           # 历次运行归档
│       ├── log.jsonl       # 本次事件流
│       ├── result.json     # cc-worker 输出的一行 JSON 结果
│       ├── stderr.log      # 脚本与执行器诊断
│       ├── handoff.md      # 换会话时落盘的交接单
│       ├── switch.log      # cctrim 换会话/交接注入记录
│       └── handoff-archive/# 过期交接单归档
└── shared/
    ├── findings/           # 工单内共享结论：ccwN.md、final.md
    └── artifacts/          # 产物登记：ccwN.done、截图、日志路径等
```

跨工单复用的知识在 `~/.dsh/state/superagent/shared/knowledge/`：`index.md` 只有一行式索引，正文在同名 `.md`。team 的每个子 worker 都会被告知「先读 index，只挑相关条目」。

## 3. lane 语义

- **缺省 `main`**：状态文件直接落在状态根，行为与旧版 `cc-worker` 完全一致；单 worker 工单不受 team 机制影响。
- **其它 lane**：状态落到 `lanes/<lane>/`，锁、会话、日志、预算全部独立，因此不同 lane 可以真正并行；同一 lane 仍然串行（`flock` 最多等 600 秒）。
- **命名**：只允许字母、数字、`-`、`_`（会拼进路径，禁止 `/` 与 `..`）；team 计划推荐 `ccw1`、`ccw2`、`ccw3`…，与面板显示一致。旧 `w1/w2` 在面板里显示为 `ccw1/ccw2`。
- **上限**：`--workers` 默认 3，钳制到 1–4。
- **嵌套**：`team` 子命令内部设置 `CC_TEAM_DEPTH=1`，再次调用 `team` 直接报错，避免指数级膨胀。

## 4. team 三阶段

```
cc-worker team "总任务" --dir DIR [--workers N]
        │
        ├─ 阶段 1/3 统筹：lane=lead，最多 N 个子任务
        │     写 $DIR/.cc-worker/team-plan.json
        │     JSON 数组：[{"lane":"ccw1","task":"...（含验收与禁止范围）"}, ...]
        │     计划为空/解析失败 → 降级为单 worker 直跑（lane=main）
        │
        ├─ 阶段 2/3 并行：每 lane 一个 cc-worker run
        │     各自 result.json / stderr.log / task.txt
        │     零 token 监督：轮询 pid 判活，到 DEADLINE 先 TERM 再 KILL
        │     结束后 team_conflicts.py 扫描各 lane「改动文件」段落
        │     重叠路径写入 shared/conflicts.md
        │
        └─ 阶段 3/3 汇总：resume lead
              读各 lane handoff.md + conflicts.md
              裁决冲突、标注失败缺口
              写 shared/findings/final.md，输出 team-summary.json
```

统筹提示词要求子任务「互不依赖、可并行」，并显式写出**禁止触碰的范围**，这是冲突检测能生效的前提。

## 5. handoff（会话交接）

`cc-worker` 在上下文过长时会换新会话（cctrim）：

1. 换会话前由 `cc-diag/decide.py --handoff` 生成 `handoff.md`（本 lane）；
2. `switch.log` 记录 `cctrim switch to <sid>` 与原因；
3. 新会话以 `--new` 起跑时注入 `handoff.md`（超过 24h 视为过期，归档到 `handoff-archive/`，不注入）；
4. lead 汇总阶段直接读各 lane 的 `handoff.md`，因此交接单是「跨进程、跨会话」唯一可信的状态传递面。

## 6. shared 与冲突

| 位置 | 写者 | 读者 | 用途 |
|---|---|---|---|
| `shared/findings/<lane>.md` | 子 worker | 其它子 worker、lead、人 | 中间结论，避免重复劳动；首行 `DONE` / `BLOCKED` |
| `shared/findings/final.md` | lead | 人、后续轮次 | 统一结论与缺口 |
| `shared/artifacts/*.done` | 编排者/子 worker | 编排者 | 完成信号（`ccwN.done`），轮询等待用 |
| `shared/conflicts.md` | `team_conflicts.py` | lead | 改动路径重叠的机器检测结果 |

## 7. 预算与硬约束

执行层把「提示词承诺」变成「代码拒绝」：

- **参数守卫**：Executor Session（`worker-*`）调用 `cc-worker` 时必须带 `--max-turns`；ccw1 起扩展为识别 `--lane` / `--workers` / `team`，校验 lane 命名、拒绝 team 嵌套。
- **成本熔断**：按工单累计花费（`runs/*.jsonl`）判断，超过阈值拒绝启动；按 lane 聚合输出，避免只看 main。
- **预算计划**：worker 首条消息可给出 `BUDGET_PLAN {steps, input_tokens, output_tokens}`；`budget-status.json` 记录违规类型（`tool-before-plan`、`plan-overrun`、`over-budget-plan` 等）。
- **上下文守卫**：单轮缓存读、步数、换会话次数都会被治理面板统计。

## 8. 治理面板的观察视角

`dsh-governance-panel` 与派活流程零耦合：独立路由 `/api/governance`、独立侧边栏图标，只读状态根。它按 lane 聚合 token、成本、轮次、时长与 handoff 切换，汇总 team 总成本与并行度，并把 `shared/findings/*.md` 与 `conflicts.md` 作为治理告警/信息展示；无 `lanes/`、无 `team-plan.json` 的旧工单按单 main 模式兼容。

## 9. 一次完整协作的时序

```
人/编排器
  │  cc-worker team "任务" --dir DIR --workers 3
  ▼
lead lane ──写 team-plan.json──► 共享区
  │
  ├─ ccw1 run ─► lanes/ccw1/{result.json,handoff.md} ─┐
  ├─ ccw2 run ─► lanes/ccw2/{...}                     ├─► conflicts.md
  └─ ccw3 run ─► lanes/ccw3/{...}                     ┘
  │
  ▼
lead 汇总 ─► shared/findings/final.md + team-summary.json
  │
  ▼
pane 展示各 lane 状态        governance 只读统计与告警
```