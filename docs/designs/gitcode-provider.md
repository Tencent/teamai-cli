# GitCode Provider 设计方案

> Issue: [#361 Support the GitCode platform](https://github.com/Tencent/teamai-cli/issues/361)
> 目标平台：GitCode（gitcode.com，CSDN 旗下国内代码托管平台，Gitee/AtomGit 风格 v5 API）
> 范围：仅公有云 `gitcode.com`；认证做到 init 交互式贴 token（存 `~/.netrc`）。

## 1. 背景与问题

`teamai init https://gitcode.com/xxx/repo.git` 报 `Unrecognized GitHub repo format`——
`gitcode.com` 不在 provider `HOST_MAP` 中。连带 `teamai push`（自动建分支 + PR）不可用。

现有 provider 抽象已成熟（github / tgit / cnb / gitlab / git），新增一个 provider 是成熟路径。

## 2. 关键结论：GitCode 是 Gitee 风格，不是 GitLab 风格

结构上参照 GitLab provider，但 API 方言几乎每项都不同（均已实机验证）：

| 维度 | GitLab | **GitCode** |
|---|---|---|
| API base | `<host>/api/v4`（同域） | `https://api.gitcode.com/api/v5`（独立 API 域名） |
| REST 认证头 | `PRIVATE-TOKEN` | `Authorization: Bearer` |
| whoami 字段 | `username` | **`login`** |
| 建 PR | `POST /projects/{id}/merge_requests` | `POST /repos/{owner}/{repo}/pulls` |
| PR body | `source_branch`/`target_branch`/… | `head`/`base`/`title`/`body` |
| PR 响应 URL | `web_url` | `html_url`（web 路径 `/pull/` 单数） |
| 建仓 | `POST /projects` | 个人 `POST /user/repos`；组织 `POST /orgs/{org}/repos` |
| 命名空间 | 多级 subgroup + `/-/` 路由 | 单层 user/org，GitHub 风格 `/owner/repo/pulls/1` |

结论：新建独立 `src/providers/gitcode/`，以 GitLab 为骨架、按 Gitee 方言改写。

### 2.1 为什么用 PAT，不用 OAuth / gitcode-cli

- **OAuth**：只有 authorization code flow（需注册 app + client_secret + redirect_uri），
  **无 device flow**，不适合公开发布的 CLI。
- **gitcode-cli（`gc`）**：社区项目，只能 pip/源码/deb·rpm 安装，**npm 装不了**，且它自己也是 PAT。
- **官方 MCP（gitcode-org-com/gitcode-mcp，Go）**：其 `api/*.go` 源码是权威 API 契约——
  端点 / 字段 / 认证 / 错误码全在其中，可**几乎零 token** 还原 REST 方言（见 §5）。
- **结论**：纯 REST + PAT。

## 3. 认证设计（init 交互式贴 token）

- token 解析：`GITCODE_TOKEN`（主）→ `GC_TOKEN`（别名）→ `~/.netrc` 的 gitcode.com 条目。
- 无 token 且 TTY：提示粘贴 PAT，`GET /user` 验证，写 `~/.netrc`（0600）。非 TTY 报错。
- 复用 `~/.netrc`（git 原生认、TGit 已有先例），不发明新存储。

## 4. 文件改动

新增 `src/providers/gitcode/`：`index.ts` / `gitcode-api.ts` / `repo-url.ts` / `mr-fetch.ts` / `org.ts`。
接线：`registry.ts`（HOST_MAP + KNOWN_PROVIDERS + PROVIDERS + import）、`providers/index.ts`、
`types.ts`（enum）、`doctor.ts`（分支）、`clone.ts`（shallowClone 分支）。
测试：`gitcode-provider.test.ts`、`provider-fallback.test.ts` 补充、`e2e/gitcode-provider-live.test.ts`。

## 5. 方言点实测结论 ✅

均已用真实 `GITCODE_TOKEN` 在实机验证：

1. **REST 认证**：`Authorization: Bearer`；whoami `GET /user` → `login`。
2. **git-over-HTTPS 认证 ≠ REST 认证**：git 端点**拒绝 Bearer**（仍索要用户名），
   仅接受 Basic `oauth2:<token>`——和 TGit 同类坑。
3. **建 PR**：`POST /repos/{o}/{r}/pulls`，body `head`/`base`/`title`/`body`，响应 `html_url`（`/pull/` 单数）。
4. **建仓**：`POST /user/repos`（个人）body `{name, private, auto_init}`——实测建仓成功。
5. **fetchMR**：`GET /repos/{o}/{r}/pulls/{n}` + `/commits` + `/files`（diff 取 `patch`）。

### 5.1 关键修复：团队仓 push 认证

`teamai push` 的分支 push 走 `pushRepoBranch` → 裸 `git push`（无 auth 注入），依赖 clone 时持久化的凭据。
GitLab 的 clone 用一次性 `-c http.extraHeader`（不持久化）——照搬会导致 push 报 **Access denied**（实机复现）。
GitHub / TGit 的做法是把 token 内嵌进 remote URL（持久化到 `.git/config`）。

**修复**：`gitcodeRepoClone`（团队仓 clone）内嵌 `https://oauth2:<token>@gitcode.com/...`，
使 `git push`（分支 + PR 流程）能认证。token 只落在 `~/.teamai/team-repo` 的私有 clone 中，
与 GitHub / TGit 一致。（`clone.ts` 的浅克隆路径非 push 目标，沿用 extraHeader。）

### 5.2 关键修复：内嵌凭据必须绕开系统 Credential Helper

凭据已经在 URL 里，git 仍会把它交给平台 helper 缓存。实机复现：隔离 `HOME`（Xcode 的
`git-core/gitconfig` 仍启用 `credential.helper = osxkeychain`）下，`git credential-osxkeychain store`
找不到默认钥匙串，弹出「找不到用于储存 oauth2 的钥匙串」模态框并阻塞 git —— `teamai init` 撞满
clone 的 120s 超时后报 `Clone failed: ... Cloning into ...`（无其他 stderr），`teamai pull` 则卡在
`Pulling team repo...` 永不返回。

**修复**：内嵌凭据的 git 调用统一经 `spawnGit(..., { credentialInUrl: true })`
（`-c credential.helper=` + `GIT_TERMINAL_PROMPT=0`），clone 成功后 `pinUrlCredential()` 把空的
`credential.helper` 写入该 clone 的 local config，使后续 pull/fetch/push 一并跳过 helper；
`createGit()` 另加 120s「无输出」预算，让任何挂死都以报错收场而不是无限等待。
GitHub / TGit 走同一条内嵌路径，同步修复。

## 6. 端到端验证（真实 CLI + 真实 GitCode 仓）

- `teamai init https://gitcode.com/...`：✔ Detected provider gitcode / ✔ Authenticated / ✔ Team repo cloned /
  ✔ Member registration pushed（init 期的 push 也通过认证）。
- `teamai push --all`：✔ Pushed branch / ✔ **Pull Request created: `.../pull/1`**。
- `fetchMergeRequest(.../pull/1)`：✔ 拉到 title/author/commits/diff。
- clone：HTTPS（token 走内嵌，push 可用）+ SSH（公钥）均通过。
- 单测：gitcode + fallback 全过；type check 通过。
- 测试仓与临时 SSH key 已清理。

**未做真机覆盖**（边缘/可选）：`listOrgRepos`（缺测试组织）、组织建仓、交互式贴 token 分支。

## 7. 非目标

- 自托管 GitCode 企业版（`TEAMAI_GITCODE_HOST`）。
- OAuth 浏览器/device 登录（GitCode 无 device flow）。
- 内嵌 gitcode-cli 依赖。
