# 管理员初始化

> [English](../admin-setup.md) | [简体中文](admin-setup.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

一位管理员做完这些。其他人走[快速开始的路径 B](./getting-started.md#路径-b加入团队)。

选一张和你的团队相符的 demo，抄下来。每条都以 `teamai doctor` 结束，每一行都应通过。

| 你要的 | 抄这份 |
| --- | --- |
| 独立团队仓库，资源只进当前项目 | [Demo 1](#demo-1-独立团队仓库) |
| 这台机器上的每个项目都能用 | [Demo 2](#demo-2-用户级) |
| 业务仓库本身就是团队仓库 | [Demo 3](#demo-3-单仓) |
| 公司级资源，再加一个项目仓库 | [Demo 4](#demo-4-组织仓加项目仓) |
| 不同的人收到不同的 skill | [Demo 5](#demo-5-角色和项目) |

GitHub、GitLab、GitCode、CNB、工蜂和私有 Git 都可以。Token 和自建 GitLab 见 [Git Provider](./providers.md)。

---

## Demo 1. 独立团队仓库

建一个空仓库（建议名 `<团队名>-teamai`），给同事写权限，然后：

```bash
cd /path/to/my-project
teamai init https://github.com/your-org/platform-teamai
teamai doctor
```

把仓库地址发给同事。他们在自己的项目里跑同一条 `init`。

资源落在这个项目里（`.claude/skills/`，以及 `init` 找到的其他工具的对应目录）。`teamai.yaml` 里的 `scope:` 不起作用，只有 `init` 的 `--scope` 算数。

---

## Demo 2. 用户级

同一个团队仓库。资源装到用户主目录，这台机器上的每个项目都能看见。

```bash
teamai init https://github.com/your-org/platform-teamai --scope user
teamai doctor
```

| | 项目级（Demo 1，默认） | 用户级（Demo 2） |
| --- | --- | --- |
| 装到 | 项目目录 | `~/` |
| 适合 | 只属于这一个仓库的 skill | 每个仓库都该有的约定和 skill |
| 一起用 | 项目安装还可以读用户级安装 | 见 [Demo 4](#demo-4-组织仓加项目仓) |

---

## Demo 3. 单仓

业务仓库就是团队仓库，没有第二个仓库。

```bash
cd /path/to/my-project
teamai init . --agent claude,cursor
teamai doctor
```

`--agent` 可以重复写，也可以用逗号（`claude,cursor`）。再跑一次 `init .` 会保留已经启用的工具，并加上你新写的。在终端里不写 `--agent` 时，`init` 会问；选项 1 **Auto** 是主目录里已经装好的工具。

`init` 把下面这棵目录提交到当前分支。把这个分支推上去，下一个人 clone 之后，第一次跑 `teamai` 或打开 AI 会话就会把安装做完（Git 托管平台已经登录的前提下）。

```text
my-project/
├── .teamai/
│   ├── teamai.yaml
│   ├── skills/
│   ├── rules/
│   ├── docs/
│   ├── agents/
│   ├── env/env.yaml          # 会进仓库，不要放密钥
│   ├── env/secrets.yaml      # 只写名字，不写值
│   ├── hooks/hooks.yaml
│   └── mcp/mcp.yaml
├── .claude/settings.json     # 每个 --agent 一份设置
└── src/
```

skill 和 rule 用 `teamai push` 加，它会开一个 pull request。`docs/`、`hooks/hooks.yaml`、`mcp/mcp.yaml` 用普通 commit。`env/env.yaml` 里只放非密钥。密钥只在 `env/secrets.yaml` 里写名字、不写值，见[团队密钥](../../designs/team-secrets.md)。

这一套团队配置绑在这一个仓库上。要让很多仓库共用同一份知识，用 [Demo 1](#demo-1-独立团队仓库)。

### Git 权限

默认分支受保护时，成员需要：

- 能推送 `teamai-reports` 和 `teamai-learnings`，这两个 ref 不存在时也能创建
- 能推送 `teamai push` 创建的功能分支
- 能对默认分支开 pull request

成员不需要直接推 `main`，也不需要管理员权限。`provider: git` 时，teamai 推送分支并打印你手动开 pull request 的命令。

---

## Demo 4. 组织仓加项目仓

CLI 装一次。每个 scope 有自己的配置和自己的 clone。

```bash
# 每位开发者一次：公司级 skills、rules、docs、agents
teamai init https://github.com/your-org/engineering-practices --scope user

# 在某一个服务里：项目资源优先
cd /path/to/java-service
teamai init https://github.com/your-org/java-service-teamai --inherit-user-scope
teamai doctor
```

`teamai pull` 先刷新用户级的 skills、rules、docs、agents、文化文件和搜索索引，再刷新项目级。用户级的 env、hooks、MCP、跨团队订阅和用量上报不会继承。同名资源留在各自的目录里；recall 优先用项目里的那份。

---

## Demo 5. 角色和项目

所有人收同一套 skill 时，跳过这份 demo。没有 `manifest/roles.yaml` 也没有 `manifest/projects.yaml` 时，`pull` 把仓库根目录发给每个成员。

**角色**是岗位（`frontend`、`infra`）。**项目**是这个目录属于哪个产品（`checkout`、`billing`）。成员收到两边的并集，两边互不覆盖。

`skills/common/` 发给所有列出 `common` 的角色。`skills/frontend/` 只发给列出 `frontend` 的角色和项目。启用了角色或项目之后，留在根目录 `skills/` 的 skill 只有成员订阅了它的 tag 才会下发（`teamai tags subscribe <tag>`）。

```text
platform-teamai/
├── teamai.yaml
├── manifest/
│   ├── roles.yaml
│   └── projects.yaml
├── skills/
│   ├── common/code-review/SKILL.md
│   └── frontend/react-patterns/SKILL.md
├── rules/
│   ├── common/style.md
│   └── frontend/react.md
└── env/
    ├── env.yaml
    └── frontend/env.yaml
```

```yaml
# manifest/roles.yaml
version: 1
roles:
  - id: frontend
    description: Web engineers
    resources:
      knowledge: [common, frontend]
      skills:    [common, frontend]
      agents:    [common, frontend]
  - id: infra
    description: Infrastructure
    resources:
      knowledge: [common, infra]
      skills:    [common, infra]
      agents:    [common, infra]
```

```yaml
# manifest/projects.yaml
version: 1
projects:
  - id: checkout
    name: Checkout service
    resources:
      knowledge: [checkout]
      skills:    [checkout]
      learnings: [checkout]
      agents:    [checkout]
```

```yaml
# env/env.yaml — 所有人
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint

# env/frontend/env.yaml — 只有 frontend 这个 namespace 生效的人
variables:
  - key: API_ENDPOINT
    value: https://web.example.com
```

下面的命令会写入这两份 manifest 并开一个 pull request。合并之后，每个人在自己工作的目录里选角色。

```bash
# 管理员，做一次
teamai roles add frontend --namespaces common,frontend -d "Web engineers"
teamai projects add checkout --namespaces checkout --name "Checkout service"

# 每位成员，在自己的项目里
teamai roles set frontend
teamai projects set checkout
teamai pull
teamai list
```

`teamai list` 应能看到 `common` 和 `frontend` 的 skill，以及 `skills/checkout/` 下的内容。`learnings/checkout/` 只在激活了该项目的目录里可见。仓库根目录的 `learnings/` 仍然所有人共享。

namespace 是一段路径（`frontend`，不是 `web/frontend`）。

一个目录要激活全部项目时，用 `teamai init <repo> --project all`。

---

## 可复制的 teamai.yaml

独立团队仓库放在仓库根目录。[Demo 3](#demo-3-单仓) 放在 `.teamai/teamai.yaml`。`init` 会写一份，把占位符换成你的。

```yaml
team: platform
description: Platform team AI resources
repo: https://github.com/your-org/platform-teamai.git
provider: github

reviewers:
  - alice

sharing:
  recall:
    enabled: true
  docs:
    localDir: ./.teamai/docs
  env:
    injectShellProfile: true
```

其余字段见[配置参考](./reference.md#teamaiyaml远端团队配置)。

---

## init 写在这台机器上的配置

不用手写。Demo 1 之后是这样：

```yaml
# ~/.teamai/projects/<project>-<hash>/config.yaml
repo:
  localPath: ~/.teamai/projects/<project>-<hash>/team-repo
  remote: https://github.com/your-org/platform-teamai.git
username: alice
scope: project
projectRoot: /path/to/my-project
primaryRole: frontend          # Demo 5 之后
additionalRoles: []
```

用户级（Demo 2）用 `~/.teamai/config.yaml`，`scope: user`。Demo 4 在项目配置里加上 `inheritUserScope: true`。

clone、learnings 和报告实际落在哪，见[数据目录布局](../../designs/data-directory-layout.md)。
