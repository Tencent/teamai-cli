# 共享团队资源

> [English](../sharing.md) | [简体中文](sharing.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 共享团队资源

这是 Team Execution：Skills、Rules 等 Harness 定义一次，经 MR 评审后由 `teamai pull` 分发到每个 Agent。

### Skills（技能）

```bash
# 创建 skill
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
# Deploy Helper
当用户请求部署时，按以下步骤执行：
1. 检查当前分支是否为 master
2. 运行测试 `npm test`
3. 构建 `npm run build`
4. 部署 `./deploy.sh`
EOF

# 推送到团队（YAML frontmatter 会自动补全）
teamai push

# 推送到指定角色 namespace
teamai push --role pm
```

> **Frontmatter 自动补全：** 推送时 CLI 会检查 `SKILL.md` 的 YAML frontmatter（`name`/`description`），缺失则自动从目录名和内容中推导并补全。你也可以手动添加更精确的 frontmatter：
>
> ```yaml
> ---
> name: my-deploy-helper
> description: 帮助团队部署服务的自动化技能
> tags: [deploy, automation]
> ---
> ```
>
> YAML 格式损坏或 frontmatter 根节点不是 mapping 时，CLI 会保留原文并输出告警；请手动修复后再推送。

启用角色化 skills 后，push 的目标目录为：

- 默认：`skills/<primaryRole>/<skill-name>/`
- 显式覆盖：`skills/<role>/<skill-name>/`（通过 `--role`）

### Rules（规则）

带作用范围的 rule 中，YAML 注释不属于 glob：`paths: **/*.ts # TypeScript files` 的原生规则只匹配 `**/*.ts`，内联渠道也得到同样的路径提示。`paths:` 下的块列表条目同样如此。

```bash
# 创建 rule
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# 代码审查规范
- 所有函数必须有 JSDoc 注释
- 禁止使用 `any` 类型
- 测试覆盖率不低于 80%
EOF

# 推送
teamai push
```

> 管理员可在 `teamai.yaml` 中设置强制规则（`sharing.rules.enforced`），成员不可删除。

teamai 没有投递记录的 rule 文件，只有当它与团队仓库历史中该团队 rule 的某个版本相同时，才算 teamai 的。团队从未有过的名字的个人 rule 现在会被保留而不再被清理，即使在 teamai 原本会清理的目录（`.claude/rules/`、`.cursor/rules/`）中也是如此。位于团队 rule 或 agent 路径上的你自己的文件同样会被 `pull`、`teamai remove` 和 `teamai uninstall` 保留并指出（见[自动同步](./member-guide.md#自动同步)中“pull 会保留你修改过的 skill、rule 和 agent”）；`teamai remove` 和 `teamai uninstall` 只删除 teamai 的副本（在该 checkout 的记录中，或按历史是某个团队版本），并逐一指出留下的你自己的文件：

``Kept <path>: it is not teamai's (no delivery record, and it matches no team version of <resource>), so <command> left it.``只要这样的文件挡住了某个团队 rule 或 agent，每次 `pull` 都会做完整同步，而不是停在 “Already synced”，直到你重命名或删除该文件；之后的下一次 pull 就会送达团队版本。

`push` 只把 rule 的 Markdown 正文写回团队仓库。工具 rules 目录里没有对应团队 rule 的文件属于你：`pull` 会留下它，`push` 也不会把它当成新的团队 rule。旧版 teamai 原样写入的副本，若仍与当时下发的内容一致，下一次 `pull` 会改写成新格式；你改过的副本会保留并点名。

大多数工具在自己的 rules 目录中为每条 rule 得到一个文件。Codex、`codex-internal` 和 `tcodex` 不读取 rules 目录（`.codex/rules/` 存放的是 Codex 自己的 `*.rules` 命令策略文件），因此 `pull` 不为它们写任何 rule 文件。user scope 下，团队 rule 写入该工具自己的 `AGENTS.md`（`~/.codex/AGENTS.md`、`~/.codex-internal/AGENTS.md`、`~/.tcodex/AGENTS.md`；`toolRoots` 条目可改变其位置）中的 `<!-- [teamai:team-rules:start] -->` 区块，只有该工具读取这个文件。在项目中，改由它们的 session-start hook 把项目的团队 rule 加入每个会话：

项目 `AGENTS.md` 属于项目维护者，其他拥有自己 rules 格式的工具也会读取它。ZCode、DeepSeek Harness、OpenClaw、Pi 和 JoyCode 同样没有 rules 格式，在 user scope 下把同样的区块写入只有该工具读取的文件：`~/.zcode/AGENTS.md`、`$DSH_HOME/AGENTS.md`（未设置 `DSH_HOME` 时为 `~/.dsh/AGENTS.md`）、OpenClaw 工作区的 `AGENTS.md`（按其 hook 的方式查找）、`~/.pi/agent/AGENTS.md`，以及 `~/.joycode/rules.txt`。这些文件同时存放 culture、共享指令和 recall 区块。ZCode、DeepSeek Harness 和 JoyCode 的文件是固定的：它们的 `toolPaths` 条目中指向其他文件的 `claudemd` 是该工具不读取的文件，pull 会从中移除 teamai 的区块。pull 只为已安装的工具写入，项目 pull 不写这些文件。`openclaw.json` 不是纯 JSON 时（OpenClaw 读取 JSON5），teamai 无法判断 OpenClaw 使用哪个工作区，因此不写入该区块：

pull 会给出警告，`doctor` 会失败，直到该文件改为纯 JSON。在项目中，ZCode 和 DeepSeek Harness 通过与 Codex 相同的 session-start hook 得到项目的团队 rule，Pi 则通过 teamai 的 Pi 扩展得到，扩展把它们加在团队指令之后、加入每次运行的系统提示；它们在项目中都不会得到 user rule，因此在两个 scope 都安装 teamai 时，每条 rule 只送达该工具一次。ZCode 和 DeepSeek Harness 在压缩会话时会丢弃 hook 的文本，rule 要到下一个会话才回来；DeepSeek Harness 以分离方式运行该 hook，第一次请求可能错过它们；在项目中 `init` 和 `doctor` 会说明这一点。OpenClaw 不会得到项目 rule，因为它唯一的项目文件是其他工具也会读取的 `AGENTS.md`；

在项目中 `init` 和 `doctor` 会说明这一点。旧版本把 rule 复制到这些工具从不读取的 `.openclaw/rules`、`.pi/rules`、`~/.pi/agent/rules` 和 `~/.joycode/rules`：下一次 pull（即使团队版本未变）会删除仍是 teamai 所下发内容的副本，并点名你改过的副本。Hermes 的 `SOUL.md` 区块得到同样的内容，且只由 user scope 的 pull 写入：

`SOUL.md` 是全局文件，项目 pull 会让它保持 user scope pull 写入时的样子。即使团队仓库没有变化，user pull 也会重写该区块，从而修复旧版本项目 pull 覆盖过的区块。若本机没有 user scope 配置，项目 pull 会移除旧版项目 pull 留下的团队规则区块，并保留 SOUL.md 中的其他内容。Hermes 不会得到项目 rule，在项目中 `init` 和 `doctor` 会说明原因：

`.hermes.md` 会遮蔽项目 `AGENTS.md`，`pre_llm_call` hook 会在每一轮重复添加 rule，而唯一的插件提示段落（最多 4,000 个字符）已用于团队指令。frontmatter 会被去掉，所以带 `paths:` 的 rule 在这里对所有文件生效，并以一行 `Applies to files matching: <globs>` 开头。Codex 在压缩上下文或 clear 之后会再次运行该 hook；恢复会话时不添加任何内容，因为会话中已包含这些 rule。Codex 启动的子 agent 通过 `SubagentStart` hook 获得它们。公开版 Codex 只运行已信任的 hook。teamai 会自动信任它写入的 hooks；如果自动信任被禁用或失败，请在 `/hooks` 中批准它们以获得项目的 rule。

culture、共享指令和 recall 区块采用同样的划分。user scope 下它们写入同一个 `AGENTS.md`，标记之外你自己的内容保持不变。在项目中，session-start hook 把它们与 rule 一起加入会话，`pull` 不改动项目 `AGENTS.md`。

> 团队 `teamai.yaml` 中的 `toolPaths` 会整体替换内置默认值。设置了它的团队应为每个 Codex 系条目加上 `userScope.claudemd: .codex/AGENTS.md`（`.codex-internal/…`、`.tcodex/…`），用于 user scope 的 rule 和区块，并去掉其 `rules` 路径，因为 Codex 从不读取该目录。顶层的 `claudemd` 会把区块重新写进项目 `AGENTS.md`，所以不要设置。在项目中，hook 只需要该条目的 `settings` 路径，它安装在那里。`codex` 条目还需要 `mcpProject: .codex/config.toml`，项目的团队 MCP server 才会写入。本版本中 rules 位置发生变化的其他工具同理：

> 之前写的条目仍会把 rules 发往工具从不读取的目录，pull 也会保留那些副本。请从 Pi 或 OpenClaw 条目中去掉 `rules` 和 `userScope.rules`，给 JoyCode 条目加上 `userScope.rules: null`（其项目级 `rules: .joycode/rules` 保留），并把 WorkBuddy 条目的 `rules` 设为 `.codebuddy/rules`、`userScope.rules` 设为 `.workbuddy/rules`。对这样的条目，`teamai doctor` 的 `Rules delivered to <tool>` 会失败并指出要改什么。

> 从把 rule 复制到 `.codex/rules/` 的旧版本升级后，下一次 `pull` 会删除 teamai 投递到那里的 `.md` 副本，包括 `teamai-recall.md`。清理使用记录的 `toolRoots` 位置，同时检查发布者本地的无命名空间文件名及命名空间副本。你改过的副本会保留，并在警告中点名；`*.rules` 文件从不改动。团队此后已删除的 rule，其副本只有与记录的投递哈希一致时才会删除；没有该记录时也会保留并点名。同一次 pull 会为 `hooks.json` 中的 teamai hook 加上 `additionalContextLimit: 0` 和一个 `SubagentStart` 条目，随后 teamai 会在公开版 Codex 中重新信任这些 hook（见 Hooks 章节）。

### Env、hooks 与 MCP server 按 namespace 划分

环境变量、团队 hooks 和 MCP server 各自是团队仓库根目录下的一个列表文件（对所有人共享），
外加每个 namespace 一个文件：

```text
env/env.yaml              hooks/hooks.yaml              mcp/mcp.yaml              根目录，共享
env/<ns>/env.yaml         hooks/<ns>/hooks.yaml         mcp/<ns>/mcp.yaml         仅在 <ns> 激活时生效
```

namespace 的声明方式与 skills、agents 相同：写在 `manifest/roles.yaml` 中角色或
`manifest/projects.yaml` 中项目的 `resources:` 下，每种类型各用自己的 key。成员的活动
namespace 是其角色与所在目录项目的并集：

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      env:   [checkout]
      hooks: [checkout]
      mcp:   [checkout]
```

- **覆盖。** 活动 namespace 中的条目会整体替换根目录中同名的条目：变量按 `key`、hook 按
  `id`、server 按 `name`（`command`、`args`、`env` 与 `tools:` 一起替换；覆盖条目没有
  `tools:` 时对所有工具生效）。不做字段级合并。
- **冲突只停掉该类型，不停掉整个 pull。** 同一文件中重复的名字、两个活动 namespace 中的
  同名条目，或无法解析、无法读取的活动文件，都会让该类型本次不生效：已安装的内容保持不变，警告会给出
  文件与修复方法。Hooks 与 MCP 在文件无效时不再移除全部托管条目。缺失的内置 hooks 仍会安装，
  因此首次 `teamai init` 也能拿到 SessionStart pull，之后由它应用修复；若 `hooks/hooks.yaml`
  本身无法解析，内置 hooks 使用默认设置，且只装到还没有任何 teamai hook 的工具中。
- **停用** namespace（`teamai projects set`、`teamai roles set`）后，下一次 pull（包括
  `Already synced`）会恢复被覆盖的根条目并移除仅属于该 namespace 的条目。即使
  `env/env.yaml` 不存在或为空，`env.sh` 也会被重写。
- **目录名**与声明的 namespace 按忽略大小写的方式匹配，与 docs 相同：`env: [checkout]`
  在任何文件系统上都会读取 `env/Checkout/env.yaml`，`env add --project checkout` 也会写入这个文件。
- **MCP 的 `${VAR}`** 从同一份解析后的环境变量集合取值。
- **旧模式**（成员没有角色，且团队没有 `projects.yaml`）只读取根目录文件，行为不变；
  `teamai doctor` 会列出根文件中重复的名字。
- **值从哪里来。** `teamai env list`、`teamai mcp list`、`teamai hooks list` 与
  `teamai list <env|hooks|mcp> --source repo` 会给出每个条目的 namespace、是否覆盖了
  根条目，并指出每个未下发的条目及其原因；`teamai status` 按 namespace 计数并同样
  指出它们；`teamai doctor` 以提示信息列出每一处覆盖。
  你用 `teamai env set KEY` 为该团队设置了值时，变量取你的值，否则取文件中的值；环境
  不覆盖二者，`env.sh` 导出的就是这个值（用 `--from-env` 设置的除外）。`teamai env list` 与
  `teamai list env` 显示这个值及其来源：`team` 或 `env.yaml`。
- **先让所有成员升级。** teamai 0.25.0 与 0.26.0 beta 会拒绝不认识的 `resources:` key，
  声明 `env`、`hooks` 或 `mcp` 会让这些版本的 pull 失败。从本版本起，未知的
  `resources:` key 只会给出警告，`teamai roles` 与 `teamai projects` 保存 manifest 时也会保留它。

这些文件取代的按条目 key：

| Key | 适用于 | 现在 |
|---|---|---|
| `projects:` | env、hooks、MCP | 已移除：该条目不再下发给任何人；pull、各 list 命令和 status 都会警告并给出应迁往的文件 |
| `roles:` | env | 已移除，处理方式相同 |
| `roles:` | hooks、MCP | 已弃用：在一个次版本内仍像 0.25.0 一样按角色过滤，根文件中以不同 `roles:` 重复的名字也照旧生效；pull 会警告，`teamai doctor` 有一项检查，两者都会列出每个目标文件 |

没有自动迁移：把每个条目移到警告给出的 namespace 文件中，并删掉该 key。
如果 `teamai env add` 更新的已有变量仍带有已移除的按条目 `projects:` 或 `roles:` key，
命令会保留该 key，并警告 pull 不会下发这个变量，同时指出应迁往的 namespace 文件。

条目若带有其 schema 不认识的其他 key（例如拼错的 `role:`），同样不会下发给任何人；
pull、各 list 命令、status 与 `teamai doctor` 会指出文件、条目和该 key。请改正或删除这个 key。
较新版本 teamai 新增的 key 对旧版本同样是未知 key，因此团队使用新的条目 key 之前，
请先让所有成员升级。

hooks 或 MCP 文件若没有任何一个应有的顶层 key（例如把 `servers:` 写成 `server:`），
按无法解析的文件处理：pull 保留已安装的 server 或 hook，pull 与 `teamai doctor`
会指出文件、实际找到的 key 和应有的 key。`servers:` 或 `hooks:` 旁多出的顶层 key 会被忽略。

### Env（环境变量）

```bash
teamai env add API_ENDPOINT https://api.example.com --description "团队 API 地址"
teamai env add API_ENDPOINT https://checkout.internal --project checkout   # 该项目的 env namespace 文件
teamai env remove API_ENDPOINT --role checkout                          # env/checkout/env.yaml
teamai env list
teamai push
```

变量定义在团队仓库的 `env/env.yaml` 中，按 namespace 划分的写在 `env/<ns>/env.yaml`
（见 [Env、hooks 与 MCP server 按 namespace 划分](#envhooks-与-mcp-server-按-namespace-划分)）。`teamai env add` 与
`teamai env remove` 编辑根文件，加上 `--role <ns>` / `--project <id>` 时编辑对应
namespace 的文件；`--project` 使用该项目声明的唯一 env namespace；`--role` 指定的 namespace
若没有任何角色或项目声明，会给出警告，因为该文件不会送达任何人。两个命令都不会编辑无法解析的文件；
团队仓库无法刷新时 `--project` 不做任何修改，因为过期的 `manifest/projects.yaml` 可能指向错误的 namespace。
`teamai push` 会带上其中任何一个文件的改动。

```yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: 团队 API 地址              # 可选
```

**密钥。** 团队需要的密钥只声明、不写值，写在 `env/secrets.yaml` 或某个 namespace 的
`env/<ns>/secrets.yaml` 中（生效条件与 `env/<ns>/env.yaml` 相同，namespace 条目替换根文件中同 key
的条目）。每个成员在自己的机器上保存值。

```yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope   # 可选
    url: https://github.com/settings/tokens     # 可选：成员获取 token 的地址
```

```bash
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai env remove GITHUB_TOKEN        # env.yaml 未设置的 key；两个文件都有时加 --secret
teamai push
```

`teamai env add KEY --secret` 在根文件中（或用 `--role` / `--project` 在对应 namespace 的文件中）声明一个 key，
或更新它的描述和 url；它不接受值，也不会输出值。

每个成员为当前目录的团队设置自己的值，从不通过命令行参数传入：

```bash
teamai env set GITHUB_TOKEN                               # 提示输入，不回显
teamai env set GITHUB_TOKEN --stdin                       # 从管道读取
teamai env set GITHUB_TOKEN --from-env WORK_GITHUB_TOKEN  # 使用时从该变量读取
teamai env set GITHUB_TOKEN --global                      # 对本机所有团队生效
teamai env unset GITHUB_TOKEN [--global]
```

`env set` 接受已声明的密钥，不加 `--global` 时也接受该目录收到的 `env.yaml` 变量，并把值保存在 `~/.teamai/secrets/teams/<hash>.json`
（权限 `0600`），每个团队仓库一个文件，按你的 `~/.teamai/config.yaml` 中的团队仓库 URL 命名（不使用 `teamai.yaml` 的 `repo:`），修改 `team:` 不影响它；加 `--global` 时保存在 `~/.teamai/secrets/machine.json`，
对本机所有团队生效，为某个团队设置的值仍然优先。不在任何 scope 中时，`--global` 接受任何合法的 key，
并提示目前还没有团队声明它。值保持设置时该 key 的类型：

团队不再声明某个同时在 `env.yaml` 中设置的密钥后，你的值不会用于该变量，`env list` 会提示先运行 `teamai env unset KEY`，再运行 `teamai env set KEY`。`teamai env list` 和 `teamai list env` 会把每个已声明的密钥
显示为 `team`（你为该团队设置了它）、`global`（你为本机设置了它）、`environment`（你自己的环境中有它的值）、`missing`，
或 `unreadable`（你的值文件无法读取），从不显示值，
`--reveal` 也一样。既声明为密钥、又在 `env.yaml` 中设置的 key 按密钥处理：它的 `env.yaml` 值不会
导出到 `env.sh`，也不会列出。密钥文件无法使用时不会被当作"没有密钥"：

`env.sh` 和 MCP server 保持原样，
`pull` 会警告，`env list` 和 `mcp list` 以非零状态退出（此时 `env list` 不显示任何变量的值，因为其中任何一个都可能是密钥），
`teamai doctor` 的检查失败并指出该文件。值文件无法读取时，`Your team secret values can be read` 检查失败。`teamai push` 会带上任何密钥文件的改动。
见[团队密钥](../../designs/team-secrets.md)。

`gh`、`glab` 等 CLI 在 `teamai env exec` 下运行时，会拿到当前目录的变量和密钥；它对项目的每个 worktree
都以同样的方式找到 scope：

```bash
teamai env exec -- gh pr create
teamai env exec -- glab mr list
```

命令继承你的环境，并叠加该 scope 的 `env.yaml` 变量和按[解析顺序](../../designs/team-secrets.md#resolution)解析的密钥；在该 scope 下没有值的已声明密钥
会从中移除。命令前要加 `--`：否则 teamai 会把命令的参数当作自己的，因此它会提示并以退出码 2 结束。缺少密钥时，会在 stderr 上打印 `teamai env set` 那一行提示，命令照常运行。teamai 打印的所有内容
都输出到 stderr，退出码就是命令的退出码。这里没有 teamai 配置时，命令以你的环境运行，并给出提示。
不会把任何值写入磁盘。见[用 `env exec` 运行 CLI](../../designs/team-secrets.md#running-a-cli-with-env-exec)。

scope 声明了密钥时，session-start hook 会告诉 agent 有哪些 key 及其 `description`，并让它通过
`teamai env exec --` 运行需要这些 key 的 CLI。工具会丢弃 hook 输出的 agent 从 teamai core skill 获得同样的规则。
agent 从不索要密钥值：缺少密钥时，它会请你在自己的终端运行 `teamai env set KEY`。见
[告诉 agent](../../designs/team-secrets.md#telling-the-agent)。

不再下发到该目录的变量会在下一次 pull 时从 `env.sh` 中移除，即使这次 pull 因团队仓库
未变化而提示 `Already synced` 也一样。在那次 pull 之前，`teamai doctor` 会报告
`env.sh` 中仍在导出的这类变量，前一个项目的密钥不会悄无声息地继续生效。

shell 配置文件会保留用户级 scope 的 teamai 区块，外加一个项目级区块：在项目级目录中 pull 会替换上一个项目的区块，用户级区块保持不变。用户级区块在前，因此两者定义了同一个键时以项目的值为准。在多个项目级目录中都执行过 pull 的机器，新开的 shell 里会是用户级的变量加上最后一次 pull 的那个目录的变量。每个目录自己的 `env.sh` 仍然是正确的；只是 shell 配置文件只指向最后一个项目的那个。

`pull` 时，若启用了 `injectShellProfile`（默认启用），`$SHELL` 为 zsh 时环境变量块会写入 `~/.zshrc`，否则写入 `~/.bashrc`——但 Windows 上例外：`$SHELL` 通常未设置，而 Git Bash 以*登录 shell*方式启动，从不读取 `.bashrc`，因此 teamai 会优先选择已存在的 `~/.bash_profile`、其次 `~/.bash_login`、再次 `~/.profile`，只有三者都不存在时才回退到 `~/.bashrc`（通过 MSYS2/Cygwin 安装、会设置 `$SHELL` 的 zsh 仍会解析到 `.zshrc`）。这与 Git for Windows 自身在 `/etc/profile.d/bash_profile.sh` 中的回退逻辑一致，其判断条件是 `[ -e ~/.bashrc -a ! -e ~/.bash_profile -a ! -e ~/.bash_login -a ! -e ~/.profile ]`——只有在这一种情况下它才会生成一个会 source `.bashrc` 的 `.bash_profile`；

这也是为什么哪怕一个只 source 了其他内容（例如 `~/.local/bin/env`）的 `~/.profile` 存在，也足以让 `.bashrc` 单独失效。可通过 `teamai.yaml` 中的 `sharing.env.shellProfilePath` 覆盖目标文件。

每次 pull 都会重新走一遍这个优先级判断，找到当前环境实际会读取的那个文件，然后沿着它对另外四个候选文件名的引用一路查下去——无论要经过多少跳

——寻找一个已经带着代码块的候选文件，而不是重复注入。如果这条链上还没有文件带着本作用域的代码块，就使用第一个带着其他作用域代码块的文件，让用户级区块和项目级区块按顺序放在同一个文件里，而不是分散在两个文件中。如果链条中间经过的是这五个候选文件名之外的文件（比如某些环境会改用 `~/.config/shell/profile` 这类自定义文件来 source），这条链就不会被继续跟踪。这正是为了不让 Git for Windows 自身的引导逻辑把目标文件从脚下换掉：

上面那条 `/etc/profile.d/bash_profile.sh` 判断条件，在第一次 pull 写入 `.bashrc` 之后同样会成立，于是下一次 Git Bash 登录 shell 启动时就会自动生成一个 source 它的 `~/.bash_profile`；如果不沿着这条转发链去找，下一次 pull 就会转而偏好这个新出现的文件，在那里注入第二个代码块，而原来那个——依旧在正常工作，只是绕得更远了——则会被误报为失效的遗留代码块。同样的道理也适用于一个普通的 `.profile`：它用一条扁平的存在性守卫（`[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`）为交互式 shell source `.bashrc`——这时登录 shell 最先读到的文件，离实际代码块有两跳之遥。

不过，只有两种字面写法才算真正的引用：单独一行的裸 `source X` / `. X`，或者单独一行、与 Git for Windows 自己生成的写法完全一致的自引用存在性守卫 `test -f X && . X` / `[ -f X ] && . X`（被测试路径与被 source 路径完全相同）——两种情况下 `X` 都必须是不加引号的 `~/name`，或不加引号/用双引号包裹的 `$HOME/name`（绝不是加了引号的 `~`，也绝不是用单引号包裹的 `$HOME`：shell 不会展开这两种写法，看起来对的引用实际会 source 一个不存在的字面路径）。除此之外的写法——source 本身带了重定向或额外参数、`||` 回退、不相关的 `&&` 连接命令、任何这段逻辑无法独立验证的条件

——一律不识别，直接回退到按优先级选出的文件，而不是去猜。这是刻意收窄到两种固定写法的封闭集合，而不是尝试解析任意的 shell 条件：真要匹配一个真实 shell 脚本能用来让某一行变成有条件执行（或者把可执行内容伪装成惰性文本）的所有手法，需要一个真正的 shell 解析器，任何固定规模的规则集合都不可能穷尽这件事。嵌在 `if`、`for`/`while`/`until`、`case`、`select`、函数体，或者 `(...)`/`{...}` 分组里的内容一律不算数，不管外层条件写的是什么

——这些结构要么不保证一定会执行，要么即使一定会执行（比如子 shell 或大括号分组），它导出的环境变量也传不到调用它的 shell 里，这也意味着 Debian/Ubuntu 标准模板里那种嵌套两层 `if`、沿途还检查 `$BASH_VERSION` 的写法无法被识别，会回退到按优先级选出的文件。位于无条件的顶层 `return` 或 `exit` 之后的内容同样不算数，因为控制流根本不会执行到那里。凡是这套逻辑判断不了的情况，以及当前这条链条根本没触及到的候选文件——哪怕它本身带着代码块——都绝不会因此被优先选中，否则 #682 之前旧版本留下的失效代码块就会永远压过正确的文件，等于在升级后又悄悄把 #682 引入回来。

`doctor`（以及 `pull` 结束后自动运行的检查）还会标记出遗留在*其他*候选文件中的 teamai 环境变量块——例如 #682 之前的旧版本写入 `.bashrc` 的代码块，即便该代码块本身已损坏、从未生效。`teamai uninstall` 会清理它。

### Docs（文档）

将文档放入团队仓库 `docs/` 目录，push 后团队成员 pull 时自动同步。

**按 namespace 分发 docs。** 只要有任一角色或项目在 `resources.docs` 中列出某个顶层 `docs/<ns>/`，它就成为一个 namespace，此后只分发给激活了它的成员（其角色与所在目录项目的 namespace 并集），其他人不再收到。没有任何角色或项目列出的 `docs/<dir>/` 仍然共享，因此已有的子目录继续分发给所有人：

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]     # docs/checkout/ 只在 checkout 激活时分发
```

- 没有覆盖规则：每个 namespace 是独立的子树，namespace 中的文件不会替换根目录的文件。
- 某个 namespace 对你不再激活时，下一次 pull 会删除本地仍与团队副本（或团队更早的某个版本，即你收到后团队又修改过）逐字节一致的该 namespace 文档；你修改过的文档会保留，并打印一行说明它的路径。其中团队仓库从未有过的本地文件属于你，会保留，与文档镜像的其他位置一样。
- `team-codebase` 不能作为 docs namespace：`docs/team-codebase/` 是旧版 codebase 输出目录。声明它的 manifest 会加载失败。
- `recall` 和 `teamai doctor` 使用同一过滤规则：recall 只索引你收到的文档，`Team docs delivered` 不会要求你拥有未激活的 namespace。
- 旧模式（没有角色，也没有 `projects.yaml`）照旧分发整个 `docs/`。

### MCP Server

在团队仓库的 `mcp/mcp.yaml` 中声明一次，`teamai pull` 时会按各工具的原生格式写入它们各自的 MCP 配置文件。不在 `enabledAgents` 中或列在 `disabledAgents` 中的工具会被跳过。

```yaml
servers:
  - name: gpu-analysis
    description: GPU 存量与价格查询
    transport: http                      # stdio | http | sse
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000

  - name: local-formatter
    transport: stdio
    command: npx
    args: ['-y', '@acme/formatter-mcp']
    env:
      FORMATTER_MODE: strict
    requires: [npx]                      # PATH 上找不到 npx 时跳过并提示
    tools: [claude, cursor]              # 可选；默认所有支持 MCP 的工具
```

`requires` 从 `PATH` 解析。Windows 上还会匹配 `PATHEXT` 后缀（`uvx` 可匹配 `uvx.exe` / `uvx.cmd`）。

项目或角色通过 `mcp/<ns>/mcp.yaml` 限定 server（见
[Env、hooks 与 MCP server 按 namespace 划分](#envhooks-与-mcp-server-按-namespace-划分)）：其中的 server 只下发给激活了该
namespace 的成员，并替换根目录中的同名 server。按 namespace 划分正是为了控制成本：
否则一个有 5 个项目、每个项目 3 个 server 的团队，会让每位成员启动 15 个 server 进程，
并在每次会话的上下文中携带 15 份工具列表。

`teamai remove mcp <name>` 与 `push` 采用同一约定：`mcp/mcp.yaml` 定义了该名字时从这个文件移除，
否则从唯一定义了它的 `mcp/<ns>/mcp.yaml` 移除。`--role <ns>` 或 `--project <id>` 可改为指定某个
namespace 文件；只有当根文件未定义、而多个 namespace 文件都定义了该名字时，才必须指定。
有 MCP 文件无法解析时，根文件未定义的裸名字不会移除任何内容，因为无法解析的文件可能定义了它；
请修复该文件，或传入 `--role` / `--project`。若参数指定的正是无法解析的文件，会直接说明，而不是报告找不到该名字。

各工具的落点：

| 工具 | 用户级 | 项目级 |
|---|---|---|
| claude | `~/.claude.json` | `<project>/.mcp.json`；开启 [`sharing.gitExclude`](./member-guide.md#让分发的文件不进入-git) 后为 `~/.claude.json` 的 `projects[<主 checkout>]`（见下文） |
| cursor | `~/.cursor/mcp.json` | `<project>/.cursor/mcp.json` |
| codebuddy | `~/.codebuddy/.mcp.json`、`~/.codebuddy/mcp.json`、`~/.codebuddy.json` 中第一个存在的文件（见下文） | `<project>/.mcp.json`；开启 [`sharing.gitExclude`](./member-guide.md#让分发的文件不进入-git) 后为 `~/.codebuddy.json` 的 `projects[<worktree 根目录>]`（见下文） |
| workbuddy | `~/.workbuddy/mcp.json` | `<project>/.workbuddy/mcp.json` |
| copilot | `$COPILOT_HOME/mcp-config.json` | `<project>/.github/mcp.json` |
| codex | `~/.codex/config.toml` | `<project>/.codex/config.toml` |
| qoder | `~/.qoder/settings.json` | `<project>/.qoder/settings.json` |
| qoder-cn | `~/.qoder-cn/settings.json` | `<project>/.qoder/settings.json` |
| kiro | `~/.kiro/settings/mcp.json` | `<project>/.kiro/settings/mcp.json` |
| trae | — | `<project>/.trae/mcp.json` |
| trae-cn | — | `<project>/.trae/mcp.json` |
| opencode | `~/.config/opencode/opencode.json` | `<project>/opencode.json` |
| omp | `~/.omp/agent/mcp.json` | `<project>/.omp/mcp.json` |
| pi | `~/.pi/agent/mcp.json` | `<project>/.pi/mcp.json` |
| zcode | `~/.agents/mcp.json` | —（不写入 ZCode 的项目级 MCP 格式） |

Codex 只在受信任的项目中读取 `<project>/.codex/config.toml`。写入团队 MCP servers 后，`teamai pull` 会自动信任主 checkout，除非设置了 `codexTrustEnabled: false`，或该项目已被明确标记为不信任。自动信任被禁用或失败时，可在 `~/.codex/config.toml` 中加入 `[projects."<主 checkout 的真实路径>"]` 表并设置 `trust_level = "trusted"`；信任主 checkout 即覆盖该仓库的所有 worktree。项目未受信任、而其文件含有团队 server 时，`teamai doctor` 会报告。


在用户级，CodeBuddy 只读取一个 MCP 文件：`~/.codebuddy/.mcp.json`、`~/.codebuddy/mcp.json`、
`~/.codebuddy.json` 中第一个存在的文件，不会合并它们。pull 会把 teamai 的 server 写入该文件，
与你自己的 server 并存；只有这几个文件都不存在时，才会创建 `~/.codebuddy/.mcp.json`。
如果你之后创建了排在更前面的文件（`codebuddy mcp add -s user` 会创建 `~/.codebuddy/.mcp.json`），
下一次 `teamai pull` 会把 teamai 自己的 server 移入该文件，你自己的 server 保持原处；
在此之前，`teamai doctor` 会给出警告，`teamai mcp list` 会指出它们所在的文件。
`teamai mcp remove` 和 `teamai uninstall` 会从实际存放它们的文件中移除。


pull 和 uninstall 还会从 CodeBuddy 不读取的文件中移除没有记录、但与某个团队版本的 server 相同的条目，
因此记录丢失也不会留下残余。指向这几个文件中另一个的符号链接视为该文件本身：teamai 通过链接写入，
不会在它们之间移动任何内容。
早期版本总是创建 `~/.codebuddy/mcp.json`，它会遮住 `~/.codebuddy.json`：当它只含 teamai 的 server、
且排在后面的文件存在时，下一次 pull 会把这些 server 移入该文件，删除 `~/.codebuddy/mcp.json`，
并只提示一次。在 `~/.codebuddy.json` 中 teamai 只改动自己的条目。若 `~/.codebuddy/mcp.json`
还含有你自己的 server 或任何其他键，它保持原样，teamai 仍写入该文件。


HTTP 模式团队的本地 agent 也安装到 CodeBuddy 读取的那个文件并记录它；
它曾安装到 CodeBuddy 已不再读取的文件中的 server，会在再次安装时移过去。

CodeBuddy Code 的 [MCP 文档](https://www.codebuddy.cn/docs/cli/mcp)
明确将项目根目录的 `.mcp.json` 列为首选项目配置。
该路径与上文 TeamAI 的用户级 CodeBuddy 文件相互独立。
`teamai.yaml` 中显式设置的 `toolPaths.codebuddy.mcpProject` 仍然优先生效。
已有团队若固定使用 `.codebuddy/mcp.json`，请先在对应工作区执行
`teamai mcp remove`，再将该值改为 `.mcp.json`，最后运行
`teamai mcp inject`。请检查并保留两处文件中自行添加的服务；
TeamAI 不会迁移或删除旧文件。Claude Code 也读取根目录的 `.mcp.json`，
因此两个工具共享该文件。

开启 `sharing.gitExclude` 后，Claude 的项目级 server 不再写入 `.mcp.json`，而是写入 Claude Code 的 local scope：
`~/.claude.json`（设置了 `CLAUDE_CONFIG_DIR` 时位于其中）的 `projects[<key>].mcpServers`，其中 `<key>` 是 Claude Code
为该 checkout 使用的路径，即主 checkout 的真实路径，因此所有 worktree 共用一份（`--separate-git-dir` 仓库的 linked worktree
用 git 目录；submodule 的 linked worktree 用其在 `.git/modules` 下的目录）。这样解析后的 token 不会进入工作区，Claude Code
加载这些 server 时无需批准，团队自己的 `.mcp.json` 保持原样。teamai 在那里只改动自己的条目，`teamai uninstall` 也只移除这些
条目，覆盖它记录过的每个 key，包括 worktree 已删除的 key。下一次 pull 会从 `.mcp.json` 中移除 teamai 的 server，保留你自己的
server，保留你改动过的 teamai server 并给出提示；文件中不再剩下任何内容且 git 未跟踪它时删除该文件。关闭此选项后，下一次 pull
会把这些 server 移回去，并从每个记录过的 key 中移除它们。
项目中安装并启用了 tclaude 时，Claude 继续使用 tclaude 读取的 `.mcp.json`。单仓库（single-repo）团队中 Claude 也继续使用 `.mcp.json`：每个 worktree 读取各自分支的 `.teamai/mcp/mcp.yaml`，而 Claude Code 把所有 worktree 记在同一个 key 下，因此下一次 pull 会把 teamai 的 server 从该 key 移回每个 checkout 的 `.mcp.json`；该文件只含 teamai 的 server 时，git exclude 块会列出它。

CodeBuddy 的项目级 server 也以同样方式移到 CodeBuddy 的 local scope：`CODEBUDDY_CONFIG_DIR`（未设置时为你的 home 目录）中
`.codebuddy.json` 的 `projects[<key>].mcpServers`。CodeBuddy 按其运行目录作为 key，因此 `<key>` 是每个 worktree 根目录的真实路径，
每个 worktree 各有一份：pull 会写入它，git 创建 worktree 时运行的 pull 也会写入。与以前一样，在子目录中启动的 CodeBuddy 看不到
项目级 server。对于已不存在的 worktree，下一次 pull 会从它的 key 中移除 teamai 的 server，保留你自己的 server。teamai 只改动自己的条目，
该文件的其他内容保持不变，`teamai uninstall` 也只移除 teamai 的 server，覆盖它记录过的每个 key。移出和移回 `.mcp.json` 的方式与上文 Claude 相同，
因此开启此选项后不会有 pull 写入 `.mcp.json`。

使用 HTTP 后端的团队中，本地 agent 遵循同一选项（按每个工作区读取）：它的 `install_mcp` 把 Claude 和 CodeBuddy 的 server
写入上述 local scope，使用相同的 key，不写 `.mcp.json`；`uninstall_mcp` 和 `teamai uninstall` 只移除它在那里记录的 server。
以前的安装留在 `.mcp.json` 中的 server 会在本地 agent 下一次同步时移过去；你改动过的副本留在原处并给出提示，归你所有；
其他工具的记录仍认领的条目也留在原处。选项关闭时不会移动任何内容；teamai 无法读取该选项时，本地 agent 不会在该工作区为
Claude 或 CodeBuddy 安装任何内容，并说明原因。`teamai doctor` 会指出本地 agent 记录的、仍在 `.mcp.json` 中的 server。
`teamai source remove-http` 不移除这些 server，但保留它们的记录，因此之后的 `teamai uninstall`（包括找不到任何配置的卸载）会移除它们（见[卸载](./faq.md#卸载)）。

TeamAI 仅在所有权记录证明已完成顶层写入且内容仍匹配时，才删除 `mcpServers` 旁的 Copilot 顶层条目。旧记录缺少位置证据时，即使内容与团队定义相同，也保留顶层条目。顶层所有权记录不授权修改 `mcpServers` 下的同名成员条目；更新跳过该冲突，移除时只清理受管理的顶层副本。缺少位置标记的记录只有在哈希匹配嵌套条目且不同时匹配顶层条目时，才能认领嵌套条目。完成的嵌套写入记录 `bare: false`；

位置记录写入失败时，所有权仍未得到证明。HTTP 本地代理首次安装先只读检查 Git 保护，再保存临时所有权记录，随后添加排除规则和文件记录，最后写入凭据。初始所有权记录写入失败不会改变 Git 排除规则或 MCP 配置。

HTTP local-agent 更新 JSON MCP 配置时，先保留原有 ownership 记录，配置写入成功后才更新记录；如果随后保存记录失败，会恢复原配置。`uninstall_mcp` 先删除配置中的条目，再移除 ownership 记录：配置写入失败或无法读取时保留记录以便重试，manifest 写入失败时恢复条目。MCP reconcile 在保存 ownership 前失败时，会恢复本次已写入的所有配置，包括多个工具共用的文件。恢复本身也失败时，错误会同时说明两次失败及受影响的文件；修复配置与 ownership 记录后再重试。只要凭据仍在文件中，就继续保留 Git 排除保护。

Copilot 使用原生 `mcpServers` 结构：`stdio` 写成 `type: "local"`，远程传输保留 `http` 或 `sse`，每个 TeamAI 管理的条目都会带上必需的 `tools: ["*"]` 允许列表。TeamAI 遵循 `COPILOT_HOME`，项目配置使用 Copilot CLI 官方文档指定的 `.github/mcp.json` 仓库路径。详见 [GitHub Copilot CLI 添加 MCP Server](https://docs.github.com/zh/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)。Codex 支持 `stdio` 与 `http`，`sse` 会被跳过。Qoder 使用对应作用域 `.qoder/settings.json` 中与 Claude 兼容的 `mcpServers` 格式；Trae 在其项目 `.trae/mcp.json` 中使用同一结构，两个版本的 target 在同一条共享归属记录下映射这同一个文件。Kiro 在专用的、只含 `mcpServers` 的 `.kiro/settings/mcp.json` 中使用同一格式（见 [Kiro MCP 配置文档](https://kiro.dev/docs/mcp/configuration/)）。

OpenCode 支持 `stdio`（写成其 `type:"local"` 形态）、`http` 和 `sse`（后两者均为 `type:"remote"`，由客户端协商传输协议），其 server 位于共享 `opencode.json` 的 `mcp` 键下。归属记录在 `~/.teamai/managed-mcp.json`——手动添加的 server 不动；

与手写同名则跳过，除非 `--force`。

**密钥**：在 `mcp.yaml` 里写 `${VAR}`，不要写明文。团队在 `env/secrets.yaml` 中声明的 key 优先取你为该团队设置的值（`teamai env set`），其次取你为本机设置的值（`teamai env set --global`），再次取你自己的环境，不包括 teamai `env.sh` 导出的值（见[团队密钥](../../designs/team-secrets.md#resolution)）。其他变量优先取你为该团队设置的值（`teamai env set KEY`），其次是该目录收到的团队环境变量（`env/env.yaml` 与活动的 `env/<ns>/env.yaml`）；

环境只补充团队没有设置的 key，不再覆盖团队变量（见[团队密钥](../../designs/team-secrets.md#variables)）。你导出的值与团队的值不同而被忽略时，交互式 `pull` 和 `teamai doctor` 会指出。变量无法解析则跳过并提示。已声明的密钥不同：pull 找不到它时，之前某次 pull 写入的条目原样保留，因此里面可能是已经轮换掉的旧值，直到某次 pull 找到新值（见[团队密钥](../../designs/team-secrets.md#a-missing-secret-keeps-the-mcp-entry)）。交互式 `pull`、`teamai mcp list`、`teamai env list`、`teamai doctor` 和 `teamai env exec` 会指出没有值的已声明密钥、用到它的 server 以及设置它的命令：`` github: GITHUB_TOKEN is not set. Run `teamai env set GITHUB_TOKEN` (<url>). ``

teamai 会**把每个 `${VAR}` 解析成取值后原样写入**各工具的配置文件，并以 `0600` 写入该文件，已有的 `0644` 文件也会收紧（不含已解析值的配置保持原权限；新建文件权限为 `0600`）。它不依赖任何工具自身的环境变量展开——因为那种展开很脆弱：最典型的是，以 GUI 方式（Dock/Launchpad）启动的 IDE 不会继承你 shell 中 `export` 的变量，`${VAR}` 占位符会展开为空、导致服务端 401。解析成明文可以保证无论工具如何启动，token 都在。

> ⚠️ **解析后的 token 会落盘。** 项目级 MCP 配置（`.mcp.json`、`.github/mcp.json`、`.cursor/mcp.json`、`.codex/config.toml`、`opencode.json`）因此含有明文密钥。只要这类文件将含有 teamai 解析出的值且 git 会跟踪它，teamai 就会在写入该值之前把路径写入本地克隆的 `.git/info/exclude`（仓库没有 `.git/info/` 时会先创建它，例如用 `git init --template=` 创建的仓库），放在 `# [teamai:mcp-exclude:start]` 块中（同一仓库的各 worktree 共用该文件）。

符号链接按实际写入的那个文件加入 exclude。teamai 不改已提交的 `.gitignore`。git 已经跟踪的文件保持原样，`teamai mcp list` 和 `teamai doctor` 会指出它。若曾经提交过，执行 `git rm --cached <file>` 并轮换 token。旧版本写入的文件同样处理。其余情况见 [Team secrets](../../designs/team-secrets.md)。

Claude Code 可能把来自仓库的 `.mcp.json` 标为待批准，需在交互式会话中确认一次。local scope 中的 server（开启 `sharing.gitExclude` 时，见上文）无需批准，CodeBuddy 的也是如此。

```bash
teamai mcp list              # 查看 server、各自来自哪个文件、密钥状态与安装位置
teamai mcp inject            # 立即注入；--dry-run 预览，--force 覆盖同名
teamai mcp remove            # 移除所有 teamai 管理的 server；--dry-run 预览
```
