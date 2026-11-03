# dsh-superagent plugins

This repository publishes two DSH (DeepSeek Harness) bundles from one place:

| Package | Directory | What it does |
|---|---|---|
| `dsh-superagent` | `packages/dsh-superagent` | A proactive agent for one GitHub repository: listens to GitHub and optionally Feishu, evaluates requests under a Policy, turns authorized ones into tickets, and executes each in its own DSH session. |
| `dsh-superagent-pane` | `packages/dsh-superagent-pane` | Sidebar dispatch panel for `dsh-superagent`: send tasks from the DSH web UI and watch what the worker is doing. |

`dsh-superagent-pane` depends on `dsh-superagent`; install both.

## Install

1. In DSH, open **Plugins → Experimental plugins** and switch on **Custom plugin indexes**.
2. Open the **Discover** tab, choose **Add index source**, and enter the index URL:

   ```
   https://szmdshagent.github.io/dsh-superagent-plugins/index.json
   ```

3. Pick `dsh-superagent` and `dsh-superagent-pane` and install the listed version.

The index (`index.json`) pins each package to an exact commit and package directory, so an install does not depend on the default branch moving.

## Layout

```
index.json                     plugin market index (format 1)
packages/dsh-superagent/       dsh-superagent bundle
packages/dsh-superagent-pane/  dsh-superagent-pane bundle
```

Both packages ship their built `lib/` in the repository, so a Git install needs no build step and no `prepare` script.

## License

`dsh-superagent` is MIT © DeepSeek Harness Team. `dsh-superagent-pane` is MIT © szm.
