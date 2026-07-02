# CI E2E Setup

GitHub Actions 上的 `e2e` job 跑全量端到端测试（init / push / pull / source / env / tags / roles / contribute / dashboard / uninstall …），跟之前手工逐个命令测的覆盖面对齐。本文档说明怎么配置才能让 e2e 真正在 CI 上跑起来。

---

## 触发条件

`e2e` job 在以下情况触发：

- 推送到 `master` / `main`
- 任何 PR 指向 `master` / `main`
- 仓库变量 `TEAMAI_TEST_REPO_URL` **必须**已配置，否则 job 自动跳过（fork 出来的仓没配 secrets 会自动 skip，CI 不报红）

为了避免多个 PR/push 同时操作同一个 fixture 仓造成状态污染，e2e job 用 `concurrency: e2e-fixture-repo` 串行排队跑（不取消正在跑的，让它跑完留下干净状态）。

---

## 必需的配置

### 1. Repository Variable: `TEAMAI_TEST_REPO_URL`

GitHub repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**

| Name | Value | 说明 |
|---|---|---|
| `TEAMAI_TEST_REPO_URL` | `<owner>/<repo>` | E2E 用的 fixture 仓（`owner/repo` 简写或完整 https URL 都行） |

> Fixture 仓由本仓库 maintainer 自行选定。可以是任何专门用来跑 e2e 的私有/公开仓 —— CI 会反复在它上面 push/pull/uninstall，所以**不要复用线上业务仓**。
> 换 fixture 仓只要改这个 Variable 的值即可，无需改代码。

### 2. Repository Secret: `TEAMAI_TEST_TOKEN`

**Settings → Secrets and variables → Actions → Secrets → New repository secret**

| Name | Value |
|---|---|
| `TEAMAI_TEST_TOKEN` | GitHub Fine-grained Personal Access Token，对 fixture 仓有读写权限 |

#### 怎么生成这个 token

1. 用**对 fixture 仓有 admin/write 权限**的账号登录
2. 访问 https://github.com/settings/personal-access-tokens/new
3. 配置：
   - **Token name**: `teamai-cli e2e fixture (CI)`
   - **Expiration**: 90 天（到期前续）
   - **Repository access** → Only select repositories → 选 `TEAMAI_TEST_REPO_URL` 指向的那个 fixture 仓
   - **Permissions** → Repository permissions：
     - `Contents`: **Read and write**（push/pull 必需）
     - `Pull requests`: **Read and write**（push 流程会建 PR）
     - `Metadata`: Read-only（默认）
4. Generate → 复制 token（只显示一次）→ 粘贴到 GitHub Secret

> ⚠️ Token 是私货，只配在 GitHub Secrets 里，**绝不要 commit 到代码或 .env**。
> ⚠️ 到期前 GitHub 会发邮件提醒，看到提醒就续一下并更新 Secret。

---

## 跑了哪些命令

`src/__tests__/e2e/e2e.test.ts` 的 `remote commands` + `init project scope` 两个 describe 覆盖（要 token 才跑）：

| 命令 | 测试什么 |
|---|---|
| `members` / `members list` / `members add` | 列成员、确认 add 流不再有 |
| `status` | 跑通不崩 |
| `pull --dry-run` / `pull --force` | 同步流程 |
| `push --dry-run` | 推送流程（不真推） |
| `tags` / `tags subscribe` / `tags unsubscribe` | tag 订阅 roundtrip |
| `tags add` / `tags remove` | admin tag 操作 roundtrip（在真实 skill 上） |
| `source list` | 列 source（无 token 也能跑） |
| `env add` / `env list` / `env remove` | 团队环境变量 roundtrip |
| `stats` / `digest` / `recall` | 只读分析命令 |
| `track --tool claude` | hook 事件上报 |
| `contribute --dry-run --file ...` | 经验贡献 dry-run |
| `dashboard -p 37210` | spawn Web 服务 + curl 验活 + kill |
| `uninstall --dry-run` / `uninstall --force` | 卸载预览 + 真卸载 + 重建恢复 |
| `roles set + pull` | 切换角色后 skill 集变化 |
| `init --scope project --repo ... --force` | 全新 init（沙盒 cwd + 隔离 HOME） |

不要 token 的部分：`--version` / `--help` / `tags --help` / `members --help` / `uninstall --help` / 源码 sanity check —— PR from forks 也能跑。

---

## 本地复现 CI 的 e2e

⚠️ **不要用你自己的真实 `~/.teamai/`** 跑！会污染你的工作仓。

```bash
# 1. 隔离一个临时 HOME
export HOME=$(mktemp -d)

# 2. 配 fixture 仓 + token（owner/repo 自己填）
export TEAMAI_TEST_PROVIDER=github
export TEAMAI_TEST_REPO_URL=<owner>/<repo>
export TEAMAI_TEST_TOKEN=ghp_xxxxx
export GITHUB_TOKEN=$TEAMAI_TEST_TOKEN

# 3. 准备 ~/.teamai/config.yaml + clone fixture 仓
mkdir -p $HOME/.teamai
git clone "https://x-access-token:${TEAMAI_TEST_TOKEN}@github.com/${TEAMAI_TEST_REPO_URL}.git" \
  $HOME/.teamai/team-repo
cat > $HOME/.teamai/config.yaml <<EOF
repo:
  localPath: $HOME/.teamai/team-repo
  remote: $TEAMAI_TEST_REPO_URL
username: ci
updatePolicy: auto
EOF

# 4. 跑
npm run build
npx vitest run --config vitest.e2e.config.ts --reporter=verbose
```

跑完之后 `rm -rf $HOME` 即可清理（注意 `$HOME` 是临时目录，不是你真实的 home）。

---

## 故障排查

### `Skipping remote E2E tests: TEAMAI_TEST_TOKEN or TEAMAI_TEST_REPO_URL not set`

CI 上：检查 Secret/Variable 名字拼写是否完全一致（区分大小写）；fork PR 拿不到 secret，正常 skip。

### `403 Resource not accessible by personal access token`

Fine-grained token 权限不全。确认 `Contents: read/write` + `Pull requests: read/write` 都打开了，且选中了正确的仓。

### `dashboard` 测试 timeout

启动慢于 10 秒。把 `vitest.e2e.config.ts` 的 `testTimeout` 调大，或把循环里的 `i < 20` 调大。

### Fixture 仓被 e2e 写脏（残留 `__ci_e2e_tag__` 之类）

正常情况测试会 add/remove roundtrip 自清。如果中途崩了留下垃圾：本地 clone fixture → 手动 `git revert` 或 reset → push。CI 失败时也会跑 `Cleanup fixture repo state on failure` step 做 `git reset --hard HEAD`。
