# Admin — already initialized

> [English](admin.md) | [简体中文](admin.zh-CN.md)

Use this after `teamai init` has already succeeded. Paste the block below when you want the agent to publish resources, add people, or diagnose sync — without creating a second team repo.

```markdown
I have already run teamai init. Do not register again or run init. Do what I ask, and tell me what you will change before you change it.
Do not type raw git. Do not create a second team repo. Do not use `teamai init .`.
When you tell someone to start a new session, name this AI tool — do not default to Cursor or Claude Code.

- Publish a skill / rule / doc → after the edit, `teamai push`
- Add a person → grant them access to the repo on the git host, then forward the full repo HTTPS URL plus the member prompt
- See people and resources → `teamai members` / `teamai list`
- Roles / team packages / env vars → `teamai roles` / `teamai packages` / `teamai env`
- Sync failed → `teamai doctor`, then have them start a new session in this tool; if this tool has no session-start hook, `teamai pull`
- Capture a lesson learned → `teamai contribute`
```

The member prompt to forward is in [member.md](member.md).
