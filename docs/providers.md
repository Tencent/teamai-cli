# Git Provider 说明

TeamAI CLI 通过 provider 抽象层支持多个 Git 托管平台。当前实现了五个：

| Provider | Host            | 认证方式                            | 建议场景              |
|----------|-----------------|--------------------------------------|----------------------|
| `github` | github.com      | `gh` CLI 或 `GITHUB_TOKEN` 环境变量  | 开源项目、外部用户    |
| `tgit`   | git.woa.com     | `gf` CLI（自动下载）+ `~/.netrc`     | 腾讯内部团队          |
| `cnb`    | cnb.cool        | `cnb login` 或 `CNB_TOKEN` 环境变量  | CNB（云原生构建）用户 |
| `gitlab` | gitlab.com 或自托管实例 | `GITLAB_TOKEN` 环境变量              | GitLab / 企业自托管   |
| `git`    | 任意 Git host   | 系统 Git Credential Helper 或 SSH Key | 自建 Gitea 等其他平台 |

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
https://git.example.com/group/repo.git  → git
git@git.example.com:group/repo.git      → git
```

provider 选择会写入 team 仓库的 `teamai.yaml` 的 `provider` 字段，后续 `push` / `pull` 都按这个值来。

## 通用 Git Provider（自建/私有仓库）

不在已知 host 列表中的完整 HTTPS 或 SSH URL 会自动选择 `git` provider。例如：

```bash
teamai init https://code.qschou.com/Enterprise/arb-workflow-kit.git --scope user
# 或使用 SSH
teamai init git@code.qschou.com:Enterprise/arb-workflow-kit.git --scope user
```

通用 provider 不读取或保存平台 Token，而是让系统 `git` 处理认证：

- HTTPS：预先配置 Git Credential Helper；不要把用户名、密码或 Token 写进 URL。
- SSH：预先配置 SSH Key，并确保 `ssh-agent` 能访问私钥。

clone、pull、push 均可正常使用。平台 API 操作（自动建仓、自动创建 MR/PR）无法跨不同服务统一实现，因此暂不支持；`teamai push` 会先推送分支，再提示用户到对应平台手动创建 MR。

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

## GitLab Provider（含自托管）

GitLab Provider 通过 GitLab **REST API v4** 工作，**不需要任何外部 CLI**——只依赖一个 Personal Access Token。这是新增 Provider 时推荐的形态：GitLab（含企业自托管实例）都有标准的 REST API，行为可预测。

### 认证

通过标准 GitLab 环境变量配置：

```bash
export GITLAB_URL=https://gitlab.example.com   # 自托管实例 base URL；默认 https://gitlab.com
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxx      # Personal Access Token，需要 api scope
```

token 变量支持三个名字（按优先级）：`GITLAB_TOKEN` > `GITLAB_PRIVATE_TOKEN` > `GITLAB_PAT`。空值/纯空白视为未设置，会继续尝试下一个别名。

`GITLAB_URL` **必须带 scheme**（`https://` 或 `http://`）。写成 `gitlab.example.com` 会在执行 GitLab 操作时报错退出，而不是静默回落到 gitlab.com。内网 http 实例、非标准端口、以及挂在子路径下的部署（`https://example.com/gitlab`）都会被完整保留，包括 clone URL。

### 自托管实例检测

- **公有 gitlab.com**：URL host 直接命中，自动选择 gitlab provider。
- **自托管实例**：设置 `GITLAB_URL` 后，URL host 与 `GITLAB_URL` 的 host 相同时自动识别为 gitlab；也可用 `TEAMAI_GITLAB_HOST` 直接指定 host。两种方式都不需要写完整 URL：
  ```bash
  export GITLAB_URL=https://git.example.com
  teamai init git.example.com/yourgroup/yourrepo     # → gitlab
  ```
- 也可以在 team 仓库的 `teamai.yaml` 显式写 `provider: gitlab` 强制切换。

### 与 `git` 通用 Provider 的分工

未知 host 默认落到 `git` 通用 Provider——它只做传输（clone/pull/push 走系统 Git 凭据），`createRepo` 和创建 MR 都会直接报「不支持」。GitLab Provider 的价值就在这里：把自托管实例识别出来后，建仓、建 MR、拉 MR 数据、列 group 仓库这些平台能力才可用。检测顺序是 **已知 host → 自托管 GitLab → `git` 通用回落**。

### 多级命名空间

GitLab 支持 `group/subgroup/repo` 多级路径，provider 的路径解析会保留完整 group 路径：

```
https://git.example.com/Group/Subgroup/repo
git@git.example.com:Group/Subgroup/repo.git
```

也可以直接粘贴浏览器地址栏里的 URL：GitLab 的 `/-/` 路由分隔符及其后内容（`/-/tree/main`、`/-/merge_requests/42`、`/-/blob/...`）会被自动剥离，解析回项目本身。

### 支持的操作

| 操作                   | 实现                                                        |
|------------------------|-------------------------------------------------------------|
| clone                  | `git clone <base-url>/...`，token 以 `oauth2:` 基本认证注入 |
| 创建仓库               | `POST /api/v4/projects`（用户 namespace，或按路径精确解析 group；解析不到直接报错，不会退回个人 namespace） |
| 创建 MR                | `POST /api/v4/projects/:id/merge_requests`                 |
| 指定 reviewer          | 解析 username → user id，提交 `reviewer_ids`                |
| 拉取 MR 数据           | `GET /api/v4/projects/:id/merge_requests/:iid` + commits + changes |
| 列出 group 仓库        | `GET /api/v4/groups/:path/projects`（分页，`include_subgroups=true` 含子组） |

### 默认 email 域

GitLab Provider 不设默认 email 域（同 GitHub），使用用户的 git 全局配置。

## 手动指定 Provider

除了 URL 自动检测，也可以在 team 仓库的 `teamai.yaml` 中显式写 `provider: github`、`provider: tgit`、`provider: cnb`、`provider: gitlab` 或 `provider: git` 强制切换。一个典型的 `teamai.yaml`：

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

Provider 是一个 TypeScript 接口（见 [`src/providers/types.ts`](../src/providers/types.ts)），新增带平台 API 能力的 GitLab / Bitbucket / Gitea provider 只需要：

1. 新建 `src/providers/<name>/` 目录
2. 实现 `GitProvider` 接口：`parseRepoInput` / `authenticate` / `cloneRepo` / `createRepo` / `createPullRequest` / `getDefaultEmailDomain`
3. 在 [`src/providers/registry.ts`](../src/providers/registry.ts) 的 `HOST_MAP` 和 `PROVIDERS` 中注册
4. 写单元测试，参考 [`src/__tests__/github-provider.test.ts`](../src/__tests__/github-provider.test.ts)

PR 欢迎。
