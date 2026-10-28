# Git Providers

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

TeamAI CLI talks to Git hosting platforms through a provider layer. Six providers are implemented:

| Provider | Host | Authentication | Suggested for |
|----------|------|----------------|---------------|
| `github` | github.com | `gh` CLI or the `GITHUB_TOKEN` environment variable | Open source projects, external users |
| `cnb` | cnb.cool | `cnb login` or the `CNB_TOKEN` environment variable | CNB (Cloud Native Build) users |
| `gitlab` | gitlab.com or a self-hosted instance | `GITLAB_TOKEN` environment variable | GitLab, including enterprise self-hosted |
| `gitcode` | gitcode.com | `GITCODE_TOKEN` environment variable, or paste a token during init | GitCode (CSDN) users |
| `git` | any Git host | The system Git credential helper or an SSH key | Self-hosted Gitea and other platforms |
| `tgit` | git.woa.com | `gf` CLI (downloaded automatically) + `~/.netrc` | Tencent internal teams |

## Provider auto-detection

`teamai init <input>` (or the equivalent `teamai init --repo <input>`) picks the provider from the shape of the input:

```
your-org/your-repo                        → github (default)
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

After a successful init the provider is written to the `provider` field of the team repo's `teamai.yaml`, and later `push` / `pull` runs follow that value. A member's own `--provider` choice, saved on their machine, takes precedence over it (next section).

### Choosing a provider by hand (`--provider`)

```bash
teamai init https://gitlab.example.com/group/repo --provider git
```

Values: `tgit`, `github`, `cnb`, `gitlab`, `gitcode`, `git`. `git` needs no platform token and uses your existing Git credentials; open PRs/MRs on the Git host yourself. The choice only affects your machine. A self-hosted GitLab with `--provider gitlab` still needs `GITLAB_URL` and `GITLAB_TOKEN`.

## Generic Git provider (self-hosted and private repos)

A full HTTPS or SSH URL whose host is not in the known list gets the `git` provider. For example:

```bash
teamai init https://code.qschou.com/Enterprise/arb-workflow-kit.git --scope user
# or over SSH
teamai init git@code.qschou.com:Enterprise/arb-workflow-kit.git --scope user
```

The generic provider preserves the clone path, including whether it ends in `.git`. Azure Repos uses this provider too:

```bash
teamai init https://dev.azure.com/org/project/_git/repo
```

The generic provider neither reads nor stores a platform token; the system `git` handles authentication:

- HTTPS: configure a Git credential helper first. Do not put a username, password or token in the URL.
- SSH: configure an SSH key first and make sure `ssh-agent` can reach the private key.

## GitHub provider

### Authentication

Two options; the `gh` CLI is recommended.

**Option 1: the `gh` CLI (recommended)**

```bash
# macOS
brew install gh

# Debian/Ubuntu
sudo apt install gh

# other platforms: https://cli.github.com/
```

Run `gh auth login` after installing, or let `teamai init` start the interactive login:

```bash
teamai init your-org/your-repo
# when not logged in, runs gh auth login --web (interactive terminals only)
```

A non-interactive run (stdin is not a TTY, or `CI` / `TEAMAI_NONINTERACTIVE` is set) does not start that login: nobody would complete the browser device flow and the job would hang until it timed out ([#711](https://github.com/Tencent/teamai-cli/issues/711)). `init` fails at once and asks you to export a `GITHUB_TOKEN` (or `GH_TOKEN`) with the `repo` scope.

**Option 2: the `GITHUB_TOKEN` environment variable**

Where the `gh` CLI cannot be installed (CI, containers, locked-down Linux), authenticate with a [personal access token](https://github.com/settings/tokens):

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
teamai init your-org/your-repo
```

The token needs the `repo` scope. `GH_TOKEN` is recognized as an alias.

When MR/PR import falls back to the GitHub REST API, a failed metadata, commits, or diff request reports its HTTP status and response body before AI extraction. Check the PR's visibility, credentials, or rate limit before retrying.

### Default branch

TeamAI detects the default branch with `getDefaultBranch()`: `origin/HEAD` first, then `origin/main` and `origin/master`. Both `main` and `master` work; no repository setting needs to change.

### Branch permission

Teammates need permission to push branches and to open pull requests. Leave the default branch protected. Reports and learnings use `teamai-reports` and `teamai-learnings`. See [Git permissions](distribution.md#git-permissions).

## TGit provider (Tencent Gongfeng)

### Authentication

`teamai init` downloads the Gongfeng CLI `gf` to `~/.teamai/gf/` and, in an interactive terminal, runs `gf auth login` (iOA SSO, browser device code or a manual token). The token lands in `~/.netrc` and every later git operation carries it.

A non-interactive run (stdin is not a TTY, or `CI` / `TEAMAI_NONINTERACTIVE` is set) does not start that login; it fails at once and asks you to run `gf auth login` once in an interactive terminal ([#711](https://github.com/Tencent/teamai-cli/issues/711)). There is no substitute token here: `TGIT_TOKEN` is only for the REST API, the git endpoints of git.woa.com do not accept it, so it cannot clone. After one login, non-interactive runs reuse the saved credentials.

### Default email domain

TGit sets the git commit email to `<username>@tencent.com` by default. The GitHub provider sets no default domain and lets the user's global git configuration apply.

## CNB provider (cnb.cool)

The CNB ([Cloud Native Build](https://cnb.cool)) provider is a thin wrapper around the official `@cnbcool/cnb-cli`, in the same spirit as TGit: authentication, repo creation and PR creation are delegated to the platform's own CLI. A missing CLI is installed with `npm i -g @cnbcool/cnb-cli`.

### Authentication

Two options, mirroring how the GitHub provider treats `GITHUB_TOKEN`.

**Option 1: `cnb login` (interactive, recommended on a workstation)**

```bash
cnb login --host cnb.cool   # OAuth2 device flow; afterwards `cnb git-credential` supplies git credentials
teamai init https://cnb.cool/your-org/your-repo
```

> **Why `--host`**: without an explicit host, the `cnb` CLI infers the platform address from the first git remote of the current directory. Running `cnb login` inside a repo whose remote points at a non-CNB platform (an internal git server, say) sends the request to that host and gets a `401`. An explicit `--host cnb.cool` avoids that; a self-hosted instance uses its own domain. When `teamai init` starts the login itself, it already passes `--host` from `TEAMAI_CNB_HOST` (default `cnb.cool`). That automatic login happens only in an interactive terminal; a non-interactive run fails at once and asks for `CNB_TOKEN` (option 2, [#711](https://github.com/Tencent/teamai-cli/issues/711)).

**Option 2: the `CNB_TOKEN` environment variable (headless / CI)**

```bash
export CNB_TOKEN=xxxxxxxx
teamai init https://cnb.cool/your-org/your-repo
```

With `CNB_TOKEN` set, `cnb login` is not needed. The username is read from `cnb users get-user-info` and can be overridden with `CNB_USERNAME`.

> **Organizations and repos must be created on the web.** The OAuth token from `cnb login` lacks the permissions to create an organization (`group-manage:rw`) or a repo (`group-resource:rw`), so the CLI cannot create them. When `teamai init` runs into one of these cases it prints the web link and asks you to run again afterwards:
> - the organization does not exist → `https://cnb.cool/new/groups`
> - the organization exists but you cannot create repos in it → `https://cnb.cool/new/repos`
>
> To let the CLI create them, use an access token with `group-manage:rw` / `group-resource:rw` instead (via `CNB_TOKEN`).

### Default email domain

The CNB provider sets no default email domain (same as GitHub).

### Host scope and self-hosting

Only the public community platform **cnb.cool** is supported (the only host that has been tested), and it is selected only when the URL names `cnb.cool`; it is never the default fallback.

An internal or enterprise instance (an intranet mirror, say) can override the git host with `TEAMAI_CNB_HOST`, but such a deployment must also point the `cnb` CLI at its API with `CNB_API_ENDPOINT` (and `CNB_WEB_ENDPOINT`). This wrapper does not manage those endpoints and the setup is untested, so it is not a supported configuration yet.

## GitLab provider (including self-hosted)

The GitLab provider uses the GitLab **REST API v4** and needs no external CLI, only a personal access token. This is the recommended shape for new providers: GitLab, self-hosted instances included, has a standard REST API with predictable behavior.

### Authentication

Configured through the standard GitLab environment variables:

```bash
export GITLAB_URL=https://gitlab.example.com    # base URL of a self-hosted instance; default https://gitlab.com
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxx       # personal access token with the api scope
export GITLAB_API_PREFIX=api/v4                  # API path prefix; default api/v4 (standard GitLab)
```

Three names are accepted for the token, in priority order: `GITLAB_TOKEN` > `GITLAB_PRIVATE_TOKEN` > `GITLAB_PAT`. An empty or whitespace-only value counts as unset and the next alias is tried.

`GITLAB_URL` **must carry a scheme** (`https://` or `http://`). `gitlab.example.com` on its own makes GitLab operations exit with an error instead of silently falling back to gitlab.com. Intranet http instances, non-standard ports and sub-path deployments (`https://example.com/gitlab`) are preserved in full, clone URLs included. MR import also preserves this deployment prefix in API requests and leaves it out of the project id; the MR URL must belong to that instance path.

`GITLAB_API_PREFIX` is for gateway setups where the GitLab API is mounted on a non-standard path (`/api/gitlab` instead of `/api/v4`). It also applies to the group repository listing used by `teamai import --from-org`, every page included; unset or empty, `api/v4` is used. Setting it avoids 405 errors in those setups. Examples:

```bash
# standard self-hosted GitLab (default, GITLAB_API_PREFIX not needed)
export GITLAB_URL=https://gitlab.example.com
export GITLAB_TOKEN=glpat-xxx

# gateway setup (API path changed to /api/gitlab)
export GITLAB_URL=https://code.company.com
export GITLAB_API_PREFIX=api/gitlab
export GITLAB_TOKEN=glpat-xxx
```

GitLab MR creation has a 30-second deadline, shared by reviewer lookups, the create request and their response bodies. Init uses its configured push timeout instead. An expired reviewer lookup stops creation; other reviewer lookup failures remain best-effort. If creation times out, the pushed branch remains available for manual review. A timeout after the create request was sent cannot prove that GitLab did not create the MR; check the host before retrying.

### Default email domain

The GitLab provider sets no default email domain (same as GitHub) and uses the user's global git configuration.

## GitCode provider (gitcode.com)

GitCode (gitcode.com, CSDN's platform) uses a Gitee-style **REST API v5** (`https://api.gitcode.com/api/v5`), needs no external CLI, and relies on a single personal access token. The provider is modeled on the GitLab one structurally, but the API dialect is entirely different: a separate API domain, `Authorization: Bearer`, PRs created with `head`/`base`/`title`/`body`, whoami in `login`.

### Authentication

The token is resolved in this order:

1. `GITCODE_TOKEN` (primary)
2. `GC_TOKEN` (alias, for existing gitcode-cli users)
3. the `machine gitcode.com` entry in `~/.netrc`

```bash
export GITCODE_TOKEN=xxxxxxxxxxxx
```

Generate the PAT under GitCode → Settings → Access Tokens.

**Interactive login**: on the first `teamai init` without a configured token, you are asked to paste a PAT once; after verification it is written to `~/.netrc` (mode `0600`) for later commands and `git push`. In CI and headless environments set `GITCODE_TOKEN` directly; no prompt appears.

### Namespaces

GitCode namespaces are single-level (a user or an organization); repo addresses look like `owner/repo` and nested subgroups are not supported. Only the public cloud `gitcode.com` is supported.

### Default email domain

GitCode sets no default email domain and uses the user's global git configuration.

## Setting the provider in `teamai.yaml`

Besides URL auto-detection, the team repo's `teamai.yaml` can name the provider explicitly with `provider: github`, `provider: tgit`, `provider: cnb`, `provider: gitlab`, `provider: gitcode` or `provider: git`. A typical `teamai.yaml`:

```yaml
team: my-team
description: TeamAI shared resources
repo: https://github.com/your-org/your-repo.git
provider: github
reviewers:
  - alice
  - bob
```

## Adding a provider

Provider internals and the steps for adding a new one are in [Adding a Git provider](../dev/adding-a-provider.md).
