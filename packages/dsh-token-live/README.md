# dsh-token-live

在 dsh Web 界面的输入框下方（composer dock）加一枚小条：**今日累计 token + 实时 tok/s**。

每 2 秒查一次用量，用相邻两次 `totalTokens` 的差值除以秒数算速率；第一次只显示累计，还没有速率。

## 前提

数据来自另一个插件 [`dsh-plugin-usage`](https://www.npmjs.com/package/dsh-plugin-usage) 提供的 `POST /api/usage/query`。**没装它，本插件静默不显示**（按设计：dock 常驻，不能刷屏报错）。

```bash
dsh plugin --profile superagent add dsh-plugin-usage
```

## 安装

```bash
cd packages/dsh-token-live
pnpm install && pnpm build
dsh plugin --profile superagent add "link:$PWD"
```

把 `"dsh-token-live"` 加进 `~/.dsh/profiles/superagent/package.json` 的 `dsh.profile.bundles`，重启宿主。

## 显示逻辑

- 正常：`今日 12.3k tokens · 45 次调用 · 1.2k tok/s`
- 刚启动 / 无速率：只显示累计，不显示速率
- slot 不存在、路由不可用、返回格式不对：**不渲染、不抛错**

## 配置

无。语言跟随宿主 locale（内置中/英文案）。

## License

MIT