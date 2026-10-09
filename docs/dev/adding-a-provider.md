# Adding a Git provider

Maintainer notes on the provider layer. The user-facing behavior of each provider (authentication, detection, supported operations) is in the [Git Providers](../guide/providers.md) guide page.

## CLI resolution and launching (cross-platform)

The GitHub and CNB providers delegate their operations to the platform's own CLI, so they share one resolution and launch path ([`src/utils/cli-path.ts`](../../src/utils/cli-path.ts)):

- **Resolution**: `resolveCliPath(cmd)` uses the native `where` on Windows and tries `bash -lc` → `zsh -lc` → `which` on macOS / Linux. It returns an absolute path that **exists and can be launched**, or `null`.
  - `which` cannot be used on Windows: it comes from Git Bash / WSL and returns MSYS-style paths (`/c/Program Files/GitHub CLI/gh`), which Node reads as `C:\c\...`, so `existsSync` is always false and `spawn` fails with ENOENT. The symptom was `isGhInstalled()` answering "installed" while every `ghExec()` failed silently with status 1 and an **empty stderr**.
  - In the output of `where`, the extension-less shim npm generates often comes before the `.cmd`; `pickWindowsCommand()` accepts only `.exe` / `.cmd` / `.bat`, because CreateProcess cannot start an extension-less file.
- **Launching**: the resolved absolute path is handed to `cross-spawn`. Node's native `spawn` cannot run a `.cmd` directly (`EINVAL`), and `cnb`, installed through npm, exists on Windows only as `.cmd` / `.ps1` with no `.exe`, so "resolvable" and "launchable" must both hold. A missing CLI returns 127 with the reason on stderr instead of a silent status 1.

TGit's `gf` CLI is the exception: it supports only macOS / Linux, and its path is passed as an argument to `bash -c`, so it is left as is.

## Steps

A provider is a TypeScript interface (see [`src/providers/types.ts`](../../src/providers/types.ts)). Adding a provider with platform API support (GitLab, Bitbucket, Gitea and the like) takes:

1. A new `src/providers/<name>/` directory
2. An implementation of the `GitProvider` interface: `parseRepoInput` / `authenticate` / `cloneRepo` / `createRepo` / `createPullRequest` / `getDefaultEmailDomain`
3. Registration in `HOST_MAP` and `PROVIDERS` in [`src/providers/registry.ts`](../../src/providers/registry.ts)
4. Unit tests, modeled on [`src/__tests__/github-provider.test.ts`](../../src/__tests__/github-provider.test.ts)

The [GitCode provider design](../designs/gitcode-provider.md) is a worked example. PRs are welcome.
