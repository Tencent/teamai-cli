# Admin — already initialized

> [English](admin.md) | [简体中文](admin.zh-CN.md)

Use this after `teamai init` has already succeeded. Paste the block below when you want the agent to publish resources, add people, or diagnose sync.

The member prompt to forward is [prompt B](member.md).

```markdown
I have already run teamai init. Do not register again or run init. Do what I ask, and tell me what you will change before you change it.
When you tell someone to start a new session, name this AI tool — do not default to Cursor or Claude Code.

- Publish a skill / rule / doc → after the edit, `teamai push`
- Add a person → grant them access on the git host, then give me the repo URL plus prompt B to forward
- See people and resources → `teamai members` / `teamai list`
- Roles / team packages / env vars → `teamai roles` / `teamai packages` / `teamai env`
- Sync failed → `teamai doctor`, then have them start a new session; if there is no hook, `teamai pull`
- Capture a lesson learned → `teamai contribute`

Do not type raw git. Do not create a second team repo. If GitHub `push` fails, check whether the default branch is `master`.
```
