# Team repo checkout

> [English](team-repo.md) | [简体中文](zh-CN/team-repo.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Git submodules

If your team distributes skills as git submodules, opt in with `submodules: true`
in `teamai.yaml`:

```yaml
submodules: true
```

On every pull, teamai runs `git submodule update --init` so submodule-based
skills are populated at the revisions pinned by the team repo (git-repo
backends only; the full submodule history is fetched, since a shallow fetch
cannot check out older pins). Disabled by default. If the update fails, pull
logs a warning and holds back the recorded revision, so the next pull
re-syncs and retries the update instead of skipping it. Note: submodule
fetching relies on the ambient git credentials — private submodules on hosts
authenticated by per-command token injection (rather than a configured
credential helper) will not authenticate.

## Post-pull scripts

Teams often deploy more than teamai's built-in surfaces (models a client
offers, machine-local installs, a PATH shim). `scripts.postPull` in
`teamai.yaml` declares a Node entrypoint teamai runs once a pull has fully
finished, for the team repo that owns this machine's deployment — the
project scope's repo when a project is active, otherwise the user scope's
(an inherited user scope brings resources and knowledge only, not deploys):

```yaml
scripts:
  postPull:
    path: scripts/deploy.mjs
```

The path is relative to the team repo root; one that resolves outside it
(symlink included) is rejected. On the
session-start path the script runs as a child of the pull process and is
waited on under a fixed budget (`TEAMAI_POSTPULL_TIMEOUT_SEC` is exported so
the script can self-limit its heavy steps); on expiry the script is left
running rather than killed, and the next pull reconciles. An interactive
`teamai pull` launches it fire-and-forget into the terminal instead. A bad
path, a missing file or a failed spawn is a line in `~/.teamai/debug.log`
(`postPull: launched / exited / timed out`), never a failed pull.
