# Git Provider

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

TeamAI CLI 通过 provider 抽象层支持多个 Git 托管平台。当前实现了六个：

| Provider | Host            | 认证方式                            | 建议场景              |
|----------|-----------------|--------------------------------------|----------------------|
| `github` | github.com      | `gh` CLI 或 `GITHUB_TOKEN` 环境变量  | 开源项目、外部用户    |
| `cnb`    | cnb.cool        | `cnb login` 或 `CNB_TOKEN` 环境变量  | CNB（云原生构建）用户 |
| `gitlab` | gitlab.com 或自托管实例 | `GITLAB_TOKEN` 环境变量              | GitLab / 企业自托管   |
| `gitcode`| gitcode.com     | `GITCODE_TOKEN` 环境变量或 init 交互粘贴 | GitCode（CSDN）用户 |
| `git`    | 任意 Git host   | 系统 Git Credential Helper 或 SSH Key | 自建 Gitea 等其他平台 |
| `tgit`   | git.woa.com     | `gf` CLI（自动下载）+ `~/.netrc`     | 腾讯内部团队          |

## Provider 自动检测

`teamai init <input>`（或等价别名 `teamai init --repo <input>`）根据输入格式自动选择 provider：

```
your-org/your-repo                        → github（默认）
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
https://git.example.com/group/repo.git  → git
git@git.example.com:group/repo.git      → git
```

初始化成功后，provider 选择会写入 team 仓库的 `teamai.yaml` 的 `provider` 字段，后续 `push` / `pull` 都按这个值来；成员用 `--provider` 保存在本机的选择优先于它（见下节）。

### 手动指定 provider（`--provider`）

```bash
teamai init https://gitlab.example.com/group/repo --provider git
```

取值：`tgit`、`github`、`cnb`、`gitlab`、`gitcode`、`git`。`git` 不需要平台 token，用已有的 Git 凭据；PR/MR 需要自己到 Git 平台上创建。该选择只影响本机。自建 GitLab 用 `--provider gitlab` 时仍需设置 `GITLAB_URL` 和 `GITLAB_TOKEN`。

## 通用 Git Provider（自建/私有仓库）

完整 HTTPS 或 SSH URL 的 host 不在已知列表里，就用 `git`。例如：

```bash
teamai init https://code.qschou.com/Enterprise/arb-workflow-kit.git --scope user
# 或使用 SSH
teamai init git@code.qschou.com:Enterprise/arb-workflow-kit.git --scope user
```

通用 provider 保留克隆路径，包括原地址是否带 `.git` 后缀。Azure Repos 也使用此 provider：

```bash
teamai init https://dev.azure.com/org/project/_git/repo
```

通用 provider 不读取或保存平台 Token，而是让系统 `git` 处理认证：

- HTTPS：预先配置 Git Credential Helper；不要把用户名、密码或 Token 写进 URL。
- SSH：预先配置 SSH Key，并确保 `ssh-agent` 能访问私钥。

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
teamai init your-org/your-repo
# 检测到未登录时会自动调起 gh auth login --web（仅限交互式终端）
```

非交互式运行（stdin 不是 TTY，或设置了 `CI` / `TEAMAI_NONINTERACTIVE`）不会调起该登录：浏览器 device flow 无人完成，只会把任务挂到超时（[#711](https://github.com/Tencent/teamai-cli/issues/711)）。此时 `init` 立即失败并提示导出带 `repo` 权限的 `GITHUB_TOKEN`（或 `GH_TOKEN`）。

**方式 2：`GITHUB_TOKEN` 环境变量**

无法安装 `gh` CLI 的环境（CI、容器、受限 Linux）可以通过 [personal access token](https://github.com/settings/tokens) 认证：

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
teamai init your-org/your-repo
```

token 需要 `repo` 权限。`GH_TOKEN` 作为别名也会被识别。

MR/PR 导入回退到 GitHub REST API 时，元信息、提交列表或 diff 请求失败会在 AI 提炼前报告 HTTP 状态码和响应正文。请检查 PR 可见性、凭据或限流状态后重试。

### 默认分支

TeamAI 通过 `getDefaultBranch()` 自动识别默认分支：先看 `origin/HEAD`，再依次探测
`origin/main`、`origin/master`。`main` 和 `master` 都可以，无需改动仓库设置。

### 分支权限

同事有分支写权限、能开 pull request 就够了。主干保持保护。上报和学习记录走 `teamai-reports` 和 `teamai-learnings`。详见[Git 权限](distribution.md#git-权限)。

## TGit Provider（腾讯工蜂）

### 认证

`teamai init` 会自动下载工蜂 CLI `gf` 到 `~/.teamai/gf/`，然后在交互式终端里运行 `gf auth login`（支持 iOA SSO / 浏览器 device code / 手动 token）。登录后 token 存在 `~/.netrc`，所有后续 git 操作自动带上。

非交互式运行（stdin 不是 TTY，或设置了 `CI` / `TEAMAI_NONINTERACTIVE`）不会调起该登录，而是立即失败并提示先在交互式终端执行一次 `gf auth login`（[#711](https://github.com/Tencent/teamai-cli/issues/711)）。这里没有可替代的 token：`TGIT_TOKEN` 仅用于 REST API，git.woa.com 的 git 端点不接受它，因此无法用它 clone；登录一次之后，后续非交互式运行会复用它保存的凭据。

### 默认 email 域

TGit 会把 git commit email 默认配置为 `<username>@tencent.com`。GitHub Provider 不设默认域（让用户的全局 git 配置生效）。

## CNB Provider（cnb.cool）

CNB（[云原生构建](https://cnb.cool)）provider 是对官方 CLI `@cnbcool/cnb-cli` 的薄封装，思路与 TGit 一致：把认证、建仓、建 PR 等操作都委托给平台自己的 CLI。CLI 缺失时会通过 `npm i -g @cnbcool/cnb-cli` 自动安装。

### 认证

两种方式，与 GitHub Provider 对待 `GITHUB_TOKEN` 的思路一致：

**方式 1：`cnb login`（交互式，开发机推荐）**

```bash
cnb login --host cnb.cool   # OAuth2 device flow，登录后 `cnb git-credential` 为 git 提供凭据
teamai init https://cnb.cool/your-org/your-repo
```

> **为什么要带 `--host`**：`cnb` CLI 在未显式指定 host 时，会从当前目录第一个 git remote 推断平台地址。若在一个 remote 指向非 CNB 平台（如内网 git 服务器）的仓库里直接跑 `cnb login`，请求会被打到那个 host 并返回 `401`。显式 `--host cnb.cool` 可避免此问题（自托管实例改用对应域名）。由 `teamai init` 自动触发登录时，teamai 已按 `TEAMAI_CNB_HOST`（默认 `cnb.cool`）带上 `--host`，无需手动处理；该自动登录仅在交互式终端里发生，非交互式运行改为立即失败并提示设置 `CNB_TOKEN`（见方式 2，[#711](https://github.com/Tencent/teamai-cli/issues/711)）。

**方式 2：`CNB_TOKEN` 环境变量（headless / CI）**

```bash
export CNB_TOKEN=xxxxxxxx
teamai init https://cnb.cool/your-org/your-repo
```

设置 `CNB_TOKEN` 后无需 `cnb login`。用户名从 `cnb users get-user-info` 解析，也可用 `CNB_USERNAME` 覆盖。

> **组织和仓库都需在网页创建**：`cnb login` 的 OAuth 令牌不含创建组织（`group-manage:rw`）
> 或创建仓库（`group-resource:rw`）的权限，无法通过 CLI 创建。`teamai init` 遇到以下情况会打印
> 网页链接引导你创建后重新运行：
> - 组织不存在 → `https://cnb.cool/new/groups`
> - 组织存在但无权限建仓库 → `https://cnb.cool/new/repos`
>
> 若要让 CLI 直接创建，需改用带 `group-manage:rw` / `group-resource:rw` 权限的 access token（经 `CNB_TOKEN`）。

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

`GITLAB_URL` **必须带 scheme**（`https://` 或 `http://`）。写成 `gitlab.example.com` 会在执行 GitLab 操作时报错退出，而不是静默回落到 gitlab.com。内网 http 实例、非标准端口、以及挂在子路径下的部署（`https://example.com/gitlab`）都会被完整保留，包括 clone URL。MR 导入也会在 API 请求中保留这个部署前缀，并从项目 ID 中排除它；MR URL 必须位于该实例路径下。

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

GitLab 创建 MR 的超时为 30 秒，reviewer 查询、创建请求及其响应体共用这一预算；init 改用其配置的推送超时。reviewer 查询超时会停止创建，其他 reviewer 查询失败仍按尽力而为处理。创建超时后，已推送的分支仍可用于手动发起评审。若创建请求已经发出，超时不能证明 GitLab 未创建 MR，重试前应先在平台上检查。

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

GitCode 命名空间为单层（用户或组织），仓库地址形如 `owner/repo`，不支持多级子组。仅支持公有云 `gitcode.com`。

### 默认 email 域

GitCode 不设默认 email 域，使用用户的 git 全局配置。

## 在 `teamai.yaml` 中指定 Provider

除了 URL 自动检测，也可以在 team 仓库的 `teamai.yaml` 中显式写 `provider: github`、`provider: tgit`、`provider: cnb`、`provider: gitlab`、`provider: gitcode` 或 `provider: git` 强制切换。一个典型的 `teamai.yaml`：

```yaml
team: my-team
description: TeamAI shared resources
repo: https://github.com/your-org/your-repo.git
provider: github
reviewers:
  - alice
  - bob
```

## 新增 Provider

Provider 层的内部实现和新增 provider 的步骤见 [Adding a Git provider](../../dev/adding-a-provider.md)。
