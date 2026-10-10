# Member Guide

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

## Member Onboarding

```bash
npm install -g teamai-cli
cd /path/to/my-project
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

A new skill, rule, or agent asks which directory it goes to. An open pull request is updated in place.

### Check status

```bash
teamai status
```

### Role management

```bash
teamai roles list
teamai roles set hai
teamai pull
```

How roles are defined: [Setup demos](./admin-setup.md#roles-and-projects).

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

## Keeping Delivered Files Out of Git

```yaml
sharing:
  gitExclude:
    enabled: true
```

`teamai pull` lists the paths it delivered in this clone's `.git/info/exclude`. It does not change `.gitignore`. The tools still load the files. `git status` does not show them.

`gitExcludeEnabled` in this project's local config wins. The next pull applies it.
