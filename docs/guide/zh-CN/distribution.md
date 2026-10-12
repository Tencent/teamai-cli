# 分发管理机制

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

装到哪、用哪个仓库，以及谁收到什么，都在这里。没放进 namespace 的文件给所有人。

## 安装范围

### 独立的 teamai 仓库

团队资产在单独的仓库里。当前项目只是指向它。

只进当前项目：

```bash
cd /path/to/my-project
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

### 不独立

业务仓库自己就是团队仓库。资产写在这个仓库的 `.teamai/` 里。

```bash
cd /path/to/my-project
teamai init . --agent claude,cursor
```

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

skill 和 rule 用 `teamai push`。`docs/`、`hooks/hooks.yaml`、`mcp/mcp.yaml`、`models/models.yaml` 自己 commit。

### Git 权限

同事能推分支、能开 pull request。主干保持保护。

### Git 子模块

skill 用 git submodule 发时，在 `teamai.yaml` 里打开。每次 pull 按仓库钉住的版本检出。

```yaml
submodules: true
```

### Pull 后脚本

pull 结束后跑一个 Node 脚本。项目 scope 跑项目仓的，否则跑用户仓的。

```yaml
scripts:
  postPull:
    path: scripts/deploy.mjs
```

路径相对团队仓库根目录。会话启动时会等它跑完，超时后留在后台；交互式 `teamai pull` 不等。失败不会让 pull 失败，记在 `~/.teamai/debug.log`。

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
      wiki: [checkout]         # 代码库 slug，evidence/code/checkout/
```

把这两份文件提交。在项目里：

```bash
teamai roles set frontend
teamai projects set checkout
teamai pull
```

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
