# Git Provider 说明

TeamAI CLI 通过 provider 抽象层支持多个 Git 托管平台。当前实现了六个：

| Provider | Host            | 认证方式                            | 建议场景              |
|----------|-----------------|--------------------------------------|----------------------|
| `github` | github.com      | `gh` CLI 或 `GITHUB_TOKEN` 环境变量  | 开源项目、外部用户    |
| `tgit`   | git.woa.com     | `gf` CLI（自动下载）+ `~/.netrc`     | 腾讯内部团队          |
| `cnb`    | cnb.cool        | `cnb login` 或 `CNB_TOKEN` 环境变量  | CNB（云原生构建）用户 |
| `gitlab` | gitlab.com 或自托管实例 | `GITLAB_TOKEN` 环境变量              | GitLab / 企业自托管   |
| `gitcode`| gitcode.com     | `GITCODE_TOKEN` 环境变量或 init 交互粘贴 | GitCode（CSDN）用户 |
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
https://gitcode.com/org/repo(.git)      → gitcode
git@gitcode.com:org/repo.git            → gitcode
https://git.example.com/group/repo.git  → 检查 GitLab，未确认则 git
git@git.example.com:group/repo.git      → 检查 GitLab，未确认则 git
```

已知 host 和显式配置的 GitLab 实例优先。对于未知 host，`init` 会匿名探测 GitLab 登录页；确认是未配置的 GitLab 实例时，先提示设置 `GITLAB_URL` 和 `GITLAB_TOKEN` 后重试，不会直接把探测结果写入配置。未确认则继续使用 `git`。

初始化成功后，provider 选择会写入 team 仓库的 `teamai.yaml` 的 `provider` 字段，后续 `push` / `pull` 都按这个值来。探测不会自动修改已有的 provider。

## 通用 Git Provider（自建/私有仓库）

完整 HTTPS 或 SSH URL 的 host 若不在已知列表、不匹配显式 GitLab 配置，且探测未确认 GitLab，就会选择 `git` provider。例如：

```bash
teamai init https://code.qschou.com/Enterprise/arb-workflow-kit.git --scope user
# 或使用 SSH
teamai init git@code.qschou.com:Enterprise/arb-workflow-kit.git --scope user
```

通用 provider 不读取或保存平台 Token，而是让系统 `git` 处理认证：

- HTTPS：预先配置 Git Credential Helper；不要把用户名、密码或 Token 写进 URL。
- SSH：预先配置 SSH Key，并确保 `ssh-agent` 能访问私钥。

clone、pull、push 均可正常使用。平台 API 操作（自动建仓、自动创建 MR/PR）无法跨不同服务统一实现，因此暂不支持；`teamai push` 会先推送分支，再提示用户到对应平台手动创建 MR，并以非零退出码表明自动 PR/MR 创建未完成。

若已有 `provider: git` 的仓库在创建 PR 时失败，CLI 会额外检查该 host；确认是 GitLab 后，会提示设置实例地址和 token，并将团队仓库 `teamai.yaml` 的 `provider` 改为 `gitlab`。这个提示不会自动修改配置，也不会撤回已经推送的分支。

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
cnb login --host cnb.cool   # OAuth2 device flow，登录后 `cnb git-credential` 为 git 提供凭据
teamai init https://cnb.cool/yourorg/yourrepo
```

> **为什么要带 `--host`**：`cnb` CLI 在未显式指定 host 时，会从当前目录第一个 git remote 推断平台地址。若在一个 remote 指向非 CNB 平台（如内网 git 服务器）的仓库里直接跑 `cnb login`，请求会被打到那个 host 并返回 `401`。显式 `--host cnb.cool` 可避免此问题（自托管实例改用对应域名）。由 `teamai init` 自动触发登录时，teamai 已按 `TEAMAI_CNB_HOST`（默认 `cnb.cool`）带上 `--host`，无需手动处理。

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
export GITLAB_URL=https://gitlab.example.com    # 自托管实例 base URL；默认 https://gitlab.com
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxx       # Personal Access Token，需要 api scope
export GITLAB_API_PREFIX=api/v4                  # API 路径前缀；默认 api/v4（标准 GitLab）
```

token 变量支持三个名字（按优先级）：`GITLAB_TOKEN` > `GITLAB_PRIVATE_TOKEN` > `GITLAB_PAT`。空值/纯空白视为未设置，会继续尝试下一个别名。

`GITLAB_URL` **必须带 scheme**（`https://` 或 `http://`）。写成 `gitlab.example.com` 会在执行 GitLab 操作时报错退出，而不是静默回落到 gitlab.com。内网 http 实例、非标准端口、以及挂在子路径下的部署（`https://example.com/gitlab`）都会被完整保留，包括 clone URL。

`GITLAB_API_PREFIX` 用于网关代理场景：某些自托管实例通过网关统一路由，GitLab API 被挂载到非标准路径（如 `/api/gitlab` 而不是标准的 `/api/v4`）。该配置也适用于 `teamai import --from-org` 的 group 仓库列表请求（包括所有分页）；未设置或为空时仍使用 `api/v4`。此时设置该变量可避免 405 错误。示例：

```bash
# 标准 GitLab 自托管（默认，无需设置 GITLAB_API_PREFIX）
export GITLAB_URL=https://gitlab.example.com
export GITLAB_TOKEN=glpat-xxx

# 网关代理场景（API 路径被改为 /api/gitlab）
export GITLAB_URL=https://code.company.com
export GITLAB_API_PREFIX=api/gitlab
export GITLAB_TOKEN=glpat-xxx
```

### 自托管实例检测

- **公有 gitlab.com**：URL host 直接命中，自动选择 gitlab provider。
- **自托管实例**：设置 `GITLAB_URL` 后，URL host 与 `GITLAB_URL` 的 host 相同时自动识别为 gitlab；也可用 `TEAMAI_GITLAB_HOST` 直接指定 host。仓库参数需使用完整 HTTP(S) 或 SSH URL：
  ```bash
  export GITLAB_URL=https://git.example.com
  teamai init https://git.example.com/yourgroup/yourrepo     # → gitlab
  ```
- **未配置的未知 host**：`init` 会匿名请求根路径下的 `/users/sign_in?auto_sign_in=false`，仅在响应包含明确的 GitLab 页面特征时确认。确认后，在认证、克隆和写入配置前停止，提示设置 `GITLAB_URL` 和具有 `api` 权限的 `GITLAB_TOKEN` 后重试。实例 URL 不会自动持久化。
- **探测边界**：请求总超时为三秒，不发送 token、不跟随重定向、不关闭 TLS 校验。HTTP(S) 仓库 URL 保留其 scheme 和 Web 端口；SSH 仓库 URL 使用 HTTPS 的默认 443 端口探测，不会把 SSH 端口当作 Web 端口。超时、网络错误、代理拦截、重定向和无法确认的页面都继续回落到 `git`。子路径部署、SSO 遮蔽的登录页，以及 Web 地址与 SSH host 不同的实例，需要显式配置 `GITLAB_URL`。
- **已有 `provider: git`**：设置实例地址和 token 后，还需在团队仓库的 `teamai.yaml` 中将 `provider` 改为 `gitlab`。仅补设环境变量不会覆盖配置中的 provider。创建 PR 失败后的 GitLab 探测只提供修复提示，不会自动切换。

### 与 `git` 通用 Provider 的分工

检测顺序是 **已知 host → 显式配置的自托管 GitLab → 匿名 GitLab 探测 → `git` 通用回落**。匿名探测只用于 `init` 的配置提示，以及通用 provider 创建 PR 失败后的诊断，只确认具有明确特征的 GitLab 页面，不会自动配置实例或 token。未确认的 host 使用 `git` 通用 Provider，clone/pull/push 走系统 Git 凭据，自动建仓和创建 MR 则不受支持。配置好 GitLab Provider 后，才可使用建仓、建 MR、拉 MR 数据、列 group 仓库等平台能力。

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
| clone                  | `git clone <base-url>/...`，token 以 `oauth2:` 基本认证经 `-c http.extraHeader` 注入（不写进 URL，因此不会残留在克隆仓库的 `.git/config`） |
| 创建仓库               | `POST /api/v4/projects`（用户 namespace，或按路径精确解析 group；解析不到直接报错，不会退回个人 namespace） |
| 创建 MR                | `POST /api/v4/projects/:id/merge_requests`                 |
| 指定 reviewer          | 解析 username → user id，提交 `reviewer_ids`                |
| 拉取 MR 数据           | `GET /api/v4/projects/:id/merge_requests/:iid` + commits + changes；MR URL 的 host 必须与已配置实例（`GITLAB_URL` / `TEAMAI_GITLAB_HOST`，默认 gitlab.com）一致，否则拒绝请求，避免把 token 发往未配置的 host |
| 列出 group 仓库        | `GET /api/v4/groups/:path/projects`（分页，`include_subgroups=true` 含子组） |

GitLab API 表中的 `/api/v4` 为默认前缀；设置 `GITLAB_API_PREFIX` 后，API 请求使用配置的前缀。

### 默认 email 域

GitLab Provider 不设默认 email 域（同 GitHub），使用用户的 git 全局配置。

## GitCode Provider（gitcode.com）

GitCode（gitcode.com，CSDN 旗下国内平台）使用 Gitee 风格的 **REST API v5**（`https://api.gitcode.com/api/v5`），不需要任何外部 CLI，只依赖一个 Personal Access Token。结构上参照 GitLab Provider，但 API 方言与 GitLab 完全不同（独立 API 域名、`Authorization: Bearer` 认证、PR 用 `head`/`base`/`title`/`body`、whoami 用 `login`）。

### 认证

按优先级解析 token：

1. `GITCODE_TOKEN`（主）
2. `GC_TOKEN`（别名，兼容 gitcode-cli 用户已有的环境变量）
3. `~/.netrc` 中的 `machine gitcode.com` 条目

```bash
export GITCODE_TOKEN=xxxxxxxxxxxx
```

在 GitCode → 设置 / Settings → Access Tokens（私人令牌）生成 PAT。

**交互式登录**：首次 `teamai init` 若未配置 token，会提示粘贴一次 PAT，验证通过后写入 `~/.netrc`（权限 `0600`）供后续命令与 `git push` 复用。CI / 无头环境请直接配置 `GITCODE_TOKEN`，不会触发交互。

### 命名空间

GitCode 命名空间为单层（用户或组织），仓库地址形如 `owner/repo`，不支持多级子组。

### 支持的操作

| 操作 | 实现 |
|------|------|
| clone | HTTPS 走 `oauth2:<token>@` 内嵌（团队仓，凭据持久化以便后续 push）或 `http.extraHeader`（浅克隆）；亦支持 SSH 公钥 |
| createRepo | 个人 `POST /user/repos`；组织 `POST /orgs/:org/repos` |
| createPullRequest | `POST /repos/:owner/:repo/pulls`（`head`/`base`/`title`/`body`） |
| fetchMergeRequest | `GET /repos/:owner/:repo/pulls/:n` + commits + files；PR URL 的 host 必须为 gitcode.com，否则拒绝，避免把 token 发往未配置的 host |
| listOrgRepos | `GET /orgs/:org/repos` 分页 |

> 注：仅支持公有云 `gitcode.com`，暂不支持自托管 GitCode 企业版。

**关键方言**：GitCode 的 git-over-HTTPS 端点**拒绝 `Authorization: Bearer`**，只接受 Basic `oauth2:<token>`（已实机验证）。而 REST API 用 Bearer。因此团队仓 clone 把 token 内嵌进 remote URL（`oauth2:<token>@`），使 `git push`（分支 + PR 流程）能通过认证——与 GitHub / TGit 一致。

### 默认 email 域

GitCode 不设默认 email 域，使用用户的 git 全局配置。

## 手动指定 Provider

除了 URL 自动检测，也可以在 team 仓库的 `teamai.yaml` 中显式写 `provider: github`、`provider: tgit`、`provider: cnb`、`provider: gitlab`、`provider: gitcode` 或 `provider: git` 强制切换。一个典型的 `teamai.yaml`：

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

## CLI 解析与启动（跨平台）

GitHub 与 CNB 两个 provider 都把操作委托给平台自己的 CLI，因此二者共用同一套解析与启动逻辑（[`src/utils/cli-path.ts`](../src/utils/cli-path.ts)）：

- **解析**：`resolveCliPath(cmd)` 在 Windows 上走原生 `where`，在 macOS / Linux 上依次尝试 `bash -lc` → `zsh -lc` → `which`，返回一个**存在且可启动**的绝对路径；找不到时返回 `null`。
  - Windows 上不能用 `which`：它来自 Git Bash / WSL，返回 MSYS 风格路径（如 `/c/Program Files/GitHub CLI/gh`），Node 会把 `/c/...` 当成 `C:\c\...`，于是 `existsSync` 恒为 false、`spawn` 报 ENOENT。表现为 `isGhInstalled()` 回答"已安装"，而每次 `ghExec()` 都以 status 1 + **空 stderr** 静默失败。
  - `where` 的输出里，npm 生成的不带扩展名的 shim 往往排在 `.cmd` 之前；`pickWindowsCommand()` 只接受 `.exe` / `.cmd` / `.bat`，因为无扩展名的文件 CreateProcess 无法启动。
- **启动**：解析出的绝对路径交给 `cross-spawn` 启动。Node 原生 `spawn` 无法直接执行 `.cmd`（报 `EINVAL`）——`cnb` 由 npm 安装，在 Windows 上只有 `.cmd` / `.ps1`、没有 `.exe`，所以"能解析"和"能启动"必须同时成立；CLI 缺失时返回 127 并在 stderr 里说明原因，不再静默返回 status 1。

TGit 的 `gf` CLI 是例外：它只支持 macOS / Linux，且其路径会作为参数传给 `bash -c`，因此保留原样。

## 新增 Provider

Provider 是一个 TypeScript 接口（见 [`src/providers/types.ts`](../src/providers/types.ts)），新增带平台 API 能力的 GitLab / Bitbucket / Gitea provider 只需要：

1. 新建 `src/providers/<name>/` 目录
2. 实现 `GitProvider` 接口：`parseRepoInput` / `authenticate` / `cloneRepo` / `createRepo` / `createPullRequest` / `getDefaultEmailDomain`
3. 在 [`src/providers/registry.ts`](../src/providers/registry.ts) 的 `HOST_MAP` 和 `PROVIDERS` 中注册
4. 写单元测试，参考 [`src/__tests__/github-provider.test.ts`](../src/__tests__/github-provider.test.ts)

PR 欢迎。
