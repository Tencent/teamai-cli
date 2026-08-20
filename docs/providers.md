# Git Provider 说明

TeamAI CLI 通过 provider 抽象层支持多个 git 托管平台。当前实现了四个：

| Provider | Host                        | 认证方式                                       | 建议场景              |
|----------|-----------------------------|------------------------------------------------|----------------------|
| `github` | github.com                  | `gh` CLI 或 `GITHUB_TOKEN` 环境变量            | 开源项目、外部用户    |
| `tgit`   | git.woa.com                 | `gf` CLI（自动下载）+ `~/.netrc`               | 腾讯内部团队          |
| `cnb`    | cnb.cool                    | `cnb login` 或 `CNB_TOKEN` 环境变量            | CNB（云原生构建）用户 |
| `gitlab` | gitlab.com / 自托管 GitLab  | `GITLAB_TOKEN` 环境变量 或 `glab` CLI          | GitLab 用户 / 自托管  |

## Provider 自动检测

`teamai init <input>`（或等价别名 `teamai init --repo <input>`）根据输入格式自动选择 provider：

```
yourorg/yourrepo                        → github（默认）
https://github.com/org/repo(.git)       → github
git@github.com:org/repo.git             → github
https://git.woa.com/team/repo(.git)     → tgit
git@git.woa.com:team/repo.git           → tgit
https://cnb.cool/org/repo(.git)         → cnb
git@cnb.cool:org/repo.git               → cnb
https://gitlab.com/org/repo(.git)       → gitlab
git@gitlab.com:org/repo.git             → gitlab
https://<TEAMAI_GITLAB_HOST>/g/repo     → gitlab（自托管，见下）
```

provider 选择会写入 team 仓库的 `teamai.yaml` 的 `provider` 字段，后续 `push` / `pull` 都按这个值来。

## GitHub Provider

### 认证

两种方式，**推荐用 `gh` CLI**：

**方式 1：`gh` CLI（推荐）**

```bash
# macOS
brew install gh

# Debian/Ubuntu
sudo apt install gh

# 其他平台见 https://cli.github.com/
```

安装后运行 `gh auth login`，或直接让 `teamai init` 触发交互式登录：

```bash
teamai init yourorg/yourrepo
# 检测到未登录时会自动调起 gh auth login --web
```

**方式 2：`GITHUB_TOKEN` 环境变量**

无法安装 `gh` CLI 的环境（CI、容器、受限 Linux）可以通过 [personal access token](https://github.com/settings/tokens) 认证：

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
teamai init yourorg/yourrepo
```

token 需要 `repo` 权限。`GH_TOKEN` 作为别名也会被识别。

### 支持的操作

| 操作                   | 实现                                                        |
|------------------------|-------------------------------------------------------------|
| clone                  | `git clone https://x-access-token:$TOKEN@github.com/...`    |
| 创建仓库               | `POST /user/repos` 或 `POST /orgs/:org/repos`               |
| 创建 PR                | `gh pr create` 或 `POST /repos/:o/:r/pulls`                 |
| 指定 reviewer          | `gh pr create -r` 或 `POST .../requested_reviewers`         |

### 默认分支

GitHub 新仓库默认分支通常是 `main`。TeamAI 当前实现中 `push` 的目标分支硬编码为 `master`（历史遗留）。如果你的 GitHub 仓库使用 `main`，可以在仓库 **Settings → Branches** 中将默认分支改为 `master`，或等待后续版本支持可配置目标分支。

## TGit Provider（腾讯工蜂）

### 认证

`teamai init` 会自动下载工蜂 CLI `gf` 到 `~/.teamai/gf/`，然后运行 `gf auth login`（支持 iOA SSO / 浏览器 device code / 手动 token）。登录后 token 存在 `~/.netrc`，所有后续 git 操作自动带上。

### 多级命名空间

TGit 支持 `group/subgroup/repo` 这种多级路径（GitHub 不支持），provider 里有专门的路径处理逻辑：

```
https://git.woa.com/Group/Subgroup/repo
git@git.woa.com:Group/Subgroup/repo.git
```

### 默认 email 域

TGit 会把 git commit email 默认配置为 `<username>@tencent.com`。GitHub Provider 不设默认域（让用户的全局 git 配置生效）。

## CNB Provider（cnb.cool）

CNB（[云原生构建](https://cnb.cool)）provider 是对官方 CLI `@cnbcool/cnb-cli` 的薄封装，思路与 TGit 一致：把认证、建仓、建 PR 等操作都委托给平台自己的 CLI。CLI 缺失时会通过 `npm i -g @cnbcool/cnb-cli` 自动安装。

### 认证

两种方式，与 GitHub Provider 对待 `GITHUB_TOKEN` 的思路一致：

**方式 1：`cnb login`（交互式，开发机推荐）**

```bash
cnb login   # OAuth2 device flow，登录后 `cnb git-credential` 为 git 提供凭据
teamai init https://cnb.cool/yourorg/yourrepo
```

**方式 2：`CNB_TOKEN` 环境变量（headless / CI）**

```bash
export CNB_TOKEN=xxxxxxxx
teamai init https://cnb.cool/yourorg/yourrepo
```

设置 `CNB_TOKEN` 后无需 `cnb login`。用户名从 `cnb users get-user-info` 解析，也可用 `CNB_USERNAME` 覆盖。

### 支持的操作

| 操作      | 实现                                                              |
|-----------|-------------------------------------------------------------------|
| clone     | `git clone https://cnb:$CNB_TOKEN@cnb.cool/...`，或 `cnb git-credential` |
| 创建仓库  | `cnb repositories create-repo`                                    |
| 创建 PR   | `cnb pulls post-pull`                                             |
| 用户名    | `cnb users get-user-info`（或 `CNB_USERNAME`）                    |

### 多级命名空间

与 TGit 类似，CNB 支持 `org/subgroup/repo` 这种嵌套路径。

### 默认 email 域

CNB Provider 不设默认 email 域（同 GitHub）。

### host 范围与自托管

当前只支持公有社区平台 **cnb.cool**（唯一经过实测的 host），并且只在 URL 明确为 `cnb.cool` 时才会被选中，不会作为默认 fallback。

内部/企业自托管实例（如内网镜像）可通过 `TEAMAI_CNB_HOST` 覆盖 git host，但这类部署还必须给 `cnb` CLI 设置 `CNB_API_ENDPOINT`（以及 `CNB_WEB_ENDPOINT`）指向对应 API——本封装不代管这些端点，且尚未实测，暂不作为受支持配置。

## GitLab Provider（gitlab.com / 自托管）

GitLab provider 直接对接 GitLab REST API v4（`/api/v4`），不依赖第三方 CLI，思路与 TGit（本质上也是 GitLab 系）一致。同时支持公有 **gitlab.com** 和企业自托管实例。

### 认证

两种方式：

**方式 1：`GITLAB_TOKEN` 环境变量（headless / CI 推荐）**

```bash
export GITLAB_TOKEN=glpat-xxxxxxxx   # Personal Access Token，需要 "api" scope
teamai init https://gitlab.com/yourorg/yourrepo
```

`GL_TOKEN` 作为别名也会被识别；在 GitLab CI 中，内置的 `CI_JOB_TOKEN` 会作为兜底自动生效（无需额外配置）。这类 token 通过 `PRIVATE-TOKEN` 头发送。

**方式 2：`glab` CLI**

安装 [`glab`](https://gitlab.com/gitlab-org/cli) 并运行 `glab auth login` 后，teamai 会通过 `glab auth token` 取得 OAuth token（以 `Authorization: Bearer` 发送）。

> 认证时先尝试解析到的 scheme，遇到 401 会自动用另一种 scheme 重试一次，所以 PAT 与 OAuth token 都能用。

### 自托管实例

设置 `TEAMAI_GITLAB_HOST` 指向自托管 host（默认 `gitlab.com`）：

```bash
export TEAMAI_GITLAB_HOST=gitlab.mycorp.com
export GITLAB_TOKEN=glpat-xxxxxxxx
teamai init https://gitlab.mycorp.com/platform/team/repo
```

设置后，指向该 host 的 URL（HTTPS / SSH）会被识别为 `gitlab`，REST API base 也随之切到 `https://<host>/api/v4`。

### 支持的操作

| 操作          | 实现                                                                 |
|---------------|----------------------------------------------------------------------|
| clone         | `git clone https://oauth2:$TOKEN@<host>/...`（凭据内嵌进 remote URL） |
| 创建仓库      | `POST /projects`（owner 非本人时先解析 `GET /namespaces/:owner`）     |
| 创建 MR       | `POST /projects/:id/merge_requests`                                  |
| 指定 reviewer | 通过 `GET /users?username=` 解析为 `reviewer_ids`                    |
| 拉取 MR 详情  | `GET /projects/:id/merge_requests/:iid` + `/commits` + `/changes`    |
| 列出 group 仓库 | `GET /groups/:id/projects?include_subgroups=true`                  |

### CI MR-extract

CI 场景下（`teamai import --from-mr <MR-URL>` 及知识回写）同样支持 GitLab：

- 幂等评论通过 notes API（`POST/PUT /projects/:id/merge_requests/:iid/notes`）写入，用 marker 注释锚定。
- reviewer 的拒绝信号读取 note 上的 award emoji：👎（`thumbsdown`）= reject，无则默认写入。

### 多级命名空间

与 TGit / CNB 类似，GitLab 支持 `group/subgroup/repo` 这种嵌套路径；projectId 用 `encodeURIComponent(owner/repo)` 编码。

### 默认 email 域

GitLab Provider 不设默认 email 域（同 GitHub，让用户全局 git 配置生效）。

## 手动指定 Provider

除了 URL 自动检测，也可以在 team 仓库的 `teamai.yaml` 中显式写 `provider: github`、`provider: tgit`、`provider: cnb` 或 `provider: gitlab` 强制切换。一个典型的 `teamai.yaml`：

```yaml
team: my-team
scope: user
description: TeamAI shared resources
repo: https://github.com/yourorg/yourrepo.git
provider: github
reviewers:
  - alice
  - bob
```

## 新增 Provider

Provider 是一个 TypeScript 接口（见 [`src/providers/types.ts`](../src/providers/types.ts)），新增 Bitbucket / Gitea 等只需要（可参考已实现的 `src/providers/gitlab/`）：

1. 新建 `src/providers/<name>/` 目录
2. 实现 `GitProvider` 接口：`parseRepoInput` / `authenticate` / `cloneRepo` / `createRepo` / `createPullRequest` / `getDefaultEmailDomain`
3. 在 [`src/providers/registry.ts`](../src/providers/registry.ts) 的 `HOST_MAP` 和 `PROVIDERS` 中注册
4. 写单元测试，参考 [`src/__tests__/github-provider.test.ts`](../src/__tests__/github-provider.test.ts)

PR 欢迎。
