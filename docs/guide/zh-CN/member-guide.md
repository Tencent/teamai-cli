# 成员使用

> [English](../member-guide.md) | [简体中文](member-guide.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 成员接入

管理员将团队仓库地址分享给成员后：

**项目级团队（默认）：**

```bash
npm install -g teamai-cli
cd /path/to/my-project
teamai init https://github.com/your-org/your-repo
# 完成！AI 工具已自动获得团队资源
```

**用户级团队：**

```bash
npm install -g teamai-cli
teamai init https://github.com/your-org/your-repo --scope user
```

**纯 Git、无需平台 token（`--provider git`）：**

团队仓库所在平台的 provider 需要 token 时（例如自建 GitLab 需要 `GITLAB_TOKEN`），从不需要 CLI 创建 PR/MR 的成员可以改用已有的 Git 认证（SSH Key 或 Credential Helper）：

```bash
teamai init https://gitlab.example.com/yourgroup/yourrepo --provider git
```

- `--provider` 跳过自动检测，直接使用指定的 provider：`tgit`、`github`、`cnb`、`gitlab`、`gitcode` 或 `git`。`git` 不做平台登录，也不检查 token。
- 该选择只保存在本机的本地配置中。已有的 `teamai.yaml` 不变，其他成员仍使用团队的 provider。`init` 新建 `teamai.yaml` 时，`--provider git` 写入的仍是 `init` 不带该参数时检测到的 provider；若 host 是尚未配置的自建 GitLab，`init` 会停止并提示设置 `GITLAB_URL`，而不是写入 `git`。
- 自建 GitLab 使用 `--provider gitlab` 时仍需设置 `GITLAB_URL` 或 `TEAMAI_GITLAB_HOST`（以及 `GITLAB_TOKEN`）。两者都未设置时 `init` 会直接停止，否则 GitLab API 会指向 gitlab.com。
- `pull` 照常工作。`push` 会推送分支，但无法创建 PR/MR，需要到 Git 平台上手动创建；由于这一步没有完成，命令以非零退出码结束。
- 不带 `--provider` 重新运行 `teamai init` 即恢复自动检测。

**HTTP 模式（只读消费者）：**

无需 git 访问、仅消费 skills/rules 的用户或 agent：

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

- 只读模式：`push` / `contribute` / `remove` 不可用，`import --from-mr` 无法发布其 learning（`--dry-run` 和 `--output` 仍可用）。
- 无需 git clone——skills/rules 通过 report/sync/ack 生命周期按 session 下发。
- 支持的 agent 在 session 启动时自动上报已安装 skill 状态，并拉取服务端管理的安装/更新/卸载指令。
- OpenClaw 的 HTTP prompt 在已存在且已解析的用户工作区中创建缺失的 `AGENTS.md`，并保留文件中已有的个人内容。
- API key 存储为 `0600` 权限，也可通过 `TEAMAI_API_TOKEN` 环境变量传入。

**验证：**

```bash
teamai status                       # 查看状态
teamai members                      # 查看团队成员
teamai list                         # 全部资源类型（skills|rules|docs|env|agents|hooks|mcp）+ 本地 skills
teamai list mcp                     # 只看团队 MCP servers
teamai list --source repo           # 只看团队仓库
teamai list --source local          # 各已安装 agent 下的 skills
teamai list --agent claude --verbose
teamai list env --reveal            # 明文显示 env（默认脱敏）

teamai skill                        # 先输出 teamai list skills --source all，再列出 CLI 内置 skill 目录
teamai skill show hai-deploy-test   # 看单个 skill 的来源 / 贡献者 / 安装位置 / 描述摘要

teamai skill list --json            # 当前 CLI 提供的内置 skill 清单（机器可读）
teamai skill get core               # 打印内置工作流：core | setup | wiki | share
teamai skill get wiki --full        # 同时附上该 skill 的 references 与 templates
teamai skill path wiki              # 打印打包目录，用于运行 skill 自带的脚本
```

#### 内置 skill 随 CLI 一起版本化

内置工作流（`core`、`setup`、`wiki`、`share`）随 npm 包一起发布，由已安装的 CLI 通过 `teamai skill get`
按需打印，因此 agent 读到的内容始终与正在运行的 CLI 版本一致——`npm i -g teamai-cli@latest` 本身就是更新，
无需 `teamai pull` 内容就是最新的。每个 agent 只收到一个文件：`~/.<tool>/skills/teamai/SKILL.md`（或该工具存放团队 skill 的位置：OpenClaw 的 workspace、`HERMES_HOME`），
一个指向这些命令的小型发现入口（stub）。旧版本会把整棵目录复制到每个 agent 下，两次 pull 之间内容会过时；


`teamai pull` 会清除这些残留，并把每个被删除的文件先复制到 `~/.teamai/removed-skills/` 下（每次 pull 一个目录；
`teamai uninstall` 会删除 `~/.teamai/`，这份备份也随之删除）。只删除内容与某个发布版本完全一致的文件：你改过的打包文件，
或你自己用旧名字写的 skill，都属于你，会保留。目录里若还有你自己的文件，
只删除其中的打包文件，保留该目录和你的文件，并在 pull 输出中点名。`share` 只在开启 recall 后才会提供（默认关闭；
团队在 `teamai.yaml` 设置 `sharing.recall.enabled: true`，或单台机器运行 `teamai recall enable`）：在此之前，
`teamai skill get share` 会拒绝并说明原因。


只读 HTTP 源上它同样会拒绝，因为 `teamai contribute` 无法写入；teamai 配置文件存在但无法加载时也会拒绝
（提示会说明失败原因；若是文件无法解析，还会指出是哪个文件、哪一行；若是校验失败，还会指出是哪个字段、为何不合法），因为此时无法确定 recall 与来源。旧名字仍然可用：
`teamai skill get team-wiki-codebase` 等价于 `wiki`。

---

## 日常使用

### 自动同步

`teamai init` 时已注入 Hooks 到你的 AI 工具中，并在结束时执行了一次 pull，因此你的第一个会话就已拥有团队的 skill、rule 和 MCP server。**每次启动 AI 会话时会自动执行 `teamai pull`**，无需手动操作。在 project scope 下，该 SessionStart hook 会先为当前 Agent 创建项目根目录（例如用 Claude Code 打开仓库时创建 `<project>/.claude`），然后再 pull。

*(注：会话启动自动同步依赖工具的生命周期 Hooks 支持，如 [CC]、Codex、GitHub Copilot CLI、Cursor、CodeBuddy、WorkBuddy、Qoder、ZCode、Kiro、OpenCode、Oh My Pi、Pi、Hermes、OpenClaw、DeepSeek Harness 等。Kiro 仅在交互式 CLI 会话激活由 TeamAI 渲染的自定义 agent 时触发该 Hook；其内存中的内置默认 agent 无法写入，非交互模式也不会触发 `agentSpawn`。对于暂无 teamai 可写入 Hooks 的工具（如 JoyCode、Gemini CLI 等），需手动执行 `teamai pull`。)*

如果需要立即同步，可以手动执行：

```bash
teamai pull              # 手动拉取
teamai pull --dry-run    # 试运行，不实际修改
```

没有 `--dry-run` 预览的命令（如 `teamai init`、`teamai hooks remove`、`teamai models add` / `configure` / `remove`、`teamai bind-project` 和 `teamai codebase --extract`）会拒绝该参数：打印 `teamai <command> has no --dry-run preview, nothing was run` 并以退出码 1 结束。

`remove`、`roles init/add/remove/update`、`projects add/update/remove` 和 `import --from-repo/--from-repo-list` 支持 `--dry-run`。远程导入源优先于较低优先级的 iWiki 或 Claude 参数。`digest`、`import --from-claude` 和 `import --from-iwiki` 尚无安全预览，也拒绝该参数。`stats`、`recall <query>`、`import --from-org`、`--from-mr`、`--dir` 和 `recall feedback` 的预览仍可使用。

手动执行 `teamai pull` 会在结束时运行 `teamai doctor` 的检查，并逐条打印失败项及其修复建议——包括它刚刚报告同步的 skill 是否真的落到每个启用工具的磁盘上、且可被读取。全部通过时不会有任何额外输出，退出码也不变。SessionStart hook 路径和 `--dry-run` 完全不运行检查，会话启动速度保持不变。托管平台相关的检查（`gh`/`gf` 认证）留给 `teamai doctor`：这次 pull 刚刚用过该平台。

**pull 会保留你修改过的 skill、rule 和 agent。** pull 按检出记录它在每个 skill、rule、agent 路径写入的内容。完整同步时，与记录不一致的副本会被保留并由 pull 指出，其他工具的副本照常更新。一个 skill 算作一份副本：它的任一团队文件被改动，整个 skill 都会保留；只有你自己添加的文件不计入。团队版本没有变化时，pull 输出 ``Kept <path>: you changed it since teamai delivered it. Share it with `teamai push`, or delete it and run `teamai pull --force` to get the team version back.``；

团队版本也变了时（无论是团队改的，还是你的[本地模型别名覆盖](./advanced.md#本地覆盖)导致的），pull 给出警告，请你先把这项改动合并进自己的副本，再 push；由于 SessionStart 时的 pull 不输出信息，`teamai push` 也会对该副本给出警告。`--force` 同样保留这些副本，`--dry-run` 会逐个输出 `Would keep <path>`。团队删除某项资源时，你修改过的副本也会保留，并由 pull 指出；

该路径上不含任何团队版本的你自己的文件同样保留，pull 会说明它不属于 teamai（``Kept <path>: it is not teamai's (...), so pull left it.``）。pull 没有记录的 skill、rule 或 agent（升级后第一次完整 pull 之前、新 worktree 中、从备份恢复或复制而来的检出（`.git` 因此有了新的标识），或你自己写的），只有当它与 teamai 按团队仓库历史中某个版本为该资源下发的内容相同时，才算 teamai 的；pull 会像以前一样更新或删除它。skill 目录只有其中每个文件都是 teamai 的才算 teamai 的，因此目录里只要有一个你自己的文件，整个目录就属于你。其他这类内容属于你：

pull 既不写入也不删除它。在 teamai 下发某个团队 skill、rule 或 agent 的位置，pull 会输出 ``Kept <path>: it is not teamai's (no delivery record, and it matches no team version of <resource>). 

Rename or delete it, then run teamai pull, to receive the team version.``；若另一条检出记录表明 teamai 曾写过该路径（例如恢复备份之后），则输出上面那几行；`teamai doctor` 以 `not teamai's (kept by pull)` 列出它并给出同样的说明，在它被移走之前每次 pull 都做完整同步。团队从未有过的文件名不会被处理。`teamai remove` 对它刷新的 rule 做同样的检查，但不写入记录；本地 agent 的安装仍会不经这些检查重写团队 rule。旧版 CLI 保存 state 时会丢弃这份记录。

**Codex 与 `.agents/skills`。** Codex 还会读取共享目录 `.agents/skills/`（user scope 下为 `~/.agents/skills/`），其他工具和你也会往这里写。只有当那里已有的副本按上述规则属于 teamai 时，teamai 才会把团队 skill 下发到那里。其他副本属于你，保持不动：团队 skill 改为下发到 `.codex/skills/<name>/`，并且每次完整同步都会输出 ``Codex skill conflict for <name>: .agents/skills/<name> is not teamai's, so it was left alone; the team skill is in .codex/skills/<name>. 

Codex now sees two skills named <name>.``。在每个工具的 skills 目录中，`teamai remove skills <name>` 和 `teamai uninstall` 只删除 teamai 的副本（检出记录中有它，或按历史是某个团队版本），并逐个指出它们保留的你自己的 skill：``Kept <path>: it is not teamai's (no delivery record, and it matches no team version of skills/<name>), so <command> left it.``

> Project scope 默认与 user scope 隔离。当前工作目录属于一个以 project scope 初始化过的项目时（其分区在 `~/.teamai/projects/<slug>/` 下，或旧版仓库内的 `.teamai/config.yaml`），`pull` 会处理该项目并跳过 user scope；仅当本地配置包含 `inheritUserScope: true` 时，才会先刷新安全的 user 资源通道。当前目录没有 project 配置时，`pull` 处理 user scope。project 模式下，user 的 `env`、MCP 定义、sources、reporting 和写入行为仍保持隔离。hooks 是唯一例外：project scope 的内置 hooks 会注入到你的 **HOME** 工具设置（`~/.claude/settings.json` 等），而非 `<projectRoot>`

> ——因为它们依据传给 `hook-dispatch` 的 `cwd` 门控，且 `~/.claude` 恒存在、能通过「已安装工具」门槛（详见 Hooks 章节）。团队自己的 hooks（`hooks/hooks.yaml`）对 Claude Code 和 Codex 则写入主 checkout，不加门控（`<主 checkout>/.claude/settings.local.json`、`<主 checkout>/.codex/hooks.json`），项目的所有 worktree 共用一份。路径遵循项目的 `toolPaths`；Claude 在其配置的 settings 文件旁使用 `settings.local.json`。bare 仓库没有主 checkout，因此各 worktree 保留自己的副本；其他工具仍写在 HOME，仅在 `cwd` 位于该项目内时运行。在没有 teamai 配置的目录中（既没有 project 配置也没有 user scope），团队 hooks 不做任何事：不显示提醒，也不记录会话或 skill 使用；

> 只运行机器级别的工作（CLI 更新检查、SessionStart 时的 pull、本地 agent，以及 pull 暂存的包提示）。对团队 hooks 和 skill 使用记录而言，存在但无法读取的 project 配置视为没有配置，而不会退回 user scope，也不会退回其后优先级更低的 project 配置（如旧的 `.teamai/config.yaml`）。`pull` 遵循同一规则：此时不同步任何 scope，输出 ``Nothing was synced: <file>: <reason>. 

> Fix the file, or move it aside and run `teamai init` to write a new one.`` 并以 exit 1 退出（加 `--silent` 时不输出，但仍以 exit 1 退出）；会话启动时不运行 pull，也不创建 agent 目录、不暂存包提示。`cwd` 已被删除的 hook（会话比它的 worktree 活得更久）沿用该会话最后记录的 scope，因此会话最后的事件和 skill 使用仍归属项目，分享提醒也遵循项目的设置，而不是 user scope 的。这需要本地事件日志中仍保留该会话之前的事件（压缩只保留活跃会话），且不适用于 Copilot，因为它的事件不记录目录。self 单仓模式则把 hooks 保留在业务仓库里，随 clone 传播。

启用角色化 skills 后，`pull` 的 skills 同步来源会变成 `skills/<namespace>/` 中的内容，按 `primaryRole + additionalRoles` 展开对应的 namespace，拍平安装到本地各 AI 工具 skills 目录。`rules/<namespace>/` 和 `claudemd/<namespace>/` 按 `knowledge` namespace 同步，`docs/<namespace>/` 在被声明后按 `docs` namespace 同步（见 [Docs（文档）](./sharing.md#docs文档)）；`agents/<namespace>/` 按角色的 `agents` namespace 同步（见 [Agents 资源类型](./advanced.md#agents-资源类型)）。`learnings/` 根目录对所有人共享，而 `learnings/<project-id>/` 子目录只对本目录激活的项目同步（见 [多项目](./admin-setup.md#多项目project-作为与-role-正交的维度)）。

**namespace 中的条目会替换根目录的同名条目。** 配置了角色或项目时，活跃 namespace 中的条目会取代根目录中的同名条目下发。替换以整个条目为单位，不做合并：

- skill 按目录名替换根目录的同名 skill，包括你通过标签收到的根目录 skill。安装时会删除被替换版本的文件；任何团队版本都没有的文件会保留。
- agent 按文件名（不含扩展名）替换根目录的同名 agent。
- rule 按第一层文件名替换：`rules/<ns>/<name>.md` 替换 `rules/<name>.md`，Hermes 的 `SOUL.md` 区块以及 session-start hook 或 Pi 扩展添加的 rule 同样如此。更深的路径（如 `rules/<ns>/<dir>/<name>.md`）不替换任何文件，被你的标签订阅排除的 namespace rule 也不替换。在与你自己的 rule 共用的目录中（除 Cursor 外每个有自有 rules 格式的工具：JoyCode、Copilot、Kiro、Qoder、CodeBuddy、WorkBuddy 和 Oh My Pi），被替换的根 rule 副本只在仍是 teamai 所下发的内容（当前的根 rule，或你上次 pull 时的版本）时删除；你改过的副本会保留，且每次 pull 都会点名它，因为工具会把它与 namespace rule 一起加载。
- `claudemd/<ns>/<name>.md` 在托管区块中替换 `claudemd/<name>.md`。

该 namespace 不再活跃后，下一次 pull 会重新下发根目录条目。两个活跃 namespace 定义同名 skill 或 agent 时，它们会争用同一个安装文件，因此 pull 会报错并列出两个文件，本次运行不更新该类型，已安装的内容保持不变（skills 在 recall 中已有的索引也保持不变）；其他资源类型照常同步。两个活跃 namespace 定义同名 rule 或共享指令时，两者都会下发，因为它们各有自己的位置（本地的 `rules/<ns>/`、区块中各自的一段）；只有根目录的那一份会让位。`push` 会把被替换条目的修改写回其 namespace，而不会写到根目录；

recall 只索引你实际收到的 skills 和 rules，而不是仓库中的全部内容。无法使用的替换项不会替换任何内容：没有 `SKILL.md` 的 skill 目录不会下发，pull 会点名提示；agent 文件无法解析时，它原本要替换的 agent 保持安装。`teamai doctor` 会以提示的形式列出每一处替换。未配置角色或项目时行为不变：所有 namespace 与根目录并列下发，`doctor` 会列出团队仓库中重复定义的每个名称。

项目可能需要覆盖的共享内容应放在根目录，而不是放在每个角色都会激活的 namespace 中：根目录条目会让位给活跃的 namespace，namespace 条目则不会。例如，公司的 `rules/code-style.md` 放在根目录；需要不同规范的 checkout 项目添加 `rules/checkout/code-style.md`。激活了 `checkout` 的成员拿到项目版本，其他人仍使用共享版本。如果共享规则放在 `rules/common/code-style.md`，checkout 成员就会同时收到两份。

### 团队包

`teamai packages` 通过现有团队仓库统一声明和恢复 npm 包与 Claude Code 插件。TeamAI 调用原生 `npm` 和 `claude plugin` CLI，不自行分发包内容。

**管理员操作：**

传入 target 时，命令会完成安装，并将声明写入团队仓库的 `teamai.yaml`：

```bash
# npm 包（默认安装为项目依赖）
teamai packages install typescript

# 未带 scope 的 name@version 与 plugin@marketplace 有歧义，需显式指定 npm
teamai packages install typescript@5.9.2 --npm

# 从指定 registry 安装全局 npm CLI
teamai packages install eslint@latest --global \
  --registry https://registry.npmjs.org/

# Claude 插件
teamai packages install code-review@claude-plugins-official

# 通过现有评审流程分享更新后的 teamai.yaml
teamai push
```

npm target 支持 `name` 或 `name@version`。由于未带 scope 的 `name@value` 也可能表示 `plugin@marketplace`，当后缀不是已声明或已注册的 Claude marketplace 时需使用 `--npm`。带 scope 的 npm 名称（`@scope/name`）、无版本名称、`--global` 和 `--registry` 已能明确表示 npm，不会探测 Claude CLI。安装项目依赖时，当前目录必须包含 `package.json`；机器级 CLI 工具使用 `--global`。`--registry` 会随该包的声明保存，且必须是不包含凭据的 HTTP(S) URL。registry 认证信息应保存在 npm 配置或环境变量中。

Claude 插件 target 使用 `plugin@marketplace` 格式。`claude-plugins-official` 官方 marketplace 会自动解析；使用其他 marketplace 前，需先在 Claude Code 中注册，以便 TeamAI 获取并记录其来源。可使用 `--claude` 明确指定生态，并在 marketplace 不可用时获得针对性的错误。存在歧义的 target 会直接失败，不会运行任一包管理器。`--global` 和 `--registry` 仅适用于 npm target。

**成员操作：**

现有 SessionStart hook 会执行 `teamai pull`。当 `packages` 声明发生变化时，它只会提示成员检查 `teamai.yaml` 并主动安装，不会自动执行第三方包或插件代码。pull 继续在后台运行，避免网络延迟阻塞 IDE；如果声明在 SessionStart 输出窗口结束后才拉取完成，TeamAI 会把同一条提示安全地排队，并在本会话下一次 UserPromptSubmit 时投递。

```bash
teamai packages             # 安装团队声明的全部包和插件
teamai packages --dry-run   # 预览底层命令，不安装也不写文件
teamai doctor              # 检查运行环境、声明的包/marketplace/插件状态，以及磁盘上实际落地的资源；任一检查失败时退出码为 1
```

安装成功后，TeamAI 会在当前 scope 的数据目录（项目为 `~/.teamai/projects/<slug>/`，user scope 为 `~/.teamai/`）写入本地快照 `teamai.lock`，不会写入工作区。旧版本写在 `.teamai/teamai.lock` 的文件会在下次安装或会话启动时移到这里，旧版本为隐藏它而创建的 `.teamai/.gitignore` 也会删除。如果仓库跟踪了该文件，它会留在原处（移走会在 `git status` 中留下一条删除记录）：teamai 在数据目录有自己的副本之前从原处读取它，`teamai doctor` 会指出它，并给出停止跟踪的命令 `git rm --cached .teamai/teamai.lock`。该文件记录已安装版本，以及供 SessionStart 提示比对的声明哈希，不会写入团队仓库。在 user scope 下，全局 npm 工具和 Claude 插件只需确认一次；

项目 npm 依赖会按工作目录分别确认，避免在一个仓库安装后错误关闭另一个仓库的提示。

**声明格式：**

以下内容由 `teamai packages install <target>` 自动维护：

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
    - name: eslint
      version: latest
      global: true
      registry: https://registry.npmjs.org/
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

- `npm[].version` 默认为 `*`，`global` 默认为 `false`。
- `claude.marketplaces` 记录 marketplace 名称与仓库来源。
- Claude 插件必须使用 `plugin@marketplace` 格式，且对应 marketplace 必须已声明。
- `packages` 内未知或拼错的键会在 install 或 push 前被拒绝。
- 包声明对全团队生效，不受角色或项目筛选影响。

### 排除个人不需要的 Skill

如果团队共享的某个 skill 不适合你，可以只在本地将它排除，无需修改团队仓库，也不会影响其他成员：

```bash
teamai skill exclude add using-superpowers --dry-run # 预览操作，不修改配置或 pull 状态
teamai skill exclude add using-superpowers
teamai pull                    # 从本地 AI 工具中删除
teamai skill exclude list

teamai skill exclude remove using-superpowers --dry-run # 预览操作，不修改配置或 pull 状态
teamai skill exclude remove using-superpowers
teamai pull                    # 重新同步
```

排除列表保存在当前 user 或 project scope 的 `config.yaml` 中：

```yaml
excludedSkills:
  - using-superpowers
```

排除规则在角色和标签过滤之后生效。执行 `teamai pull` 时，被排除的 skill 不会同步，并且会清理由之前 pull 安装的副本。`teamai doctor` 会把最终结果集与磁盘实际内容比对，并且不会要求被排除的 skill 存在。

### 推送本地资源

扫描前，`push` 会用团队仓库的新版刷新未修改的旧规则副本。对于有自有规则格式的工具（Cursor 的 `.mdc`、JoyCode 自己的 `.mdc`、Copilot 的 `.instructions.md`、Kiro steering，以及 Qoder、CodeBuddy、WorkBuddy 与 Oh My Pi rules），会单独比较 Markdown 正文，忽略自动生成的头部，并以该工具的格式写入更新；本地正文编辑会保留。对 Copilot，此行为适用于项目规则和 `COPILOT_HOME` 下的用户规则。它刷新的每份副本都会记录为 teamai 写入的内容，因此下一次 `teamai pull` 仍会更新它，而不会当作你的修改保留。这些工具的 rules 目录中新建的文件是你自己的、该工具格式的 rule，因此 `push` 从不提交它；

要分享新的团队 rule，请把它写成 `.claude/rules/` 下的普通 `.md`（需要时用 `paths:` 限定范围），再 push。

团队仅修改 `paths` 时，只要本地文件仍与某个已记录版本的生成副本一致，`push` 也会刷新 Copilot 的 `applyTo`；此时本地手动修改过的头部会保留。

规则预同步会跳过被 `enabledAgents` 或 `disabledAgents` 排除的工具，即使其配置目录仍然存在。

```bash
teamai push          # 扫描新增/修改的资源，创建 MR
teamai push --all    # 跳过确认，直接推送
teamai push --role pm  # 推送到 pm namespace（skills/pm/、rules/pm/、agents/pm/）
teamai push --branch feature/gitee-destination  # 使用显式目标分支
```

`--branch` 指定新推送使用的分支；已有开放 PR 始终沿用其记录的分支进行更新。如果团队仓库 clone 存在用户修改、暂存、未跟踪或冲突文件，TeamAI 会在 push 前拒绝执行；TeamAI 自己管理的 `teamai.yaml`、`teamai env add` 修改的 env 文件和 sync-lock 状态会单独处理。其他本地改动请先提交或 stash。

**命名空间选择（新资源）：** 推送新的 skill、rule 或 agent 时，CLI 会自动检测可用的命名空间并提供交互式选择：

```
Which namespace should new skills be pushed to?
  1. common
  2. hai
  3. pm
Choose namespace [1-3] (default: 1 = common):
```

- 每种资源类型按各自维度解析：skill 用 `skills`，rule 用 `knowledge`，agent 用 `agents`。一次推送涉及多种类型时，每个维度各询问一次
- 有 `primaryRole` 时，从 manifest 展开可用 namespace 列表
- 无 `primaryRole` 时，skill 自动扫描团队仓库目录结构；新的 rule / agent 保留在共享根目录
- 单一命名空间时自动选中；也可用 `--role <id>` 显式指定
- 修改已有资源时自动保持原 namespace
- 每个资源的落点都会打印出来，例如 `[rules] my-rule → rules/pm/my-rule.md`
- 若 roles manifest 存在却无法给出答案，命令会报错停止，而不会退回共享根目录。未包含当前配置的角色时：请修复 `manifest/roles.yaml`、执行 `teamai roles set <role>`，或用 `--role <ns>` 显式指定。无法读取、无法解析或为空时，push 在扫描阶段即停止（exit 2），早于 `--role` 生效，因为扫描需要 manifest 才能判断哪些 namespace 属于你：请先修复 `manifest/roles.yaml`。团队仓库根本没有 `manifest/roles.yaml` 时，保持原有行为
- `teamai push --dry-run` 会做同样的落点解析，并在同样的无法解析情况下报错，不会把真实命令会拒绝的推送报为可行
- 当有多个 namespace 可接收新资源、且没有可供询问的终端（CI、hook、`TEAMAI_NONINTERACTIVE`）时，push 会以退出码 2 停止，列出这些 namespace，并要求使用 `--role <ns>`
- `--role`/`--project` 只放置新资源。对共享根目录 rule 或 agent 的修改仍留在共享根目录，push 会给出提示
- 已落点的资源在发布它的机器上仍可维护：PR 未合并期间，待评审 PR 记录会把作者对自己副本的修改带回该 PR；文件进入默认分支后，`state.json` 会记录 push 的落点，因此修改仍会写回同一个文件；即使 agent 落在本目录未激活的 namespace，也不会被当作“无活跃源”跳过
- `teamai remove rules <name>` 同时接受作者副本的简名和发布名 `<namespace>/<name>`：会打印实际解析到的名字，并同时删除带 namespace 的团队文件和作者在 rules 根目录的副本。若无法先刷新团队仓库，或本机的落点记录无法更新并保存，`remove` 会以退出码 1 停止且不删除任何内容，因为两者都可能把名字解析到错误的文件。`--dry-run` 只执行 fetch：

  按真实 pull 后的克隆当前分支内容解析名字（单仓模式使用 origin 默认分支），且不保存任何落点记录。克隆预览先 fetch 配置的上游，包括名称不同的分支或远程。无法快进或没有上游时，再 fetch origin/当前分支以模拟真实 reset 回退。两种刷新都无法成功时，本地分支的删除预览会拒绝运行。克隆模式下 fetch 失败时，预览会使用与真实删除相同的拒绝消息，并以退出码 1 停止。克隆存在未提交更改时，预览也会以退出码 1 拒绝运行，请先 commit 或 stash。业务文件的未提交更改不会阻止单仓模式预览。
- 本地 agent 被视为其来源团队 agent 的编辑：优先是活跃 namespace 中的 agent，其次是本机放置的 agent，最后是被二者替换的共享根目录 agent。只有三者都不存在时，才由 `--role`/`--project` 决定，此时该 agent 在该 namespace 中是新的；

  若该 namespace 已有同名 agent，则跳过该 agent 而不是覆盖它，与 rule 的处理一致。两个活跃的同名 agent 无论是否指定参数都视为有歧义并跳过。同名 agent 允许存在于多个 namespace，因此你未指定的非活跃 namespace 中的同名副本不会阻止你发布。本机放置的 agent 若在当前检出上次同步后被团队修改，会暂缓推送，因为 agents 没有推送前同步。pull 会保留你修改过的副本，因此请先另存你的修改，删除该副本，执行 `teamai pull --force`，重新应用修改后再 push。单仓库模式下，`.teamai/` 中的根目录副本若与其落点文件的某个旧版本相同，也会暂缓推送：没有任何操作会刷新它，因此它是旧副本而不是编辑
- 新资源绝不会覆盖已存在的资源：若解析出的 namespace 下已有同名文件，命令会报错并指出该文件：请先 pull 并修改已有副本、重命名自己的资源，或用 `--role <ns>` 换一个 namespace
- 本目录未激活的 namespace 下的 agent 可通过落点记录继续编辑，`pull` 也会基于同一记录下发它，使本地副本与团队文件保持同步；它会像活跃 namespace 中的 agent 一样替换共享根目录的同名 agent。若已激活的 namespace 中已有同名 agent，则以它为准
- 待评审 PR 中的资源默认沿用该 PR 的落点；但若本次 push 明确指定的 namespace 与记录的落点不同（共享根目录也算一种落点），则以命令行为准，原 PR 保持不动，并提示该冲突
- push 开始时若无法刷新团队仓库，`--project` 会报错停止，而不会按可能已过期的 `manifest/projects.yaml` 落点；未使用 `--role` 放置的任何新资源同样如此，因为其落点来自该克隆（`manifest/roles.yaml`、它的缺失，或仓库中已有的 namespace）。请先修复 pull 再重试，或用 `--role <ns>` 显式指定 namespace。若本机的落点记录无法更新并保存，`push` 也会停止且不推送任何内容
- 落点记录只在推送的文件进入默认分支后才写入，因此未合并即关闭的 PR 不会留下记录，无论其分支是否还在。团队删除该文件时，记录会被清除。未配置角色或项目时，共享根目录出现同名文件也会清除记录（此时你的根目录副本改为跟随该文件，`pull` 会提示）；配置了角色或项目时，放置的资源会在本机替换该共享根目录资源，记录保留。`push`、`pull` 和 `remove` 都会在读取记录前先做这一步。`teamai remove` 本身不清除记录：

  删除要等其 PR 合并才进入默认分支，在此之前重试 `remove` 仍会把简名解析到带 namespace 的团队文件。若该文件进入默认分支时的内容与你推送的不同（例如评审者在 squash 合并前修改了 PR），则不会写入记录，push 会提示一次；此时运行 `teamai pull`，并把该文件当作现在的团队文件来编辑
- 你自己发布到某个 namespace 的 rule，其本地副本仍留在 rules 根目录。该 namespace 在本目录激活时，`pull` 会直接更新这个副本，而不会在 `rules/<namespace>/` 下再写一份；未激活时 `pull` 不会动它。配置了角色或项目时，共享根目录的同名 rule 不会下发到这个副本上：你放置的 rule 会替换它。只有当它对应的团队文件不存在时才会被清理

**更新已存在的 PR 而非重复创建：** 如果某个资源已在一个未合并的 PR 中等待评审，再次对它执行 `teamai push` 会就地更新那个已存在的 PR（通过 force-push 其分支），而不是新开一个重复的 PR。保持该资源被选中即更新其 PR；取消勾选则不动它。同一次运行中选中的其他无关资源会进入各自新开的 PR。一旦该 PR 合并（或其分支从远端删除），记录会被清除，下次 push 照常新开 PR。

**YAML Frontmatter 自动补全：** 推送时 CLI 自动检查合法的 mapping 形式 `SKILL.md` frontmatter，缺少 `name`/`description` 则自动补全。格式损坏或根节点为标量时会保留原文并告警，需要手动修复。

### 查看状态

```bash
teamai status        # 当前 scope、同步时间、资源统计
teamai status --all  # 列出 ~/.teamai/projects 下所有项目数据分区
```

`Team resources` 中的 `skills` 数量与 `teamai list skills --source repo` 的团队仓库列表一致，
包含平铺技能（`skills/<name>/SKILL.md`）和 namespace 下的技能
（`skills/<namespace>/<name>/SKILL.md`）。namespace 目录及技能包内部的子模块不单独计数。
例如，`skills/ai/` 下有 6 个技能，另有 `skills/officecli/`，总数为 7。

`docs` 递归统计 `docs/` 下的文件，排除隐藏文件和隐藏目录。全部放在子目录里的文档也会被
`pull` 发现并同步。此资源摘要不包含经验数量；经验在根目录全团队共享，或按启用的项目选择，
不按角色划分。

`--all` 会枚举每个项目的机器数据分区，并标注为 **active**（项目仍在磁盘上）、
**ORPHAN**（项目已移动/删除——该分区可安全 `rm -rf`）或 **unknown**（无 `anchor`
文件，无法确认是否孤儿——绝不建议删除）。ORPHAN 判定只依据 anchor，因此绝不会凭猜测
把分区标记为可删除。teamai 从不自动回收孤儿分区，因此这是你找出可手动删除分区的方式。

### 角色管理

角色（Roles）控制每个成员看到哪些 skills、namespace 化的 rules 与 agents。管理员通过 `manifest/roles.yaml` 定义角色，成员选择自己的角色后，pull 会同步对应 namespace 的 skills。启用标签订阅后，还可以额外同步其他 namespace 中显式匹配标签的 skills，但不会包含非活跃 namespace 中未打标签的 skills。

**管理员操作：**

```bash
# 初始化（交互式创建 manifest）
teamai roles init

# 添加角色
teamai roles add devops --namespaces common,infra -d "基础设施团队"

# 修改角色（增删 namespace、改描述）
teamai roles update hai --add-namespaces infra
teamai roles update hai --remove-namespaces legacy -d "新描述"

# 删除角色
teamai roles remove devops

# 预览变更
teamai roles add test --namespaces common,test --dry-run
```

`--namespaces` 列表会同时应用到 `knowledge`、`skills` 与 `agents`。以上命令会自动 push 分支并创建 MR，合并后对全团队生效。加 `--dry-run` 时，`teamai roles init/add/update/remove` 与 `teamai projects add/update/remove` 只 fetch 并读取真实 pull 后的克隆当前分支 manifest（单仓模式使用 origin 默认分支），不会 pull 团队仓库，单仓模式下也不会创建 worktree，因此尚未推送的提交会保留。若 fetch 失败，这些 manifest 预览会警告并使用未改变的克隆检出，单仓模式则使用上次获取的默认分支副本，与真实编辑在 pull 失败后警告并继续的策略一致。

克隆预览遇到未提交更改时会以退出码 1 拒绝运行，并提示先 commit 或 stash，因为真实 pull 可能保留本地 manifest 编辑。业务文件的未提交更改不会阻止单仓模式预览。干净克隆预览会保留领先分支、快进落后分支，分叉时使用 origin/当前分支，与真实 pull 一致。`roles init --dry-run` 在临时检出内检查已有 manifest 并询问是否覆盖。克隆模式下，真实 `roles init` 只在检查已有 manifest 和交互提问之前 pull 一次，写入之前不会再次 pull。

**成员操作：**

```bash
# 查看可选角色
teamai roles list

# 选择自己的角色
teamai roles set hai
teamai roles set hai --add pm    # 主角色 hai + 额外角色 pm

# 同步新角色的资源
teamai pull
```

> **安全降级：** 如果管理员删除了某个角色，仍然配置了该角色的成员在 pull 时不会报错，而是回退到全量同步并输出警告，提示重新选择角色。

### 标签订阅

标签让成员订阅默认角色 namespace 之外的指定 skills 和 rules。

```bash
teamai tags list
teamai tags subscribe frontend testing
teamai tags unsubscribe testing
```

管理员可通过 `teamai tags add` 和 `teamai tags remove` 管理资源标签。修改订阅后运行 `teamai pull`，即使团队仓库没有变化也会执行全量同步，新匹配的资源会被安装，取消订阅的资源会被清理。该次 pull 结束时的检查会确认新匹配的 skill 已送达每个启用的工具。

---

## 提交 Co-Author 署名

AI 编码工具会在它生成的提交上打一个 `Co-Authored-By:` / attribution 尾注。希望保持干净历史的团队可以为全员关闭它，成员仍可在自己机器上覆盖。`teamai pull` 会把最终生效的意图写入每个已安装工具各自的配置文件。

该功能采用与 recall 相同的两级配置：

| 层级 | 配置文件 | 字段 | 说明 |
|------|----------|------|------|
| 团队默认 | `teamai.yaml` | `sharing.coAuthor.enabled` | `true` = 保留尾注 / `false` = 去除尾注。整块省略表示"无意见"（teamai 不做任何改动） |
| 用户覆盖 | `~/.teamai/config.yaml` | `coAuthorEnabled` | `true` / `false`，优先级高于团队默认 |

不同工具家族映射到不同的设置项：

| 工具家族 | 文件 | 写入的设置 | 作用域 | 可靠性 |
|------|------|------|------|------|
| Claude（`claude`、`codebuddy`、`workbuddy`） | 用户 scope：`settings.json`；项目 scope：`.claude/settings.local.json` | `attribution.commit` / `attribution.pr` 置为 `""` | 用户 **或** 项目（跟随当前 scope）；项目 scope 下仅 `claude`，写入成员本地文件 | 确定生效 |
| Codex（`codex`） | `~/.codex/config.toml` | `commit_attribution = ""` | 仅用户 | 尽力而为 —— 仅当 `[features].codex_git_commit = true` 时生效，teamai 不会强制开启该开关 |
| Cursor | `~/.cursor/cli-config.json` | `attribution.attributeCommitsToAgent = false` | 仅用户 | 尽力而为 —— 存在[上游已知 bug](https://forum.cursor.com/t/local-executor-ignores-cli-config-attribution-opt-out-forcing-co-authored-by-trailer/167722)，local executor 可能忽略该设置 |

语义：

- **只写不删。** teamai 一旦写入某个值，之后团队撤下策略也不会改动该值 —— teamai 绝不还原它去除过的尾注。若要重新启用，请显式把意图设回 `true`（这会移除 teamai 的覆盖，从而恢复工具自身的默认行为）。
- **幂等。** teamai 在 `state.json` 的 `coAuthorManaged` 中记录每个文件上次写入的值，无变化时跳过写入。
- **只改动已安装的工具**，并保留各配置文件中已有的键与注释（键级别的精修，而非整文件重生成）。
- **不改动共享的项目文件。** 该选择属于成员个人，而项目的 `.claude/settings.json` 往往纳入版本控制，因此在项目 scope 下 teamai 只写 Claude 的成员本地文件 `.claude/settings.local.json`，其他 Claude 家族工具只在用户 scope 下处理。此修复之前的版本会写入共享的项目 `settings.json`；

  下一次 `pull` 仅当其中的 `attribution` 恰好是 teamai 写入的 `{"commit": "", "pr": ""}`、且 teamai 记录过曾写入该文件时才移除它，并且只删除这一个键。若该文件已纳入版本控制，请提交这一改动。若团队和你都没有设置 co-author 选择，下一次 `pull` 会在同样的条件下把该值从 `.claude/settings.json` 移到 `.claude/settings.local.json`，你的署名设置保持不变（你已在 `settings.local.json` 中设置的值会保留）；其他 Claude 家族工具的共享 settings 文件则保持原样，直到有了选择。

`pull` 之后请重启 AI 工具会话使改动生效。
