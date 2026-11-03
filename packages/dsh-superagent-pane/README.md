# dsh-superagent-pane

`dsh-superagent` 的侧边栏派活面板：在 DSH Web 界面里把任务派给 superagent，显示 worker 正在做什么，并提供工单收尾与 executor 的硬性守卫。

它依赖 `dsh-superagent`（同仓库的 `packages/dsh-superagent`）。两个包需一起安装：`dsh-superagent` 提供 orchestrator、Source 与工单模型，本包只从它导入 `key` 与 `Trigger` 两个符号，其余全部通过宿主公开的 Cordis 服务接入。

安装后在 DSH 的 Plugins → Discover 里添加本仓库的索引即可（索引托管在 GitHub Pages）。
