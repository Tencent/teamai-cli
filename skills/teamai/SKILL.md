---
name: teamai
description: >-
  Guide for TeamAI — the CLI that syncs a team's AI skills, rules, docs, and env
  across AI coding tools (set up, join, manage, contribute, uninstall). Invoke
  ONLY when the user explicitly runs `/teamai`. Do NOT auto-trigger from ordinary
  conversation, even if words like "team", "skill", or "sync" appear.
---

# TeamAI — Team AI Skills & Rules Sync

You are guiding a user through TeamAI. **They may not know Git.** You run the
commands; they only make choices when you ask. Follow the steps literally —
do not skip, reorder, or invent commands.

## STEP 0 — Progressive disclosure (do this first, every time)

Look at what the user typed after `/teamai`.

**If they gave NO scenario** (bare `/teamai`, or only greetings/no task):
print the menu below **exactly**, then **STOP and wait**. Take no other action —
do not run any command, do not read any reference file yet.

```
teamai — Team AI Skills & Rules Sync

Usage examples (copy one to get started):

  🏗️  Admin — set up a new team repo:
      /teamai Help me set up TeamAI for my team from scratch

  🤝  Member — join an existing team:
      /teamai Help me join my team's TeamAI, repo URL is https://...

  🔧  Admin — daily management (publish & update skills, rules, MCP, env):
      /teamai I already have TeamAI set up, help me manage it

  📊  Anyone — open the team dashboard:
      /teamai Open the TeamAI dashboard

  💡  Member — share a skill with the team (just ask in plain language):
      /teamai Share this <skill-name> skill with my team

  🗑️  Anyone — remove TeamAI from this machine:
      /teamai Uninstall TeamAI
```

> **Sharing a session's learnings is automatic — not a menu choice.** TeamAI
> prompts on its own at the end of a session that produced something worth sharing,
> and the **`teamai-share-learnings`** skill takes over. The user does not invoke
> `/teamai` for it. (Only appears when the admin left team sharing enabled — on by
> default.)

**If they DID describe a scenario**, match it to one row of the table below,
then open that reference file and follow it step by step.

| The user wants to…                                  | Load this reference                      |
|-----------------------------------------------------|------------------------------------------|
| Set up TeamAI for a team from scratch (create repo) | `references/setup-admin.md`              |
| Join their team (with or without a repo URL)         | `references/join-member.md`              |
| Manage a team: publish/update skills, rules, MCP, env, invite members | `references/manage-admin.md`  |
| Share / publish a skill with the team ("share this xxx skill") — any member, not just admins | `references/contribute-member.md` |
| Open the team dashboard (web UI)                    | run `teamai dashboard` (see cheat sheet) |
| Remove / uninstall TeamAI from this machine         | `references/uninstall.md`                |

> **Sharing session learnings is automatic, via a separate skill — do not route it
> here.** TeamAI prompts on its own at the end of a session worth sharing, and the
> **`teamai-share-learnings`** skill summarizes the session and runs
> `teamai contribute`. The user does not ask for it through `/teamai`. (Only when
> the admin left team sharing on — the default.) `contribute-member.md` here is for
> a member **publishing a reusable skill** on request ("share this xxx skill with
> my team").

Choosing between "set up" and "join": a user **setting up a new team** becomes its
admin and creates the repo; a user **joining an existing team** needs a repo URL
from their admin. If someone wants to join but has no URL, that is still the
**join** flow — `join-member.md` tells them to ask their admin for it. Do **not**
send a would-be member to the setup/create-repo flow just because they lack a URL.

If the request is ambiguous (e.g. "help me with teamai" with no direction),
ask ONE short question to pick a row, then proceed. When something breaks at any
step, load `references/troubleshooting.md`.

## Global rules (apply to every scenario)

1. **Reply in the user's language — including every example and hand-off blurb.**
   Answer in whatever language the user used to invoke the skill (Chinese in →
   Chinese out, English in → English out, and so on), for the whole conversation.
   This applies to **everything you write**, not just prose: the reference files
   below are written in English, but any ready-made sentence they hand you — the
   invite line you give an admin to forward to members, the one-line explanations,
   the "what's next" summary — **must be translated into the user's language before
   you show it.** Do not paste an English example at a Chinese-speaking user.
   *Only* commands, flags, URLs, file paths, and code identifiers stay verbatim
   (never translate `teamai pull`, `--scope user`, `/teamai`, a repo URL, etc.).
   Example: for a Chinese user, the member-invite line becomes
   `/teamai 帮我加入团队的 TeamAI，仓库地址是 https://...`, not the English form.
2. **Never teach Git.** Do not mention branches, commits, clone, or push/pull of
   Git itself. TeamAI hides all of that. The user thinks in terms of "my team's
   skills", not repositories.
3. **Always use a full URL** for the team repo (e.g.
   `https://github.com/yourorg/yourrepo`). Never use the `owner/repo` short form.
4. **You run the commands.** Only pause to ask the user when you need a web login,
   a value only they know, or a genuine either/or choice. Show each command before
   you run it, in one short line.
5. **Detect the current AI tool first.** TeamAI behaves differently per host. Note
   which tool this conversation is running in (Claude Code, Cursor, CodeBuddy,
   WorkBuddy, ChatGPT App, Codex, OpenCode, Kiro, Gemini CLI, …). When you reopen a
   session, use the name of **this** tool — do not assume Claude Code or Cursor.
   Some hosts need extra manual steps for hooks — see
   `references/troubleshooting.md` ("Agent-specific caveats").
6. **Prerequisite:** Node.js ≥ 20. Install once with `npm install -g teamai-cli`
   and verify with `teamai --version`.
7. **Finish with `teamai doctor`.** Every setup/onboarding flow ends by running
   `teamai doctor` and resolving whatever it reports before you call it done.
8. **After init, resources appear on the NEXT session.** `teamai init` injects a
   session-start hook that auto-runs `teamai pull`. It is normal that the skills/
   rules directories are empty right after init — they fill in when the user opens
   a fresh session in this tool. To sync immediately, run `teamai pull`.
9. **Don't limit which AI tools get set up — cover all of them by default.** Unless
   the user explicitly says "only install to Claude Code" (or names specific
   tools), do **not** pass `--agent` to restrict the install. Let `teamai init` set
   up **every AI tool already installed on the machine** (omitting `--agent` gives
   an interactive picker; select all detected tools, or the user's stated subset).
   **After init, report which agents were set up** — tell the user, in their
   language, exactly which tools will now auto-start TeamAI (and which detected
   tools were skipped and why, e.g. Codex trust-gate / CodeBuddy design). Verify
   the real per-tool result with `teamai doctor` / `teamai hooks list`.

## Command cheat sheet (ground truth — do not invent flags)

```bash
teamai init <full-repo-url>       # Set up / join a team (configure provider, clone, register)
teamai init <url> --scope user    # Install for the whole machine instead of just this project
teamai pull                       # Sync team resources into local AI tools now
teamai push                       # Publish your local skills/rules/docs to the team
teamai doctor                     # Diagnose configuration and hook problems
teamai status                     # Show local vs team differences
teamai list                       # List resources (skills|rules|docs|env|agents|hooks|mcp)
teamai members                    # See team members (subcommand: teamai members list)
teamai roles                      # Manage roles / resource namespaces
teamai projects                   # Manage multiple projects from one repo (list|set|members)
teamai packages                   # Install team-declared npm packages & Claude plugins
teamai env                        # Manage shared team environment variables
teamai dashboard                  # Open the AI coding session dashboard (web UI, default port 3721)
teamai contribute --file <p> --title <t>   # Contribute a knowledge doc (usually via the teamai-share-learnings skill)
```

Anything not in this cheat sheet: check `teamai <command> --help` before using it.
Do **not** guess flags (for example, there is no member-invite flag in the CLI —
inviting a member is done on the Git platform's website; see
`references/manage-admin.md`).
