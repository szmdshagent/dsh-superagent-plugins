# dsh-superagent 插件 / dsh-superagent plugins

本仓库从同一个地方发布四个 DSH（DeepSeek Harness）组合包。<br>This repository publishes four DSH (DeepSeek Harness) bundles from one place:

| 包 / Package | 目录 / Directory | 作用 / What it does |
|---|---|---|
| `dsh-superagent` | `packages/dsh-superagent` | 面向单个 GitHub 仓库的主动式智能体：监听 GitHub（可选飞书），按策略评估请求，把获得授权的请求转成工单，并在独立的 DSH 会话里逐个执行。<br>A proactive agent for one GitHub repository: listens to GitHub and optionally Feishu, evaluates requests under a Policy, turns authorized ones into tickets, and executes each in its own DSH session. |
| `dsh-superagent-pane` | `packages/dsh-superagent-pane` | `dsh-superagent` 的侧边栏派活面板：在 DSH Web 界面里派活，并查看 worker 正在做什么；支持枚举 lane、展示存活/完成/失败。<br>Sidebar dispatch panel for `dsh-superagent`: send tasks from the DSH web UI, watch what workers are doing, and see per-lane status. |
| `dsh-superagent-executor` | `packages/dsh-superagent-executor` | worker 执行层：`cc-worker` 调用参数硬校验（`--max-turns`、`--lane`、`team` 嵌套、lane 命名）、工单成本熔断、按 lane 聚合运行状态。目录内附 `cc-worker` 只读快照与 SHA-256。<br>Worker execution layer: hard validation of `cc-worker` arguments (`--max-turns`, `--lane`, team nesting, lane naming), per-ticket cost circuit breaker, and per-lane run state. Ships a read-only `cc-worker` snapshot with SHA-256. |
| `dsh-governance-panel` | `packages/dsh-governance-panel` | 独立治理面板：只读 `.cc-worker/` 痕迹，按 lane/team 聚合成本、上下文、交接、预算、执行器与活性，不改派活流程。<br>Standalone governance panel: reads `.cc-worker/` traces only and aggregates cost, context, handoff, budget, executor and liveness per lane/team, without touching dispatch. |

`dsh-superagent-pane` 把 `dsh-superagent` 作为可选 peer 依赖，运行时从 profile 解析，两个都要装；`dsh-superagent-executor` 与 `dsh-governance-panel` 是独立 bundle，可单独安装。<br>`dsh-superagent-pane` uses `dsh-superagent` as an optional peer dependency, resolved from the profile at runtime; install both. `dsh-superagent-executor` and `dsh-governance-panel` are standalone bundles and can be installed on their own.

## 安装 / Install

1. 在 DSH 里打开 **Plugins → Experimental plugins**，启用 **Custom plugin indexes**。<br>In DSH, open **Plugins → Experimental plugins** and switch on **Custom plugin indexes**.
2. 打开 **Discover** 标签页，选择 **Add index source**，填入索引 URL：<br>Open the **Discover** tab, choose **Add index source**, and enter the index URL:

   ```
   https://szmdshagent.github.io/dsh-superagent-plugins/index.json
   ```

3. 先装 **`dsh-superagent`**，再装 **`dsh-superagent-pane`**，各自装列表里的版本。侧边栏面板把 `dsh-superagent` 声明为可选 peer 依赖，并在运行时从 profile 解析，因此两个包必须按这个顺序分别安装。<br>Install **`dsh-superagent` first**, then **`dsh-superagent-pane`**, each at the listed version. The pane declares `dsh-superagent` as an optional peer dependency and resolves it from the profile at runtime, so the two must be installed as separate bundles in that order.
4. **`dsh-superagent-executor`** 与 **`dsh-governance-panel`** 按需单独安装；它们不依赖主包的内部模块，升级主包时不会被覆盖。<br>Install **`dsh-superagent-executor`** and **`dsh-governance-panel`** separately as needed; they do not import the main bundle's internals and survive main-bundle upgrades.

索引（`index.json`）把每个包固定到确切的 commit 和包目录，因此安装不受默认分支移动的影响。<br>The index (`index.json`) pins each package to an exact commit and package directory, so an install does not depend on the default branch moving.

## 目录结构 / Layout

```
index.json                                      # 插件市场索引（format 1） / plugin market index (format 1)
packages/dsh-superagent/                        # dsh-superagent 组合包 / bundle
packages/dsh-superagent-pane/                   # dsh-superagent-pane 组合包 / bundle
packages/dsh-superagent-executor/               # 执行层组合包 / execution bundle
packages/dsh-superagent-executor/cc-worker/     # cc-worker 快照 + README + SHA256SUMS
packages/dsh-governance-panel/                  # 治理面板组合包 / governance bundle
docs/architecture-collab.md                     # team / lane / handoff / shared 架构说明
```

所有包都把构建好的 `lib/` 随仓库发布，因此从 Git 安装不需要构建步骤，也不需要 `prepare` 脚本。<br>All packages ship their built `lib/` in the repository, so a Git install needs no build step and no `prepare` script.

## 协作机制 / Collaboration

一个工单可以由多个并行 worker 分头执行，每个 lane 有独立会话、锁、预算和交接单，最后由 lead lane 汇总。分层、状态目录、`team` 三阶段与冲突检测详见 [docs/architecture-collab.md](docs/architecture-collab.md)。<br>A ticket can run across parallel workers, each lane with its own session, lock, budget and handoff, merged by the lead lane. See [docs/architecture-collab.md](docs/architecture-collab.md) for layers, state layout, the three team phases and conflict detection.

## 许可 / License

`dsh-superagent` 以 MIT 许可发布（MIT © DeepSeek Harness Team）；`dsh-superagent-pane`、`dsh-superagent-executor` 与 `dsh-governance-panel` 为 MIT © szm。<br>`dsh-superagent` is MIT © DeepSeek Harness Team. `dsh-superagent-pane`, `dsh-superagent-executor` and `dsh-governance-panel` are MIT © szm.