# 管理员初始化

> [English](../admin-setup.md) | [简体中文](admin-setup.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 管理员初始化

> 只需一位管理员完成，其他成员跳到[成员接入](./member-guide.md#成员接入)。

在 GitHub、GitLab（gitlab.com 或自建实例）、GitCode（gitcode.com）、CNB（cnb.cool）、TGit，或任意私有/自建 Git 服务上创建一个空仓库（命名建议：`TeamAi-<团队名>`）。对于支持自动建仓的 provider，也可直接执行 `teamai init`，按提示创建尚不存在的仓库。

> **CNB 例外：** `cnb login` 令牌既不能建组织（`group-manage:rw`）也不能建仓库（`group-resource:rw`），`init` 会改为打印网页链接引导你创建后重新运行——组织不存在用 `https://cnb.cool/new/groups`，无权限建仓库用 `https://cnb.cool/new/repos`；如需 CLI 直接创建，请改用带这些权限的 `CNB_TOKEN` access token。

使用自建 GitLab 时，先配置实例地址和具有 `api` 权限的 Personal Access Token：

```bash
export GITLAB_URL=https://git.example.com
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxx
teamai init https://git.example.com/yourgroup/yourrepo
```

也可以不设 `GITLAB_URL`，只设 `TEAMAI_GITLAB_HOST=git.example.com`：此时 API 指向 `https://git.example.com`。两者同时设置时必须是同一个 host，否则 teamai 会在发送 token 前停止。

对于未知 host，`init` 会匿名检查 GitLab 登录页，总超时为三秒。确认是 GitLab 后，会在认证、克隆或写入配置前停止，提示设置实例地址和 token 后重试。探测不发送 token，也不跟随重定向。无法确认时，初始化继续使用通用 `git` provider；它支持 Git 传输，但不能自动建仓或创建 PR/MR。实例若由 SSO 遮蔽、部署在子路径下，或无法被探测访问，请显式设置 `GITLAB_URL`。

只同步资源、从不需要 CLI 创建 MR 的成员可以不配 token：见[成员接入](./member-guide.md#成员接入)中的 `--provider git`。

**已经初始化为 `provider: git`？** 设置上述环境变量，并把团队仓库 `teamai.yaml` 中的 `provider` 改为 `gitlab`。仅设置环境变量不会改变已有 provider 选择。失败的 `teamai push` 可能已经推送了分支；若其诊断探测到 GitLab，会输出这些修复步骤。详见 [Provider 配置](providers.md#gitlab-provider含自托管)。

### 项目级（Project Scope，默认）

资源安装到项目目录下（`<project>/.claude/skills/` 等），适用于项目特定的技能和规则。

```bash
# project 是默认值，可省略 --scope
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo
# 等价别名：teamai init --repo https://github.com/yourorg/yourrepo
```

生成的目录结构：

```
/path/to/my-project/          # 你的业务仓库 —— 零 teamai 残留
├── .claude/skills/              # 项目级 skills（自动同步）
├── .claude/rules/               # 项目级 rules（自动同步）
└── src/

~/.teamai/projects/<path-slug>-<hash>/  # 本项目的机器数据分区（slug 由项目路径派生）
├── config.yaml
├── state.json
├── team-repo/                           # 团队仓库克隆（知识资产在默认分支）
├── learnings-wt/                        # `teamai-learnings` 孤儿分支的检出
├── pending-learnings/                   # 尚未发布的贡献
└── reports-wt/                          # `teamai-reports` 孤儿分支的检出
```

独立 git clone 与单仓模式使用同一套拆分：`members/` `sessions/` `votes/` `stats/` 写到 `teamai-reports` 孤儿分支，`learnings/` 写到 `teamai-learnings`（两个检出目录都在 clone **旁边**，不嵌在 clone 里）。知识资产（`skills/` `rules/` `docs/` `teamai.yaml`）仍在默认分支，通过 PR 写入。默认分支上已有的上报文件与 learnings 都留在原地：`members/` 仍会从默认分支副本读取（只读继承根，不复制也不删除；同一文件两处都有时以分支副本为准），其余上报数据从此被忽略，learnings 仍会被读取。

两种模式下，只读取上报数据的命令（`members`、`digest`、`projects members`、`stats`）都不会创建或推送 `teamai-reports` 分支。`teamai pull` 在重建检索索引（投票热度）和技能推荐之前，会先从 `origin` 刷新上报检出。写入上报（`session save --push`、Stop hook 投票、成员注册、自动上报）会先合并 `origin` 上该成员文件的最新副本，因此同一成员在两台机器上报时不会丢掉会话、投票或统计。

项目的机器数据（config、state、team-repo 克隆、搜索索引、MCP manifest、资源缓存）
存放在 `~/.teamai/projects/<slug>/` 下的按项目分区里，**不再**放进业务仓库，因此工作区
无 teamai 残留，且同一仓库的 `git worktree` 共享同一分区。在新 worktree 中首次执行
`teamai pull` 会向它完整同步一次，即使团队仓库自另一个检出 pull 之后并未变化。worktree 尚未 pull 过时，
若 `teamai push` 发现与团队仓库不同的团队 rule 或 skill 就会停止，因为无法区分队友的更新和你的修改。
`teamai pull` 会覆盖这些文件：如有修改，请先另存一份，再在该 worktree 中执行 `teamai pull`，放回修改后重新 push。各 Agent 的项目根目录
（`.claude/`、`.cursor/`、`.codebuddy/` 等）仍在工作区内创建。`teamai init` 会为你选择的每个工具
创建根目录，并在结束时执行一次 pull 将其填充：用 `--agent <tool>` 指定工具；或在终端中不带 `--agent`
运行时，从与单仓库模式相同的选择器中勾选（第 1 项 **Auto** 为你 home 目录下已安装的工具，也是回车默认项）。
所选工具会追加到 `enabledAgents`，因此重新执行只会新增工具，不会丢掉之前的选择。否则由 **SessionStart** 按刚打开的
工具创建：打开 Claude Code 时会创建 `.claude/`，再由 pull 写入。单独执行 `teamai pull`，以及非交互且不带
`--agent` 的 `init`，仍会跳过项目里还不存在根目录的工具，因此不会给尚未在本项目选择或打开过的 Agent 凭空建目录。

新 worktree 不必等到第一次会话。在项目 scope 下，`teamai init` 与 `teamai pull` 会在仓库的本地
git 配置中安装一个 git hook，所有 worktree 共用：`hook.teamai-post-checkout`、
`hook.teamai-post-merge` 与 `hook.teamai-post-rewrite`（需要 Git 2.54 或更高版本）。Git 会在任何
`core.hooksPath` hook 管理器和 `.git/hooks` 脚本之外一并运行它。当 `git worktree add`，或运行相同
checkout hook 的应用，新建一个检出时，该 hook 会创建 `enabledAgents` 的项目根目录（为空时，取主检出已有的根目录），
并在命令返回前向该 worktree 执行 pull，因此其中的第一次会话就已具备团队的 skill、rule 与 MCP 服务器。
团队仓库克隆若在 24 小时内 fetch 过，这次 pull 直接读取它（否则先 fetch），订阅的 source 读取其缓存克隆；
随后在后台运行一次完整的 `teamai pull --silent`，fetch 团队仓库、source、learnings 与 reports。
切换分支不会触发任何操作。跳过 checkout hook 的宿主需要在 AI 工具启动前完成 `teamai pull` 的准备步骤。
Codex CLI 0.160.0 请先用 `git worktree add` 创建检出，在其中执行 `teamai pull`，再用
`codex exec -C <worktree>` 启动；原生 `codex exec --worktree` 路径会跳过 `post-checkout`。
`git pull` 之后（`post-merge`，或 rebase 完成后的 `post-rewrite`，包括 `pull.rebase=true`；Git 2.32 及更早版本中，开启 autostash 的快进 rebase 只运行 `post-checkout`，同样会同步），该 hook 会 fetch 团队仓库（最多等待 5 秒），
并在 `git pull` 返回前交付其变更；超过 5 秒时，以及 source、learnings 与 reports，交给同样的后台 pull。
单仓库模式下，它交付 `git pull` 刚带来的知识，不访问网络。有冲突的 rebase 仅在完成后同步；
`git commit --amend` 不触发同步。该 hook 不输出任何内容且始终以 0 退出，
因此 pull 失败也不会让 git 命令失败。hook 内的失败（团队仓库 fetch 失败，或在 5 秒上限处被中止而后台 pull
也未完成；另一个 teamai 进程持有项目的同步锁，超过 hook 的等待时间：`git pull` 之后 5 秒（包括单仓库模式），新 worktree 60 秒；资源、hook 或 MCP 未完整交付）
会写入 `~/.teamai/debug.log` 并被记录：`teamai doctor` 会指出它及其修复方法，每次交互式 `teamai pull`
都会提示，直到某次完成为止。后台 pull 会重试，只有所有启动交付阶段都成功后，hook pull 或交互式 pull 才会清除该记录。`teamai doctor` 还会报告 hook
是否已安装并启用。Git 2.54+ 可禁用指定 hook
（`hook.teamai-<event>.enabled=false`）；Git 2.55+ 还可禁用整个事件
（`hook.<event>.enabled=false`）。两种设置均可写在全局、本地或 worktree 配置中。
doctor 检查 Git 的实际生效配置，并按其作用域给出重新启用命令（本地覆盖，或删除本地配置无法覆盖的 worktree 设置）；`teamai pull` 保留显式禁用设置。
启用后运行 `teamai pull` 完成同步。它遵循下文的 scope 规则：没有项目配置，或项目配置无法读取，
都不会同步；无法读取配置的原因保留在 `~/.teamai/debug.log` 中。其命令是一行 `sh`，带着 Git 传入的参数运行 `teamai hook-dispatch <event> --tool git`，
与 Agent hook 一样通过 `~/.teamai/bin` 找到 `teamai`。

Git 低于 2.54 且未设置 `core.hooksPath` 时，teamai 改为在 `.git/hooks/post-checkout`、
`.git/hooks/post-merge` 与 `.git/hooks/post-rewrite` 的 shebang 之后插入一段位于 `# >>> teamai git hook` 与 `# <<< teamai git hook <<<`
标记之间的代码块（脚本不存在时会创建），脚本的其他行保持不变。该代码块运行同一条命令，不输出任何内容，
也不改变脚本的退出码。设置了 `core.hooksPath`（hook 管理器），或 hook 脚本是符号链接或不是可执行的 shell 脚本时，teamai
不写入任何内容，`teamai doctor` 会建议：将 Git 升级到 2.54 或更高版本；或者，如果团队同意提交它，在管理器定义的
post-checkout、post-merge 与 post-rewrite hook 中运行
`command -v teamai >/dev/null 2>&1 && teamai hook-dispatch <event> --tool git "$@" >/dev/null 2>&1 || true`
（`<event>` 为对应的事件名），管理器的配置不是 shell 脚本时用 `sh -c '...'` 包裹。
在没有 teamai 的机器上，这一行什么也不做。
已有 hook 的内容和权限保持不变。读取或写入 hook 失败时，`init` 与 `hooks inject` 会传播该错误；
由 Git 启动的 pull 会记录错误，下一次 `teamai pull` 会重试。

Git 升级到 2.54 或更高版本后，下一次 `teamai pull` 会安装配置 hook 并移除该代码块，避免 hook 运行两次。
`teamai pull --dry-run` 会说明是否将安装或更新该 hook，但不写入任何内容。在项目中运行 `teamai uninstall`
会移除 `hook.teamai-post-checkout`、`hook.teamai-post-merge` 与 `hook.teamai-post-rewrite` 条目以及带标记的代码块；其他 hook 和脚本行保持不变。
移除后只剩 shebang 的脚本是 teamai 创建的，会被删除。

> **从旧版 teamai 升级？** 升级后首次执行 `teamai init` / `pull` / `push` / `contribute`
> （或 `import --from-mr`）会自动把已有的
> `<repo>/.teamai/` 迁移进分区（复制 → 校验 → 原子切换），并把旧目录保留为
> `<repo>/.teamai.bak/`，待你确认一切正常后自行删除。若仓库的另一个检出已完成迁移，
> 旧目录中尚未发布的 learning 队列会先移入分区的队列，绝不会进入备份。若分区已存在但其 `config.yaml`
> 无法读取或缺失，迁移会保留 `<repo>/.teamai/` 并给出带路径的警告：修复或恢复该文件
> （或把缺少 config 的分区移开）后，下一次执行上述任一命令会完成迁移。
> 在旧目录的数据迁移完成之前，`contribute`、`import --from-mr` 与 `init`（`--scope user` 除外）
> 会以退出码 1 停止、不保存任何内容，并说明原因：另一个 teamai 命令正持有其锁、分区 `config.yaml` 如上所述不可用，
> 或旧队列无法移动。处理之后重新执行即可。`contribute --scope user` 与
> `import --from-mr --output` 不写本项目的队列，因此既不触发迁移，也不会因此停止。
> 只读命令与 `hook-dispatch` 路径永不触发迁移；`teamai --dry-run pull` 可预演。**迁移后不支持降级**——旧版会把项目判定为
> 未初始化；`.teamai.bak/` 是人工回滚路径。

如果仓库启用了角色化 skills（存在 `manifest/roles.yaml`），`teamai init` 还会交互式要求你选择：

- `primaryRole`：默认 skill 同步和推送的目标 namespace
- `additionalRoles`：额外需要同步的 skill namespace

角色提示中可以输入一个或多个用逗号分隔的角色编号。第一个编号会保存为 `primaryRole`，后续编号会保存为 `additionalRoles`（例如 `1,3`）。

也可以通过 CLI 参数跳过交互，实现完全非交互式初始化（适合 CI/CD 或 AI agent）：

```bash
GITHUB_TOKEN=ghp_... teamai init https://github.com/yourorg/yourrepo --scope project --role hai_dev --force
```

没有终端时 `init` 不会等待任何人：所有提示取默认值，需要浏览器登录的 provider 会立即失败并指出应准备的凭据（GitHub 用 `GITHUB_TOKEN` / `GH_TOKEN`，CNB 用 `CNB_TOKEN`，GitLab 用 `GITLAB_TOKEN`，GitCode 用 `GITCODE_TOKEN`）。TGit 是例外：它没有可用于无人值守的 token——`TGIT_TOKEN` 仅用于 REST API，git.woa.com 的 git 端点不接受它，因此需要先在该机器的交互式终端执行一次 `gf auth login`，之后无人值守运行会复用它保存的凭据。`git` 本身会关闭自己的提问：`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`（不弹 askpass 对话框）、`GCM_INTERACTIVE=never`，且仅在你自己没有设置该变量时才生效。`ssh` 不在其列：它的批处理选项只能经由 `GIT_SSH_COMMAND` 传入，而该变量会覆盖各仓库自己配置的 `core.sshCommand`，因此 ssh 远端仍可能询问私钥口令或未知主机，需要你自行关闭——在该仓库执行 `git config core.sshCommand 'ssh -o BatchMode=yes'`，或为本次运行导出 `GIT_SSH_COMMAND`。stdin 不是 TTY、或设置了 `CI` / `TEAMAI_NONINTERACTIVE` 时都视为非交互，因此分配了伪终端的 agent 沙箱也能声明自己是无人值守运行。

`init` 的全部参数见 [`commands.md`](../../../skill-data/core/references/commands.md) 和 `teamai init --help`；`--project` 见下文[多项目](#多项目project-作为与-role-正交的维度)。

#### 多项目：`project` 作为与 `role` 正交的维度

当一个团队仓库承载多个项目时，`project` 是与 `role` 平级的第二个分发维度，由
admin 在 `manifest/projects.yaml` 中声明。`role` 回答「我的职能是什么」，`project`
回答「这个目录属于哪个项目」。两者正交且相加 —— 成员得到的是其 role namespace
与激活 project namespace 的**并集**（两者之间没有覆盖关系）。

项目身份跟着工作目录走，与 `--role` 完全同一个模式：

```bash
cd ~/work/hai-inference && teamai init <team-repo> --project hai-inference
cd ~/work/billing       && teamai init <team-repo> --project billing
```

此后每个目录只同步自己项目的 skills/rules/CLAUDE.md 与 learnings。要点：

当 `manifest/projects.yaml` 声明了项目且未传 `--project` 时，交互式
`init` 会在角色选择后询问本目录所属项目。输入逗号分隔的编号可选择多个；
直接回车则保持不属于任何项目。没有交互终端时会保留空项目集，并提示之后可运行
`teamai projects set <id>`。显式传入 `--project` 时跳过选择提示。

- **learnings 隔离。** 仓库 `learnings/` 根目录对全团队共享；项目私有经验放在
  `learnings/<project-id>/` 子目录下，只对该项目成员的 `teamai recall` 可见。
  未激活任何项目的目录只能看到共享的根目录。
- **不自动激活。** 与「唯一 role 会被自动选中」不同，唯一的 project 不会自动选中
  —— 成员可以不属于任何项目（能获得共享的 learnings 根，以及其 role 列出的
  namespace，例如 `common`；没有 role 时不会通过 namespace 收到任何 skill）。
- **根 skill 通过 tag 获取。** 团队启用 roles 或 projects 后，根目录 `skills/`
  是 tag 目录：用 `teamai tags subscribe <tag>` 获取根 skill。pull 删除不再下发的
  skill 时（例如选择 role 或 project 之后），会用一行输出列出它们的名字。
- **一次激活全部。** `--project all` 是保留值：展开为 manifest 声明的全部 id
  并落盘为快照，于是 monorepo 的接入文档只写一行，而不必维护一份「新增项目就会
  漂移」的清单。它是对全部项目（含项目私有 learnings）的显式选择，重跑 `init`
  即重新解析。id 恰好叫 `all` 的项目会被该展开覆盖，但无法用这个 flag 单独选中；
  `teamai projects set all` 走的是字面 id，仍能单独激活它。
- **向后兼容。** 没有 `manifest/projects.yaml` 的仓库行为与之前完全一致；现存扁平
  的 `learnings/*.md` 继续对所有人共享（零迁移）。
- **`teamai contribute`** 在激活项目合计解析出恰好一个 learnings namespace 时，
  默认写入 `learnings/<namespace>/`，否则写入共享根目录。可用 `--namespace <ns>`
  指定其中一个活跃 namespace；`teamai projects list` 会显示默认落点和允许的选项。

`manifest/projects.yaml` 示例：

```yaml
version: 1
projects:
  - id: hai-inference
    name: HAI Inference
    resources:
      knowledge: [hai-inference]
      skills:    [hai-inference]
      learnings: [hai-inference]
      agents:    [hai-inference]   # 可选
```

项目 id 与 `resources:` 下的每个 namespace 都会成为目录名
（`skills/<namespace>/`、`learnings/<namespace>/`、`agents/<namespace>/`），因此
都不能越出自己命名的目录。

**namespace** 必须是单个路径片段：不含 `/`、`\`、`:` 和控制字符，结尾不能是 `.`
或空格，也不能是 Windows 设备名（`CON`、`NUL`、`AUX`、`PRN`、`CONIN$`、`CONOUT$`、`COM1`–`COM9`、
`LPT1`–`LPT9`，含 Windows 同样识别为设备编号的上标形式，带不带扩展名都算）。Windows 会从每个路径片段删除结尾的句点与空格，
因此 `.. ` 最终变成 `..` 越出上级目录，`frontend.` 最终变成 `frontend` 落进另一个
namespace 的目录；该规则同时排除了 `.` 与 `..`。除此之外不受限制 —— 非 ASCII 名称、
名称中间含空格的目录、以及只是以设备名开头的名称（如 `console`）仍然合法。
同一资源类型下的两个 namespace 不能仅有大小写差异（如 `frontend` 与 `Frontend`，按 Unicode 大小写折叠 `σ` 与 `ς` 也算）：在
Windows 与 macOS 的默认文件系统上它们是同一个目录，限定到其中一个的 role 或 project
会读到另一个的资源。该校验跨越两个 manifest，因为 `roles.yaml` 与 `projects.yaml` 共用
同一套 `skills/`、`knowledge/`、`agents/` 目录。

**项目 id** 沿用它原有的、更严格的规则，因为它还会在命令行中输入并按逗号切分：
只允许字母、数字、`.`、`_` 和 `-`，且不能是 `.` 或 `..`。

违反任一规则的 manifest 会解析失败，错误信息会指出具体条目。

**命令**（低频的事后修正与查询，对标 `teamai roles …`）：

```bash
teamai projects list                 # 已定义的项目 + 本目录激活的项目
teamai projects set hai-inference    # 设置本目录激活的项目（覆盖语义；逗号分隔或重复；留空清除）
teamai projects set hai-inference --dry-run # 预览选择，不保存配置
teamai projects members hai-inference # 查看某项目下注册了哪些成员

# 管理员：修改 manifest/projects.yaml 并发起 PR
teamai projects add checkout --namespaces common,checkout --name "Checkout"  # 首次 add 会创建 projects.yaml
teamai projects update checkout --add-namespaces payments --remove-namespaces common
teamai projects remove checkout
```

`--namespaces` 会把同一组 namespace 写入项目的每种资源类型（`knowledge`、`skills`、
`learnings`、`agents`）；`update` 在每种类型各自的列表上增删，因此手工编辑过的按类型
布局会被保留。两者都不会改动 `env`、`hooks`、`mcp`、`models`、`docs` 或 `wiki`：这些请手动声明（见
[Env、hooks 与 MCP server 按 namespace 划分](./sharing.md#envhooks-与-mcp-server-按-namespace-划分)），因为旧版 CLI 的成员读不了它们。执行 `projects remove` 后，仍激活该项目的目录在下一次 pull 时会提示警告、
回退为仅按角色过滤，并清理已部署的该项目 skills、rules 和 agents——前提是该项目的内容
仍在团队仓库中，因为正是靠它识别已部署的副本。请在成员都 pull 过之后，再用单独的变更删除这些内容。

成员登记是 `init` 的**副作用**：执行 `teamai init --project <id>` 会把 `<id>`
追加进你的 `members/<user>.yaml` 名册（跨目录 append + 去重），于是团队侧可以回答
「谁在项目 X」。`teamai push --project <id>` 会按资源类型各自的维度（从 manifest
解析）把新资源推送到该项目对应的 namespace：skill 走 `resources.skills`，rule 走
`resources.knowledge`，agent 走 `resources.agents`。若该项目未为本次推送涉及的类型
声明 namespace，命令会报错并指明该类型，而不会退回共享根目录（那会发给所有人）。

本地配置示例：

```yaml
repo:
  localPath: ~/.teamai/projects/<path-slug>-<hash>/team-repo
  remote: https://github.com/yourorg/yourrepo.git
username: alice
scope: project
projectRoot: /path/to/my-project   # 资源落地位置（当前 checkout）
inheritUserScope: true            # 可选，仅 project scope
primaryRole: hai
additionalRoles:
  - pm
resourceProfileVersion: 1
```

### 用户级（User Scope）

资源安装到用户主目录（`~/.claude/skills/` 等），适用于通用团队规范、跨项目技能。

```bash
teamai init https://github.com/yourorg/yourrepo --scope user
```

生成的目录结构：

```
~/.teamai/
├── config.yaml          # 本地配置
├── team-repo/           # 团队仓库克隆（知识资产在默认分支）
│   ├── teamai.yaml      # 远端团队配置
│   ├── skills/ rules/ docs/ env/
│   ├── manifest/roles.yaml  # 角色定义（启用角色化 skills 时）
│   └── learnings/       # 迁到独立分支之前写下的 learnings
├── learnings-wt/        # `teamai-learnings` 检出（团队知识库）
├── pending-learnings/   # 尚未发布的贡献
├── reports-wt/          # `teamai-reports` 检出（`members/` `sessions/` `votes/` `stats/`）
~/.claude/skills/        # 团队 skills（自动同步）
~/.claude/rules/         # 团队 rules（自动同步）
```

### 如何选择 Scope？

| 维度 | Project Scope（默认） | User Scope |
|------|-------------------|---------------|
| **资源安装位置** | 项目目录下 | `~/` 下 |
| **适用场景** | 项目特定的技能和规则 | 通用团队规范、跨项目技能 |
| **能否共存** | ✅ 可以；project 保持当前 scope，并可选择继承安全的 user 资源 | ✅ 可以；仍是独立的用户主目录级安装 |

> **本机安装位置**仅由 `teamai init` 的 `--scope`（默认 `project`）决定。远端 `teamai.yaml` 中若仍有 `scope` 字段会被忽略。

### 单仓模式（业务仓即团队仓）

无需单独的团队仓库，可以让某个已有项目自己的 git 仓库直接充当团队仓。在项目内运行：

```bash
cd /path/to/my-project
teamai init .                        # 交互式：选择要启用哪些 AI 工具
teamai init . --agent claude,codex   # 非交互：启用 Claude Code + Codex
```

**选择启用哪些 AI 工具。** 单仓模式会在你的仓库里为每个工具创建一个目录（如 `.claude/`、`.codex/`）——建好 skills 目录、注入 teamai hooks，并把该工具的 settings 提交到 main，让队友 clone 后即可获得。由你决定启用哪些工具：

- **`--agent <name...>`** —— 显式列表，可重复或逗号分隔：`--agent claude`、`--agent claude,codex`、`--agent claude --agent cursor`。选择器提供 `claude`、`codex`、`cursor`、`copilot`、`pi`、`joycode`、`codebuddy`、`workbuddy`；`--agent` 也接受其他已知 agent id，例如 `dsh`（DeepSeek Harness）。
- **交互式（无 `--agent`、有终端）** —— teamai 弹出多选列表。第 1 项是 **Auto**，会列出你本机已安装的 AI 工具（`~/.claude`、`~/.codex`……）并作为回车默认项；其余各项是具体工具。Auto 与具体工具可以组合勾选。
- **非交互（无 `--agent`、无终端 —— CI、hook、clone 时自愈 bootstrap）** —— teamai 会按你本机 home 目录下已装的工具（`~/.claude`、`~/.codex`……）来建。若一个都没检测到，则什么都不建（你仍拿到知识，可稍后运行 `teamai init .` 再选工具）。

**数据如何在分支间拆分：**

| 数据 | 存放位置 | 如何写入 | 需要默认分支写权限吗？ |
|------|----------|----------|------------------------|
| 知识资产：`skills/` `rules/` `docs/` `env/` `agents/`、`teamai.yaml` | **main** 分支的 `.teamai/` | `teamai push` → PR | 不需要：推送分支并开 PR 即可 |
| `learnings/` | `teamai-learnings` **孤儿分支** | `teamai contribute` 直接推送 | 不需要 |
| 上报数据：`members/` `sessions/` `votes/` `stats/` | `teamai-reports` **孤儿分支** | `init`、`session save`、hook、pull 自动上报 | 不需要 |
| 本机私有：`config.yaml`、`state.json`、搜索索引（每个检出一份）、env 备份、MCP manifest、`reports-wt/` 与 `learnings-wt/` 检出、待发布队列（`pending-learnings/`） | `~/.teamai/projects/<slug>/`（**分区**，在仓库之外，所有 worktree 共用） | 仅本地 | — |
| 可丢弃的知识 PR worktree（`knowledge-wt/`） | `.teamai/`（已 gitignore；按需重建） | 仅本地 | — |

git 同一分支只能在一个 worktree 中检出，所以仓库的所有检出共用 `teamai-learnings`
和 `teamai-reports` 的检出以及待发布队列。旧版 teamai 把它们放在每个检出自己的
`.teamai/` 里。`init`、`pull`、`push`、`contribute` 和 `import --from-mr` 会把该检出的队列移入分区，第一个需要分支检出
的命令会移除旧检出。旧检出中若有未提交的改动则保留，命令会指出其路径：在你提交、
移走或删除这些改动之前，不会向该分支发布内容，也不会从该分支召回内容，`recall maintenance` 与
`recall promote` 会停止。已排队的 learning
仍留在队列中，仍可被召回。旧版 `import --from-mr`（0.25.0 至 0.26.0-beta.3）写进 learnings 检出却从未提交的 learning
不算在内：下一次 `pull` 或 `contribute`（或排队了 learning 的 `import --from-mr`）会把它排队并发布（放入项目的命名空间，按 `contribute`
的方式命名），并指出它原来的位置，旧检出因此可以移除。若分支或队列中已有同一条（按 `source_mr` 或内容判断），
则删除它，提示中会给出已有的那条 learning。检出无法创建时（例如 `teamai-learnings` 已在别处检出），maintenance 与 promote
同样会停止，并说明原因。
同一项目的 git 模式安装把检出放在相同的路径。切换模式后，teamai 会拒绝使用属于另一个
仓库的检出，并打印清除它的 `git worktree remove` 命令：不会向它发布、不会为它建索引（包括其中的投票）、
也不会改写其中内容（`recall maintenance` 与 `recall promote` 会停止）。旧安装仍在队列中的
learning 会被移到同一数据目录下的 `pending-learnings.<旧类型>`，新安装不会发布它们；`init`
会说明数量和位置，并删除为旧仓库构建的搜索索引（下一次 `recall` 会重建）。以同一类型对另一个团队仓库重新运行 `init`
也同样处理，队列移到 `pending-learnings.<类型>-<仓库>`（例如 `pending-learnings.git-github.com-org-team-a`）；
同一仓库换一种写法（带或不带 `.git`、SSH 或 HTTPS）不会移动队列。克隆另一个团队仓库之前（或复用之前某次 `init` 留下的该仓库克隆之前），
`init` 会把旧的 `config.yaml` 移到旁边的 `config.yaml.previous` 并给出提示：若 `init` 在保存新配置前停止，
所有命令都会要求先运行 `teamai init`，而不会用旧团队的配置操作新的克隆。重新运行 `init` 即可：它会从 `config.yaml.previous` 沿用该配置的设置（agent、工具根目录）。若旧安装的 `config.yaml` 存在但无法读取，
就无从得知队列属于谁：`init` 会把它移到 `pending-learnings.unknown`，指出该文件，并删除搜索索引。尚未升级的检出中的旧队列也同样处理：
在该检出运行的下一个命令会把它移到 `pending-learnings.self` 并给出路径。反过来，当某个检出的 `init --self`
把 git 模式项目切换为单仓库模式，而另一个仍保留旧安装的检出从 main 取得了知识时，在那里运行的下一个
`init`、`pull`、`push`、`contribute` 或 `import --from-mr` 会把旧安装的队列移到 `pending-learnings.git`，
其余部分（config、克隆、env 等）移到 `<checkout>/.teamai.bak/`，知识保持不动。`teamai uninstall` 在请求确认前会列出每个仍有未发布 learning 的队列。
若 `contribute` 或 `import --from-mr` 在迁移正在移动本检出数据、或 `init` 正在切换项目模式或团队仓库时写入队列，
它会等待对方完成（最多 3 秒）。若此时它启动时读取的安装已经变化，它不保存任何内容并以退出码 1 结束
（`This project's teamai install changed while this command ran`），重新执行即可。若等待结束后对方仍未完成，
它同样以退出码 1 结束（`Another teamai command is moving this project's queued learnings`）。
切换前刚写入的 learning 会随旧安装的队列一起被移开，绝不会发布到新仓库。这需要双方都是本版本：
旧版 teamai 的 `contribute` 若与迁移同时运行，其 learning 仍可能留在 `.teamai.bak/` 中。
teamai 无法证明属于本仓库的检出同样会被拒绝，且永不删除：例如其 `.git` 指向已被移动或删除的仓库，
或本仓库已不再登记它（克隆被删除后重新 clone，`init` 在同一路径切换到另一个团队仓库时即是如此）。
请把它移开，或在确认其中没有需要的内容后删除。

learnings 迁到独立分支之前团队已经写下的内容，原地留在默认分支上。不复制、不删除、
不迁移：该目录仍会被读取，所有既有 learning 依然能从 `teamai recall` 中找回。新的
learning 写入 `teamai-learnings`。

**默认分支受保护时所需的最小 Git 权限。**

成员需要：

- 推送 `teamai-reports` 与 `teamai-learnings`，并在这两个 ref 不存在时创建它们
- 推送 `teamai push` 创建的特性分支
- 向默认分支开 PR

成员不需要：

- 直接推送 `main` / `master`
- 绕过分支保护，或拥有管理员权限

打开分支保护后日常使用照常：`init` 注册成员、`pull` 同步、`contribute` 发布、
`push` 开 PR。`provider: git` 下 teamai 无法替你开 PR —— 它会推送分支并打印手动开 PR
的命令；`teamai contribute` 则完全不需要 PR。HTTP 后端不受影响：它通过 API 写入，
根本没有分支。

本机私有数据存放在仓库之外的按项目**分区**里，因此单仓模式的 `.teamai/` 只保留提交到
main 的团队知识 —— `git status` 保持干净。旧版单仓装升级后，下一次
`init`/`pull`/`push`/`contribute` 会自动把这些机器数据搬进分区（main 上的知识原封不动）。

**克隆即初始化。** 由于知识资产和 `.teamai/teamai.yaml` 里的 `mode: self` 标记都提交在 main 上，团队成员 clone 仓库后会被自动初始化：下一条 `teamai` 命令或 AI 会话会识别该标记，并（在其 git provider 已认证的前提下）自动写入本机配置、注入 hooks、在孤儿分支上注册成员 —— 无需手抄 repo/role 参数。若尚未认证，teamai 会提示其运行一次 `teamai init .`。

**安全性。** 单仓模式下 teamai 的每一次 git 写操作（知识 PR 和上报孤儿分支）都在 `.teamai/` 下的隔离 git worktree 中进行，绝不会 checkout、reset 或切换你的工作区和当前分支。隔离 worktree 里的提交会跳过本地 git hook（例如 husky / lint-staged）：从 `origin/<default>` 检出的干净工作区往往只有 hook 脚本、没有本地生成的 `husky.sh`，而且知识/上报文件本来就不该跑业务仓的 lint。你在业务仓里的普通 `git commit` 仍会走 hook。

**管理员在 `teamai init .` 之后的清单：**

1. `teamai init .` 已经帮你把 `.teamai/`（skills、rules、docs、空的 `learnings/`、`teamai.yaml`、`.gitignore`）以及每个所选工具的 settings（如 `.claude/settings.json`、`.codex/hooks.json`）提交到当前分支。贡献的内容不在其中：`teamai contribute` 会把它们推送到 `teamai-learnings` 分支。
2. 推送 main，供团队成员 clone。
3. 之后新增资源用 `teamai push` —— 它会（通过隔离 worktree）向你的仓库开 PR，而不是直接改动你的工作区。单仓模式下，你既可以在 AI 工具目录（如 `~/.claude/skills/`）里编写，**也可以**直接把资源放进仓库里的 `.teamai/`：
   - `.teamai/skills/` —— 团队 skills
   - `.teamai/rules/` —— 共享 rules
   - `.teamai/agents/` —— subagent 定义（`<name>.yaml`，或旧版 `<name>.md`）
   - `.teamai/env/env.yaml` —— 共享环境变量

   `teamai push` 会同时扫描这些目录和你的 AI 工具目录，只呈现真正的新增或修改（已提交的内容会被跳过）。`.teamai/` 下的规则或 skill 如果与团队文件的某个旧版本一致（你的分支落后于默认分支时就会这样），也不算修改：push 会给出警告并跳过它，而不会覆盖队友的更新。如果你改了某个 agent 的扩展名（如 `helper.md` → `helper.yaml`），请手动删掉旧文件 —— `teamai push` 不会替你删除，同 stem 的两个文件会在 pull 时冲突。
4. **docs / hooks / mcp** 通过直接编辑对应文件来贡献 —— 它们不走 `teamai push`，用普通的 `git commit` + push 即可分发：
   - `.teamai/docs/` —— 团队文档
   - `.teamai/hooks/hooks.yaml` —— 团队 hooks
   - `.teamai/mcp/mcp.yaml` —— 共享 MCP servers

> **关于 `env` 的提醒。** 单仓模式下 `.teamai/env/env.yaml` **会被提交到 main**（不同于独立模式的每机本地 env），因此会随 clone 分发给所有人。`env.yaml` 存的是明文键值对 —— 只放非敏感的共享配置。密钥请在 `.teamai/env/secrets.yaml` 中只声明、不写值（见[团队密钥](../../designs/team-secrets.md)），值留在你自己未追踪的环境里。

> **限制。** 单仓模式把一套团队配置绑定到一个业务仓。如果需要一套团队知识库被多个业务仓共享，请改用独立团队仓（`teamai init <repo>`）。

### 在项目仓库下叠加组织级仓库

当一部分经验全组织通用、另一部分只属于具体项目时，可以使用两个 Team Repo。CLI 只安装一次，但两个 scope 各有独立的本地配置和仓库克隆：

```bash
# 每位开发者执行一次：组织通用 skills、rules、docs、agents 和 learnings
teamai init https://github.com/yourorg/engineering-practices --scope user

# 在 Java 项目中：项目资源保持当前 scope，recall 时优先
cd /path/to/java-service
teamai init https://github.com/yourorg/java-service-teamai --inherit-user-scope
```

启用继承后，`teamai pull` 会先把 user 的 `skills`、`rules`、`docs`、`agents`、共享指令/文化和检索索引刷新到用户主目录级位置，再刷新项目目录中的 project scope。user 的 `env`、hooks、MCP 定义、跨团队 sources、usage reporting 和远端仓库写入不会被继承。两个配置和两个 Git 仓库仍然分离；该功能组合的是安全读取路径，不会合并 Git 仓库或文件。同名的已安装资源仍分别位于 user/project 路径，由具体 AI 工具决定运行时优先级；Recall 则明确保证相同资源类型和文件名的 project 条目覆盖 user 条目。
