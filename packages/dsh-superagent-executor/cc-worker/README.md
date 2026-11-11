# cc-worker 快照 / cc-worker snapshot

本目录保存 DSH superagent worker 执行器 `cc-worker` 的**只读快照**，用于把「执行层」与主插件一起入库、可审计、可回滚。<br>This directory keeps a **read-only snapshot** of the `cc-worker` executor so the execution layer ships and versions together with the plugins.

## 来源 / Source

| 项 / Item | 值 / Value |
|---|---|
| 运行副本 / Runtime copy | `/home/szm/.local/bin/cc-worker` |
| 快照日期 / Snapshot date | 2026-11-11 |
| 版本特征 / Version | 含 `team` / `--lane` 协作机制（team-plan.json、lanes/\<lane\>、shared/findings、conflicts.md） |
| SHA-256 | `914e8454d8b053122df9d5d03f05d9c09d9b9e86ca8b071170de397aef999907` |

校验 / Verify:

```sh
sha256sum -c SHA256SUMS
```

## 注意 / Notes

- 这是**快照**，不是运行副本：本机实际执行仍走 `/home/szm/.local/bin/cc-worker`；仓库里的改动不会自动生效。<br>This is a **snapshot**, not the runtime copy: the machine still executes `/home/szm/.local/bin/cc-worker`, so edits here do not take effect by themselves.
- 升级执行器时重新快照，并同步更新本文件与 `SHA256SUMS`。<br>Re-snapshot on every executor upgrade and update this file and `SHA256SUMS` together.
- 脚本开头用 `set -u`，并假定 bash；无头调用会跳过 Claude Code 权限审批（`--dangerously-skip-permissions`），仅限本机 `szm` 用户使用。<br>It is a bash script with `set -u`; headless runs skip Claude Code permission prompts (`--dangerously-skip-permissions`) and are intended only for the local `szm` user.

## 用法速查 / Quick usage

```sh
cc-worker run "任务描述" --dir DIR [--new] [--model NAME] [--timeout SECONDS] [--max-turns N]
cc-worker team --plan team-plan.json --dir DIR        # 按 lane 并行派活
```

完整参数以脚本头注释与 `cc-worker help` 为准。<br>See the header comments and `cc-worker help` for the full set of options.