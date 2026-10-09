# GitCode provider design

> Status: **implemented** (`src/providers/gitcode/`).

> Issue: [#361 Support the GitCode platform](https://github.com/Tencent/teamai-cli/issues/361)
> Target: GitCode (gitcode.com, CSDN's code hosting platform; Gitee/AtomGit-style v5 API)
> Scope: the public cloud `gitcode.com` only; authentication by pasting a token interactively during init (stored in `~/.netrc`).

## 1. Background and problem

`teamai init https://gitcode.com/xxx/repo.git` failed with `Unrecognized GitHub repo format`: `gitcode.com` was not in the provider `HOST_MAP`, so `teamai push` (automatic branch + PR) was unavailable as well.

The provider abstraction was already mature (github / tgit / cnb / gitlab / git), so adding a provider was the established route.

## 2. Key conclusion: GitCode is Gitee-style, not GitLab-style

Structurally the implementation follows the GitLab provider, but almost every API detail differs (all verified against the live service):

| Aspect | GitLab | **GitCode** |
|---|---|---|
| API base | `<host>/api/v4` (same domain; `GITLAB_API_PREFIX` can override) | `https://api.gitcode.com/api/v5` (separate API domain) |
| REST auth header | `PRIVATE-TOKEN` | `Authorization: Bearer` |
| whoami field | `username` | **`login`** |
| Create PR | `POST /projects/{id}/merge_requests` | `POST /repos/{owner}/{repo}/pulls` |
| PR body | `source_branch` / `target_branch` / … | `head` / `base` / `title` / `body` |
| PR URL in response | `web_url` | `html_url` (web path `/pull/`, singular) |
| Create repo | `POST /projects` | personal `POST /user/repos`; organization `POST /orgs/{org}/repos` |
| Namespaces | nested subgroups with `/-/` routing | single-level user/org, GitHub-style `/owner/repo/pulls/1` |

Conclusion: a separate `src/providers/gitcode/`, with GitLab as the skeleton and the Gitee dialect applied.

### 2.1 Why a PAT rather than OAuth or gitcode-cli

- **OAuth**: only the authorization code flow exists (register an app, client_secret, redirect_uri); there is **no device flow**, so it does not suit a publicly distributed CLI.
- **gitcode-cli (`gc`)**: a community project installed via pip, source, or deb/rpm, **not npm**, and it uses a PAT itself.
- **Official MCP (gitcode-org-com/gitcode-mcp, Go)**: its `api/*.go` sources are the authoritative API contract. Endpoints, fields, auth and error codes are all there, so the REST dialect can be reproduced from it almost without tokens (see §5).
- **Conclusion**: plain REST with a PAT.

## 3. Authentication (paste a token during init)

- Token resolution: `GITCODE_TOKEN` (primary) → `GC_TOKEN` (alias) → the gitcode.com entry in `~/.netrc`.
- No token and a TTY: prompt for a PAT, verify it with `GET /user`, write it to `~/.netrc` (0600). Without a TTY, fail with an error.
- `~/.netrc` is reused because git reads it natively and TGit already uses it; no new store is introduced.

## 4. Files

New `src/providers/gitcode/`: `index.ts` / `gitcode-api.ts` / `repo-url.ts` / `mr-fetch.ts` / `org.ts`.
Wiring: `registry.ts` (HOST_MAP + KNOWN_PROVIDERS + PROVIDERS + import), `providers/index.ts`, `types.ts` (enum), `doctor.ts` (branch), `clone.ts` (shallowClone branch).
Tests: `gitcode-provider.test.ts`, additions to `provider-fallback.test.ts`, `e2e/gitcode-provider-live.test.ts`.

## 5. Dialect details confirmed against the live service ✅

All verified with a real `GITCODE_TOKEN`:

1. **REST auth**: `Authorization: Bearer`; whoami is `GET /user` → `login`.
2. **git-over-HTTPS auth differs from REST auth**: the git endpoints **reject Bearer** (they still ask for a username) and accept only Basic `oauth2:<token>`, the same trap as TGit.
3. **Create PR**: `POST /repos/{o}/{r}/pulls` with `head` / `base` / `title` / `body`; the response carries `html_url` (`/pull/`, singular).
4. **Create repo**: `POST /user/repos` (personal) with `{name, private, auto_init}`; confirmed working.
5. **fetchMR**: `GET /repos/{o}/{r}/pulls/{n}` + `/commits` + `/files` (the diff comes from `patch`).

### 5.1 Key fix: push authentication for the team repo

`teamai push` pushes its branch through `pushRepoBranch` → a bare `git push` with no auth injection, relying on the credentials persisted at clone time.
The GitLab clone uses a one-off `-c http.extraHeader` (not persisted); copying that made push fail with **Access denied** (reproduced live).
GitHub and TGit embed the token in the remote URL instead (persisted in `.git/config`).

**Fix**: `gitcodeRepoClone` (the team-repo clone) embeds `https://oauth2:<token>@gitcode.com/...`, so `git push` (branch + PR flow) authenticates. The token lands only in the private clone under `~/.teamai/team-repo`, as with GitHub and TGit. (The shallow-clone path in `clone.ts` is not a push target and keeps using extraHeader.)

## 6. End-to-end verification (real CLI, real GitCode repo)

- `teamai init https://gitcode.com/...`: ✔ Detected provider gitcode / ✔ Authenticated / ✔ Team repo cloned / ✔ Member registration pushed (the push during init authenticates too).
- `teamai push --all`: ✔ Pushed branch / ✔ **Pull Request created: `.../pull/1`**.
- `fetchMergeRequest(.../pull/1)`: ✔ title / author / commits / diff retrieved.
- Clone: HTTPS (embedded token, push works) and SSH (public key) both pass.
- Unit tests: gitcode + fallback all pass; type check passes.
- The test repo and temporary SSH key were cleaned up.

**Not covered live** (edge or optional): `listOrgRepos` (no test organization available), organization repo creation, the interactive paste-a-token branch.

## 7. Non-goals

- Self-hosted GitCode Enterprise (`TEAMAI_GITCODE_HOST`).
- OAuth browser or device login (GitCode has no device flow).
- Bundling gitcode-cli as a dependency.
