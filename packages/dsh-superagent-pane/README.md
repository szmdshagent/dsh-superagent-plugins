# dsh-superagent-pane

给 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) agent 的「派活」侧边栏：直接从面板输入任务派活，看工单跑到哪一步、worker 正在干什么，结果以气泡回到对话里。**无需 @ 智能体。**

独立包：官方升级 superagent（整树覆盖非 git 目录）也删不掉它。

## 能力

**派活面板**
侧边栏出现「派活」图标，点开就是聊天界面。输入框旁是「派活 / 对话」双模式：

- **派活**（默认）：直接建单，秒发、权限完整。
- **对话**：走主 Session 分诊，用于答疑与查状态；普通派活请求会被规则过滤，属设计如此。

**工单状态条**
显示工单标题、阶段（运行中 / 等你处理 / 待命 / 已结束）与已运行时长。运行中会显示 worker **正在做什么的人话短语**（「运行 Python 脚本（h1.py）」「正在思考…（上一步：查找文件）」），原始命令收进「详情」折叠；超过 2 分钟没新动作会提示。同一对话的进行中工单全部显示。

**消息排队可见**
发完没回复时，输入框上方显示「已送达 · worker 正忙，消息排队中（已等 X）」，不用猜它看没看到。长任务期间新消息要等当前回合收尾才被读到，这是引擎设计，不是丢消息。

**协作分组（自动）**
同一批相关任务会自动成组（组内至多 4 个），组内共享上下文与结果卡；过了存活期自动解散。

**针对卡死的自愈**
- 僵尸检测：`running` 但长时间没动静的工单会被标红「卡死 · 需处理」，往这种线程派活会自动改投新线程。
- 卡死自愈：评估阶段卡在 `evaluating` 的消息，插件每 30 秒扫一次、超过 5 分钟没结论就重新排队，避免「后面的活儿上不去」。

**定时派活**
面板里的 ⏰ 按钮：每天 / 每周 / 每隔 / 一次，配置存 KV，每 20 秒扫描一次，复用面板派活通道。

**广播**
把一句话广播给符合条件的工单。默认按关键词 + 时间窗（「最近 12 小时」指**最近一次被唤醒**的时间，不是建单时间）；选「全部」才全量投递。

**工单收尾（tid.ts 入口）**
已结束工单把结果回写到面板对话、归档 worker 会话、在无其他会话时回收工作目录。

**worker 硬限制（guard 入口，可选）**
把 Executor Session 的 bash 限制成只读白名单 + 放行 cc-worker 调用，禁止 write/edit 类工具直接落盘——实质改动必须经 cc-worker。不认识就不需要，可以从 `cordis.patch.yml` 里删掉 `dsh-superagent-pane-guard` 那一条。

## 安装

```bash
cd packages/dsh-superagent-pane
pnpm install && pnpm build
dsh plugin --profile superagent add "link:$PWD"
```

把 `"dsh-superagent-pane"` 加进 `~/.dsh/profiles/superagent/package.json` 的 `dsh.profile.bundles`，然后重启。

**前提**：profile 里要先有 superagent 本体（peer 依赖 `dsh-superagent`）。

## 必须做的一次性配置：policy 里登记 pane 源

新 Source 的默认 policy **不会**自动合并进已保存的设置。没登记时面板消息会被判 `ignore`（看起来就是「发了没反应」）。登记一次：

```bash
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' \
  "http://127.0.0.1:3082/orchestrator/api/settings/policy" \
  -d '{"value": <当前完整 policy，sources.pane.allowed 里含 {"id":"owner"}> , "revision": <当前 revision>}'
```

先 GET 同一路径拿现值与 revision，改完再 PUT。

## 配置

在 `~/.dsh/profiles/superagent/cordis.patch.yml` 里按 `id` 覆盖：

```yaml
- id: dsh-superagent-pane
  config: {}
```

## 排障速查

| 现象 | 先看什么 |
| --- | --- |
| 没有「派活」图标 | 首页 HTML 里有没有 `dsh-superagent-pane/client.js`。有=登记成功问题在前端；没有=profile 没装上 |
| 发了没反应 | policy 是否登记了 pane 源；再看工单是否卡在评估阶段（插件自愈会兜） |
| 状态条没有「正在做什么」 | `GET /orchestrator/api/pane/activity/<会话id>`；`session not found` 说明会话目录不匹配 |
| 插件不生效 | `dsh --profile superagent --dump-config` 里有没有这几条；bundle 是否写进了 `dsh.profile.bundles` |

## License

MIT