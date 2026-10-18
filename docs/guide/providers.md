# Git Providers

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

TeamAI CLI talks to Git hosting platforms through a provider layer. Seven providers are implemented:

| Provider | Host | Authentication | Suggested for |
|----------|------|----------------|---------------|
| `github` | github.com | `gh` CLI or the `GITHUB_TOKEN` environment variable | Open source projects, external users |
| `cnb` | cnb.cool | `cnb login` or the `CNB_TOKEN` environment variable | CNB (Cloud Native Build) users |
| `gitlab` | gitlab.com or a self-hosted instance | `GITLAB_TOKEN` environment variable | GitLab, including enterprise self-hosted |
| `gitea` | configured self-hosted instance | `GITEA_TOKEN` or a hidden token prompt | Gitea PR workflow |
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

Values: `tgit`, `github`, `cnb`, `gitlab`, `gitcode`, `gitea`, `git`. `git` needs no platform token and uses your existing Git credentials; open PRs/MRs on the Git host yourself. The choice only affects your machine. A self-hosted GitLab with `--provider gitlab` still needs `GITLAB_URL` and `GITLAB_TOKEN`.

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

An unattended run (stdin is not a TTY, or `CI` / `TEAMAI_NONINTERACTIVE` is set) does not start that login: nobody would complete the browser device flow and the job would hang until it timed out ([#711](https://github.com/Tencent/teamai-cli/issues/711)). `init` fails at once and asks you to export a `GITHUB_TOKEN` (or `GH_TOKEN`) with the `repo` scope.

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

An unattended run (stdin is not a TTY, or `CI` / `TEAMAI_NONINTERACTIVE` is set) does not start that login; it fails at once and asks you to run `gf auth login` once in an interactive terminal ([#711](https://github.com/Tencent/teamai-cli/issues/711)). There is no substitute token here: `TGIT_TOKEN` is only for the REST API, the git endpoints of git.woa.com do not accept it, so it cannot clone. After one login, unattended runs reuse the saved credentials.

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

> **Why `--host`**: without an explicit host, the `cnb` CLI infers the platform address from the first git remote of the current directory. Running `cnb login` inside a repo whose remote points at a non-CNB platform (an internal git server, say) sends the request to that host and gets a `401`. An explicit `--host cnb.cool` avoids that; a self-hosted instance uses its own domain. When `teamai init` starts the login itself, it already passes `--host` from `TEAMAI_CNB_HOST` (default `cnb.cool`). That automatic login happens only in an interactive terminal; an unattended run fails at once and asks for `CNB_TOKEN` (option 2, [#711](https://github.com/Tencent/teamai-cli/issues/711)).

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

Besides URL auto-detection, the team repo's `teamai.yaml` can name the provider explicitly with `provider: github`, `provider: tgit`, `provider: cnb`, `provider: gitlab`, `provider: gitcode`, `provider: gitea` or `provider: git`. A typical `teamai.yaml`:

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


## Gitea provider (self-hosted)

The `gitea` provider uses the instance REST API and Git directly. It needs no
separate platform CLI. Configure the full instance URL before joining a team:

```bash
export GITEA_URL=https://gitea.example.com
teamai init https://gitea.example.com/your-org/team.git --scope user
```

An unknown HTTP(S) host can be probed anonymously for a compatible version
endpoint. This only prints a configuration hint; it never authorizes sending a
token to that host. Set `GITEA_URL` and retry. This build does not map gitea.com
globally or claim Forgejo compatibility without a separate live verification.

### Authentication and URLs

Set `GITEA_TOKEN` to a Personal Access Token, or paste one at the hidden terminal
prompt during `init`. The token is verified with `GET /api/v1/user` before it is
saved to `~/.netrc` with mode `0600`. Non-interactive initialization requires an
existing env/netrc token and fails immediately when none is configured. An invalid
configured token fails with an actionable error rather than restarting login.

The token needs access to the repository, PRs/reviewers/comments, the user profile,
and any organization operations you use. Token scopes vary by server version:
verify them against that instance's API documentation. An administrator should
create the organization and team repository before member onboarding; a private
repository's ambiguous 404 is not treated as permission to create another one.

`GITEA_URL` preserves its HTTP(S) scheme, port and reverse-proxy subpath. HTTP
repository/PR URLs must match that complete origin and base path. Optional
`TEAMAI_GITEA_HOST` must name the same host, with the same HTTP port when supplied.
The SSH port may differ, but SSH aliases with a different hostname are not supported:

```bash
export GITEA_URL=https://gitea.example.com/sub/path
teamai init ssh://git@gitea.example.com:2222/your-org/team.git --scope user
```

SSH initialization still uses the PAT for platform identity; the clone and later
Git operations keep the SSH URL and use your key. For shallow imports with `--ssh`,
provide an explicit SSH URL including the port, rather than an HTTP URL whose SSH
port the CLI would have to guess.

REST uses `Authorization: token <PAT>`. HTTP Git uses Basic authentication with
the verified login and the token as password. The private team clone persists
those credentials in its origin URL so later bare `git push` works. Treat that
clone as credential-bearing. Shallow source clones use a one-off header instead.
Changing the env/netrc token does not replace a token already embedded in an
origin: update that private clone's credentials and verify both API and Git access.
TLS migration also requires updating saved remotes, not just `GITEA_URL`.

Netrc matches hostname, not port. Separate user directories or explicit credentials
are needed when several authenticated services share a hostname. Do not let test
instances overwrite another service's netrc entry.

### Sharing, import and permissions

`teamai push --all` pushes a branch, creates a PR, and requests the configured
reviewers by Gitea login. An existing PR is recovered using both repositories
and both branch refs, not only the head branch. Reviewers are requested separately:
a bad login prints a warning but does not discard the PR or other valid requests.

For a protected default branch, an administrator first initializes the TeamAI
skeleton and reviewer configuration, then enables protection. Members need write
access to their push branches and the reports/learnings branches, plus PR access;
ordinary membership does not need permission to push directly to main.

This provider supports `teamai import --from-mr <instance>/org/repo/pulls/N`
for PR metadata, paginated commits and a bounded diff. A diff over 50 KiB is marked
incomplete. Required evidence failures stop import rather than yielding an empty
diff. Review discussions are included by default; disable them with the import discussion option. Individual discussion failures warn while preserving required PR evidence. Gitea CI
extraction/comment commands and Gitea Actions templates are outside this provider.

Anonymous public repositories can be shallow-cloned and fetched. This does not
provide anonymous `teamai init`, member registration or push. `teamai doctor`
checks the configured URL and presence of a token; an actual API request verifies
whether the token is accepted.

### Migrating a generic Git team

Install a Gitea-capable build for all members before changing the shared manifest
to `provider: gitea`. A member can try the new provider first with
`teamai init <url> --provider gitea` while the team still uses `provider: git`.
An explicit local provider choice outranks the team manifest; reinitialize members
that previously opted into `--provider git`. Merge the team configuration change
through a PR and verify a regular member can create and update a PR automatically.
