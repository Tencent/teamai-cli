# Paste-able onboarding prompts

> [English](README.md) | [简体中文](README.zh-CN.md)

These prompts are for people who have **not used Git**. Copy the fenced block from one file and paste it into Claude Code, Codex, Cursor, CodeBuddy, WorkBuddy, OpenCode, Qoder, or any other supported agent. The agent runs the commands; it should only ask when a web login or a choice is required.

When it tells you to start a new session, it should name **the tool you are in now**.

| Situation | Prompt |
|-----------|--------|
| You do not have a team repo URL yet | [Getting started](getting-started.md) |
| Someone already gave you a repo URL | [Member](member.md) |
| You already ran `teamai init` and need day-to-day admin | [Admin](admin.md) |

Getting started finishes by handing you the repo URL plus a short member prompt (prompt B) to forward.

The paste blocks reuse `init` / `pull` / `push` / `doctor` (admin also uses `members` / `list` / `roles` / `packages` / `env` / `contribute`). They do not teach Git, do not use the `owner/repo` short form, do not recommend a host by region, and do not cover single-repo mode (`teamai init .`).
