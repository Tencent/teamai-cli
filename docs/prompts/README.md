# Paste-able onboarding prompts

> [English](README.md) | [简体中文](README.zh-CN.md)

These prompts are for people who have **not used Git**. Paste one into Claude Code, Codex, Cursor, CodeBuddy, WorkBuddy, OpenCode, Qoder, or any other supported agent. The agent runs `teamai init` / `pull` / `push` / `doctor` for you and only asks when a web login or a choice is required.

When the agent tells you to start a new session, it should name **the tool you are in now** — not a default such as Cursor or Claude Code.

| Situation | Prompt |
|-----------|--------|
| You do not have a team repo URL yet | [Getting started](getting-started.md) |
| Someone already gave you a repo URL | [Member](member.md) |
| You already ran `teamai init` and need day-to-day admin | [Admin](admin.md) |

Getting started finishes by handing you the repo URL plus the [member prompt](member.md) to forward.

Do not use the `owner/repo` short form (`owner/repo` is treated as GitHub). Do not use `teamai init .` — these prompts keep a separate team repo; they do not cover single-repo mode.
