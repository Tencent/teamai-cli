# Member Guide

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

## Member Onboarding

```bash
npm install -g teamai-cli
cd /path/to/my-workspace
teamai init https://github.com/your-org/your-repo
```

This machine:

```bash
teamai init https://github.com/your-org/your-repo --scope user
```

Skip the platform token and use your existing SSH key or Git credentials:

```bash
teamai init https://gitlab.example.com/yourgroup/yourrepo --provider git
```

This only affects your machine. `push` pushes the branch; open the PR/MR on the Git host yourself.

Read-only, no git:

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

An agent access token (`sk-`) works for one agent only. Pass that agent with `--agent <tool>`; each agent then keeps its own token. While an agent's current token still works, a new one for the same agent is not used, so its delivered models keep working.

Then enroll each workspace you want synced: run `teamai bind-project` once there. Binding it to a ClawPro project is optional — add `--skip` to stay unbound, and no prompt asks again. A worktree inherits its main checkout's choice. The HTTP agent leaves a workspace where this never ran alone, saying so once per session; a workspace enrolled but still pending a project keeps asking in each new chat (and after a pause) until it is bound or skipped, and a non-interactive `teamai bind-project` lists the account's projects so a setup script can act on them.

Running it again with the same endpoint and key keeps them. Moving to another endpoint or key needs `--force`, and without it nothing is changed:

```text
$ teamai init --http https://new-host.example/api --token <new-key>
...
✖ The HTTP local agent already uses https://your-team-host/api. Re-run with --force to replace it with https://new-host.example/api.
$ teamai init --http https://new-host.example/api --token <new-key> --force
```

```bash
teamai doctor
teamai list
```

## Day-to-Day Use

### Auto-sync

A session start runs `teamai pull`. Run it yourself when the tool has no such hook.

`pull` leaves a skill, rule, or agent you changed.

```bash
teamai pull
teamai pull --dry-run
```

### Team packages

```bash
teamai packages
```

When the team's `packages` change, session start asks you to run that. It does not install them.

### Excluding skills you don't need

```bash
teamai skill exclude add using-superpowers
teamai pull

teamai skill exclude remove using-superpowers
teamai pull
```

This only affects your machine.

### Push local resources

```bash
teamai push
teamai push --role pm
```

A new skill, rule, or agent asks which directory it goes to. The choices come from your role and the active projects. An open pull request is updated in place.

### Check status

```bash
teamai status
```

### Role management

```bash
teamai roles list
teamai roles set hai   # unless the team assigns roles (below)
teamai pull
```

How roles are defined: [Distribution mechanism](./distribution.md#roles-and-projects). A team that assigns roles in `manifest/members.yaml` decides yours: `roles list` shows them, `roles set` is refused, and a change goes through that file — see [Assigning roles in the team repo](./distribution.md#assigning-roles-in-the-team-repo).

### Tag subscriptions

```bash
teamai tags list
teamai tags subscribe frontend testing
teamai tags unsubscribe testing
teamai pull
```

## Commit Co-Author Attribution

In the team repo's `teamai.yaml`:

```yaml
sharing:
  coAuthor:
    enabled: false
```

`false` removes the commit trailer. `true` keeps it. Leave the block out and teamai does not change each tool's own setting.

`coAuthorEnabled` in `~/.teamai/config.yaml` on your machine wins. The next `teamai pull` writes each tool's config.

## Auto-Compact Threshold

In the team repo's `teamai.yaml`:

```yaml
sharing:
  autoCompact:
    tokens: 400000
```

AI tools then compact a conversation at their next compaction check once its context reaches about 400K tokens; a long turn can run a little past it before that check. Each tool takes the number its own way:

| Tool | Setting written |
|------|-----------------|
| Claude Code, TClaude | `settings.json` `autoCompactWindow` = tokens + 33K |
| CodeBuddy, WorkBuddy | `settings.json` `autoCompactWindow` = tokens ÷ the tool's mid-turn ratio (0.92, or WorkBuddy's 0.9) |
| Codex, TCodex | `config.toml` `model_auto_compact_token_limit` = tokens |
| DeepSeek Harness | `cordis.patch.yml` row `compaction-basic`, one ratio per model |

A tool still compacts by its model's own window when that is smaller, so a model with a small window is not affected. teamai skips a tool and says why when the tool cannot take the number: an environment variable overrides the setting, a custom CodeBuddy model has no `maxInputTokens`, or no DeepSeek Harness model fits. Cursor has no such setting. Restart the tool after a pull.

These files are shared by the machine, so one scope decides: the user scope when there is one, else the workspace the pull runs in. A value you set yourself is never overwritten. `autoCompactTokens` in that scope's config wins; `0` opts out. When the team drops the block, the next `teamai pull` removes the values teamai wrote.

## Keeping Delivered Files Out of Git

```yaml
sharing:
  gitExclude:
    enabled: true
```

`teamai pull` lists the paths it delivered in this clone's `.git/info/exclude`. It does not change `.gitignore`. The tools still load the files. `git status` does not show them.

`gitExcludeEnabled` in this project's local config wins. The next pull applies it.
