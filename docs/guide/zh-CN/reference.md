# 参考

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 命令参考

完整列表见 [`skill-data/core/references/commands.md`](../../../skill-data/core/references/commands.md)，或运行 `teamai --help` 和 `teamai <command> --help`。

---

## 配置文件参考

### teamai.yaml（远端团队配置）

```yaml
team: my-team
description: 团队 AI 资源仓库
repo: https://github.com/your-org/your-repo.git
provider: github
# language: en                # 可选。en 只用英文。省略或 zh 保持中英双语的 recall 规则、TodoWrite 提示和已合入 MR 提示
# scope: 若存在则忽略。本机安装位置由 teamai init --scope 决定

reviewers:
  - reviewer1

packages:
  npm:
    - name: typescript
      version: "*"

sharing:
  rules:
    enforced: [code-review-guide]
  recall:
    enabled: false
  docs:
    localDir: ./.teamai/docs   # 默认 ~/.teamai/docs
  env:
    injectShellProfile: true
  coAuthor:
    enabled: false
  gitExclude:
    enabled: true              # init 为新团队写入 true
  contributeHint:
    enabled: true
  intervention:
    correctionKeywords: []
  webhooks:
    enabled: true
    endpoints:
      - url: https://example.com/hook
        type: json             # json | feishu | wecom
        events: ["*"]          # session-start、session-stop、skill-use、push、pull，或 *
        secret: my-signing-key
        timeout: 5000
        retries: 3
```

### config.yaml（本地配置）

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/your-org/your-repo.git
username: your-name
updatePolicy: auto             # auto / prompt / skip
scope: workspace               # workspace（init 默认）或 user；project 按 workspace 读取
projectRoot: /path/to/my-workspace
inheritUserScope: true
coAuthorEnabled: true
gitExcludeEnabled: true
contributeHintEnabled: false
usageReportEnabled: false
codexTrustEnabled: false
toolRoots:
  claude: ~/.claude-work
  codex: ~/.codex-alt
```

角色、项目和 tag 字段保存的是这个目录自己的选择。workspace 还会交付其中已初始化仓库的选择，这些选择在每次 pull 时读取，不会写入这里。参见[包含仓库的 workspace](./distribution.md#包含仓库的-workspace)。

#### 迁移后的工具根目录（`toolRoots`）

Claude Code 用 `CLAUDE_CONFIG_DIR`、Codex 用 `CODEX_HOME` 时，`init` 会记下那个目录。目前只认 `claude` 和 `codex`。

```bash
CLAUDE_CONFIG_DIR=~/.claude-work teamai init
CLAUDE_CONFIG_DIR= teamai init    # 清掉记录
CODEX_HOME= teamai init
```

目录要在 home 下，或在 `~/.config/` 下面。Copilot 用自己的 `COPILOT_HOME`。

### Webhook 通知（`sharing.webhooks`）

| 事件 | 何时发送 |
| --- | --- |
| `session-start` | 会话开始 |
| `session-stop` | 会话结束 |
| `skill-use` | 调用了某个 skill |
| `push` | `teamai push` 真正推上去 |
| `pull` | `teamai pull` 真正同步完 |
| `*` | 以上全部 |

不发工具入参和输出。设了 `secret` 就带 `X-TeamAI-Signature`。

```bash
teamai webhook list
teamai webhook test
teamai webhook test --dry-run
```

---

## 模型配置

`teamai models switch` 才会改 Agent。之后 `pull` 让已切换的 Agent 跟上团队目录。

`team:<id>` 来自 `models/models.yaml`，以及当前 namespace 的 `models/<ns>/models.yaml`，不含密钥。`local:<id>` 在 `~/.teamai/models/models.yaml`。同名时要写前缀。

### 团队目录

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3
          - deepseek-v4-flash
```

`api_key` 必须是 `${API_KEY}`。`base_url` 不要以 `/v1` 结尾。第一个模型是默认。

| Agent | 协议 | `switch` 写入 |
| --- | --- | --- |
| Claude Code | `anthropic` | `~/.claude/settings.json` |
| Codex | `openai-responses` | `~/.codex/config.toml` |
| OpenCode | 任意 | `opencode.json` |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json` |
| Pi | 任意 | `~/.pi/agent/models.json` |
| OMP | 任意 | `~/.omp/agent/models.yml` |
| Muse Code | `openai-responses` | `~/.config/muse/settings.json`，密钥以 `META_API_KEY` 写入 `~/.teamai/models/env.sh`，由 shell 配置文件加载 |

上面的例子没有 `openai-responses`，所以不会改 Codex 和 Muse Code。

### 使用团队配置

```bash
teamai models list
teamai models switch tokenhub
teamai models switch --agent claude --model deepseek-v4-flash
teamai models switch --dry-run
```

不带名字会列出全部配置再问你。密钥放环境变量，不要写进命令参数：

```bash
teamai models configure tokenhub --from-env TOKENHUB_API_KEY
printf '%s' "$TOKENHUB_API_KEY" | teamai models configure tokenhub --api-key-stdin
```

### 团队配置按 namespace 划分

`models/<ns>/models.yaml` 会整份替换根目录里同 `id` 的配置。声明方式和 env 一样，见 [Env、hooks 与 MCP server 按 namespace 划分](./sharing.md#envhooks-与-mcp-server-按-namespace-划分)。

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      models: [checkout]
```

换了网关地址要重新 `teamai models switch team:<id>`。两个 namespace 抢同一个 id 时，这次不更新模型。

### 个人配置

```bash
teamai models add my-gateway --name "My gateway" \
  --protocol anthropic,openai-chat-completions \
  --base-url https://gateway.example.com \
  --model glm-5.3,deepseek-v4-flash \
  --from-env MY_GATEWAY_KEY
teamai models switch my-gateway
```

个人 id 不能和团队配置重名。

### 恢复

```bash
teamai models restore
teamai models restore --agent codex
teamai models remove local:my-gateway
```

只还原 TeamAI 改过的字段。你自己改过的 Agent，之后的 switch 和 restore 会跳过。
