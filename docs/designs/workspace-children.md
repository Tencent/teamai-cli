# Workspace children

> Status: **implemented**. Issue: [#913](https://github.com/Tencent/teamai-cli/issues/913).

A workspace (a folder set up with `teamai init` in the workspace scope, which the code calls `project`) also delivers what the repos and folders set up inside it select. Members who keep several repos in one folder and start their agent there get every repo's resources, with no list to maintain. No flag or config key turns it on: a workspace with children has them, and one without behaves as before.

```text
ws/                  teamai init <team> [--project platform]
  svc-a/             teamai init <team> --project svc-a
  backend/svc-b/     teamai init <team> --project svc-b

pull in ws/          its own selection, plus svc-a's and svc-b's
pull in svc-a/       svc-a's, as before
```

## Children

`readWorkspaceChildren` (`src/workspace-children.ts`) walks the workspace at each pull, and for a command that loads its scope through `autoDetectInit` or the env commands' loader. The share gate a Stop hook asks skips the walk, and the hook runners and the dashboard do not walk:

- Up to three folder levels down. It stops at any repo, set up or not, so a child's own folders and worktrees stay the child's, and never enters a dot folder or `node_modules`.
- A plain folder with its own config is a child, and the walk goes on through it.
- In a workspace that is a git repo, only repos are children.
- A child counts once per anchor (its data partition), so a linked worktree whose main checkout is also a child adds nothing. A linked worktree of the workspace reads the children of its main checkout.
- No git process runs: a clone, a submodule and a linked worktree resolve their anchor from the path, the `gitdir:` line or the `commondir` file. A child's config is read with `dryRun`, so nothing in the child is written.
- One team repo per workspace. A child whose remote does not match (`remotesMatch`), or one in single-repo mode, is left out and named.

The result is attached to the workspace's config in memory (`LocalConfig.children`) and never persisted; `serializeLocalConfig` drops it.

## Delivered selection

`deliveredMembers` turns the children into members: the workspace's own selection, when it has one, then each child's selection on the workspace's config, ordered by path. Each consumer that resolved the own selection resolves each member and unions the results: namespaces (`resolveResourceNamespaces`), skills, rules and agents (`resolveDesiredSkills`, `resolveDesiredRules`, `resolveDesiredAgents`), instruction files (`collectClaudemdFiles`: a root file one member replaces stays while another receives it), and env, hooks, MCP servers and models (`resolveEntries`).

- Each child counts with its own tags and exclusions. The workspace's own exclusions apply on top.
- An unknown project id in a child drops only that project, with a warning.
- One name with the same content in several members is delivered once. Its recorded origin is the first in member order. One whose copies differ is held and named; the rest is unaffected. A held name keeps what is installed for it now, in each tool: its delivery neither adds, updates nor removes it (`EntryResolution.held` for env, hooks, MCP servers and models). Env exports the value in the env backup, which records no file or description, so `env list` shows the key as `installed (held back)`; a key the member set with `--from-env` is read from that variable, as when it is not held. No history is kept. Where a held entry sits still follows the current rules: a held Claude or CodeBuddy MCP server moves between `.mcp.json` and the local scope with the others, unless the member has their own server of that name where it would go, and a held hook's `$PWD` gate is rendered again with today's children. A held Codex hook moves between the project's `.codex/hooks.json` and teamai's dispatcher with the others. A secret whose declarations differ only in description or url is not held: the first is delivered, and both files are named. A held skill the workspace excludes is not kept: cleanup removes its copy when it equals the version of any member that delivers the name.
- An MCP server is delivered unless the workspace, or every child that delivers it, excludes it.
- A workspace without children resolves exactly as before: every seam checks `deliveredMembers` first and falls through when it returns null.

The "Already synced" fast path stores a fingerprint of the children (anchor and selection of each, plus the ones left out) in `lastPullByWorkspace`, so a child that changes its selection reaches the workspace at its next pull.

## Keeping the workspace out of its children

A session started in a child must not pick up what the workspace receives:

- Claude Code and CodeBuddy load a parent folder's project MCP file. In a workspace with children, their MCP servers go to the tool's local scope (the path `sharing.gitExclude` already uses) instead of `.mcp.json`. Claude's stay in `.mcp.json` in single-repo mode or while tclaude or Muse Code reads it (`mcpRelocated`), and a child session then loads them.
- A child's pull writes `claudeMdExcludes` into the child's own `.claude/settings.local.json`: the workspace's `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md` and `.claude/rules/**`. The pull record owns those entries, so a later pull removes stale ones and leaves the member's own, and `uninstall` takes them back.
- Team hooks for tools without a per-directory hook file are gated on `$PWD`; in a workspace the gate also excludes every folder set up under it: each checkout of a child, and each child left out.

## Reading and writing

- `recall` and `viz` read the learnings of every member's projects. The search index stores the children fingerprint, and `recall` and `viz` rebuild an index whose fingerprint differs. `viz` builds a missing index from what the workspace delivers, as `recall` does. Learnings come only from the workspace's own team clone, and sessions are recorded against the workspace alone.
- `contribute` writes to the workspace's own selection by default, or to the shared root when it has none. `--namespace` accepts every learnings namespace the workspace reads. `projects list` shows both.
- `push` reads the delivered selection, so an edit goes back to the namespace it came from, a child's included. A new item is placed by the workspace's own selection. A skill delivered once for several namespaces goes back to each that a member delivers and whose team copy still holds what was delivered; one the team changed since is skipped and named.

## Reporting

`pull` names the children, and each one left out with the reason, on every run. `status` prints one line, `projects list` lists each child and its selection, and `doctor` checks with the delivered selection and names the children left out.

## Limits

- `teamai remove` in a workspace removes the item from the team repo, for every member, as it does in any scope.
- In a plain-folder workspace, a folder without its own config inside it (such as `ws/notes/`) falls to the user scope.
- A child without a role, in a team with `manifest/roles.yaml`, receives everything unfiltered, and so does the workspace through it.
- The `recall --check` threshold reads the index's term statistics, so a workspace with more content has a stricter threshold.
- A repo in single-repo mode gets its local config from the session-start bootstrap (`src/bootstrap.ts`) without a command from the member. Cloned into a workspace, it shows up as a child left out on every pull.
- Children from several team repos, deeper than three levels, or a switch to turn detection off are not supported.
