# 基础 Harness

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

## Skills

```bash
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
---
name: my-deploy-helper
description: 帮助团队部署服务
---
# Deploy Helper
当用户请求部署时，按以下步骤执行：
1. 检查当前分支是否为 master
2. 运行测试 `npm test`
3. 构建 `npm run build`
4. 部署 `./deploy.sh`
EOF

teamai push
teamai push --role pm
```

没有 frontmatter 时，`push` 会补上 `name` 和 `description`。新 skill 写到你的角色或当前项目给出的 `skills/<ns>/<name>/`。有多个时会问，并提供明确的共享根目录选项。`--role` 指定命名空间；`--shared` 把新资源放到整个团队共享的根目录，即使已有命名空间。它不能与 `--role` 或 `--project` 同用。已从命名空间交付的资源，编辑后仍回到原位置。选择命名空间且团队有 `manifest/roles.yaml` 或 `manifest/projects.yaml` 时，该空间必须由其中某个角色或项目声明。

角色或项目过滤 skill 时，共享根目录的 skill 仍按原有 tags 订阅规则交付。`--shared` 选择的是发布位置。

## Rules

```bash
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# 代码审查规范
- 所有函数必须有 JSDoc 注释
- 禁止使用 `any` 类型
EOF

teamai push
```

成员不能删的 rule，写在 `teamai.yaml`：

```yaml
sharing:
  rules:
    enforced: [code-review-guide]
```

你自己的 rule 会留下。`push` 只把已有团队 rule 的正文写回仓库。

这里的 Antigravity 指三者：CLI（`agy`）、Antigravity 2.0 和 Antigravity IDE 读取同样的 `~/.gemini/config` 和 `.agents`，所以一次 pull 三者都能用。

Antigravity 只加载带 `trigger` 的 rule，所以 pull 会加上。带 `paths:` 的 rule 会变成模型处理这些文件时才采用的 rule：

```markdown
<!-- 团队仓库里的 rules/api-errors.md -->
---
paths: ["src/api/**/*.ts"]
---
Return typed errors from API handlers.

<!-- teamai pull 之后的 ~/.gemini/config/rules/api-errors.md -->
---
trigger: model_decision
description: "Applies when reading or editing files matching src/api/**/*.ts"
---

Return typed errors from API handlers.
```

没有 `paths:` 的 rule 得到 `trigger: always_on`。

rule 还可以在 frontmatter 的 `related:` 块中声明与其他团队资源的关系（doc 也可以；learning 在贡献时同样这样声明）：

```markdown
---
related:
  MAPS_TO: teamwiki/evidence/code/pay/modules/ledger-receipts.md
  REFERENCES: [docs/payments-overview.md]
---
```

`MAPS_TO` 指向 teamwiki 代码页面，`REFERENCES` 指向任意资源，`SUPERSEDES` / `CONFLICTS_WITH` 指向规则、文档或 learning。`teamai recall` 会把每条声明的关系、以及每条由 `paths:` glob 派生的关系（见知识指南），作为 `Related:` 行打印在命中结果上，会话拿到关系的一端时也就看到了另一端。`teamai review --branch` 会判定 `related:` 块使用了表格外关系的规则或文档为失败；指向分支上不存在资源的关系是警告，不会判定失败。

### 目录型 rule：确定加载的 skill

`rules/` 下包含 `RULE.md` 的目录是一个目录型 rule。`RULE.md` 就是这条 rule，其他文件是 rule 让 agent 去读的辅助文件：

```text
rules/api-style/
├─ RULE.md
├─ RULE.zh.md
├─ checklist.md
└─ examples/good-endpoint.ts
```

```markdown
<!-- rules/api-style/RULE.md -->
---
paths: ["src/api/**"]
---
Follow the team API style. Before adding an endpoint, read
${TEAMAI_RULE_DIR}/checklist.md and ${TEAMAI_RULE_DIR}/examples/good-endpoint.ts.
```

| | Skill | 目录型 rule |
|---|---|---|
| 由谁加载 | 模型，或 `/skill` / `$skill` | teamai：始终加载，或按 `paths:` |
| 手动调用 | 可以 | 不可以；rule 可以指向一个 skill，确保它被用上 |
| 辅助文件 | 有 | 有，需要时才读 |
| 上下文开销 | 用到之前只占描述 | 每个会话都有正文；没有原生 rule 的工具在 SessionStart 时整段注入 |

正文写短，细节放进目录。

- 名字就是路径，和 rule 文件一样：`rules/api-style/` 是 `api-style`，`rules/fe/api-style/` 是 `fe/api-style`。每个工具的 rules 目录里得到 `api-style.md`。
- `RULE.zh.md` 或 `RULE.en.md` 是对应 `language` 的正文。`RULE.md` 的 frontmatter 对所有语言生效；语言版本里的 frontmatter 会被忽略，pull 会给出警告。
- 在工作区中，pull 把目录复制到每个 worktree 的 `.teamai/delivered/rules/api-style/`（git 会忽略它），并把 `${TEAMAI_RULE_DIR}` 换成它的路径（用正斜杠）。所有工具都从这里读取：Claude Code 得到绝对路径，不读取项目之外文件的工具得到从项目根目录算起的 `.teamai/delivered/rules/api-style`。在一个 worktree 里 pull，不会改动其他 worktree 的目录。
- 用户范围的 rule 没有工作树，所以 pull 把它复制到 `~/.teamai/rules/api-style/` 并指向该路径。对 Claude Code，pull 会把该目录追加到 `~/.claude/settings.json` 的 `permissions.additionalDirectories`，排在你自己的条目之后，uninstall 时移除。对其他读取那里前可能需要确认的工具，pull 各警告一次。哪个工具得到哪种，见[工具支持](tool-support.md#用户范围)的「规则文件夹的文件」一列。
- 目录型 rule 在团队仓库里修改。push 不会从它的交付副本提出任何改动。
- 团队从目录里删掉的文件，会一直留在交付的副本里，直到这条 rule 被移除，因为你改过的 rule 副本可能还引用它。同一个路径不能既是文件又是目录：团队把 `details/` 改成文件 `details`（或反过来）时，新版本占用这个路径，pull 会说明哪个文件被移除了。

提交目录型 rule 之前，让每位成员先升级。旧版 teamai 会把 `rules/api-style/` 里的每个文件各自当作一条始终生效的 rule（`api-style/RULE`、`api-style/RULE.zh`、`api-style/checklist`），或者跳过这个目录。

teamai 的 recall rule 是目录 [`rules/teamai-recall/`](https://github.com/Tencent/teamai-cli/tree/main/rules/teamai-recall)。团队在团队仓库根目录放自己的 `rules/teamai-recall/` 即可替换它。目录里的 README 列出了各个文件以及每个文件必须保留的行。缺少这些行或包含链接的替换会被 pull 拒绝，pull 会指出是哪个文件，并继续使用 teamai 自带的。`teamai review --branch` 会在合并前把这样的替换判为失败。

## Agents

`agents/<name>.yaml`。`name` 与文件名一致。自己 commit，或在工具里改完后 `teamai push`。

```yaml
# agents/code-reviewer.yaml
name: code-reviewer
description: Review a change before it is pushed
instructions: |
  Read the diff and comment on correctness, tests, and risks.
tools: [Read, Grep]
targets: [claude, cursor]
```

`targets` 不写就发给所有已安装的工具。只给一个角色时放到 `agents/<namespace>/`，并在 `resources.agents` 里声明。

```bash
teamai push
teamai push --role frontend
teamai remove agents code-reviewer
```

### 替换 recall agent

[recall](knowledge.md#开启--关闭-recall) 开着时，teamai 会装上自己的 `teamai-recall` agent。团队同名的 agent 会替换它，就像团队工作流替换[默认工作流](workflow.md#默认工作流)。放在 `agents/` 下给所有人，放在 `agents/<namespace>/` 下只给一个角色：

```yaml
# agents/frontend/teamai-recall.yaml
name: teamai-recall
description: Search the team knowledge base for a frontend task and return doc_ids
tools: [Bash, Read, Grep, Glob]
instructions: |
  Run `teamai recall --caller teamai-recall "<task>"` and read the top three hits.
  For each component the task names, grep src/design-system/ and its Storybook stories.
  Return at most ten lines: doc_ids, file paths, and the one rule that applies.
```

每次调用 `teamai recall` 都带上 `--caller teamai-recall`，和 teamai 自带的 agent 一样：这样 agent 打开的文档才会记到 recall 上。

```console
# frontend 角色的成员
$ teamai pull
✔ [workspace] Synced 1 agents
$ head -3 .claude/agents/teamai-recall.md
---
name: teamai-recall
description: Search the team knowledge base for a frontend task and return doc_ids

# backend 角色的成员仍是 teamai 自带的
$ head -3 .claude/agents/teamai-recall.md
---
name: teamai-recall
description: >-
```

团队文件存在之后，在工具里改副本再 `teamai push`，和其他团队 agent 一样。对 teamai 自带副本的修改永远不会被推送，所以第一个版本要以 commit 的形式进团队仓库。删掉这个文件，下一次 `pull` 会装回 teamai 自带的 agent。recall 关着时，两者 pull 都不装。

`pull` 按工具自己的格式写入它的 agents 目录：Codex 系列是 `<name>.toml`，Copilot 是 `<name>.agent.md`，Kiro 是 `<name>.json`，其余是 `<name>.md`。Trae 和 Trae CN 只在 Beta 设置“启用 Subagents 目录”打开时加载 `.trae/agents`，且只接受自己的模型 id，所以它们的副本不写 agent 的 `model`。Trae CN 在 `~/.trae-cn/agents` 的用户副本会写别名或 `tool_extras.trae-cn` 给出的模型。项目的 `.trae/agents` 两个版本都会读，所以从不写 `model`，其他键则同时取自 `tool_extras.trae` 和 `tool_extras.trae-cn`；两个版本给同一个键不同的值时，该 agent 在那里会被跳过，并给出点名该键的警告。`push` 会拒绝在该文件里修改或删除另一个版本给出的键。

Antigravity 的副本不带团队的 `model`（agy 会跳过它不认识模型的 agent），只写别名为 agy 映射的模型；工具名换成 agy 自己的：`tools: [Bash, Read]` 变成 `run_command`、`view_file` 和 `read_file`。没有这些，agy 的 subagent 就没有 shell。项目里的 `.agents/agents` 归 agy，所以装了 agy 时 Muse Code 不在那里写副本。CLI 和 Antigravity 2.0 把 agent 当作 subagent 运行；Antigravity IDE 没有 subagent，装了 CLI 时它的模型只能把活交给 `agy --agent <name>`。

self 模式下，已放入命名空间的 agent 的根目录副本会推送到放置后的文件。把它从 `.md` 转为 `.yaml` 会移除原文件，即使当前检出落后于自己已合并的 PR 也是如此。两种情况下，TeamAI 都会把放置后的文件与你上次合并的推送写入的 blob 对比。团队之后又编辑过该文件时，推送会停止并给出 `teamai push --carried <path>@<blob>` 命令。把这次修改带入根目录副本，再运行该命令。该选项只接受这一版本，直接重试或团队之后再次编辑都会再次停止推送。团队已删除的 agent 不会从根目录副本重新添加。没有 blob 的旧放置记录，只有在检出落后于团队修改时才能发现这次修改；你通过它推送的第一次编辑合并后，该记录会补上这次的 blob。

### 模型别名

`model: strong` 这类名字在 `models/aliases.yaml` 里按工具对应到具体模型：

```yaml
aliases:
  strong:
    claude: { model: opus, effort: high }
    codex: { model: gpt-6-sol, effort: high }
  fast:
    claude: haiku
```

别名以小写字母开头，后面可以是小写字母、数字或 `-`。某个 namespace 要换一套时，写 `models/<ns>/aliases.yaml`。

## Env、hooks 与 MCP server 按 namespace 划分

根目录的文件给所有人。`resources:` 里声明的 namespace 只给激活了它的成员，并替换根目录里的同名条目。

```text
env/env.yaml              hooks/hooks.yaml              mcp/mcp.yaml
env/<ns>/env.yaml         hooks/<ns>/hooks.yaml         mcp/<ns>/mcp.yaml
```

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      env: [checkout]
      hooks: [checkout]
      mcp: [checkout]
```

## Env（环境变量）

```bash
teamai env add API_ENDPOINT https://api.example.com --description "团队 API 地址"
teamai env add API_ENDPOINT https://checkout.internal --project checkout
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai push
```

```yaml
# env/env.yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: 团队 API 地址
```

```yaml
# env/secrets.yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope
    url: https://github.com/settings/tokens
```

密钥的值不进仓库。每人在自己机器上：

```bash
teamai env set GITHUB_TOKEN
teamai env exec -- gh pr create
```

### 按目录加载 Shell 环境变量

shell 获得其启动目录的团队环境变量，因此同时打开的多个项目各自拿到自己的。`teamai pull` 会在 shell 配置文件中加入一个区块（zsh 为 `.zshenv`，bash 为 bash 启动文件）。交互式 shell 在 `cd` 时切换环境变量，离开项目时恢复你自己的值。

- 在项目中：加载该项目的环境变量。设置 `inheritUserScope: true` 时也加载用户级 scope 的变量，但项目声明的键以项目为准，用户级 scope 的密钥始终不会加载。
- 在包含已初始化仓库的 workspace 中：加载它自己的环境变量加上这些仓库的。两者取值不同的键会被暂缓（held）：之前安装的值保持不变，`pull` 会指出它。
- 尚未被 pull 登记的项目：什么都不加载，直到你在那里 pull。
- 其他位置：加载用户级 scope 的环境变量。
- git 无法读取仓库时（未安装 git、`.git` 损坏、`safe.directory`）：什么都不加载。

`injectShellProfile: false` 会为该团队的 scope 关闭此功能。

限制：

- 只有 bash 和 zsh 按目录加载环境变量。在 fish、PowerShell 或不启动这两种 shell 的工具中，请通过 `teamai env exec --` 运行命令。
- 团队环境变量不能设置控制 shell 或 loader 的名称，例如 `BASH_ENV`、`HOME`、`IFS`、`PROMPT_COMMAND`，或以 `__TEAMAI_` 开头的名称。pull 会警告并忽略它们。
- `teamai doctor` 会检查在此目录启动的 shell 是否加载了本 scope 的环境变量。

## Hooks

`teamai init` 会装上这些内置 hook：

| 事件 | 做什么 |
|------|--------|
| `SessionStart` | 拉取团队资源，并记下会话开始 |
| `PostToolUse` | 记录 skill 使用。recall 开着时，`TodoWrite` 调用之后提醒 agent 用 `teamai-recall` |
| `UserPromptSubmit` | 记录输入 |
| `Stop` | 检查 CLI 更新，并记下会话结束 |

在 macOS 和 Linux 上，工具调用和输入提示只在可能有东西要输出时才等 teamai：`TodoWrite` 调用（要完整运行才知道该不该提醒；recall 关着时不提醒，什么也不输出），或者有提示留给它、或在通过 HTTP 同步的机器上的输入提示。其他时候 hook 启动一个后台进程就返回，由这个进程记下事件。`~/.teamai/debug.log` 里能看到走的是哪条路：

```text
2026-11-09T09:14:02.118Z [DEBUG] [hook-dispatch] post-tool-use/claude fast path
2026-11-09T09:14:02.161Z [DEBUG] [hook-dispatch] post-tool-use/claude background: 16ms total, 5 handlers, slowest dashboard-report=15ms | dashboard-report=15ms(ok) local-agent-sync=13ms(ok) recall-attribution=12ms(ok) skill-use=9ms(ok) new-checkout=8ms(ok)
2026-11-09T09:14:09.530Z [DEBUG] [hook-dispatch] prompt-submit/claude fast path
2026-11-09T09:14:09.571Z [DEBUG] [hook-dispatch] prompt-submit/claude background: 13ms total, 2 handlers, slowest dashboard-report=13ms | dashboard-report=13ms(ok) skill-mention=12ms(ok)
```

在任何 teamai 作用域之外的目录里，后台进程停在 `[hook-dispatch] post-tool-use/claude no scope`。

```bash
teamai hooks list
teamai hooks inject --dry-run
teamai hooks inject
teamai hooks remove
```

只处理已经安装的工具。

团队 hook 以目录形式 commit：`HOOK.yaml` 和它要运行的脚本放在一起。目录名就是 hook 的 id，只用小写字母、数字和 `-`。

```text
hooks/block-secrets/
├─ HOOK.yaml
└─ scan.sh
```

```yaml
# hooks/block-secrets/HOOK.yaml
description: Scan for secrets before a commit
event: PreToolUse
matcher: Bash
command: bash "${TEAMAI_HOOK_DIR}/scan.sh"
timeout: 15
```

pull 会复制这个目录，并把 `${TEAMAI_HOOK_DIR}` 换成它的路径（用正斜杠）。teamai 不加引号，命令需要时自己给变量加引号。目录名由 hook 的 id 和从目录里所有文件（包括 `HOOK.yaml`）得出的版本组成（下面的 `e246f037`），所以任何文件变了，目录就会变，同一个版本的文件永远不变。同一个 commit 的每个 checkout 得出的版本都一样：文件按 git 存储的内容计入，所以换行符、编码和磁盘上的可执行位都没有影响；git 忽略的文件（例如 `__pycache__/`）既不计入也不复制。新文件或改过的文件按磁盘上的内容计入。目录里有 git submodule 或独立的 git 仓库时，pull 会拒绝这个目录，因为那些文件不属于团队仓库：请把它们直接提交到团队仓库。pull 没能改写配置的工具，或成员排除的工具，会继续运行写入配置时的那些文件；等没有条目再运行那个目录，它就会被移除：

| 团队在哪里 | 目录复制到 |
|---|---|
| 用户作用域 | `~/.teamai/hooks/block-secrets.e246f037/` |
| 有团队仓库的工作区 | `~/.teamai/projects/<slug>/hooks/block-secrets.e246f037/`，所有 worktree 共用一份，因为它们运行同一组 hook 条目 |
| self 模式 | 每个 worktree 的 `.teamai/delivered/hooks/block-secrets.e246f037/`，git 会忽略它 |

self 模式下，Claude Code 的命令写成 `"$CLAUDE_PROJECT_DIR/.teamai/delivered/hooks/block-secrets.e246f037/scan.sh"`，所以每个 worktree 的 `.claude/settings.json` 都一样。只改一个脚本也会让目录换成新版本，pull 会改写 `.claude/settings.json` 里的这个路径：团队如果提交这个文件，也要一起提交这个改动。其他工具拿到的是 worktree 的绝对路径，所以它们的项目文件在每个 worktree 里都不一样。以 Cursor 的 `.cursor/hooks.json` 为例：

```text
~/work/shop/.cursor/hooks.json         bash "/Users/ana/work/shop/.teamai/delivered/hooks/block-secrets.e246f037/scan.sh"
~/work/shop-hotfix/.cursor/hooks.json  bash "/Users/ana/work/shop-hotfix/.teamai/delivered/hooks/block-secrets.e246f037/scan.sh"
```

删除一个 worktree 后，下次在另一个 worktree 里 pull，或运行 `teamai doctor --fix`，会删掉它留在 HOME 里的条目。`HOOK.yaml` 的键和 `hooks.yaml` 的条目相同，只是没有 `id`、`roles` 和 `projects`。只给一个 namespace 的 hook 放在 `hooks/<ns>/<id>/`。

简短的 hook 仍可写在 `hooks/hooks.yaml`，是带 `id` 的同样键的列表。`${TEAMAI_HOOK_DIR}` 只能用在目录里：写在 `hooks.yaml` 里，这次运行的团队 hook 会全部停下；同一个 id 既是 `hooks.yaml` 条目又是目录时也一样。分支上有这两种情况之一，或有解析不了的 `HOOK.yaml` 时，`teamai review --branch` 判定失败。`builtin` 只放在根文件里，用来关掉某条内置 hook，或改它的超时。

```yaml
hooks:
  - id: block-secret
    description: 提交前扫描密钥
    event: PreToolUse
    matcher: Bash
    command: bash ~/.teamai/team-scripts/scan-secret.sh
    timeout: 15
    tools: [claude, cursor]

builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]   # 不要 TodoWrite 提醒
  overrides:
    Hook dispatch stop: { timeout: 30 }
```

每次工具调用只跑一条 `PostToolUse` 条目 `Hook dispatch post-tool-use wildcard`，`TodoWrite` 提醒也在里面跑。在 macOS 和 Linux 上，Claude Code 2.1.119 及以上时，`~/.claude/settings.json` 里这个 key 写成两条：一条给除 `TodoWrite` 以外的所有工具，Claude Code 不等它；另一条给 `TodoWrite`，让提醒在同一轮就到 agent。低于 2.1.119 或读不到版本时，单条条目通过 `~/.teamai/bin/teamai` 启动 teamai，加载你的 profile 和团队 env 的 login shell 只在后台进程里运行；没有这个文件时照旧运行。`~/.claude/settings.json` 里的 `UserPromptSubmit` 条目在任何版本下都这样启动 teamai；在 teamai 从 login shell 里确认这个会话的目录不走 HTTP 同步之前，提示仍在 login shell 里应答。仓库里的 `.claude/settings.json` 仍是单条。`~/.codex/hooks.json` 仍是单条：teamai 找到的每个 Codex 构建（PATH 上的 `codex` 和桌面应用自带的）都在 0.148.0 及以上时，Codex 不等它；否则它像上面那样通过 `~/.teamai/bin/teamai` 启动 teamai，那里的 `UserPromptSubmit` 条目在任何版本下都这样启动。`claude-internal` 和 `tclaude`、`codex-internal` 和 `tcodex` 的 hook 文件，在任何版本下都采用其原版工具低于上述版本时的形式。在 Windows 上，这些文件都保留单条、等待的条目。把任一工具升级或降级跨过这些版本后，下一次会话启动或 `teamai pull` 会改写这条。禁用这个 key 或给它设超时，两条都生效。把 `Hook dispatch post-tool-use TodoWrite` 写进 `disabled` 仍然会关掉提醒。给这个 key 设超时不起作用，`teamai doctor` 会提示。

只给一个项目时写到 `hooks/<ns>/hooks.yaml`。

团队可以共享的四个 hook。hook 从 stdin 读到 Claude Code 的 JSON payload。

```yaml
hooks:
  # 拒绝 force push，并告诉它改用什么。
  - id: no-force-push
    description: 拒绝 git push --force
    event: PreToolUse
    matcher: Bash
    command: >-
      jq -r '.tool_input.command' | grep -Eq 'git push.* (-f|--force)( |$)'
      && { echo 'Use git push --force-with-lease' >&2; exit 2; } || true

  # 已发布的 migration 只能追加。
  - id: no-migration-edits
    description: 不改已发布的 migration
    event: PreToolUse
    matcher: Edit|Write
    command: >-
      jq -r '.tool_input.file_path // empty' | grep -q '/db/migrations/'
      && { echo 'Add a new migration instead: make migration name=...' >&2; exit 2; } || true

  # 每个会话都知道发布冻结。
  - id: release-freeze
    description: 通知发布冻结
    event: SessionStart
    command: echo 'Release freeze until Friday 18:00 UTC. Only hotfix/* branches merge to main.'

  # 格式化 agent 写的文件。
  - id: format-on-write
    description: 对改过的文件跑 Prettier
    event: PostToolUse
    matcher: Edit|Write
    command: >-
      f=$(jq -r '.tool_input.file_path // empty');
      [ -n "$f" ] && npx --no-install prettier --write "$f" >/dev/null 2>&1; true
```

hook 能做什么取决于事件。下表是每个运行该事件的工具都做得到的；Claude Code 能做的更多，比如 `UserPromptSubmit` hook 以 exit 2 退出时会拒绝这次输入：

| 事件 | exit 2（原因写到 stderr） | stdout |
|------|---------------------------|--------|
| `PreToolUse` | 拦下这次工具调用 | — |
| `SessionStart`、`UserPromptSubmit` | — | 加进 agent 的上下文 |
| `PostToolUse`、`Stop` | — | — |

`teamai hooks list` 列出每条团队 hook 在哪些工具里运行：

```text
  [no-force-push] PreToolUse [Bash]  →  jq -r '.tool_input.command' | grep -Eq 'git push.* (-f|--force)( |$)' && { echo 'Use git push --force-with-lease' >&2; exit 2; } || true  (tools: all)  from root
      runs in: claude, omp, opencode
      not in: cursor (no PreToolUse hook there)
```

OpenCode、Oh My Pi、Pi、OpenClaw、Kiro、Hermes 和 Antigravity 没有 Claude Code 那样的 hook 文件，它们的 hook 由 teamai 来跑，payload 和工具名都按 Claude Code 的（`matcher: Bash` 能匹配 OpenCode 的 `bash` 和 Hermes 的 `terminal`）。在这些工具里：

- 只跑 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse` 和 `Stop`。其他事件上的团队 hook，pull 会警告。
- `UserPromptSubmit` 能加上下文，但拦不下这次输入。
- Oh My Pi 最多等 `PreToolUse` hook 25 秒，更慢的 hook 拦不下这次调用。Hermes 的 hook 最多跑 300 秒。
- OpenClaw 和 Hermes 在会话的第一条输入时跑 `SessionStart`。OpenCode、Oh My Pi 和 Pi 每次请求都会重建系统提示词，所以从第二次请求起每次都再跑一遍 `SessionStart`，它的输出会跟着 `UserPromptSubmit` hook 的改动走（比如 `/ponytail lite` 设了级别，下一轮就能看到）。
- OpenClaw 从 `openclaw.json` 的 `plugins.load.paths` 加载 teamai 的插件。如果 `plugins.allow` 没列它，pull 会警告，hook 不会运行。
- teamai 按 OpenClaw 的方式读 `openclaw.json`，带注释也能读，所以会跟着里面设的工作区走。teamai 只在它是纯 JSON 时才改写它；带注释的文件不会被改动，pull 会打印需要你手动加的那一行：

  ```json5
  // ~/.openclaw/openclaw.json
  {
    agents: { defaults: { workspace: "~/work/team-ws" } }, // teamai 把 AGENTS.md 写到这里
    plugins: { load: { paths: ["/Users/ana/.openclaw/teamai/teamai-team-hooks.mjs"] } }, // 手动加
  }
  ```

```yaml
sharing:
  hooks:
    autoApply: false          # pull 只提示，要自己跑 teamai hooks inject
    requireTeamScripts: true  # command 必须从它的 hook 目录或 ~/.teamai/team-scripts/ 运行
```

`requireTeamScripts` 保留 `command` 原文里用到 `${TEAMAI_HOOK_DIR}` 的目录 hook，以及 `~/.teamai/team-scripts/` 下的命令，其余的（比如 `curl … | sh`）都丢掉。它检查脚本的来源是经过评审的团队仓库，不是沙箱：脚本以你的权限运行。

本机全部停用团队 hook：`TEAMAI_HOOKS_DISABLED=1`。

Antigravity 也会运行这些 hook（CLI、Antigravity 2.0 和 Antigravity IDE 都一样），经由 teamai 写在 `~/.gemini/config/hooks.json` 里的 hook。hook 收到的是 Claude Code 的 payload（`tool_name: Bash`、`tool_input.command`），退出码 2 会拦下这次调用，所以同一个 hook 两个工具都能用：

```yaml
hooks:
  - id: block-rm-rf
    description: Block recursive deletes
    event: PreToolUse
    matcher: Bash
    command: 'grep -q "rm -rf" && { echo "rm -rf is blocked; run git clean -n first." >&2; exit 2; } || exit 0'
    tools: [claude, agy]
```

agy 随后拒绝该命令：`tool call denied by pre-tool hook: rm -rf is blocked; run git clean -n first.`

### 默认 hook

teamai 自带提示的阈值和文案也放在 hook 目录里。在团队仓库根目录放一个同名目录，就能替换它。比如只在较长的会话后提醒，并换成团队自己的话：

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-friction-reminder" hooks/
```

```yaml
# hooks/teamai-friction-reminder/HOOK.yaml
description: Remind after longer sessions only
with:
  min_tools: 30
```

```markdown
<!-- hooks/teamai-friction-reminder/problem.md -->
[acme] 这次会话卡住过。如果解决办法还不在 runbook 里，记下来。
```

`teamai pull` 之后，提醒要等到 30 次工具调用才出现，并以这一行开头。

| 目录 | 放什么 |
|---|---|
| `teamai-friction-reminder` | 摩擦提醒：Stop 时提醒分享这次会话学到的东西，含阈值、评分权重、文案 |
| `teamai-mr-hint` | 会话开始时查找、提议导入最近合并的 MR：往回看多久、列几个、文案 |
| `teamai-todowrite-hint` | 任务规划好后，建议先查一次团队知识 |
| `teamai-env-hint` | 会话开始时说明这个作用域有哪些团队环境变量和密钥 |
| `teamai-package-hint` | 会话开始时说明团队的包声明变了 |

- `HOOK.yaml` 里有 `description` 和 `with:`。`with:` 里没写的键沿用 teamai 的值。
- 文案是 `<text>.md`，用 `{{ name }}` 引用变量。设了 `language: en` 或 `zh` 时，目录里有 `<text>.en.md` 或 `<text>.zh.md` 就用它。
- 每个目录的 `README.md` 列出参数及取值范围、每段文案提供的变量，以及关掉它的设置。这些设置还在原来的位置，比如 `sharing.contributeHint.enabled`。

替换目录里的值超出范围、写了默认 hook 不认的键、引用了文案不提供的变量、少了某段文案，或带了 `command` 时，pull 会拒绝它，teamai 自带的目录继续生效：

```text
hooks/teamai-friction-reminder/ is refused, and teamai's default stays in force until it is fixed: HOOK.yaml: with.min_tools must be a whole number from 1 to 1000
```

替换对整个团队生效，所以放在 namespace 里的替换（比如 `hooks/payments/teamai-friction-reminder/`）会被 pull 拒绝。`teamai review --branch` 会在合并前把 pull 拒绝的替换判为失败。

## MCP Server

团队自己写的 server 以目录形式 commit：`MCP.yaml` 和它要运行的文件放在一起。目录名就是 server 的名字，只用字母、数字、`-` 和 `_`。

```text
mcp/jira-lite/
├─ MCP.yaml
├─ server.py
└─ queries.sql
```

```yaml
# mcp/jira-lite/MCP.yaml
description: Read-only Jira lookups for the team
transport: stdio
command: uv
args: ["run", "--script", "${TEAMAI_MCP_DIR}/server.py"]
requires: [uv]
```

```python
# mcp/jira-lite/server.py
# /// script
# dependencies = ["mcp==1.2.0", "httpx==0.27.2"]
# ///
```

pull 会复制这个目录，并把 `command`、`args` 和 `env` 里的 `${TEAMAI_MCP_DIR}` 换成它的路径（用正斜杠）。teamai 不加引号。目录名由 server 名和从目录里所有文件（包括 `MCP.yaml`）得出的版本组成（下面的 `1702782c`），所以任何文件变了，目录就会变，同一个版本的文件永远不变。和 hook 一样，同一个 commit 的每个 checkout 得出的版本都一样。pull 没能改写 MCP 文件的工具，或成员排除的工具，会继续启动写入配置时的那些文件，即使 `args` 用到的团队变量变了也一样；等没有 MCP 文件再引用那个目录，它就会被移除：

| 团队在哪里 | 目录复制到 |
|---|---|
| 用户作用域 | `~/.teamai/mcp/jira-lite.1702782c/` |
| 工作区（有团队仓库或 self 模式） | 每个 worktree 的 `.teamai/delivered/mcp/jira-lite.1702782c/`，git 会忽略它 |

Claude Code 不会展开 `.mcp.json` 里的 `$CLAUDE_PROJECT_DIR`，所以各工具的 MCP 文件写的是 worktree 的绝对路径，每个 worktree 都不一样。在一个 worktree 里 pull，不会改动其他 worktree 的 server。

`MCP.yaml` 的键和 `mcp.yaml` 里的 server 相同，只是没有 `name`、`roles` 和 `projects`，而且只能是 `transport: stdio`：URL server 不带文件，所以 `http` 和 `sse` server 留在 `mcp.yaml`。只给一个 namespace 的 server 放在 `mcp/<ns>/<name>/`。`${TEAMAI_MCP_DIR}` 只能用在目录里：写在 `mcp.yaml` 里，这次运行的团队 MCP 会全部停下，已安装的保持不变；同一个名字既是 `mcp.yaml` 里的 server 又是目录时也一样。分支上有这两种情况之一，或有 pull 读不了的 `MCP.yaml` 时，`teamai review --branch` 判定失败。

teamai 不安装依赖。目录可以用下面三种方式带上依赖：

| 方式 | `command` 和 `args` | 目录里放什么 |
|---|---|---|
| PEP 723 脚本 | `uv`，`["run", "--script", "${TEAMAI_MCP_DIR}/server.py"]` | `server.py`，固定版本的依赖写在文件头里 |
| 一个打包好的 `.mjs` | `node`，`["${TEAMAI_MCP_DIR}/server.mjs"]` | `server.mjs`，依赖已打包进去 |
| 固定版本的 runner | `npx`，`["-y", "@acme/jira-mcp@1.4.0", "--config", "${TEAMAI_MCP_DIR}/config.json"]`，或用 `uvx` 加 `jira-mcp==1.4.0` | 只放配置和数据文件 |

`requires` 写成员 PATH 上需要有的 runner。缺少其中一个的成员拿不到这个 server，`teamai mcp inject` 会说出缺的是哪个。设置了 `sharing.mcp.allowedCommands` 时，要把 runner 写进去，因为它就是 server 的 `command`：

```yaml
# teamai.yaml
sharing:
  mcp:
    allowedCommands: [uv, node, npx]
```

commit server 目录之前，先让每位成员升级。读不了 MCP 目录的 teamai 会跳过它们，这些成员就拿不到这个 server。

运行已发布的包或 URL 的 server 可以继续写在 `mcp/mcp.yaml`。Muse 保存 stdio server 时可能省略 `type`。pull 和移除操作会兼容这种格式；其他 server 发生变化时，个人 server 和未变更的受管条目保持原样。

```yaml
# mcp/mcp.yaml
servers:
  - name: gpu-analysis
    description: GPU 存量与价格查询
    transport: http
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000
  - name: local-formatter
    transport: stdio
    command: npx
    args: ["-y", "@acme/formatter-mcp"]
    env:
      FORMATTER_MODE: strict
    requires: [npx]
    tools: [claude, cursor]
```

密钥写 `${VAR}`，并在 `env/secrets.yaml` 里声明。只给一个项目时，写到 `mcp/<ns>/mcp.yaml`。


OpenCode 的 `opencode.json`、Cursor 的 `mcp.json` 和 `hooks.json`、CodeBuddy 的 settings 和 MCP 文件、Qoder 的 `settings.json` 以及 Pi 的 `models.json` 可以带注释，因为这些工具本身就这样读。teamai 按同样的方式读，只改自己的条目：你写的行和注释保持原样。下面是 pull 上面的 `local-formatter` server 之后的 `~/.config/opencode/opencode.json`：

```jsonc
{
  "mcp": {
    "notes": { "type": "local", "command": ["notes-mcp"], "enabled": false }, // 等 API key 到了再开
    "local-formatter": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@acme/formatter-mcp"
      ],
      "enabled": true
    },
  },
}
```

团队去掉 `local-formatter` 后，下一次 pull 只删掉它那几行，`notes` 和它的注释保持不变。Claude Code、Codex、Muse 等工具不接受带注释的文件，teamai 也一样：pull 会警告文件无法解析，不改动它。

stdio server 的 `env` 键在 Codex TOML 中保持原样：`HTTP.PROXY` 是一个变量，`ProgramFiles(x86)` 等名称会自动加引号。

Codex MCP 表头中的 `mcp_servers` 键可以不加引号，或使用单引号、双引号，子表也一样。引号不影响 teamai 判断应更新哪个服务器，或保留哪个成员自有服务器。

ZCode 的 server 写入 `~/.zcode/cli/config.json` 或项目的 `.zcode/config.json`，位于 `mcp.servers` 下。这基于 3.16.2 源码，尚未认证 3.15.1。Pull 只从 `~/.agents/mcp.json` 移走未被修改的 teamai 条目。原生配置中有 server 后，桌面应用不再读取该备用文件，doctor 会列出其中的其他 server。

Antigravity 的用户级 server 写入 `~/.gemini/config/mcp_config.json`。项目级 server 它只从插件读取，所以 teamai 把它们写成一个插件：

```text
.agents/plugins/teamai/plugin.json       {"name": "teamai"}
.agents/plugins/teamai/mcp_config.json   {"mcpServers": {"github": {"url": "https://api.githubcopilot.com/mcp/", "headers": {...}}}}
```

agy 支持 stdio 和 HTTP server，不写 `type`；`sse` server 不会写给 agy，pull 会给出警告。`agy mcp list` 只显示用户文件里的 server，插件里的 server 在会话中可用。

WorkBuddy 按顺序使用第一个已存在的用户文件：活根下的 `.mcp.json`、`mcp.json`（活根是 `.workbuddy/` 还是 `.workbuddy-ai/`，见下），然后是 `~/.codebuddy.json`。`CODEBUDDY_CONFIG_DIR` 会移动最后一个文件。项目使用 `.mcp.json`，仅有 `mcp.json` 时使用后者。开启 `sharing.gitExclude` 后，server 写入 `.codebuddy.json` 的 `projects[<项目路径>].mcpServers`。这些路径基于 CodeBuddy 2.168.0 引擎，尚未认证 WorkBuddy 启动器的主目录绑定。Pull 只从旧项目文件 `.workbuddy/mcp.json` 移除未被修改的 teamai 条目。

WorkBuddy 的用户文件写到**最后启动的那个 app** 的数据根 —— `.workbuddy/`，或 WorkBuddy AI（国际版）的 `.workbuddy-ai/` —— 依据两个根各自的 `last-launch.json`：技能、规则、团队指令、agent 和 MCP 文件都跟随。目录存在本身不作数，因为卸载任一 app 都会把自己的根留下；两边都没有记录时沿用旧规则，即存在 `.workbuddy-ai/` 就换路径。项目作用域只换技能，团队 `userScope` 覆盖保留它指定的目标，`settings.json` 与钩子仍留在 `.workbuddy/`，`teamai doctor` 以活根作为安装凭据。

工具主目录或配置的 MCP 路径改变时，pull 保留旧副本并提示一次。确认没有工具读取后再删除。Doctor 会报告工具不读取的映射、已移动的文件，以及仅在项目根目录启动会话时才读取的项目 MCP。MCP 通道未知的内部版本只显示提示，不猜测配置路径。

在包含已初始化仓库的 workspace 中，Claude Code、CodeBuddy 和 WorkBuddy 通过各自的 local scope 而不是项目 MCP 文件获得这些 server，所以在其中某个仓库里启动的会话不会加载它们。在 self 模式下，或 tclaude、Muse Code 读取该文件时，Claude Code 的 server 仍留在其中，这样的会话会加载它们。

```bash
teamai mcp list
teamai mcp inject
teamai mcp remove
```

`mcp inject` 和 `mcp remove` 遇到无法读取或解析的工具配置时返回退出码 1，`--dry-run` 也一样，包括 Codex 的 `config.toml` 存在 TOML 语法错误的情况；文件开头的 UTF-8 BOM 可以正常处理。其他工具仍可能更新；命令会列出这些变更，并报告操作未完成。修复警告中指出的配置后，重新运行该命令。无法读取的配置及其归属记录会保留，供重试使用。`uninstall` 同样保留归属记录并返回退出码 1，直到配置修复后重试。

Muse 调整 JSON 对象的键顺序不会被视为个人修改。移除时会核对记录的内容（包括嵌套对象），仍会保留实际修改过命令、参数或环境变量的 server。旧记录如果没有内容指纹，需要团队 Git 历史中与原 hash 匹配的定义作为依据；无法证明时会保留 server 并提示。

## 模型

`models/models.yaml` 自己 commit。密钥留在每人自己的机器上。只给一个项目时写 `models/<ns>/models.yaml`。

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

```bash
teamai models switch tokenhub
```

## 从工作流步骤提议文件

带 `workspace: { team: { branch } }` 的步骤在团队仓库的全新克隆里运行，`deliver: pr` 把它在那里的改动作为一个拉取请求提议。这个工作流按字节原样提议一个评分器文件：

```yaml
schemaVersion: v1alpha1
name: propose-scorer
description: Propose one scorer file to the team as a pull request, on a branch of its own.
inputs: { file: string, name: string }
steps:
  - id: propose
    workspace: { team: { branch: "teamai/scorers/{{ inputs.name }}" } }
    deliver: pr
    command: mkdir -p scorers && cp "$FILE" "scorers/$NAME.md"
    env: { FILE: "{{ inputs.file }}", NAME: "{{ inputs.name }}" }
```

```text
teamai workflow start propose-scorer --driver local --inputs '{"file":"/tmp/review.md","name":"review"}'
  第一次运行                       从 teamai/scorers/review 打开 "propose-scorer: scorers/review.md"
  改了 /tmp/review.md 再运行       更新那个拉取请求
  main 已有相同字节                什么也不推送，不打开拉取请求
  name 为 "../review"              在克隆之前失败：git 无法用它命名分支
```

提交必须是 `teamai pull` 会接受的；拒绝哪些改动见[团队工作区](workflow.md#团队工作区)。[teamai-session-to-task](benchmarks.md#把会话变成任务) 就是这样提议它起草的任务文件。

## 团队包

```bash
teamai packages install typescript
teamai packages install code-review@claude-plugins-official
teamai push
```

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

pull 之后跑 `teamai packages`。

## 会话

无人值守的运行现在默认发布自己的会话。在 CI、云虚拟机或托管任务中，[`teamai score --drain`](scorers.md#无人值守任务结束前运行-drain) 会通过一次 `teamai-finished-sessions` 运行，把本机记录为无人值守的已捕获会话，以及在这里驱动的工作流运行的步骤会话，脱敏后归档到 `teamai-reports`。本地驱动在无人值守运行结束时执行它。要保持原来的行为，设置 `unattended: off`：

```yaml
# teamai.yaml
sessions: { publish: { unattended: off } }
```

`sessions.publish` 按运行模式分别取 `off`、`ask` 或 `auto`。下面写出的是默认值：

```yaml
# teamai.yaml
sessions:
  publish: { attended: ask, unattended: auto }
```

有人值守的 `ask` 会在摩擦提醒提供 [`teamai-share-learnings`](workflow.md#teamai-share-learnings-和-teamai-share-session) 时提议发布，成员在启动时确认一次。带 `--confirmed` 启动运行的 agent 可以替成员确认，teamai 无法核实。除此之外，成员的会话只会通过 `teamai session push` 等命令归档。无人值守的 `ask` 等同于 `off`，因为没有人在场确认。有人值守的 `auto` 在会话六小时没有任何活动后归档它，由会话启动时开始的 [`teamai-finished-sessions`](scorers.md#teamai-finished-sessions) 运行完成，该运行也评判已结束的会话。在结束前手动推送过的会话，在那次推送之后又有活动时会被再次归档。发布总会脱敏，同时改写本机路径（见[脱敏后的会话保留什么](dashboard.md#脱敏后的会话保留什么)）。HTTP 团队没有会话归档，因此在那里 `sessions.publish` 等同于 `off`，`teamai doctor` 会说明这一点。

成员的 `config.yaml` 优先，按模式分别生效。它没有写的模式沿用 `teamai.yaml`：

```yaml
# config.yaml
sessions:
  publish: { attended: ask }   # 只设置有人值守；无人值守仍按团队设置
```

值不是 `off`、`ask` 或 `auto` 时，`teamai doctor` 会报告它所在的文件和键，teamai 忽略该值，这种模式交给下一级。分支的 `teamai.yaml` 含有这样的值时，`teamai review --branch` 判定失败。会话是否评判由 `scorers/scoring.yaml` 中的 `sessions` 决定，见[已结束的会话](scorers.md#已结束的会话)。

## Docs（文档）

把文件放进团队仓库的 `docs/`，提交后成员 `pull` 时同步。某个目录只给一部分人时，在 `resources.docs` 里声明：

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]
```

self 模式下，如果当前分支落后于默认分支，推送修改过的 skill 会在可能覆盖主干文件时以 exit 2 停止。检查覆盖整个 skill 目录，包括参考文件和删除操作，即使本地改的是另一个文件也会检查。先合并默认分支、解决 skill 差异，再重试；已包含主干修改的副本可以正常推送。

团队在原命名空间重新加入退役 agent 后，应直接编辑该命名空间源文件，旧的平铺副本作为备份保留。删除退役的根目录副本不会把剩余工具副本变成新 agent。即使 checkout 已跟上默认分支，编辑或转换已放置的 agent 仍会检查上次投递的 blob。

## 保留的目录标记文件名

在类型目录下（任意深度）包含该类型标记文件的目录，就是一个目录型资源：它是一个资源，其中每个文件都属于它。技能也是这样，`skills/<name>/SKILL.md`。

| 目录 | 标记文件 | 当前版本 |
|---|---|---|
| `workflows/` | `WORKFLOW.yaml` | 读取：[工作流文件夹](workflow.md#工作流文件夹) |
| `hooks/` | `HOOK.yaml` | 读取：[Hooks](#hooks) |
| `rules/` | `RULE.md` | 读取：[目录型 rule](#目录型-rule确定加载的-skill) |
| `mcp/` | `MCP.yaml` | 读取：[MCP Server](#mcp-server) |
| `benchmarks/` | `SUITE.yaml` | 读取：[套件](benchmarks.md#编写套件) |
| `scorers/` | `SCORER.md` | 跳过 |
| `agents/` | `AGENT.md` | 跳过 |

scorer 或 agent 目录会被整体跳过，团队仓库的其他内容照常 pull：

```text
agents/
├── code-reviewer.yaml          交付：agent "code-reviewer"
└── reviewer/
    ├── AGENT.md                跳过：agents/reviewer/ 是 agent 目录
    └── checklist.md            跳过
scorers/
└── strict/
    └── SCORER.md               跳过：scorers/strict/ 是 scorer 目录
rules/
├── style.md                    交付：规则 "style"
└── api-style/
    ├── RULE.md                 交付：规则 "api-style"
    └── checklist.md            随目录一起交付
```

pull 对每个目录提示一次；由 hook 触发的 pull 会把同样的内容写进 `~/.teamai/debug.log`：

```console
$ teamai pull
⚠ agents/reviewer/ is an agent folder, which this teamai cannot read yet; it was skipped. Run teamai update.
⚠ scorers/strict/ is a scorer folder, which this teamai cannot read yet; it was skipped. Run teamai update.
✔ [user] Synced 2 rule(s)
```

`teamai status`、`teamai doctor`、`teamai review --branch` 和 dashboard 都会列出这些目录。push 不会改动它们，团队也不需要声明任何东西。

文件名必须完全一致：`rules/lint/rule.md` 仍然是规则 `lint/rule`，在 macOS 和 Windows 上也一样。

仓库里已经有标记文件名的，例如 `rules/onboarding/RULE.md`，之前会被当作规则 `onboarding/RULE` 交付。从这个版本起 `rules/onboarding/` 是一个目录型 rule `onboarding`，其中其他 `.md` 文件都是它的文件。pull 会删除之前交付的这些文件的副本，并提示一次：

```console
⚠ rules/onboarding/ holds RULE.md, so it is one folder, and db.md in it is one of its files, no longer read on its own.
```

要让它们继续是各自独立的规则，改掉标记文件的名字：

```bash
git mv rules/onboarding/RULE.md rules/onboarding/overview.md
git commit -m "rules: rename onboarding/RULE.md, a reserved folder marker"
```

团队提交目录型资源之前，每位成员都应升级。读不了某个类型的版本会跳过该类型的目录；比这些文件名更早的版本会把 `rules/api-style/` 里的每个文件各自当作一条始终生效的规则。
