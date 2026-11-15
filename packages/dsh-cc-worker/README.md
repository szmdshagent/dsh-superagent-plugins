# dsh-cc-worker

给 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) 的 agent 一双「能真正干活的手」：把写脚本、跑测试、构建、测量、批量改文件这类实质工作交给 Claude Code 执行，结果按结构化 JSON 回到对话里。

这是一个 **dsh 插件（bundle）**，自带执行器，**装好就能用，不需要任何外部脚本**。

## 为什么需要它

dsh 的 agent 擅长对话与决策，但「真正动手」的活需要一个能跑命令、能读写文件、能自我纠错的执行进程。本插件把 Claude Code 作为执行器接进来：

- 你（或上层 agent）描述任务 → 插件起一个 Claude Code 会话去干 → 拿回 `{ok, result, session_id, cost_usd, duration_s, log}`。
- 会话可复跑：同一工作目录默认续跑上次的会话，长任务不用每次从头讲背景。
- 进程自成一组：中断时整组收掉，不留僵尸进程。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `ccw_run` | 执行一项实质工作。参数：`task`（必填）、`dir`、`lane`、`fresh`、`model`、`timeout_s`、`max_turns` |
| `ccw_status` | 列出在跑的任务：`task_id`、已运行秒数、工作目录 |
| `ccw_kill` | 中断一个任务（传 `task_id`）或全部任务 |

`ccw_run` 返回值：

```json
{
  "ok": true,
  "result": "执行器给出的最终答复",
  "session_id": "a1dbf86d-...",
  "cost_usd": 0.16,
  "duration_s": 3.5,
  "log": "/path/to/work/<目录>/.cc-worker/runs/2026-11-15T15-03-54-839Z.jsonl",
  "task_id": "ccw-xxxxxxxx"
}
```

失败时 `ok: false` 且带 `error`；超时带 `timedOut: true`，被中断带 `interrupted: true`。

## 安装

### 方式一：从本地目录挂载（开发/自用推荐）

```bash
git clone <本仓库> ~/src/dsh-cc-worker
cd ~/src/dsh-cc-worker && pnpm install && pnpm build

# 挂进某个 profile
dsh plugin --profile <你的profile> add "link:$HOME/src/dsh-cc-worker"
```

然后在该 profile 的 `~/.dsh/profiles/<你的profile>/package.json` 的 `dsh.profile.bundles` 里加上 `"dsh-cc-worker"`。

（`dsh plugin add` 会把包装进 profile，但 bundle 要出现在 `dsh.profile.bundles` 里才会被真正挂载。）

### 方式二：从 git 安装

```bash
dsh plugin --profile <你的profile> add "github:<你的账号>/dsh-cc-worker"
```

包的 `prepare` 脚本会自动构建 `lib/`。同样要把 `"dsh-cc-worker"` 加进 `dsh.profile.bundles`。

装好后重启宿主：

```bash
systemctl --user restart dsh-<你的profile>
```

## 配置

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里覆盖，全部可选：

```yaml
- id: dsh-cc-worker
  config:
    workRoot: /home/me/.dsh/state/superagent/work   # 允许的工作目录根（--dir 必须在其下）
    claudeBin: claude                               # claude 可执行文件
    defaultTimeoutS: 1800
    defaultMaxTurns: 40
    maxConcurrent: 3
    extraArgs: []                                   # 透传给 claude 的额外参数，如 ["--model","claude-sonnet-5-5"]
    skipPermissions: false                          # 见下方「安全」
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `workRoot` | `~/.dsh/state/superagent/work` | 沙箱根：`dir` 不在其下会被拒绝 |
| `claudeBin` | `claude` | Claude Code CLI 的路径或命令名 |
| `defaultTimeoutS` | `1800` | 默认超时秒数 |
| `defaultMaxTurns` | `40` | 默认最大轮数 |
| `maxConcurrent` | `3` | 同时执行的任务上限 |
| `extraArgs` | `[]` | 追加给 `claude` 的参数 |
| `skipPermissions` | `false` | 是否跳过 Claude Code 的权限审批 |
| `legacyScript` | 无 | 设为路径则改调该外部脚本（见「两种执行模式」） |
| `loadMarker` | `false` | 调试用：挂载成功时写 `/tmp/dsh-cc-worker.loaded` |

## 安全

**`skipPermissions` 默认为 `false`。** 此时 Claude Code 走自己的权限流程；设为 `true` 等于允许无人值守地执行任意命令，请只在隔离环境或你完全信任的目录里开启——这是部署方自己的决定，插件不会代你打开。

其余两道闸：

1. `dir` 必须在 `workRoot` 之下，防止一个工单的会话串进别人的目录。
2. `lane` 只允许 `[A-Za-z0-9_-]`，避免拼路径时被注入。

## 两种执行模式

### 自带执行器（默认）

插件自己管理会话与进程：预分配 `session_id` 落盘、下一次同目录自动 `--resume`、`setsid` 自成进程组、监视 `interrupt` 文件与宿主存活。

**装好即可用**，不需要任何外部脚本。

### 外部脚本（`legacyScript`）

如果你已经有一套自己的执行脚本（例如 `cc-worker`），配置 `legacyScript` 后插件改为调用它：

```yaml
- id: dsh-cc-worker
  config:
    legacyScript: /home/me/.local/bin/cc-worker
```

脚本契约（与自带的 `ccw_run` 参数一致）：

```text
cc-worker run <任务> [--dir DIR] [--new] [--model NAME] [--timeout SEC] [--max-turns N]
stdout 恰一行 JSON：{ok, result, session_id, cost_usd, duration_s, log}
```

这种方式保留了脚本里本机特有的能力（例如会话瘦身、预算裁决、多 worker 协调）。没有脚本的用户不用管这一节。

## 状态目录

每个工作目录下会自动生成：

```text
<dir>/.cc-worker/
  session_id            # 当前会话 id；resume 靠它
  claude.pid            # 正在跑的 claude 进程号
  runs/*.jsonl          # 每次执行的 stream-json 原始事件
  fallback.log          # 超时/中断/宿主消失的记录
  lanes/<lane>/...      # 分道并行时各自独立一套
```

想手工中止一次执行，可以在这两个文件里选一个：

- 删掉/创建 `<dir>/.cc-worker/interrupt`（插件每秒检查一次，发现即整组收掉）
- 用 `ccw_kill` 工具传 `task_id`

## 已知限制

- 依赖本机已登录的 Claude Code CLI（`claude` 能在终端里直接跑）。
- 一次 `ccw_run` 是阻塞的：任务多久它多久，HTTP/agent 侧的超时要留够。
- 只在 Linux 上验证过（用了 `setsid` / `timeout`）；macOS 可用，Windows 需自行适配。
- `result` 只取最后一条 `type:"result"` 事件；中途事件的细节在 `runs/*.jsonl` 里。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/index.js
```

目录：

```text
src/index.ts     # 插件入口：注册 ccw_run / ccw_status / ccw_kill
src/runner.ts    # 自带执行器（无外部依赖）
src/exec.ts      # 外部脚本模式（legacyScript）
cordis.patch.yml # bundle 挂载声明
```

## License

MIT