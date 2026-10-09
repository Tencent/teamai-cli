# Git Providers

> [English](providers.md) | [简体中文](zh-CN/providers.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

TeamAI CLI talks to Git hosting platforms through a provider layer. Six providers are implemented:

| Provider | Host | Authentication | Suggested for |
|----------|------|----------------|---------------|
| `github` | github.com | `gh` CLI or the `GITHUB_TOKEN` environment variable | Open source projects, external users |
| `tgit` | git.woa.com | `gf` CLI (downloaded automatically) + `~/.netrc` | Tencent internal teams |
| `cnb` | cnb.cool | `cnb login` or the `CNB_TOKEN` environment variable | CNB (Cloud Native Build) users |
| `gitlab` | gitlab.com or a self-hosted instance | `GITLAB_TOKEN` environment variable | GitLab, including enterprise self-hosted |
| `gitcode` | gitcode.com | `GITCODE_TOKEN` environment variable, or paste a token during init | GitCode (CSDN) users |
| `git` | any Git host | The system Git credential helper or an SSH key | Self-hosted Gitea and other platforms |

## Provider auto-detection

`teamai init <input>` (or the equivalent `teamai init --repo <input>`) picks the provider from the shape of the input:

```
yourorg/yourrepo                        → github (default)
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
https://git.example.com/group/repo.git  → probe for GitLab, otherwise git
git@git.example.com:group/repo.git      → probe for GitLab, otherwise git
```

Known hosts and an explicitly configured GitLab instance win. For an unknown host, `init` probes the GitLab sign-in page anonymously. If the host is confirmed to be an unconfigured GitLab instance, `init` asks you to set `GITLAB_URL` and `GITLAB_TOKEN` and run again; it never writes the probe result into the configuration. An unconfirmed host keeps using `git`.

After a successful init the provider is written to the `provider` field of the team repo's `teamai.yaml`, and later `push` / `pull` runs follow that value. A member's own `--provider` choice, saved on their machine, takes precedence over it (next section). Probing never changes an existing provider.

### Choosing a provider by hand (`--provider`)

`teamai init <input> --provider <name>` skips the auto-detection above, including the GitLab probe, and uses the named provider. The values are the same as in `teamai.yaml`: `tgit`, `github`, `cnb`, `gitlab`, `gitcode`, `git`. The typical case is a team repo on a self-hosted GitLab whose members only need plain Git: `--provider git` performs no platform login, does not check `GITLAB_TOKEN`, and runs clone/pull/push with your existing Git credentials.

The choice is written to the member's local configuration (`provider` field) and affects only that machine: creating PRs/MRs (`push`, `remove` and friends) and the provider check in `doctor` use it first; the existing `teamai.yaml` is unchanged. When `init` creates a new `teamai.yaml` (an empty repo, or the first init in single-repo mode), `--provider git` still writes the provider that would have been detected without the flag, GitLab probe included; if the probe finds a self-hosted GitLab that is not configured yet, `init` stops and asks for `GITLAB_URL` rather than writing `git` as the team default. Any other value is written as given. Running `init` again without `--provider` restores auto-detection.

A self-hosted GitLab used with `--provider gitlab` still needs `GITLAB_URL` (and `GITLAB_TOKEN`). The GitLab API address comes from `GITLAB_URL`, and defaults to gitlab.com when unset, so when detection cannot recognize the host `init` exits with an error instead of sending the token somewhere else.

## Generic Git provider (self-hosted and private repos)

A full HTTPS or SSH URL whose host is not in the known list, does not match an explicit GitLab configuration, and is not confirmed as GitLab by the probe gets the `git` provider. For example:

```bash
teamai init https://code.qschou.com/Enterprise/arb-workflow-kit.git --scope user
# or over SSH
teamai init git@code.qschou.com:Enterprise/arb-workflow-kit.git --scope user
```

The generic provider neither reads nor stores a platform token; the system `git` handles authentication:

- HTTPS: configure a Git credential helper first. Do not put a username, password or token in the URL.
- SSH: configure an SSH key first and make sure `ssh-agent` can reach the private key.

`teamai init .` is a limited exception: it only reads the `origin` already configured in the current business repo. If that origin is a legacy HTTP Basic URL (for example `http://user:token@host/group/repo.git`), init uses its host and path to identify the repo but strips the username and token before writing `.teamai/teamai.yaml`, the local TeamAI configuration and logs. A plain `teamai init <url>`, clone, and every other generic Git URL input still reject HTTP and embedded credentials. HTTP does not encrypt Git traffic; move to HTTPS with a credential helper, or to SSH, as soon as you can.

clone, pull and push all work. Platform API operations (creating a repo, creating an MR/PR) cannot be implemented uniformly across services and are not supported: `teamai push` pushes the branch, asks you to open the MR on the platform by hand, and exits non-zero to signal that the automatic PR/MR creation did not happen.

If a repo already configured with `provider: git` fails to create a PR, the CLI checks the host once more. When it is confirmed to be GitLab, the CLI asks you to set the instance URL and token and to change `provider` to `gitlab` in the team repo's `teamai.yaml`. The hint changes no configuration and does not undo the branch that was already pushed.

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
teamai init yourorg/yourrepo
# when not logged in, runs gh auth login --web (interactive terminals only)
```

An unattended run (stdin is not a TTY, or `CI` / `TEAMAI_NONINTERACTIVE` is set) does not start that login: nobody would complete the browser device flow and the job would hang until it timed out ([#711](https://github.com/Tencent/teamai-cli/issues/711)). `init` fails at once and asks you to export a `GITHUB_TOKEN` (or `GH_TOKEN`) with the `repo` scope.

**Option 2: the `GITHUB_TOKEN` environment variable**

Where the `gh` CLI cannot be installed (CI, containers, locked-down Linux), authenticate with a [personal access token](https://github.com/settings/tokens):

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
teamai init yourorg/yourrepo
```

The token needs the `repo` scope. `GH_TOKEN` is recognized as an alias.

### Supported operations

| Operation | Implementation |
|-----------|----------------|
| clone | `git clone https://x-access-token:$TOKEN@github.com/...` |
| create repo | `POST /user/repos` or `POST /orgs/:org/repos` |
| create PR | `gh pr create` or `POST /repos/:o/:r/pulls` |
| request reviewers | `gh pr create -r` or `POST .../requested_reviewers` |

### Default branch

TeamAI detects the default branch with `getDefaultBranch()`: `origin/HEAD` first, then `origin/main` and `origin/master`. Both `main` and `master` work; no repository setting needs to change.

### Minimum permissions when the default branch is protected

Members need to push `teamai-reports` and `teamai-learnings` (including creating those two refs the first time), push the feature branches `teamai push` creates, and open PRs against the default branch. They do not need to push `main` / `master` directly, bypass branch protection, or hold admin rights. See the [project-scope section of Admin Setup](admin-setup.md#project-scope-default).

Note: `provider: git` cannot open PRs; `teamai push` pushes the branch and prints the command for opening the PR by hand. `teamai contribute` pushes `teamai-learnings` directly, without a PR.

## TGit provider (Tencent Gongfeng)

### Authentication

`teamai init` downloads the Gongfeng CLI `gf` to `~/.teamai/gf/` and, in an interactive terminal, runs `gf auth login` (iOA SSO, browser device code or a manual token). The token lands in `~/.netrc` and every later git operation carries it.

An unattended run (stdin is not a TTY, or `CI` / `TEAMAI_NONINTERACTIVE` is set) does not start that login; it fails at once and asks you to run `gf auth login` once in an interactive terminal ([#711](https://github.com/Tencent/teamai-cli/issues/711)). There is no substitute token here: `TGIT_TOKEN` is only for the REST API, the git endpoints of git.woa.com do not accept it, so it cannot clone. After one login, unattended runs reuse the saved credentials.

### Nested namespaces

TGit supports `group/subgroup/repo` paths (GitHub does not), and the provider has dedicated path handling for them:

```
https://git.woa.com/Group/Subgroup/repo
git@git.woa.com:Group/Subgroup/repo.git
```

### Default email domain

TGit sets the git commit email to `<username>@tencent.com` by default. The GitHub provider sets no default domain and lets the user's global git configuration apply.

## CNB provider (cnb.cool)

The CNB ([Cloud Native Build](https://cnb.cool)) provider is a thin wrapper around the official `@cnbcool/cnb-cli`, in the same spirit as TGit: authentication, repo creation and PR creation are delegated to the platform's own CLI. A missing CLI is installed with `npm i -g @cnbcool/cnb-cli`.

### Authentication

Two options, mirroring how the GitHub provider treats `GITHUB_TOKEN`.

**Option 1: `cnb login` (interactive, recommended on a workstation)**

```bash
cnb login --host cnb.cool   # OAuth2 device flow; afterwards `cnb git-credential` supplies git credentials
teamai init https://cnb.cool/yourorg/yourrepo
```

> **Why `--host`**: without an explicit host, the `cnb` CLI infers the platform address from the first git remote of the current directory. Running `cnb login` inside a repo whose remote points at a non-CNB platform (an internal git server, say) sends the request to that host and gets a `401`. An explicit `--host cnb.cool` avoids that; a self-hosted instance uses its own domain. When `teamai init` starts the login itself, it already passes `--host` from `TEAMAI_CNB_HOST` (default `cnb.cool`). That automatic login happens only in an interactive terminal; an unattended run fails at once and asks for `CNB_TOKEN` (option 2, [#711](https://github.com/Tencent/teamai-cli/issues/711)).

**Option 2: the `CNB_TOKEN` environment variable (headless / CI)**

```bash
export CNB_TOKEN=xxxxxxxx
teamai init https://cnb.cool/yourorg/yourrepo
```

With `CNB_TOKEN` set, `cnb login` is not needed. The username is read from `cnb users get-user-info` and can be overridden with `CNB_USERNAME`.

### Supported operations

| Operation | Implementation |
|-----------|----------------|
| clone | `git clone https://cnb:$CNB_TOKEN@cnb.cool/...`, or `cnb git-credential` |
| create repo | `cnb repositories create-repo` |
| create PR | `cnb pulls post-pull` |
| username | `cnb users get-user-info` (or `CNB_USERNAME`) |

> **Organizations and repos must be created on the web.** The OAuth token from `cnb login` lacks the permissions to create an organization (`group-manage:rw`) or a repo (`group-resource:rw`), so the CLI cannot create them. When `teamai init` runs into one of these cases it prints the web link and asks you to run again afterwards:
> - the organization does not exist → `https://cnb.cool/new/groups`
> - the organization exists but you cannot create repos in it → `https://cnb.cool/new/repos`
>
> To let the CLI create them, use an access token with `group-manage:rw` / `group-resource:rw` instead (via `CNB_TOKEN`).

### Nested namespaces

Like TGit, CNB supports nested `org/subgroup/repo` paths.

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

`GITLAB_URL` **must carry a scheme** (`https://` or `http://`). `gitlab.example.com` on its own makes GitLab operations exit with an error instead of silently falling back to gitlab.com. Intranet http instances, non-standard ports and sub-path deployments (`https://example.com/gitlab`) are preserved in full, clone URLs included.

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

### Detecting a self-hosted instance

- **Public gitlab.com**: the URL host matches directly and the gitlab provider is selected.
- **Self-hosted instance**: with `GITLAB_URL` set, a URL whose host equals the host of `GITLAB_URL` is recognized as gitlab. `TEAMAI_GITLAB_HOST` can name the host directly; without `GITLAB_URL` the API then points at `https://<that host>`. If both are set with different hosts, teamai stops with an error before sending the token. The repo argument must be a full HTTP(S) or SSH URL:
  ```bash
  export GITLAB_URL=https://git.example.com
  teamai init https://git.example.com/yourgroup/yourrepo     # → gitlab
  ```
- **Unknown, unconfigured host**: `init` requests `/users/sign_in?auto_sign_in=false` under the root path anonymously and confirms GitLab only when the response carries clear GitLab page markers. Once confirmed, it stops before authenticating, cloning or writing configuration, and asks you to set `GITLAB_URL` and a `GITLAB_TOKEN` with the `api` scope and run again. The instance URL is never persisted automatically.
- **Probe limits**: three seconds total, no token, no redirects, TLS verification on. An HTTP(S) repo URL keeps its scheme and web port; an SSH repo URL is probed over HTTPS on port 443, never on the SSH port. Timeouts, network errors, proxy interception, redirects and unrecognizable pages all fall back to `git`. Sub-path deployments, sign-in pages hidden behind SSO, and instances whose web address differs from the SSH host need an explicit `GITLAB_URL`.
- **Existing `provider: git`**: after setting the instance URL and token, also change `provider` to `gitlab` in the team repo's `teamai.yaml`. Environment variables alone do not override the provider in the configuration. The GitLab probe after a failed PR creation only prints the fix; it does not switch automatically.

### Division of labor with the generic `git` provider

Detection order is **known host → explicitly configured self-hosted GitLab → anonymous GitLab probe → generic `git` fallback**. The anonymous probe serves only the configuration hint in `init` and the diagnostic after the generic provider fails to create a PR; it confirms only pages with clear GitLab markers and never configures an instance or token. An unconfirmed host uses the generic provider: clone/pull/push run with the system Git credentials, and repo creation and MR creation are unsupported. Repo creation, MR creation, MR data fetching and group repo listing become available once the GitLab provider is configured.

### Nested namespaces

GitLab supports `group/subgroup/repo` paths, and the provider keeps the full group path:

```
https://git.example.com/Group/Subgroup/repo
git@git.example.com:Group/Subgroup/repo.git
```

A URL pasted from the browser address bar works too: GitLab's `/-/` route separator and everything after it (`/-/tree/main`, `/-/merge_requests/42`, `/-/blob/...`) is stripped and the URL resolves back to the project.

### Supported operations

| Operation | Implementation |
|-----------|----------------|
| clone | `git clone <base-url>/...`; the token is injected as `oauth2:` basic auth through `-c http.extraHeader`, not in the URL, so it does not linger in the clone's `.git/config` |
| create repo | `POST /api/v4/projects` (the user namespace, or the group resolved exactly by path; an unresolved group is an error, not a fallback to the personal namespace) |
| create MR | `POST /api/v4/projects/:id/merge_requests` |
| request reviewers | resolve username → user id, submit `reviewer_ids` |
| fetch MR data | `GET /api/v4/projects/:id/merge_requests/:iid` + commits + changes; the MR URL's host must match the configured instance (`GITLAB_URL` / `TEAMAI_GITLAB_HOST`, default gitlab.com) or the request is refused, so the token never goes to an unconfigured host |
| list group repos | `GET /api/v4/groups/:path/projects` (paged, `include_subgroups=true`) |

`/api/v4` in the table is the default prefix; with `GITLAB_API_PREFIX` set, API requests use the configured prefix.

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

GitCode namespaces are single-level (a user or an organization); repo addresses look like `owner/repo` and nested subgroups are not supported.

### Supported operations

| Operation | Implementation |
|-----------|----------------|
| clone | HTTPS with an embedded `oauth2:<token>@` (team repo, so the credential persists for later pushes) or `http.extraHeader` (shallow clones); SSH public keys also work |
| createRepo | personal `POST /user/repos`; organization `POST /orgs/:org/repos` |
| createPullRequest | `POST /repos/:owner/:repo/pulls` (`head`/`base`/`title`/`body`) |
| fetchMergeRequest | `GET /repos/:owner/:repo/pulls/:n` + commits + files; the PR URL's host must be gitcode.com or the request is refused, so the token never goes to an unconfigured host |
| listOrgRepos | `GET /orgs/:org/repos`, paged |

> Only the public cloud `gitcode.com` is supported; self-hosted GitCode Enterprise is not.

**Key dialect difference**: GitCode's git-over-HTTPS endpoints **reject `Authorization: Bearer`** and accept only Basic `oauth2:<token>` (verified against the live service), while the REST API uses Bearer. The team-repo clone therefore embeds the token in the remote URL (`oauth2:<token>@`) so that `git push` (the branch + PR flow) authenticates, as with GitHub and TGit.

### Default email domain

GitCode sets no default email domain and uses the user's global git configuration.

## Setting the provider in `teamai.yaml`

Besides URL auto-detection, the team repo's `teamai.yaml` can name the provider explicitly with `provider: github`, `provider: tgit`, `provider: cnb`, `provider: gitlab`, `provider: gitcode` or `provider: git`. A typical `teamai.yaml`:

```yaml
team: my-team
description: TeamAI shared resources
repo: https://github.com/yourorg/yourrepo.git
provider: github
reviewers:
  - alice
  - bob
```

## Adding a provider

Provider internals and the steps for adding a new one are in [Adding a Git provider](../dev/adding-a-provider.md).
