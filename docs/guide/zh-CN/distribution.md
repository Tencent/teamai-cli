# 分发管理机制

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

装到哪、用哪个仓库，以及谁收到什么，都在这里。没放进 namespace 的文件给所有人。

## 安装范围

### 项目 checkout

同一仓库的 linked worktree 共用项目的 TeamAI 配置和数据，但每个 checkout 都会在自己的工具目录中接收资源。`init` 和 `pull` 会安装 Git checkout hooks，在新 worktree 中为已启用的工具创建根目录并拉取资源，然后 checkout 命令才会返回。有些 agent 工具创建 worktree 时不跑 Git hooks，比如 Claude Code 的 `EnterWorktree` 和 Codex CLI。这样的 worktree 会在其中第一次开会话或第一次用工具时，在后台按同样方式准备好。

在 superproject worktree 中创建的子模块克隆会继承原始子模块的 TeamAI 配置和数据分区。首次 pull 会根据原始配置为克隆创建工具根目录、将资源投递到这些目录，并安装由该克隆拥有的 hooks。每个 checkout 分别记录 hook 所有权；完整卸载会移除所有 checkout 所记录的 hooks。定向卸载行为见[卸载](./faq.md#卸载)。

### 独立的 teamai 仓库

团队资产在单独的仓库里。当前项目只是指向它。

只进当前项目：

```bash
cd /path/to/my-workspace
teamai init https://github.com/your-org/platform-teamai
```

这台机器上的每个项目：

```bash
teamai init https://github.com/your-org/platform-teamai --scope user
```

公司级文件在 `~/`，这个服务的文件在项目里：

```bash
teamai init https://github.com/your-org/engineering-practices --scope user
cd /path/to/java-service
teamai init https://github.com/your-org/java-service-teamai --inherit-user-scope
```

### 将 workspace 固定到团队版本

在使用独立 git 团队仓库的 workspace 中，用 `pull --team-ref` 试用包含 `teamai.yaml` 的远程分支、标签或提交：

```bash
teamai pull --team-ref feature/review-skill
teamai pull --team-ref v2.3.0
teamai pull --team-ref 3f2c9a7d
teamai pull --team-ref main  # 用团队的默认分支名解除固定
```

固定信息保存在该 workspace 的本地配置中，对其所有 checkout 和 hook pull 生效。分支会跟随新提交；标签和提交保持固定。提交必须能从远程分支到达。`pull` 和 `status` 会显示固定状态。

切换版本时，新版本没有的 skill、rule 和 agent 的未修改副本会被移除。修改过的副本会保留，解除固定时会指出哪些修改会被 `push` 发到默认分支。固定期间 `push` 不发送任何内容，`source add`、`source remove` 和写入团队 wiki 的 `import` 会拒绝执行；pull 仍上报用量和 learnings。固定版本的 pull 失败或交付不完整时退出码为 1。`--team-ref` 不能与 `--dry-run` 同用。

此功能要求 workspace 安装，不继承 user scope，且同一团队未在 user scope 安装。不支持 HTTP 或单仓库模式。其他 workspace 保持各自的版本。

### 不独立

业务仓库自己就是团队仓库。资产写在这个仓库的 `.teamai/` 里。

```bash
cd /path/to/my-workspace
teamai init . --agent claude,cursor
```

### 包含仓库的 workspace

workspace 也会交付其下已初始化的仓库所选择的资源。
在 `ws/` 中运行 `teamai pull` 会查找最多三层目录以内的这些仓库，并列出它们的名字。
它在仓库处停止：`svc-a/` 里的文件夹和 worktree 属于 `svc-a`。
两个仓库以相同方式提供的 skill、agent、hook、env 键或 MCP server 只送达一次；内容不同的会被暂缓（held）并指出名字，每个仓库保留自己的那一份。
使用其他团队仓库的子项会被排除，并有一行说明。
你在 `svc-a/` 中的 agent 仍然只获得 `svc-a` 的资源。

## 仓库

`init` 会写 `teamai.yaml`。独立团队仓库放在仓库根目录。业务仓库自己当团队仓库时，文件是 `.teamai/teamai.yaml`，并带 `mode: self`。

```yaml
team: platform
description: Platform team AI resources
repo: https://github.com/your-org/platform-teamai.git
provider: github
sharing:
  docs:
    localDir: ./.teamai/docs
  env:
    injectShellProfile: true
```

`init .` 还会在当前分支建出这些目录：

```text
.teamai/teamai.yaml
.teamai/skills/
.teamai/rules/
.teamai/docs/
.teamai/env/env.yaml
.teamai/mcp/mcp.yaml
```

`teamai push` 发送所有分布式资源类型——skills、rules、agents、docs、env、hooks、mcp、models、claudemd、learnings、wiki、workflows、prompts、scorers——并按 `--project` 和 `--role` 做命名空间放置。

### Git 权限

同事能推分支、能开 pull request。主干保持保护。

### Git 子模块

skill 用 git submodule 发时，在 `teamai.yaml` 里打开。每次 pull 按仓库钉住的版本检出。

```yaml
submodules: true
```

### 团队脚本

`teamai.yaml` 可以声明 Node 脚本。CLI 用自己的 Node 跑，不经过 shell。`path` 相对团队仓库根目录，而且必须留在仓库里。指向仓库外的符号链接会被拒绝。脚本的工作目录是团队仓库。脚本失败不会让 init 或 pull 失败。

workspace scope 下，脚本还会拿到 TeamAI 已经解析好的检出目录。写什么由脚本决定。TeamAI 不管理个人文件，也不会替脚本覆盖它打算保留的文件。

- `TEAMAI_REPO` — 团队仓库
- `TEAMAI_SCOPE` — `user`，workspace scope 下为 `project`
- `TEAMAI_CHECKOUT` — 当前检出目录，仅 workspace scope
- `TEAMAI_MAIN_CHECKOUT` — TeamAI 解析到的主检出目录，知道时才有
- `TEAMAI_PROJECT` — 同一个解析结果，同一仓库的各个 worktree 都一样

```yaml
scripts:
  preInit:
    path: scripts/pre-init.mjs
  postInit:
    path: scripts/post-init.mjs
  prePull:
    path: scripts/pre-pull.mjs
  postPull:
    path: scripts/deploy.mjs
  postDeploy:
    path: scripts/link-local.mjs
```

- `preInit` 在 `teamai init` 里跑，本地配置已保存、hook 还没装。它可以读终端。init 会一直等，没有超时。非交互 init（没有终端、设置了 `CI` 或 `TEAMAI_NONINTERACTIVE`）会跳过。之后在终端里执行 `teamai script run preInit`。
- `postInit` 在 hook 装好之后跑。init 等它结束，再同步一次 MCP，这样脚本里填的值会生效。跳过规则和 `preInit` 一样。`teamai script run postInit` 会再跑一次并同步 MCP。
- `prePull` 在一次完整 pull 的开头、该 scope 同步之前跑。它不能读终端。pull 最多等 90 秒，超时后让它继续在后台跑。inline pull 不跑它。
- `postPull` 在完整 pull 结束之后跑。会话启动最多等 90 秒，超时后留在后台。交互式 `teamai pull` 不等。inline pull 不跑。失败记在 `~/.teamai/debug.log`。
- `postDeploy` 对每个新建的 linked worktree 或 submodule checkout 只跑一次，在它第一次交付做完后跑。Git hook 在那条 git 命令返回前跑它；hook 连不上团队仓库时，由它之后的后台 pull 跑。agent 工具不经 Git hooks 创建的 worktree，或在设置 TeamAI 之前就有的 worktree，由工具在那里的第一次会话或工具调用在后台跑。这条路径不会跑 `teamai init`。pull 最多等 15 秒。用 `teamai script run postDeploy` 再跑。脚本应当可以重复执行，并且保留已经存在的个人文件。

## 角色和项目

角色是成员的分工，比如前端。设成这个角色的人，会收到角色上声明的资源。

项目是正在做的服务。在当前目录设成这个项目后，会再收到项目上声明的资源。

`knowledge` 包含 rules 和共享指令（`claudemd/`）。项目还可以单独声明 learnings、env、hooks、mcp、models、docs、wiki。

```yaml
# manifest/roles.yaml
version: 1
roles:
  - id: frontend
    description: Web engineers
    resources:
      knowledge: [common, frontend]  # rules/<ns>/、claudemd/<ns>/
      skills: [common, frontend]
      agents: [common, frontend]
```

```yaml
# manifest/projects.yaml
version: 1
projects:
  - id: checkout
    name: Checkout service
    resources:
      knowledge: [checkout]   # rules/checkout/、claudemd/checkout/
      skills: [checkout]
      learnings: [checkout]
      agents: [checkout]
      env: [checkout]          # env/checkout/env.yaml
      hooks: [checkout]        # hooks/checkout/hooks.yaml
      mcp: [checkout]          # mcp/checkout/mcp.yaml
      models: [checkout]       # models/checkout/models.yaml
      docs: [checkout]         # docs/checkout/
      wiki: [github__acme__checkout]  # teamai import 输出的 project: slug
```

把这两份文件提交。在项目里：

```bash
teamai roles set frontend
teamai projects set checkout
teamai pull
```

`repo.localPath` 支持 `~/.teamai/team-repo` 这样的用户目录相对路径，在 Windows 上也支持原生的 `~\.teamai\team-repo` 写法。

## 在团队仓库里分配角色

默认情况下，角色由成员自己设置，也可以随时改。如果团队还把生效角色当作边界——例如用 hook 让 `frontend` 成员的 agent 只能改 `frontend/` 和共享文件——那么这个分配应当是团队仓库里一次经过评审的变更。`manifest/members.yaml` 就是这个文件：

```yaml
# manifest/members.yaml
version: 1
members:
  alice: [frontend]
  bob: [backend, ki]
default: []        # 这个文件未列出的成员所持有的角色
```

列在第一位的是主角色，其余是附加角色。该文件存在时：

- 成员的生效角色就是这里分配的角色。`teamai roles set` 会被拒绝，dashboard 的 Distribution 页面也一样，只展示角色而不提供修改。
- 文件未列出的成员持有 `default`——除非另行声明即为无角色——并且只接收共享资源，而不是没有该文件时无角色成员得到的全量同步。
- 谁可以分配角色由代码平台决定，和 `roles.yaml` 一样：保护分支、合并请求、`manifest/` 的 code owner。teamai 自己不维护任何权限名单。

成员的键是该成员本地 teamai 配置里的用户名，由 `teamai init` 从 Git 平台记录。删除该文件后，角色选择重新回到每个成员手里。teamai 从团队仓库已拉取的默认分支读取该文件，而不是成员机器上的克隆副本，所以改写或删除本地副本不起作用：只有代码平台已合并的内容才算。

重新分配会在下一次 pull 时生效。

团队 hook 读取生效角色时不需要解析任何配置文件：

```bash
teamai roles list --json
# {"roles":["frontend"],"primaryRole":"frontend","additionalRoles":[],"source":"assigned","assignmentFile":"manifest/members.yaml"}
```

`source` 取值为 `assigned`（文件中列出）、`default`（未列出）、`local`（没有该文件，成员自己的选择）或 `none`。

这不是对以该成员身份运行的进程的硬边界：agent 以该成员身份运行，可以改写用户名所在的配置，也可以改 teamai 自身。它带来的是：角色变更成为一次有记录、经过评审的团队决定，而不是笔记本上的一条命令。

## 把技能限定给部分成员

Namespace 只对设置了角色的成员过滤：`primaryRole` 未设置的成员会同步全部技能，因此只有 `manifest/roles.yaml` 并不限定任何人。有了 `manifest/members.yaml` 这个缺口就被补上——未列出的成员只接收共享资源。`teamai init` 会让新成员选择角色；manifest 之前入队的成员需要执行一次 `teamai roles set <role-id>`。之后的 pull 会收回新 namespace 之外、由 teamai 下发的副本（本地改过的保留）。

要提醒一直没设角色的成员，可以用强制规则让 agent 检查 `teamai roles list` 并催促设置——强制规则成员不可删除：

```yaml
# teamai.yaml
sharing:
  rules:
    enforced: [set-your-role]
```

标签从不做限定：订阅只会额外拉取匹配标签的技能。限定用 namespace + 角色，标签用于自愿加法。

## 标签

标签打在 skill 或 rule 上，存在团队仓库的 `tags.yaml`。成员在自己机器上订阅。没订阅任何标签时，标签不参与。订阅之后，带这些标签的 skill 和 rule 也会拉下来。没打标签的仍按角色和项目发。

```yaml
# tags.yaml
skills:
  hai-deploy: [hai, infra]
rules:
  code-style: [coding]
```

```bash
teamai tags add skills hai-deploy hai infra
teamai tags subscribe hai
teamai pull
```

## 订阅

订阅是别的团队公开的 skills。对方在自己的 `teamai.yaml` 里列出：

```yaml
publicSkills:
  - deploy-helper
```

```bash
teamai source add https://github.com/other-team/teamai-public.git --name other-team
teamai source list
teamai source browse other-team
teamai source remove other-team
teamai push
```

`source add` 写进本团队仓库。`push` 合入后，每位成员的 `pull` 都会装上。没写 `publicSkills` 时，这个源是空的。

### HTTP 源

```bash
teamai source add-http https://your-team-host/api --token <api-key>
teamai source list
teamai source remove-http
```

每个安装只能有一个 HTTP 源。主仓已经是 `init --http` 时，不能再 `add-http`。接口见 [ClawPro HTTP 后端](./http-contract.md)。
