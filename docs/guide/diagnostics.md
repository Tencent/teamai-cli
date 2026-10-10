# Diagnostics and maintenance

> [English](diagnostics.md) | [简体中文](zh-CN/diagnostics.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

`teamai update --dry-run` checks for a newer CLI version without installing it, refreshing hooks, acquiring the update lock or saving TeamAI's version-check state. Combining it with `--check` is also read-only.

```bash
teamai doctor          # Config diagnostics
teamai doctor --json   # Same diagnostics as JSON on stdout (CI, hooks, agents)
teamai stats           # Skill usage stats
teamai update --check  # Check for a CLI update without installing it
teamai update          # Check for and install a CLI update
teamai digest          # Generate the weekly team activity digest
teamai remove skills <name>   # Remove a resource (asks for confirmation)
teamai remove rules <name>
teamai remove agents <name>
teamai remove mcp <name>
teamai remove rules <name> --force   # Skip the prompt, for scripts and CI
```

`teamai stats` shows the current scope's skill usage and session totals, and a recall section when that scope's recall log has runs (see [Recall adoption and upvotes](./knowledge.md#recall-adoption-and-upvotes)). A plain `teamai stats` resolves legacy roles in memory without saving the config or printing dry-run migration notices. `teamai stats --dry-run` retains migration preview notices and writes nothing: it reads the reports checkout as it is, without refreshing or creating it, and says so. When the session owners file is missing, the preview uses the same inferred owners and already-reported credits in memory, including sessions split across scopes by older releases.

`teamai doctor` exits with code 0 only when every check passes, and code 1 when any check fails. Before initialization, it reports the missing configuration without assuming a Git provider. The same checks run at the end of a manual `teamai pull`, minus the provider ones and minus any check that pull already reported in its own words on that run. 

A check marked informational — currently only `No stale env blocks left behind` — still counts toward `doctor`'s exit code, but a pull does not fold its failure into `Pull finished, but N check(s) failed`: a leftover file from an earlier install is cleanup, not a sign this pull broke anything, so it is still named but on its own, gentler line.

Besides the provider, clone, config and hook checks, `doctor` verifies what reached your machine. `<tool> is installed` fails when `enabledAgents` lists a tool that nothing would be delivered to, which is the case where a pull reports success and that tool receives nothing. It asks the same resolver the sync uses, so a tool that keeps its skills somewhere other than its tool root, as OpenClaw does with its workspace directory, is judged where the sync would actually write. It reports an installed tool as passing too, so `--json` carries one entry per enabled tool either way. 

The checks at the end of a pull cover the scope that pull resolved from the current directory; run `teamai doctor` in another scope to check that one. `Skills delivered to <tool>` compares the skills your role namespaces, tag subscriptions and exclusions resolve to against what is on disk for each installed tool: it reports a skill that was never delivered separately from one that arrived unreadable — `SKILL.md` missing, its frontmatter unparseable, or its `name` not matching the directory, which keeps the agent from ever discovering it. 

A skill directory of your own at a team skill's path is listed as `not teamai's (kept by pull)` with pull's line for it, as a document of your own at a team document's path is by `Team docs delivered`. `Team docs delivered` compares the docs you receive (a docs namespace you do not have active is left out) against `sharing.docs.localDir`, which has one destination rather than one per tool; each expected document has to be a file that can be read, so a directory or a dangling link sitting on the name counts as missing. It also reports extra non-hidden local files as stale, including when the team bundle is empty. 

Hidden local files are preserved and do not fail this check, and neither does a local copy of a team doc in a namespace you do not have active: pull removes it when it is unchanged and names it when you edited it. `doctor` also prints notes, which are information rather than failed checks. Each note names a namespace skill, agent, rule, shared-instructions file, env variable, hook, MCP server or team model profile that replaces a root one here (`rules: "style" from rules/checkout/style.md replaces rules/style.md`). 

When a namespace contributes env variables, hooks, MCP servers or team model profiles, a note also counts where that type's entries come from (`env: 3 received here (2 root, 1 checkout)`). Without roles or projects, the notes name each file the team repo defines more than once instead, and each env variable, hook or MCP server name repeated in its root file.

For Oh My Pi and Kiro, `doctor` reports flat-name collisions even when every desired rule collides and no file can be written. Rename one of the rules in the team repo, then run `teamai pull`.

`Rules delivered to <tool>` and `Agents delivered to <tool>` do the same for the other two per-tool resources, and both ask the handler where an item lands rather than deriving a path: a rule's filename and content change per tool (`.md` verbatim, `.mdc` with derived `globs`/`alwaysApply` (unquoted for JoyCode), `.instructions.md` with `applyTo`, Kiro's flat `.md` with `inclusion`/`fileMatchPattern`, Qoder's `.md` with `trigger`/`glob`, Trae's `.md` with `globs`/`alwaysApply`, Oh My Pi's flat `.md` with `alwaysApply` or `globs`/`description`, CodeBuddy's `.md` with `alwaysApply`/`paths`; tools that read one copy, as CodeBuddy and WorkBuddy do in a project, get one check naming both), and an agent's destination comes from its render, with `targets:` deciding which tools are owed a copy at all. 

A delivered rule is compared with the bytes the handler renders for that tool, not merely read for the keys its tool needs: a `.mdc` whose `globs` no longer match the team rule's `paths:` applies to the wrong files while carrying a perfectly legal `alwaysApply`, and that reads here as `delivered from an older copy` — the same label as a body that drifted, because both landed successfully and are still wrong. 

An agent is compared with the bytes its render produces, so a copy left behind by an older spec — a plain pull skips a scope whose team repo has not changed, so it can sit there indefinitely — is reported as `delivered from an older spec` rather than passing as present. `Every team agent reaches a tool` names an agent that renders for no installed tool — usually a spec that does not parse, or a `targets:` list naming only tools you do not have. These two are `doctor`-only: they read every rule per tool and parse every agent, which would spend the budget the checks at the end of a pull run under.

After the last team rule is removed, `doctor` still reports team-owned OpenCode globs or inline blocks left by failed cleanup. Run `teamai pull` to remove them.

Several tools do not read a rules directory, so a per-file check cannot speak for them and each gets one of its own. `Team rules are active in opencode` checks that `opencode.json` (`.opencode/opencode.json` in a project) lists every glob the pull owns under `instructions`, and no stale one such as the relative `rules/*.md` an earlier release wrote: OpenCode does not auto-scan `.opencode/rules`, so without it every delivered `.md` is inert while the per-file check keeps passing. On OpenCode V2, which ignores `instructions`, it instead checks that teamai's plugin, which adds the rules to the prompt, is installed and current. 

In user scope, `Team rules are inlined in Hermes SOUL.md` compares the teamai-managed block of `SOUL.md` with what the team rules inline to, since Hermes reads standing instructions from that one file rather than from a directory — a deleted block, or one left on an older rule set, is a tool reading the wrong rules with nothing on disk to show for it. 

In user scope, `Team rules are inlined in <file>` (`Codex AGENTS.md`, `ZCode AGENTS.md`, `DeepSeek Harness AGENTS.md`, `OpenClaw workspace AGENTS.md`, `Pi AGENTS.md`, `JoyCode rules.txt`) compares the team-rules block of the file that tool reads with what the team rules inline to; for Codex it also fails when an `AGENTS.override.md` beside it shadows the file. In a project, `Project rules and instructions reach <tool> whole through its session hooks` fails when the teamai `SessionStart` or `SubagentStart` entry in that tool's `hooks.json` is missing or does not set `additionalContextLimit: 0`, without which Codex keeps only the start and end of a large set. 

In a project, `Project rules reach zcode through its SessionStart hook` fails when `~/.zcode/cli/config.json` has no teamai `SessionStart` entry or does not set `hooks.enabled: true`, and `Project rules reach dsh through its session-start hook` fails when the patch or the hook config under `~/.teamai/dsh/` is missing; doctor cannot see whether dsh runs with `--patch`. For Pi, `pi adds the team instructions and rules to its prompt` fails while teamai's Pi extension is missing or out of date. Codex, ZCode, DeepSeek Harness and Pi have no `Rules delivered to <tool>` check.

`MCP servers delivered to <tool>` compares each server the team's `mcp.yaml` resolves for that tool against the entry in the tool's own config, and names any the reconcile skipped with its reason. The comparison is the entry, not the name: reconciliation leaves an entry teamai does not own alone, so a server of your own under a team name holds the key while the team's definition never arrives, and a stale copy is just as undelivered. Both are reported as `not the team's definition`. An entry teamai has no record of counts as teamai's when it equals what teamai writes for that server now or at any earlier revision of the team repo, and the next pull updates it. 

An unrecorded entry under a server name the team no longer defines is teamai's when it equals what teamai wrote for that server at some revision of the team repo's history, and pull and `uninstall` remove it; any other stays as it is. Any other one is yours: pull keeps it and names it, `doctor` lists it, and the team server is not written to that file. Rename or delete it, then run `teamai pull`, to receive the team version, or let `teamai mcp inject --force` replace it; `teamai pull --force` does not. An unresolved `${VAR}` is reported here with the variable's name, which is otherwise said once during a pull and never again. 

A declared secret with no value is not a failure: doctor prints it as a note (`notes` in `--json`) with the command that sets it, and the exit code stays as it would be without it; a note also says when an entry kept for it may hold an old value, and when a key is declared as a secret and also set in `env.yaml`. An `mcp.yaml` that does not parse is not a team without MCP: it is reported as `Team MCP servers can be read` with the parse error, since it injects nothing into any tool and every run after the first is silent about it. 

Team hooks and team model profiles that cannot be resolved (a file that does not parse, a name defined twice in one file, or one name in two active namespaces) fail `Team hooks can be resolved` and `Team model profiles can be resolved` with the reason pull logs once; `teamai status` points here when it counts them as 0. 

`Env variables injected in shell profile` no longer stops at finding the marker comment: it checks that `env/env.yaml` parses and declares its variables under the `variables:` key (a plain `KEY: value` mapping parses as none, while an explicit `variables: []` is a configuration with nothing to deliver and fails nothing), that each one reached `env.sh` with the value `env.yaml` declares, or your value for this team (one set with `--from-env` is not written there) 

— a key left over from an older value exports it to every shell and MCP server until the next pull, and the comparison reads `env.sh` back through the generator's own inverse, so a multiline value quoted across several lines is matched rather than called stale — and that this scope's injected block (the one sourcing its own `env.sh`, since a profile can also carry another scope's) would actually load it — an unquoted Windows path degrades to something a POSIX shell cannot read, so `source` never runs and nothing says so. 

`No stale env blocks left behind` is a separate check: which file `pull` prefers has changed over time (Windows Git Bash's login shell reads `.bash_profile`/`.bash_login`/`.profile`, never `.bashrc`), and a pull only ever adds a block, never migrates an old one away, so a dead block from an earlier install or platform change can sit in another candidate file indefinitely. It names every such file (checking `.zshrc`, `.bashrc`, `.bash_profile`, `.bash_login` and `.profile`, current and legacy spellings alike) and points at `teamai uninstall` to remove them — separately from delivery, so a working env block never reads as broken just because an old one is still lying around.

`Codex trusts this project, so it loads its team MCP servers` is built in project scope while the project's `.codex/config.toml` holds a server this worktree's `managed-mcp.json` records for Codex: Codex loads that file only in a trusted project, and skips an untrusted one without saying so. It reads the `projects` table of the Codex user config (`~/.codex/config.toml`, or the one under `toolRoots.codex`) as Codex does, taking the first `projects."<dir>"` entry that sets a `trust_level` for the checkout, then for its main checkout, each by real path (`/private/tmp/...`, not `/tmp/...`). 

It fails, naming the file and its servers, until that entry sets `trust_level = "trusted"`, and a pull reports the failure in its closing checks too. If the check still fails after pull attempts automatic trust, change project trust in Codex or add the main-checkout entry yourself, which covers every worktree. doctor only reads that file.

`Contributed learnings are published` fails while `teamai contribute` has notes queued that could not be pushed. A manual `teamai pull` does not repeat it at the end when the pull has already said it: the pull tries to publish the queue and reports the outcome itself, with the push error that made it fail — more than this check can tell you. If the pull never got that far, because the team repo failed to refresh, the check is printed as usual.

`--json` prints the same report as one object on stdout and routes every log line to stderr, so `teamai doctor --json 2>/dev/null` parses whole. The exit code is unchanged. Each check carries the fix suggestion it prints in human mode:

```json
{
  "ok": false,
  "scope": "user",
  "checks": [
    { "name": "Team repo exists locally", "ok": true },
    {
      "name": "teamai hooks in claude settings",
      "ok": false,
      "fix": "Run `teamai hooks inject` to inject/update hooks"
    }
  ]
}
```

`scope` is `null` before initialization. `packages` is present only when the team repo declares packages, and carries the rendered report lines. `notes` appears only when there is an advisory: the namespace notes described above (an item that replaces a root one, or without roles or projects a name defined more than once) and the Codex hook trust reminder when Codex cannot be asked (no `codex` on PATH, or its app-server failed).

Auto-update runs in the Stop hook and is controlled by two tiers:

| Tier | File | Field | Value |
|------|------|------|------|
| Team default | `teamai.yaml` | `autoUpdate` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

The user-level `updatePolicy` always takes priority over the team-level `autoUpdate`.

Self-update only reinstalls a copy that npm manages. When teamai runs from a checkout outside `node_modules`, such as one linked with `npm link`, both auto-update and `teamai update` skip the install and print a warning, because `npm install -g` would replace the link with the published package. Pull and rebuild the checkout to update it.

On Windows, the update check, installation, and hook refresh run without opening console windows.
