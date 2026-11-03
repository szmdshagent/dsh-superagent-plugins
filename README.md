# dsh-superagent 插件 / dsh-superagent plugins

本仓库从同一个地方发布两个 DSH（DeepSeek Harness）组合包。<br>This repository publishes two DSH (DeepSeek Harness) bundles from one place:

| 包 / Package | 目录 / Directory | 作用 / What it does |
|---|---|---|
| `dsh-superagent` | `packages/dsh-superagent` | 面向单个 GitHub 仓库的主动式智能体：监听 GitHub（可选飞书），按策略评估请求，把获得授权的请求转成工单，并在独立的 DSH 会话里逐个执行。<br>A proactive agent for one GitHub repository: listens to GitHub and optionally Feishu, evaluates requests under a Policy, turns authorized ones into tickets, and executes each in its own DSH session. |
| `dsh-superagent-pane` | `packages/dsh-superagent-pane` | `dsh-superagent` 的侧边栏派活面板：在 DSH Web 界面里派活，并查看 worker 正在做什么。<br>Sidebar dispatch panel for `dsh-superagent`: send tasks from the DSH web UI and watch what the worker is doing. |

`dsh-superagent-pane` 把 `dsh-superagent` 作为可选 peer 依赖，运行时从 profile 解析，两个都要装。<br>`dsh-superagent-pane` uses `dsh-superagent` as an optional peer dependency, resolved from the profile at runtime; install both.

## 安装 / Install

1. 在 DSH 里打开 **Plugins → Experimental plugins**，打开 **Custom plugin indexes**。<br>In DSH, open **Plugins → Experimental plugins** and switch on **Custom plugin indexes**.
2. 打开 **Discover** 标签页，选择 **Add index source**，填入索引 URL：<br>Open the **Discover** tab, choose **Add index source**, and enter the index URL:

   ```
   https://szmdshagent.github.io/dsh-superagent-plugins/index.json
   ```

3. 先装 **`dsh-superagent`**，再装 **`dsh-superagent-pane`**，各自装列表里的版本。侧边栏面板把 `dsh-superagent` 声明为可选 peer 依赖，并在运行时从 profile 解析，因此两个包必须按这个顺序分别安装。<br>Install **`dsh-superagent` first**, then **`dsh-superagent-pane`**, each at the listed version. The pane declares `dsh-superagent` as an optional peer dependency and resolves it from the profile at runtime, so the two must be installed as separate bundles in that order.

索引（`index.json`）把每个包固定到确切的 commit 和包目录，因此安装不受默认分支移动的影响。<br>The index (`index.json`) pins each package to an exact commit and package directory, so an install does not depend on the default branch moving.

## 目录结构 / Layout

```
index.json                     # 插件市场索引（format 1） / plugin market index (format 1)
packages/dsh-superagent/       # dsh-superagent 组合包 / dsh-superagent bundle
packages/dsh-superagent-pane/  # dsh-superagent-pane 组合包 / dsh-superagent-pane bundle
```

两个包都把构建好的 `lib/` 随仓库发布，因此从 Git 安装不需要构建步骤，也不需要 `prepare` 脚本。<br>Both packages ship their built `lib/` in the repository, so a Git install needs no build step and no `prepare` script.

## 许可 / License

`dsh-superagent` 与 `dsh-superagent-pane` 均以 MIT 许可发布：`dsh-superagent` 为 MIT © DeepSeek Harness Team，`dsh-superagent-pane` 为 MIT © szm。<br>`dsh-superagent` is MIT © DeepSeek Harness Team. `dsh-superagent-pane` is MIT © szm.
