# Team Culture

> [English](team-culture.md) | [简体中文](zh-CN/team-culture.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Team Culture

TeamAI supports injecting your team's culture into AI tools, so your AI coding assistant is aware of your team's culture, values, and coding standards in every session.

### Creating culture.md

The admin creates a `culture.md` file at the root of the team repo:

```markdown
---
company:
  name: Acme Corp
  mission: Build great things
  vision: A world where AI helps everyone
  values:
    - Innovation
    - Integrity
    - User First
team:
  name: Platform Team
  mission: Enable developers to ship faster
  goals:
    - Ship v2.0 by Q2
    - Improve test coverage to 90%
---

## Coding Standards

- All PRs must have at least one reviewer approval
- Direct pushes to master are prohibited
- Test coverage must be at least 80%

## Collaboration Norms

- Use conventional commits format
- PR descriptions must include ## Summary and ## Test Plan
- Major changes require a design doc first
```

### Frontmatter fields

| Field | Type | Description |
|------|------|------|
| `company.name` | string (required) | Company name |
| `company.mission` | string | Company mission |
| `company.vision` | string | Company vision |
| `company.values` | string[] | Company core values |
| `team.name` | string (required) | Team name |
| `team.mission` | string | Team mission |
| `team.goals` | string[] | Team goals |

The markdown body after the frontmatter becomes the body content of the team culture guidance, injected as a whole into each AI tool's instruction target (see [Where the blocks go](#where-the-blocks-go)).

### How it works

```
Team repo
├── culture.md          ← Maintained by admin
├── skills/
├── rules/
└── ...

teamai pull
    │
    ▼  Parse culture.md
    │  ├─ frontmatter → structured company/team info
    │  └─ body → team culture guidance body
    │
    ▼  Compile into an injection block
    │
    ▼  Write it to each installed AI tool's instruction target
       ├─ ~/.claude/CLAUDE.md                       (user scope)
       ├─ <project>/.claude/rules/teamai-context.md (project scope)
       └─ ...
```

The injected content sits between the `<!-- [teamai:culture:start] -->` and `<!-- [teamai:culture:end] -->` markers, is automatically updated on every `pull`, and does not affect any other content in the file.

A pull writes the culture, shared-instructions and recall blocks only to the files of AI tools that are installed, and leaves a file alone when its blocks are already current. Earlier releases wrote these blocks to files that tools now share or that hide other instructions (listed under [Where the blocks go](#where-the-blocks-go)); while no installed tool reads such a file, the next pull removes the teamai blocks from it and names the file in its output. A tool's current file is never cleaned on its own: `teamai uninstall --agent <tool>` removes those blocks. It deletes the file when nothing else is left, unless git tracks it. A block with a missing or repeated marker is left as it is, with a warning to fix it by hand. `teamai pull --dry-run` lists the files a pull would change without writing them. When recall is disabled, the pull removes the recall block.

#### Where the blocks go

Two members of the same project can have different roles, so their shared instructions (`claudemd/`) can differ. The project's root `AGENTS.md` holds the instructions the project writes for everyone, so teamai never writes these blocks into it, into `~/AGENTS.md` or `~/.agents/AGENTS.md`, or into a file another tool reads. Each tool gets them in a file of its own or through its session hook:

| Tool | User scope | Project scope |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `.claude/rules/teamai-context.md` |
| claude-internal, tclaude | `.claude-internal/CLAUDE.md`, `.tclaude/CLAUDE.md` in their homes (unchanged) | The same paths under the project (unchanged, unverified) |
| Codex, codex-internal, tcodex | `$CODEX_HOME/AGENTS.md` (and the variants' homes), beside the team rules | Added by the session-start and subagent-start hooks, beside the project's team rules; nothing on resume |
| Copilot CLI | `$COPILOT_HOME/copilot-instructions.md` (unchanged) | `.github/copilot-instructions.md` (unchanged) |
| Cursor | `~/.cursor/rules/teamai-context.mdc` (unverified) | `.cursor/rules/teamai-context.mdc` (unverified) |
| CodeBuddy | `~/.codebuddy/CODEBUDDY.md` | `.codebuddy/rules/teamai-context.md`, one copy shared with WorkBuddy (unverified) |
| WorkBuddy | `~/.workbuddy/rules/teamai-context.md` (unverified) | `.codebuddy/rules/teamai-context.md`, one copy shared with CodeBuddy (unverified) |
| OpenCode | `~/.config/opencode/teamai-context.md`, listed by absolute path in `instructions` of `~/.config/opencode/opencode.json` | `.opencode/teamai-context.md`, listed in `instructions` of `.opencode/opencode.json` |
| Oh My Pi | `~/.omp/agent/RULES.md` | Added to each turn's system prompt by teamai's OMP extension |
| Pi | `~/.pi/agent/AGENTS.md` | Added to each run's system prompt by teamai's Pi extension |
| OpenClaw | The workspace `AGENTS.md`, found the way its hook finds it (`agents.defaults.workspace`, `OPENCLAW_WORKSPACE_DIR`, or `<state dir>/workspace`), beside the team rules (unverified) | Nothing: its only project file is the shared `AGENTS.md` |
| Hermes | A block in `$HERMES_HOME/SOUL.md`, beside the team rules block (unverified) | A system prompt section from teamai's Hermes plugin (unverified) |

A team `toolPaths` entry without `rules` keeps its configured `claudemd` for Claude Code, Cursor, CodeBuddy and WorkBuddy, which have no rules directory to take a `teamai-context` file. An entry with only `claudemd` counts as installed when that file's directory exists, and always for a bare file such as `AGENTS.md`.

*Unverified*: built from the tool's documented or source-read loader, not yet checked in a live session. Claude Code, Oh My Pi, OpenCode and Pi (project scope) were checked in live sessions, from the project root and a subdirectory. A tool with the `teamai-recall` subagent gets a recall block that calls it; a tool without one (Pi, Hermes, OpenClaw) gets a recall block that tells the agent to run `teamai recall` directly. A file several tools share gets the subagent block only when every one of them has the subagent.

Claude Code loads `.claude/rules/teamai-context.md` from the project root and any subdirectory, and still reads the project's `AGENTS.md` or authored `CLAUDE.md` the way it chose to. Copilot CLI 1.0.89 and later also reads a project's `.claude/rules`, so with both tools installed Copilot can get the blocks twice.

Both `teamai-context.mdc` files carry `alwaysApply: true`, which Cursor's rule loader reads as always applied. Cursor CLI reads `~/.cursor/rules` when the session starts under your home directory; the Cursor IDE was not checked.

The CodeBuddy and WorkBuddy rule files carry `alwaysApply: true`, which CodeBuddy's rule parser reads as always applied. Uninstalling one of the two keeps the shared project copy while the other is still installed.

In a project, teamai installs the Hermes plugin `$HERMES_HOME/plugins/teamai-instructions/` and adds it to `plugins.enabled` in `$HERMES_HOME/config.yaml` (a name you list under `plugins.disabled` stays off). A plugin of that name teamai did not write is left alone, also on uninstall, and `teamai pull` and `teamai doctor` say so. According to Hermes' documentation it builds the section once for each new session from the session's directory and keeps it through compression and resume. A section holds at most 4,000 characters, and all plugin sections together at most 8,000. When this member's instructions for the project are longer, Hermes skips them and `teamai pull` says so: teamai does not cut them or write them to `AGENTS.md`. Outside a project the section is empty, and Hermes may log that it skipped an empty section.

OpenCode loads a file only when its config lists it in `instructions`. teamai adds that entry only when the target already matches the desired blocks or its update succeeds. A malformed target or a failed write does not activate stale blocks. A failed edit keeps an existing instructions entry, including when malformed recall markers prevent a recall toggle. TeamAI saves ownership before adding a new config entry; a failed state write prevents activation, and a failed config write can be retried. Entries you already listed remain yours. It keeps your other entries and keys; the root `opencode.json` and OpenCode's own `AGENTS.md` files are left alone. While `~/.config/opencode/AGENTS.md` does not exist, OpenCode reads `~/.claude/CLAUDE.md` instead; when Claude Code gets the user blocks there, OpenCode already has them, so teamai writes no second user copy for OpenCode and says so in the pull output. Blocks left there by a Claude Code you excluded count too, since OpenCode reads them all the same; the pull then warns that nothing keeps them current. A config file teamai cannot parse as JSON (for example one with comments) is left unchanged with a warning; add the entry by hand.

Oh My Pi reads `RULES.md` as an always-applied rule beside its single user context file. In project scope teamai's OMP extension asks `teamai` for the blocks when the session starts and adds them to each turn's system prompt, from the project root and any subdirectory. Without that extension (for example with hooks removed), an Oh My Pi project session gets no team blocks. Prompts the HTTP local agent delivers for a project reach Pi, Oh My Pi and Hermes the same way, through their extension or plugin, and the Codex family through its session-start and subagent-start hooks. Pi and Oh My Pi wait for foreground session-start dispatch, including HTTP prompt sync, before caching the project instructions for the first prompt. Codex reads its HTTP prompt cache after the same sync, before returning SessionStart context.

A pull from an earlier release may have left these blocks in a file listed below. A pull removes each block only after its replacement was resolved and delivered to every installed tool that wrote that file. An unreadable or invalid culture source keeps the old culture block even if shared instructions and recall sync successfully. Failed target writes, foreign files, missing extensions or disabled plugins keep the old blocks for a retry. Excluded tools' current and retired files stay unchanged and are excluded from doctor's stale-instruction check.

HTTP prompt commands verify the current destinations of all installed former writers, including delivery from previous commands, before removing the retired shared-instructions block. A destination holding an older prompt does not count as delivered. HTTP cleanup preserves culture and recall blocks, which those commands do not replace.

While a native project instruction file still contains a TeamAI block, the session hook skips that block, including a cached HTTP prompt, to avoid adding a second member selection. Other blocks still reach the hook. Delivery resumes after the retained block is cleaned. Codex respects `AGENTS.override.md` precedence, and Oh My Pi respects `.omp/AGENTS.md`. Doctor reports incomplete or repeated markers in retired files; repair those markers before retrying pull.

The pull names each file it changes:

- Claude Code, project scope: `.claude/CLAUDE.md`
- CodeBuddy, project scope: `.codebuddy/CODEBUDDY.md`
- WorkBuddy: `~/AGENTS.md` and the project `AGENTS.md`
- Hermes: `~/AGENTS.md`
- Oh My Pi: `~/.omp/agent/AGENTS.md` and `.omp/AGENTS.md`. Oh My Pi reads one context file per level, so these hid `~/.agents/AGENTS.md` and the project's `AGENTS.md`.
- Pi: the project `AGENTS.md`
- OpenClaw, project scope: `.openclaw/workspace/AGENTS.md`, which OpenClaw never reads
- Codex family: the project `AGENTS.md`, when a team's `toolPaths` or an earlier build pointed Codex there
- Any tool whose file changed: the `claudemd` path the team's `toolPaths` sets for it, unless another tool's blocks go there now

`teamai doctor` checks that each installed tool can load these blocks: that each file holds the current blocks, that OpenCode's config lists its file, that the Pi or Oh My Pi extension and the Hermes plugin are installed and enabled, that the Hermes section fits its limit, and that no file an earlier release wrote still holds blocks.

If a requested block has incomplete or duplicated markers, the entire file stays unchanged, including its other managed blocks. Fix the named markers, then run `teamai pull` again.

A file named like a teamai target that teamai did not write is left alone and not listed in OpenCode's `instructions` (an entry you listed for it stays), and the pull warns about it. A team rule named `teamai-context` is not delivered, since it would land on that file; the pull names it, and removes a copy an earlier release delivered unless you changed it. teamai does not change `.gitignore`, `.git/info/exclude` or the git index. A team that wants to keep these files out of commits excludes them itself.

### Viewing the result

After pulling, you can view an AI tool's instruction file directly, for example Claude Code's user file:

```bash
teamai pull
cat ~/.claude/CLAUDE.md
```

You'll see an injection block like this:

```markdown
<!-- [teamai:culture:start] -->
<!-- DO NOT EDIT: This section is auto-managed by teamai -->

## Team Culture (teamai)

## Company: Acme Corp
**Mission:** Build great things
**Vision:** A world where AI helps everyone
**Values:** Innovation, Integrity, User First

## Team: Platform Team
**Mission:** Enable developers to ship faster
**Goals:**
- Ship v2.0 by Q2
- Improve test coverage to 90%

## Coding Standards
- All PRs must have at least one reviewer approval
...
<!-- [teamai:culture:end] -->
```
