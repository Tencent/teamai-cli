# CI E2E Setup

The `e2e` job on GitHub Actions runs the full end-to-end suite (init / push / pull / source / env / tags / roles / contribute / dashboard / uninstall …), matching the coverage that used to be checked by hand, one command at a time. This page explains the configuration the job needs before it will run on CI.

---

## When the job runs

The `e2e` job runs on:

- a push to `master` / `main`
- any PR targeting `master` / `main`
- only when the repository variable `TEAMAI_TEST_REPO_URL` is set; otherwise the job skips itself (a fork without the secrets skips cleanly, with no red CI)

Several PRs or pushes operating on the same fixture repo at once would corrupt its state, so the job runs under `concurrency: e2e-fixture-repo`: runs queue up and a run in progress is not cancelled, so it finishes and leaves a clean state behind.

PRs from forks run `fork-e2e` (no token; the remote cases skip). A test must never rebuild `dist/` or reinstall the OpenCode binary: workers share both.

---

## Required configuration

### 1. Repository variable: `TEAMAI_TEST_REPO_URL`

GitHub repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**

| Name | Value | Notes |
|---|---|---|
| `TEAMAI_TEST_REPO_URL` | `<owner>/<repo>` | The fixture repo the E2E suite works against (`owner/repo` or a full https URL) |

> The maintainers of this repository pick the fixture repo. Any private or public repo dedicated to e2e will do. CI pushes, pulls and uninstalls against it over and over, so **do not reuse a production repo**.
> To switch fixture repos, change this variable; no code change is needed.

### 2. Repository secret: `TEAMAI_TEST_TOKEN`

**Settings → Secrets and variables → Actions → Secrets → New repository secret**

| Name | Value |
|---|---|
| `TEAMAI_TEST_TOKEN` | A GitHub fine-grained personal access token with read/write access to the fixture repo |

#### Generating the token

1. Sign in with an account that has **admin or write access to the fixture repo**.
2. Open https://github.com/settings/personal-access-tokens/new
3. Configure:
   - **Token name**: `teamai-cli e2e fixture (CI)`
   - **Expiration**: 90 days (renew before it expires)
   - **Repository access** → Only select repositories → the fixture repo that `TEAMAI_TEST_REPO_URL` points at
   - **Permissions** → Repository permissions:
     - `Contents`: **Read and write** (needed by push/pull)
     - `Pull requests`: **Read and write** (the push flow opens a PR)
     - `Metadata`: Read-only (default)
4. Generate → copy the token (shown once) → paste it into the GitHub secret

> ⚠️ The token is a credential. It lives only in GitHub Secrets; **never commit it to code or a `.env` file**.
> ⚠️ GitHub emails a reminder before expiry. Renew the token then and update the secret.

---

## What the suite runs

The `remote commands` and `init project scope` describes in `src/__tests__/e2e/e2e.test.ts` (token required) cover:

| Command | What it checks |
|---|---|
| `members` / `members list` / `members add` | Listing members; confirming the `add` flow is gone |
| `status` | Runs without crashing |
| `pull --dry-run` / `pull --force` | Sync flow |
| `push --dry-run` | Push flow (nothing is actually pushed) |
| `tags` / `tags subscribe` / `tags unsubscribe` | Tag subscription round trip |
| `tags add` / `tags remove` | Admin tag operations round trip (on a real skill) |
| `source list` | Listing sources (also runs without a token) |
| `env add` / `env list` / `env remove` | Team env variable round trip |
| `stats` / `digest` / `recall` | Read-only analysis commands |
| `track --tool claude` | Hook event reporting |
| `contribute --dry-run --file ...` | Learning contribution dry run |
| `dashboard -p 37210` | Spawns the web server, checks it with curl, kills it |
| `uninstall --dry-run` / `uninstall --force` | Uninstall preview, real uninstall, re-init recovery |
| `roles set + pull` | The skill set changes after switching role |
| `init <repo> --force` (default project scope) | Fresh init (sandbox cwd + isolated HOME) |

Without a token: `--version` / `--help` / `tags --help` / `members --help` / `uninstall --help` / source sanity checks, plus the source add → list → browse → pull/deploy → remove/cleanup lifecycle in `source-project-scope-e2e.test.ts`, which uses a real local Git repo. PRs from forks can run these.

---

## Checking a change locally

Most cases use only local fixtures and need no token. While developing, run only the affected files; run the whole `npm run test:e2e` when you change the e2e runner, shared fixtures or test isolation (add `--maxWorkers=2` on a small machine):

```bash
npm run test:e2e -- <test-file>
```

## Reproducing CI's remote e2e locally

⚠️ **Do not run this against your real `~/.teamai/`.** It would pollute your working repos.

```bash
# 1. Isolate a temporary HOME
export HOME=$(mktemp -d)

# 2. Point at the fixture repo and token (fill in owner/repo)
export TEAMAI_TEST_PROVIDER=github
export TEAMAI_TEST_REPO_URL=<owner>/<repo>
export TEAMAI_TEST_TOKEN=ghp_xxxxx
export GITHUB_TOKEN=$TEAMAI_TEST_TOKEN

# 3. Prepare ~/.teamai/config.yaml and clone the fixture repo
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

# 4. Run
npm run build
npx vitest run --config vitest.e2e.config.ts --reporter=verbose
```

Afterwards `rm -rf $HOME` cleans up (`$HOME` is the temporary directory here, not your real home).

---

## Troubleshooting

### `Skipping remote E2E tests: TEAMAI_TEST_TOKEN or TEAMAI_TEST_REPO_URL not set`

On CI: check that the secret and variable names match exactly (case matters). A PR from a fork cannot read the secret and skips; that is expected.

### `403 Resource not accessible by personal access token`

The fine-grained token is missing a permission. Confirm `Contents: read/write` and `Pull requests: read/write` are both on and the right repository is selected.

### The `dashboard` test times out

Startup took longer than 10 seconds. Raise `testTimeout` in `vitest.e2e.config.ts`, or the `i < 20` bound in the loop.

### The fixture repo is left dirty (for example a stray `__ci_e2e_tag__`)

Normally the tests clean up after themselves with add/remove round trips. If a run crashed halfway and left residue: clone the fixture repo locally, `git revert` or reset by hand, and push. On a CI failure the `Cleanup fixture repo state on failure` step also runs `git reset --hard HEAD`.
