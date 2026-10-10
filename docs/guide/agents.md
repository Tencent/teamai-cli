# Agents

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Agents Resource Type

The team repo can maintain custom subagent definitions under an `agents/` directory (one `*.yaml` or legacy `*.md` file per agent). Root-level files reach every member. One level of subdirectories scopes agents by role or project, the same way `rules/<namespace>/` works:

```text
team-repo/
  agents/
    code-reviewer.md              # Team custom subagent, shared with everyone
    frontend/vr-reviewer.yaml     # Only for roles/projects whose `agents:` lists `frontend`
    .removed                      # tombstone (auto-managed by teamai remove agents <name>)
```

```yaml
# manifest/roles.yaml (manifest/projects.yaml takes the same key)
roles:
  - id: frontend
    resources:
      knowledge: [common, frontend]
      skills:    [common, frontend]
      agents:    [common, frontend]   # optional; omitted = root-level agents only
```

Every namespace that takes effect — `knowledge`, `skills` and `agents` — becomes a
directory name, so it must be a single path segment: no `/`, `\`, `:` or control
character, no trailing `.` or space, and not a Windows device name, and no two
namespaces of one resource type may differ only by case — in `manifest/roles.yaml`
exactly as in `manifest/projects.yaml`, and across the two. A role's
`learnings:` is accepted for backward compatibility and ignored at runtime
(learnings are namespaced by project, not by role), so it names no directory and
is not checked.

`teamai pull` copies these into each Tier-1 tool's `agents/` directory (e.g. `~/.claude/agents/`), flattened by file name, so two active namespaces must not define the same agent name (pull reports the collision and leaves agents as installed for that run; the other resource types still sync). An agent in an active namespace replaces a root-level agent of the same name, and the root one comes back once that namespace stops being active. Without a configured role or project every namespace syncs, so a root-level and a namespaced agent of one name collide too. `teamai pull` writes `<name>.toml` for Codex tools, `<name>.json` for Kiro, `<name>.agent.md` for Copilot, and `<name>.md` for every other tool. 

When a member changes role, agents of the namespaces that stopped being active are removed on the next pull, unless the deployed copy was edited locally, in which case it is kept with a warning. Without a configured role, every agent syncs. `teamai push` resolves the source using the same active role and project namespaces as pull. It writes edits to that source and skips ambiguous destinations with a warning; an agent with only inactive sources is also skipped. Skipped agents do not block other resources in the same push. 

A new agent is placed the way a new skill is: `--role <ns>` or `--project <id>` (that project's `agents` namespace) names the directory, and with neither flag it resolves from the primary role's `agents` namespaces. It only stays at the shared root — where every member receives it — when no namespace resolves, and push warns when that happens (see [Push local resources](./member-guide.md#push-local-resources)). Cleanup checks each tool separately, respecting YAML `targets` and legacy format support. An active same-named agent protects a deployed file only when it targets that tool and output file. `teamai remove agents <name>` records a tombstone. 

A namespaced agent can be named as `<namespace>/<name>`; a bare name that only one namespace has resolves to it, and a bare name found in several places is refused, with the qualified names listed, rather than removed from all of them. The next pull on every other machine deletes `<name>.agent.md`, `<name>.md`, `<name>.toml` and `<name>.json` from each synced tool's agents directory. That cleanup also runs when the pull finds the team repo unchanged. 

Removing a namespaced agent tombstones `<namespace>/<name>` only, so the same name in another namespace is untouched; a member's flattened `<name>` copy is cleaned, and not pushed again, when it can be that agent's copy (the namespace is active for them, or their machine placed the agent) and their directory does not still receive an agent of that name from another active namespace. A member who never had that namespace keeps their own agent of the same name. The CLI's built-in `teamai-recall` profile is deployed alongside team agents but is not uploaded by `teamai push`.

A YAML agent carries tool-specific fields under `tool_extras.<tool>`, and each tool receives only its own key: `tool_extras.claude` reaches Claude alone, `tool_extras.qoder` reaches Qoder, and Qoder CN, ZCode and OMP read `tool_extras.qoder-cn`, `tool_extras.zcode` and `tool_extras.omp`. tclaude and tcodex also receive the fields of `tool_extras.claude` and `tool_extras.codex` that `tool_extras.tclaude` and `tool_extras.tcodex` do not set. `teamai push` writes an edit back to the key that tool reads; for tclaude and tcodex it writes only the values that differ from the base tool's, and skips, with the reason, an edit that removes a field the tool inherits, since only the base tool's key can drop it.

### Model aliases

A YAML agent can name a kind of model instead of a model: `model: strong`, `model: fast`, or an alias the team defines. The team maps each alias per tool in an optional `models/aliases.yaml`, in the tool's own model value, with an optional reasoning effort:

```yaml
# models/aliases.yaml
aliases:
  strong:
    claude: [{ model: opus, effort: high }, { model: fable }]
    codex:  { model: gpt-6-sol, effort: high }
    opencode: anthropic/claude-opus-5-5
    cursor: "claude-opus-5[effort=high]"
  fast:
    claude: haiku
    codex:  { model: gpt-6-luna, effort: low }
  reviewer:
    claude: [{ model: opus, effort: max }]
```

- `strong` and `fast` are always aliases, and TeamAI ships no models for them. A team adds its own names, which start with a lowercase letter followed by lowercase letters, digits or hyphens. Any other `model`, such as `opus`, is written as is.
- A tool entry is one option or an ordered list of them; only the first is used for now. An option is a model string or `{ model, effort }`.
- Each tool receives the model in its own model field and the effort in its own effort field, and no other tool's keys:

  | Tool | Model | Effort field |
  |---|---|---|
  | Claude, claude-internal, tclaude | as written | `effort` |
  | Codex, codex-internal, tcodex | as written | `model_reasoning_effort`, only when the mapping sets one |
  | OpenCode | as written (`provider/model`) | `variant` |
  | CodeBuddy, Qoder, Qoder CN | as written | `effort` |
  | Cursor | as written, including the bracket form `claude-opus-5[effort=high]` | none; write the effort in the brackets |
  | Copilot | the first entry, as one model string | none |
  | Kiro, WorkBuddy, JoyCode, ZCode, OMP | as written | none |

- An `effort` mapped for a tool with no effort field is dropped: the tool receives the model alone, and pull warns once, naming the alias and the tool, when it delivers an agent that uses the alias to that tool.
- claude-internal and tclaude use the `claude` entry, codex-internal and tcodex the `codex` entry, and Qoder CN the `qoder` entry, unless the alias has a key of their own. No other tool inherits an entry: Qoder, ZCode, OMP and JoyCode never receive the `claude` model.
- A tool the alias does not map gets no `model` field, so it runs the agent on its default. Without `models/aliases.yaml`, `strong` and `fast` give no model field in any tool.
- `tool_extras.<tool>.model` pins that tool to a concrete model and skips the alias, its effort included. An effort field in `tool_extras.<tool>` without a model overrides only the alias's effort, and a tool switched to a model profile does not receive it.
- A `model` that is not a string is rejected when the agent is read. A legacy `agents/<name>.md` is copied as is, so pull warns when its `model` is an alias.
- A structural error fails the whole file: YAML that does not parse, a value of the wrong type, an alias name that breaks the naming rule, an option with `effort` and no `model`, `~`, or top-level keys without `aliases:` (such as a misspelled `alias:`; an empty file, one with only comments, and an empty `aliases:` define no aliases). Until it is fixed, pull warns, naming the file, and holds every agent with a `model` field (an unreadable file may define any name) in each tool without `tool_extras.<tool>.model`: deployed copies stay, new ones are not written, and the models pull recorded for them stay as they were. Push skips those agents and says why; everything else pushes. 

  Once the file is fixed, an ordinary `teamai pull` delivers the held agents, including ones it never deployed and team changes to them that arrived meanwhile: a pull that holds an agent, on an unchanged team repo too, does not count the team revision as synced, so the next pull syncs in full. `teamai pull --dry-run` names the agents it would hold.
- Anything else this CLI does not know is dropped with a warning, and the rest of the file applies: a tool key that is not a tool teamai knows, an option field other than `model` and `effort` (the entry is used without it), and an alias named like a tool's own model alias (`opus`, `sonnet`, `haiku`, `fable`, `inherit`, `default`, `auto`, `lite`, a short best-effort list), which is ignored so that `model: opus` stays `opus`. A `gateways` key inside an alias is reserved for a later version and ignored without a warning. Pull prints each warning once, and only when it delivers an agent that uses that alias; a warning about one tool's entry, only when that tool reads the entry.
- Pull records the model and effort each agent copy received, so an ordinary `teamai pull` applies a change even when the team repo has not moved. It rewrites only the agents whose model changed and a copy that is missing. A copy you edited is kept, and pull names it on each such pull with how to take the new model. When the alias an agent used is removed, pull warns that its `model` is now written as is, also where the alias gave that tool no model field.
- `default` in `models/aliases.yaml` is a model value like any other and is written as is, which is CodeBuddy's own value for its default model. `~` there is an error: leave the tool out to give it no model field.

#### Namespaced aliases

A role or project gives an alias its own meaning in `models/<ns>/aliases.yaml`, same shape, read where `<ns>` is active in `resources.models` of your roles or projects, as `models/<ns>/models.yaml` is. Legacy mode (no roles, no projects) reads `models/aliases.yaml` alone.

- A namespace alias replaces the root alias of the same name whole: a tool it does not map gets no `model` field, even when `models/aliases.yaml` maps that tool.
- The same alias in two active namespaces holds agents with a `model` field, as a structural error does, and pull names both files. Rename or remove it in one of them, or stop declaring one of the namespaces.
- A name that any aliases file in the team repo defines, root or namespace, active for you or not, is an alias. An agent whose alias only an inactive namespace defines gets no `model` field, rather than the name as written, and your local entry for that name still applies. Pull warns once per such alias when it delivers an agent that uses it, naming the files: activate the namespace if the alias should apply to you, or rename the alias if its name was meant as a concrete model, such as `gpt-5-codex`.
- For the same reason, a structural error in any aliases file of the team repo, including one in a namespace that is not active for you, holds agents with a `model` field, and pull names that file.
- Pull warnings and push drift name the file an entry comes from, such as `models/checkout/aliases.yaml`. `teamai doctor` notes an alias that agents you receive use when a namespace that is not active for you also defines it.

#### Local override

A member replaces a team entry on their own machine in `~/.teamai/models/aliases.yaml`, which has the same `aliases:` shape:

```yaml
# ~/.teamai/models/aliases.yaml
aliases:
  strong:
    codex: { model: gpt-6-astra, effort: xhigh }
  fast:
    codex: default          # Codex uses its own default for fast
```

- For each tool, the order is: `tool_extras.<tool>.model`, then your entry, then the team entry, then no model field. A tool switched to a model profile filters the result of your entry or the team entry, as described next. Your entry replaces the team's whole entry for that tool, effort included, so `codex: gpt-6-astra` gives Codex no effort even when the team maps one.
- `~` or `default` for a tool gives it no model field and no effort, whatever the team maps.
- A key is a reserved name (`strong`, `fast`) or an alias the team defines, and a value can be any model. You can map `strong` before your team has a `models/aliases.yaml`. A name that is neither has no effect, since the file serves every team on the machine.
- claude-internal and tclaude use your `claude` entry, codex-internal and tcodex your `codex` entry, and Qoder CN your `qoder` entry, unless you give them their own. Your `claude` entry wins over the team's `tclaude` entry.
- The file is one per machine: it applies in every scope (user and each project checkout) and to every team that uses the alias name.
- An ordinary `teamai pull` applies an edit to the file, even when the team repo has not moved.
- The file follows the same rules as the team file, `~` aside, with one difference: a structural error holds only the agents whose `model` is an alias, since this file can make no name an alias, and the warning names the file by its path. Agents with a concrete model are delivered and pushed as usual. An entry this CLI does not know is dropped with a warning.

#### Tools switched to a model profile

A tool you switched with `teamai models switch` sends its requests to the profile's gateway, which does not know your account's models. For an agent whose `model` is an alias, pull therefore writes only what the switch can route:

- Claude keeps a resolved `opus`, `sonnet` or `haiku`, from your entry or the team's, because the switch points each of these families at a gateway model. Any other model is dropped.
- Codex, OpenCode, CodeBuddy and WorkBuddy get no `model` field.
- No switched tool gets an effort, neither the alias's nor one set in `tool_extras.<tool>`, unless `tool_extras.<tool>` also pins a model.

No `model` field means the tool's native inheritance, not the profile's model: Codex, for example, uses `[agents].default_subagent_model` when your config sets one, otherwise the model of the session that starts the agent. `tool_extras.<tool>.model`, a concrete `model` such as `opus`, and your `~` or `default` are written as they are without a switch. The Claude and Codex variants (claude-internal, tclaude, codex-internal, tcodex) are never switched. A tool counts as switched only while its live settings path (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...) is the one the switch recorded and those settings still hold what TeamAI wrote, the same checks `teamai models restore` makes. 

While TeamAI cannot read its switch records (`~/.teamai/models/managed.json`), pull warns and holds alias agents in the five tools `models switch` supports; while it cannot read one switched tool's settings, in that tool only. An ordinary `teamai pull` after `teamai models switch` or `teamai models restore` rewrites the affected agents.

#### Push

For an agent whose `model` is an alias, each tool's `model` and the effort field the alias writes belong to the alias, not to the copy:

- A copy with the model and effort the last pull wrote, or the ones a pull would write now, is unedited. So pushing before you pull a change to `models/aliases.yaml`, your override or a switch reports nothing, and push's warning about a kept copy whose deployed version changed ignores such a change.
- Push never replaces `model: strong` with a concrete model and never writes the alias's effort into `tool_extras`. A model or effort you changed by hand in a copy is drift: push names the copy and where the value comes from, leaves the change out, and says where to make it: your override file for an entry that comes from it, your override file or the team aliases file the alias comes from (`models/aliases.yaml` or `models/<ns>/aliases.yaml`) for a team entry or an unmapped tool, `teamai models restore --agent <tool>` for a switched tool. `teamai push --dry-run` reports it too. Your other edits to that agent, such as its instructions or other fields, still push.
- To move an agent to another alias, write the alias name in a deployed copy, such as `model: fast` in place of `opus`, or `model: strong` in an agent that set `model: opus`, and push: push proposes `model: <alias>`. In a tool whose `tool_extras.<tool>.model` pins the model, the copy does not adopt an alias; a changed value there is reported as drift on that pin. Two copies that name different aliases conflict, as any two different values do.
- A new agent that exists only in a tool's directory is pushed with the model it has there, which is never turned back into an alias.

#### Checking with doctor

`teamai doctor` answers "why does Codex run this model". For each agent whose `model` is an alias, it prints a note with one line per installed tool the agent targets: the model and effort the tool receives, and in brackets the step that decided it. Agents and tools that resolve alike share a line; agents with a concrete model or none are left out, since they are written as their spec says.

```text
models: how model: strong resolves for agents implementer, planner:
    claude: opus, effort high  [team: models/aliases.yaml]
    codex: gpt-6-astra, effort xhigh  [local: /home/me/.teamai/models/aliases.yaml]
    opencode: tool default  [default: models/aliases.yaml does not map opencode]
```

| Step | Meaning |
|---|---|
| `extras` | `tool_extras.<tool>.model` pins the model; the alias is skipped |
| `switched` | the tool is switched to a model profile: Claude keeps `opus`, `sonnet` or `haiku`, other tools get no model field and pick one natively |
| `local` | your entry in `~/.teamai/models/aliases.yaml`; `tool default (chosen in <path>)` is your `~` or `default` |
| `team` | the team entry, in the file named |
| `default` | no model field: the alias does not map the tool, or no active aliases file defines it |

- A Codex-family line with a model and no effort says so: the effort of the session that starts the agent carries over.
- When the last pull deployed something else, such as before you pull an edit to your override, the line names what is deployed; an ordinary `teamai pull` updates it, and `Agents delivered to <tool>` lists the agent as `model changed since the last pull` without failing.
- Every entry an aliases file sets that this CLI drops is a note too.
- `Agent model aliases can be resolved` fails while a structural error in any aliases file (active or not, your own included), one alias in two active namespaces, or a switched tool whose settings cannot be read holds agents. It names the reason, the file and the held agents, as pull's own warning does.

## GitHub Copilot CLI

GitHub Copilot CLI is supported for its official custom-instructions, Rules, Skills, custom-agent, hooks, and MCP surfaces, plus TeamAI Docs and Env delivery:

- **Scopes.** User resources live below `$COPILOT_HOME` (default `~/.copilot`); project resources live below `<project>/.github`. TeamAI honors `COPILOT_HOME` for detection and every user-scope read or write.
- **Skills.** `teamai pull` writes user skills to `$COPILOT_HOME/skills/` and project skills to `.github/skills/`. Edits in either scope are detected by `teamai push` like other TeamAI skills.
- **Custom instructions.** TeamAI injects team culture and shared instructions into `$COPILOT_HOME/copilot-instructions.md` for user scope or `.github/copilot-instructions.md` for project scope. Marker-delimited TeamAI blocks are replaced idempotently, while text outside the markers remains user-owned. `teamai uninstall` removes only the managed blocks. With `sharing.gitExclude` on, the project blocks go to `.github/instructions/teamai-context.instructions.md` instead, and `.github/copilot-instructions.md` stays the team's (see [Where the blocks go](./team-culture.md#where-the-blocks-go)).
- **Rules.** Team rules become native `*.instructions.md` files under `$COPILOT_HOME/instructions/` or `.github/instructions/`. TeamAI derives Copilot's required `applyTo` frontmatter from the team rule's `paths`; a rule without `paths` uses `**`. On push, only the Markdown body flows back, preserving the team-owned `paths` metadata. Unknown Copilot instruction files remain user-owned and are not uploaded or deleted. Copilot CLI 1.0.89 and later also reads a project's `.claude/rules`, so with Claude enabled each project rule reaches Copilot twice; teamai still writes both copies, as it does for every tool that also reads another tool's files.
- **Custom agents.** Team agents become official `<name>.agent.md` profiles under `$COPILOT_HOME/agents/` or `.github/agents/`. TeamAI maps compatible tool names onto Copilot's primary aliases, preserves Copilot-only frontmatter through `tool_extras.copilot`, and removes only profiles that match team agents or the built-in recall profile. User-authored profiles remain untouched. See [GitHub's custom-agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).
- **Team Context recall.** The built-in `teamai-recall.agent.md` profile receives only `execute`, `read`, and `search`. It invokes the existing `teamai recall` pipeline, so Copilot can retrieve learnings, codebase evidence, and teamwiki results without copying or creating a second knowledge store.
- **Docs and Env.** Team docs sync to the configured local docs directory (`~/.teamai/docs` by default, or the project-relative equivalent in project scope). Team env values sync to the scope's managed `env.sh`; launch Copilot from a shell that has sourced that file. TeamAI does not copy environment values into Copilot configuration.
- **Hooks and private telemetry.** TeamAI writes a dedicated version-1 hook file at `$COPILOT_HOME/hooks/teamai.json` or `.github/hooks/teamai.json`. It uses Copilot's VS Code-compatible PascalCase events (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd`) so hook payloads retain the snake_case fields consumed by TeamAI, and emits `bash`, `powershell`, and fallback `command` fields. Session IDs, skill usage, prompt counts, lifecycle state, and final token totals feed the local dashboard. Copilot prompt text, assistant output, transcript paths, and request metadata are never stored; if final token counters are absent, the session is still recorded without token data. 

  For resumed sessions, TeamAI records a path-free log byte boundary at SessionStart and captures a marker already present only when it is neither closed nor claimed by the previous run. Shutdown counters must link to that marker or to one written after the boundary. If a marker appears only after SessionStart and SessionEnd has no provider timestamp, its run cannot be proven and the session remains recorded without token data. The file is reconciled idempotently while preserving unrelated entries. TeamAI never edits Copilot's `settings.json`.
- **MCP.** `teamai pull` and `teamai mcp inject` merge local and remote servers into `$COPILOT_HOME/mcp-config.json` or `.github/mcp.json` using Copilot's native schema. TeamAI tracks ownership outside the Copilot file, so repeated pulls are idempotent and `mcp remove` or uninstall removes only TeamAI-owned entries. Hand-authored servers and `settings.json` remain unchanged.

Team hooks still come from the team's `hooks/hooks.yaml`: edit that source in the team repository and use the normal pull/push workflow. TeamAI does not reverse-import arbitrary native hook entries from a Copilot configuration file.

## OpenCode

[OpenCode](https://opencode.ai) is supported as a first-class tool. Because its config layout differs from the Claude family, teamai handles a few things specially:

- **Scopes.** OpenCode's user config lives under `~/.config/opencode/` while its project config lives under `<project>/.opencode/` — a different prefix from every other tool. teamai writes to the correct one per `--scope`, and only ever touches OpenCode files when OpenCode is actually installed for that scope (it never creates `~/.config/opencode/` for a non-user). Hooks are the one exception — they are always user-scoped, for the reason described below.
- **Skills** land in `.opencode/skills/` (project) or `~/.config/opencode/skills/` (user). OpenCode also reads `.claude/skills` natively, but teamai writes the OpenCode path too so an OpenCode-only user still gets them.
- **Subagents** are rendered into OpenCode's own `agents/*.md` format: frontmatter carries `description` + `mode: subagent` (plus `model` and any `tool_extras.opencode` fields such as `temperature`); the agent name comes from the filename. OpenCode does **not** read `.claude/agents`, so this native copy is required.
- **Rules** are copied into `.opencode/rules/` (or `~/.config/opencode/rules/`), but OpenCode does not auto-scan a rules directory — the files are inert until referenced. teamai therefore adds globs to the `instructions` array in `opencode.json` and removes them again when the team's last rule goes away, editing only that one key and leaving your own `instructions` entries untouched. In a project that is `.opencode/rules/**/*.md` in `.opencode/opencode.json`, beside the team instructions entry; OpenCode globs a relative entry from the session's working directory and each parent up to the worktree, so it loads the namespaced rules from anywhere in the project. 

  In user scope it is the absolute `~/.config/opencode/rules/*.md` plus one glob per namespace directory a rule lands in (`~/.config/opencode/rules/<ns>/*.md`): OpenCode resolves a relative entry from the session's working directory, and globs only the file name of an absolute one, so `**` never matches. A pull drops a team namespace's glob once its rules no longer reach you; a glob you added for a directory of your own stays. 

  OpenCode ignores `paths:`: it applies every rule it loads to every file. `uninstall` removes the globs, and deletes a `.opencode/opencode.json` left with nothing else in it.
- **Hooks** are delivered as an OpenCode *plugin*, not a settings-file entry — OpenCode has no `hooks` array; it auto-loads JS/TS plugins from **both** `~/.config/opencode/plugin/` and `<project>/.opencode/plugin/`. A plugin present in both dirs is loaded twice and would dispatch every event twice, so teamai keeps exactly one copy: `teamai-hooks.ts` in the user dir, which covers every project. This matches the other tools, whose `settings.json` hooks also live in HOME and gate on the `cwd` handed to `hook-dispatch`. The plugin subscribes to OpenCode's own events and shells out to the same `teamai hook-dispatch` entry point every other tool uses. 

  On V1, the event mapping mirrors the Claude built-in set: `session.created` → session-start, `session.idle` → stop, `chat.message` → prompt-submit, `tool.execute.after` → post-tool-use. The plugin forwards the same STDIN payload other agents send (`cwd`, `session_id`, `tool_name`, `tool_input`, `prompt`, and on post-tool-use the tool's output and status), and maps OpenCode's lowercase tool ids (`skill`, `todowrite`) back to the PascalCase matchers the handler registry expects. OpenCode cannot inject a hook's stdout back into the session, so hooks run purely for their side effects (status report / sync / update). 

  Note that OpenCode *awaits* its named hooks (`chat.message`, `tool.execute.after`), so those dispatches briefly wait on the `teamai` subprocess before the agent continues; the errors are always swallowed so a hook can never fail the session. Server-pushed agent hooks (`teamai-agent-<slug>.ts`) install into the same user plugin dir. Upvote **adoption** runs for OpenCode from the recall log, not a transcript: on V1 the plugin's `shell.env` hook sets `TEAMAI_AGENT_SESSION_ID` in the bash tool's environment, so a `teamai recall` run there joins the session its hooks carry, and a `task` call links the subagent's child session to its parent, so a doc the parent opens after a subagent's recall is upvoted. 

  The opt-in LLM-judge needs a transcript, which `session.idle` does not carry, so it does not run for OpenCode, and the "adopted team knowledge" summary is never shown, as hook stdout is discarded.

  Both built-in and server-pushed hooks support OpenCode **1.18.23** and **V2** (verified with 2.0.23). Each plugin default-exports one definition: V1 calls `server`, V2 calls `setup`. V2 maps `session.prompt` and `tool.execute.after` to the same dispatches, normalizes `shell` / `subagent` to `bash` / `task`, and uses the host's native `OPENCODE_SESSION_ID` for shell recall attribution. Lifecycle subscriptions are scoped to the plugin's directory and cancelled on unload.
- **Rules and instructions on V2.** OpenCode V2 parses `instructions` but loads none of its files, so the rule globs and the team instructions entry above reach only V1. On V2 the same `teamai-hooks.ts` plugin adds them itself: its `setup` registers a session `context` hook, and the same text on compaction, that reads `~/.config/opencode/teamai-context.md` and `~/.config/opencode/rules/**/*.md` in every directory, then walks up from the session's directory to the nearest `.opencode/` holding `teamai-context.md` or `rules/` and adds that `teamai-context.md` and every `.opencode/rules/**/*.md`, sorted by path. It reads the files on each request and does not call `teamai`. V1 delivery through `instructions` is unchanged. 

  Because the plugin carries them, `teamai hooks remove` also takes the team rules and instructions away from V2 sessions. `teamai doctor` runs `opencode --version` (missing or unreadable counts as V1); on V2 `Team rules are active in opencode` and `opencode adds the team instructions to its prompt` check that the plugin is installed as this teamai writes it, instead of checking `instructions`.
- **MCP** servers live under the `mcp` key of the shared `opencode.json` (see [MCP servers](./sharing.md#mcp-servers)).
- **OpenCode V2 with the git exclude option on.** While `sharing.gitExclude` is on (see [Keeping Delivered Files Out of Git](./member-guide.md#keeping-delivered-files-out-of-git)), `opencode --version` reports V2 (asked once per command; missing or unreadable counts as V1), and the pull has installed teamai's plugin as this teamai writes it, nothing of teamai's goes into the project's opencode.json files. The pull writes the team MCP servers to `.opencode/teamai-mcp.json`, a file of teamai's alone, listed in the git exclude block, and written only once the git exclude block holds it when it would carry a resolved value. The plugin reads it when OpenCode opens the project (the same walk up to the nearest `.opencode/`, which now also stops at one holding only that file) and adds those servers to that project only. The pull then takes teamai's MCP servers out of the root `opencode.json` and its `instructions` entries out of `.opencode/opencode.json`, and deletes a file left with nothing in it. It does so only where git does not track the file, and keeps your own servers, entries and keys there: a file the team commits is left as it is, and `teamai doctor` names it under `No OpenCode V1 entries are left in shared config files`. V2 ignores those `instructions` and loads those servers a second time; remove teamai's entries yourself once nobody on the project uses V1. Without a current plugin (it could not be written, a tool was skipped for having no shell, or after `teamai hooks remove` until the next pull reinstalls it) the pull keeps the V1 entries, since they are then all V2 gets, and `teamai doctor` says so next to the missing plugin. Back on V1, or with the option off, the next pull writes the V1 entries again and removes `.opencode/teamai-mcp.json`. `teamai doctor` reports the plugin out of date on V2 until the next `teamai pull` or `teamai hooks inject`. The plugin reads the servers when OpenCode opens a project: restart OpenCode after a pull changes them.

## Pi Coding Agent

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) is supported through its documented skills, instruction, and extension surfaces:

- **Scopes.** Project skills are written to `.pi/skills/`, user-scope skills to `~/.pi/agent/skills/`. Pi reads no rules directory, so teamai writes it no rule files: the user-scope team rules are a block in `~/.pi/agent/AGENTS.md`, and in a project the TeamAI Pi extension adds the project's team rules to each run's system prompt, both without path scoping.
- **Instructions.** Pi reads the project's own `AGENTS.md` (or `CLAUDE.md`); TeamAI leaves it unchanged. User-scope team instructions go to `~/.pi/agent/AGENTS.md`. In a project, the TeamAI Pi extension asks `teamai` for the member's team instructions and the project's team rules when the session starts and adds them to the system prompt of each run; Pi rebuilds that prompt for every run, so they do not pile up.
- **Hooks.** TeamAI generates one user-scoped `teamai-hooks.ts` under `~/.pi/agent/extensions/`. It maps `session_start` → session-start, `before_agent_start` → prompt-submit, and `agent_settled` → stop; `tool_execution_start` caches the tool's input, and `tool_execution_end` dispatches post-tool-use forwarding that cached input as `tool_input`, plus the result's text as `tool_response` and a `tool_status` from its error flag. Every event carries the Pi session id (`ctx.sessionManager.getSessionId()`), the same id Pi's bash tool exports as `PI_SESSION_ID`, so a `teamai recall` run there joins the session its hooks carry and upvote **adoption** runs for Pi. Pi loads both user and project extension roots, so TeamAI never creates a project copy — a second copy would double-dispatch every event, the same single-copy policy as the OMP adapter. 

  Injection never overwrites a same-named file that lacks the TeamAI marker. Pi has no settings file for self mode to commit, so a fresh clone still needs one `teamai init`/`pull` on that machine before Pi hooks are active there. The explicit `teamai hooks remove` command and user-scope `teamai uninstall --agent pi` delete this shared extension. Project uninstall preserves it for other projects and removes any legacy project copy; files without the TeamAI marker are never removed. `teamai hooks list` always reports this global path. 

  Pi profile overrides (`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`), which relocate the agent directory, are not supported for hooks — same as the OMP adapter — and the default `~/.pi/agent/` layout is used. Model profiles are separate and do read `PI_CODING_AGENT_DIR`. The shared extension remains installed after project uninstall; instruction dispatch checks the project's tool exclusion before adding its instructions.
- **Team hooks boundary.** The Pi adapter installs only the built-in lifecycle bridge. Custom team hooks and built-in hook overrides declared in `hooks/hooks.yaml` are skipped with a warning. Full team-hook and per-project ownership semantics require a separate cross-adapter design and are deferred to a follow-up PR.
- **Server-pushed agent hooks.** HTTP-source hooks are installed as `teamai-agent-<slug>.ts` extensions in the same global extension directory. Unsupported lifecycle events are skipped with a warning.
- **MCP (Pi 0.99.0+).** Supports stdio and streamable HTTP; SSE is skipped. User configuration goes to `~/.pi/agent/mcp.json`, project configuration to `.pi/mcp.json`; Pi loads project configuration only after trusting the project. The native `codemode` default is retained, without forcing direct exposure; timeout values in `mcp.yaml` are converted from milliseconds to seconds. Local exposure/enabled changes to managed entries survive unchanged team definitions but are replaced when the team definition changes; doctor compares complete entries and reports these local differences. An extension taking over `/mcp` can disable built-in MCP; remove that extension to use the built-in support.
- **Subagents.** TeamAI custom subagent files are not supported.

## Qoder

Qoder is available as a built-in target. TeamAI deploys skills, rules, and subagents to `.qoder/skills/`, `.qoder/rules/`, and `.qoder/agents/`. Hooks and MCP servers are merged into the scope-specific `.qoder/settings.json`, preserving unrelated user settings. The paths match Qoder's user and project configuration contracts.

Rules are written in the form Qoder Desktop writes, which Qoder CLI also reads: a rule with `paths:` gets `trigger: glob` and one unquoted `glob:` line of comma-separated globs, with each `{a,b}` alternation expanded into separate globs because the line is split on every comma; a rule without `paths` gets `trigger: always_on`. Qoder publishes no schema for this frontmatter; the form comes from Desktop's rule files in `alibaba/tron-one-agent`.

Qoder CN is a separate distribution that keeps its **user** directory at `~/.qoder-cn` instead of `~/.qoder`, so it is a separate built-in target (`qoder-cn`) rather than part of `qoder`. Only the user scope differs: user-scope resources go to `~/.qoder-cn/{skills,rules,agents}` and hooks/MCP to `~/.qoder-cn/settings.json`, while project-scope resources keep Qoder's `<project>/.qoder/` layout. It reads the same Claude-compatible resource formats, so content is identical and only the user-scope root changes. Install both editions and TeamAI syncs each one to its own user directory; neither needs a symlink. 

In a project Qoder and Qoder CN both read `.qoder/rules/`, so they share one copy there: uninstalling one keeps it while the other is installed, and `doctor` checks it once, as `Rules delivered to qoder, qoder-cn`. Each edition counts as installed by its own HOME root (`~/.qoder` / `~/.qoder-cn`) or an explicit `--agent` entry, as the Trae builds do — the shared project `.qoder/` installs neither by itself.

## Kiro

Kiro is available as a built-in target. TeamAI deploys skills, rules, and subagents to `.kiro/skills/`, `.kiro/steering/`, and `.kiro/agents/`, matching [Kiro's documented layouts](https://kiro.dev/docs/skills/) for workspace skills, [steering](https://kiro.dev/docs/steering/), and custom agents. Subagents are rendered as JSON so they work with both Kiro CLI 2.x and 3.x. Each rendered agent preserves Kiro-specific fields and custom hooks, and adds a managed `hooks.agentSpawn` command that dispatches TeamAI's `session-start` event when that custom agent is activated in an interactive CLI session. 

This verified CLI 2.x hook is embedded in `.kiro/agents/*.json`, not written to the standalone `.kiro/hooks/` surface introduced for IDE 1.x and CLI 3.x; Kiro's in-memory built-in default agent cannot be modified, and `--no-interactive` does not fire `agentSpawn`. MCP servers merge into the scope-specific `.kiro/settings/mcp.json` (see [MCP servers](./sharing.md#mcp-servers)).

Rules are steering files with Kiro's inclusion frontmatter, in `.kiro/steering/` and `~/.kiro/steering/`: a rule with `paths:` gets `inclusion: fileMatch` and `fileMatchPattern` as a list of its globs; a rule without `paths` gets `inclusion: always`. Kiro reads only the top level of a steering directory ([kirodotdev/Kiro#10448](https://github.com/kirodotdev/Kiro/issues/10448)), so a namespaced rule is written flat, as for [Oh My Pi](#oh-my-pi): `rules/fe/style.md` becomes `fe.style.md`, and `push` sends an edit of that file back to `rules/fe/style.md`. 

Push requires a delivery record for that flat copy; a personal file with the same name is neither refreshed before push nor offered as an edit of the team rule. A namespaced rule whose flat name another rule you receive also has is not written, and a file of your own with a team rule's flat name is never overwritten or removed. An older nested `<ns>/<name>.md` copy is removed once its flat copy is written, unless you edited it: then it is kept and named, since Kiro does not read it. 

Kiro's own `product.md` is not a team rule, so `pull` leaves it. Kiro CLI loads every steering file whatever its `inclusion` ([kirodotdev/Kiro#7950](https://github.com/kirodotdev/Kiro/issues/7950)), so a scoped rule is always on there. 

The Kiro IDE once ignored `fileMatch` in `~/.kiro/steering` ([kirodotdev/Kiro#9176](https://github.com/kirodotdev/Kiro/issues/9176), Kiro 0.12); a maintainer reported fixes since, and the report closed without a retest.


## Trae

Trae and Trae CN are available as built-in targets. TeamAI deploys skills to `.trae/skills/` and rules to `.trae/rules/`, matching [Trae's documented layouts](https://docs.trae.ai/ide/rules). Only the user directory differs on the CN build (`~/.trae-cn` instead of `~/.trae`, as for Qoder CN): a project keeps one shared `.trae/` for both, while a user-scope pull delivers `~/.trae/skills/` and `~/.trae/user_rules/` for the international build and `~/.trae-cn/skills/` and `~/.trae-cn/user_rules/` for the CN one — Trae names its user rules directory `user_rules`, not `rules`. Trae has no settings-based hooks surface and no subagents directory, so those resources stay unsynced and you run `teamai pull` manually, as for JoyCode. MCP servers merge into the project's `.trae/mcp.json` in the Claude `mcpServers` shape (see [MCP servers](./sharing.md#mcp-servers)); both builds' targets map that one file under a single shared ownership record, so either edition's pull updates and cleans it, and a server scoped by `tools:` to one edition stays while either targets it. Trae keeps user-level MCP next to its user settings in a platform-specific directory, so no user file is written.

Each build counts as installed by its own HOME root (`~/.trae` / `~/.trae-cn`) or by an explicit `--agent` entry naming it — the shared project `.trae/` says nothing about which edition runs (as WorkBuddy is counted by `.workbuddy/`), so no half of the pair stays a "phantom sibling" that retains or resyncs the other's files. In a project both builds read the same `.trae/skills/` and `.trae/rules/`, so they share one copy of each there: uninstalling one keeps both while the other is installed.

Rules are `.md` files with Trae's frontmatter: a rule with `paths:` gets `globs: a, b` unquoted — Trae's parser takes the line as it stands and splits it on every comma — plus `alwaysApply: false`; a rule without `paths` gets `alwaysApply: true`. Trae reads rules up to three directory levels deep, so a namespaced rule keeps its `fe/style.md` shape. On `push`, only the Markdown body flows back, and a rule file there with no matching team rule is yours: `pull` leaves it and `push` never offers it as a new team rule.

## CodeBuddy and WorkBuddy

WorkBuddy runs CodeBuddy's engine, so both get rules in CodeBuddy's format: a rule with `paths:` gets `alwaysApply: false` and `paths:` as a YAML block list, one quoted glob per item; a rule without `paths` gets `alwaysApply: true`. CodeBuddy's frontmatter parser reads lines, not YAML, so the inline `paths: ["a", "b"]` a verbatim copy carried reached it as globs with the brackets in them. In a project both tools read `.codebuddy/rules/`, so that directory holds one copy of each rule for both: excluding or uninstalling one keeps the copies while the other is installed, and `doctor` checks the directory once, as `Rules delivered to codebuddy, workbuddy`. WorkBuddy counts as installed only where `.workbuddy/` exists. 

In a project that has `.workbuddy/` but no `.codebuddy/`, the shared copy creates `.codebuddy/`, so CodeBuddy then counts as installed there too and also gets skills, agents and hooks; if you do not use CodeBuddy, `teamai uninstall --agent codebuddy` removes them and keeps it excluded, and the shared rules stay for WorkBuddy. In user scope CodeBuddy reads `~/.codebuddy/rules/` and WorkBuddy `~/.workbuddy/rules/`.

## ZCode

ZCode is available as a built-in target. Skills deploy to `.zcode/skills/` (ZCode also reads the central `~/.agents/skills/`, which the `agents` entry covers), and subagents deploy as Claude-style Markdown to `.zcode/agents/`. Hooks are merged into the shared `~/.zcode/cli/config.json`, preserving unrelated keys such as plugin state. Two ZCode specifics the writer handles for you:

- Config-file hooks are **disabled by default** in ZCode — TeamAI forces `hooks.enabled: true` so the entries it writes actually fire.
- On Windows, hook entries launch through a hidden **wscript VBS launcher** (`wscript.exe <teamai-hook-dispatch.vbs> <dispatch tail>`): wscript is a GUI-subsystem binary, so hook runs never flash a console window, and the launcher spools STDIN to a temp file so the payload reaches `hook-dispatch`. Timeouts are network-scale per event (180s session start, 60s stop / prompt submit, 30s post-tool-use) so a session-start dispatch carrying a repo pull is not killed mid-flight. Payloads containing multi-byte text may degrade at the launcher's ANSI-codepage spool step — identity fields are salvaged so degraded dispatches stay linked to the session; uninstall removes both the entries and the script.
- On POSIX, entries are plain `bash -lc <dispatch>` argv vectors and the launcher is not written; on both platforms the command tail is stored verbatim as the entry's last argv element, which is what managed-entry detection and the managed-hooks manifest match against.

These paths are verified against the ZCode desktop app: profiles created in its Subagents settings page land in `~/.zcode/agents/*.md`, and files placed there (e.g. by TeamAI) show up in the page's installed list. MCP servers deploy to `~/.agents/mcp.json` (user scope, Claude `mcpServers` shape — the same file ZCode's own MCP settings page reads). Project scope is not wired: ZCode stores workspace MCP under a different key (`mcp.servers` inside `.zcode/config.json`), which the Claude writer cannot emit. ZCode reads no rules directory: in user scope the team rules are a block in `~/.zcode/AGENTS.md`, which ZCode reads as its user context, without path scoping. 

In a project, teamai's `SessionStart` hook in `~/.zcode/cli/config.json` adds the project's team rules to each new session (ZCode runs no project-level hooks). ZCode drops that text when it compacts a session, so the rules come back in the next session.

## Oh My Pi

Oh My Pi (OMP) is available as a built-in target. TeamAI deploys skills, rules, and subagents to OMP's native directories — `.omp/skills/`, `.omp/rules/`, and `.omp/agents/` at project scope, and `~/.omp/agent/skills/`, `~/.omp/agent/rules/`, and `~/.omp/agent/agents/` at user scope (user-scope resources live under the agent directory `~/.omp/agent/`, a different prefix from the project one, so TeamAI switches prefixes with the scope). Team instructions go to `~/.omp/agent/RULES.md` in user scope and, in project scope, into each turn's system prompt through the extension below (see [Where the blocks go](./team-culture.md#where-the-blocks-go)), and MCP servers merge into `~/.omp/agent/mcp.json` / `<project>/.omp/mcp.json` (Claude `mcpServers` shape — see the MCP section above). 

Skills are one-level `<name>/SKILL.md` bundles and TeamAI fills in a `description` on sync, which OMP's native skill provider requires to discover a skill. These paths follow OMP's documented discovery layout (verified against OMP 18.2.5). Hooks ride OMP's extension runner: `teamai pull` writes a single generated extension to `~/.omp/agent/extensions/teamai-hooks.ts` (never a project copy — OMP auto-loads both roots and would double-dispatch every event), which forwards OMP's `session_start` / `session_stop` / `before_agent_start` / `tool_result` events to the same `teamai hook-dispatch` entry point every other agent uses, gated on the session `cwd`. In a project session it also asks for the member's team instructions at `session_start` and appends them to the system prompt in `before_agent_start`. 

Every event carries the OMP session id (`ctx.sessionManager.getSessionId()`; a subagent has its own), and `tool_result` also the tool's text output and a status from `isError`, so upvote **adoption** runs for OMP's main agent: OMP sets no session variable in its shell, so a recall joins the session of the `bash` call that ran it, and a `read` with a line selector (`x.md:50-200`, `x.md:raw`) counts as a read of the file. From OMP 18.3.2 a subagent's events also carry its `ctx.agent` id and name, so the `teamai-recall` subagent's own reads never count. 

A subagent's session file sits under its parent's, whose header names the parent session, so the extension links the two on the subagent's tool calls, and a doc the main agent opens after a subagent's recall is upvoted (verified against OMP 18.4.8). The `session_stop` handler returns nothing, so a dispatch can never force a session continuation, and there is no matcher-scoped post-tool-use pass because OMP's tool ids are lowercase (`bash`, `read`, …) and it has no `Skill` / `TodoWrite` tool. User-scope `teamai uninstall` removes the extension; project uninstall preserves it for other projects. A same-named file without the TeamAI marker is never overwritten or removed, as with Pi. 

OMP profiles (`OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`), which relocate the agent directory, are not supported; the default `~/.omp/agent/` layout is used.

Rules are written in OMP's own frontmatter, in `.omp/rules/` and `~/.omp/agent/rules/`: a rule without `paths:` gets `alwaysApply: true`, so its text is in every prompt; a rule with `paths:` gets `globs` with its globs and a `description` (its first Markdown heading, or `Team rule for files matching <globs>`), so OMP lists it in the prompt's rulebook as `name (globs): description` and reads it when the work matches. OMP drops a rule with neither. 

OMP reads only the top level of its rules directory, so a namespaced rule is written flat: `rules/fe/style.md` becomes `fe.style.md`, and `push` sends an edit of that file back to `rules/fe/style.md`. Push requires a delivery record for that flat copy; a personal file with the same name is neither refreshed before push nor offered as an edit of the team rule. A namespaced rule whose flat name another rule you receive also has is not written: a root rule such as `rules/fe.style.md` keeps the file, two namespaced rules both go without, and `pull` names them while `doctor` fails. 

A file of your own that has a team rule's flat name is never overwritten or removed: only the content a delivery record holds, or the exact render, makes it teamai's. A flat copy you edited after delivery is kept and named by `remove` and `uninstall`. An older nested `<ns>/<name>.md` copy is removed once its flat copy is written, with or without a delivery record (the record, or the team rule verbatim, proves it unedited). One you edited is kept and named, since OMP does not read it: copy your edit into the flat file to keep it. OMP reads `.omp/rules/` only in the directory the session starts in, so the project's rules reach a session started at the project root, not one started in a subdirectory. 

OMP also loads a project's Cursor rules (`.cursor/rules/*.mdc`, top level only) and Copilot instructions (`.github/instructions/**/*.instructions.md`) as rules, and keeps one rule per name, its own `.omp/rules` copy first (checked against OMP 18.2.1's loader). A root team rule therefore reaches OMP once with Cursor or Copilot enabled, but a namespaced one reaches it twice with Copilot: as `fe.style` from `.omp/rules` and as `style` from `.github/instructions/fe/`. OMP reads `~/.cursor/rules` only when you enable that source.

## DeepSeek Harness

DeepSeek Harness (`dsh`) is supported for TeamAI skills and shared resources. DSH's official Claude-hook bridge is a profile plugin rather than a settings-file hook surface, so when dsh's home (`$DSH_HOME`, `~/.dsh/` when it is unset) exists, `teamai init`, `teamai pull`, or `teamai hooks inject` writes a Claude-compatible hook config and a Cordis patch under `~/.teamai/dsh/`.

dsh reads no rules directory. In user scope the team rules are a block in `$DSH_HOME/AGENTS.md` (`~/.dsh/AGENTS.md` when `DSH_HOME` is unset), which dsh puts in its first request, without path scoping. As for hooks, teamai writes it only when that home exists. Skills still go to `~/.dsh/skills/`, and only while `~/.dsh/` exists, whatever `DSH_HOME` says. In a project, teamai's session-start hook adds the project's team rules, once dsh runs with the patch below. dsh runs that hook detached, so the first request can miss them, and drops them when it compacts a session.

TeamAI prints the exact absolute patch path. Add that `--patch` flag to the command that starts your DSH profile, for example `dsh tui --patch "<printed-path>"`. This is a one-time launcher opt-in; `teamai hooks remove` and `teamai uninstall` remove the TeamAI patch while preserving other hook entries in the generated config.

## JoyCode

JoyCode is available as a built-in target. Skills, rules, and subagents are deployed to `.joycode/skills/`, `.joycode/rules/`, and `.joycode/agents/`. Subagents use Markdown with YAML frontmatter.

Rules are `.mdc` files in JoyCode's own render. JoyCode reads the frontmatter line by line, not as YAML: it keeps the quotes Cursor's render puts around `globs` and splits the value on every comma, so a scoped rule in Cursor's form never applied. A rule with `paths:` gets `globs:` unquoted and comma-separated, with each `{a,b}` alternation expanded into separate globs, and `alwaysApply: false`; a rule without `paths` gets `alwaysApply: true`. `doctor` compares each copy in a project's `.joycode/rules/` with this render.

In user scope JoyCode reads no rules directory: the team rules are a block in `~/.joycode/rules.txt`, without path scoping.

JoyCode rule cleanup is conservative: local `.mdc` and `.md` files absent from the team rule list are preserved unless an explicit team removal tombstone exists. This protects personal rules in the shared directory; an old team copy without a deletion record is retained rather than guessed to be stale.

For canonical YAML agents, push compares each local file with the corresponding tool rendering and merges only actual edits back into the original spec. Deployment `targets`, other tools' metadata, and fields absent from a tool's native format are preserved. Conflicting or unparseable edits are skipped rather than replacing the canonical agent.

**Hooks & Manual Sync**: JoyCode currently does not provide a lifecycle hooks mechanism or dedicated launcher/startup adapter (no `settings.json` hook array or `hooks.json` format). Consequently, opening JoyCode does not fire TeamAI's `SessionStart` event, and cannot trigger background `teamai pull`, usage reporting, or auto-update checks. Users working with JoyCode must run `teamai pull` manually in the terminal to synchronize team resources, and `teamai push` to contribute changes. If JoyCode adds hooks or extension lifecycle events in future releases, a dedicated hook adapter can be connected.

## Cursor

Cursor subagents deploy to `.cursor/agents/*.md` with YAML frontmatter carrying `agent_id` (the team agent's name), `description`, `tools`, and the agent's `model` when it declares one, plus any `tool_extras.cursor` fields; `reverseFromCursor` reads the same fields back, so a `pull` → `push` round-trip keeps the model.

Cursor project rules must live in `.cursor/rules/` as **`.mdc`** files with YAML frontmatter — a plain `.md` file there is silently ignored by Cursor. teamai therefore writes rules to Cursor as `<name>.mdc` (JoyCode, Copilot, Kiro, Qoder, Qoder CN, Trae, Trae CN, CodeBuddy, WorkBuddy and Oh My Pi get a format of their own, described in their sections; every other tool gets a plain `.md`), deriving the frontmatter from the team rule:

- A rule scoped with a `paths:` list becomes `globs: "<comma-joined>"` + `alwaysApply: false` (Cursor auto-attaches it when a matching file is in context). The value is quoted because a glob starting with `*` is not valid YAML unquoted.
- A rule with no `paths` (a mandatory team rule) becomes `alwaysApply: true` (applied to every Cursor chat session).

Only the markdown body crosses between the two formats; each side keeps its own frontmatter. On `pull` the Cursor frontmatter is machine-derived (the body is copied over with leading/trailing blank lines normalized), so a `pull` → `push` round-trip is not seen as a content change. On `push`, editing a rule's body in `.cursor/rules/*.mdc` and running `teamai push` sends **only that body** upstream — the team rule keeps its own `paths:` frontmatter, so the rule's scope is never silently lost.

Two things are deliberately *not* pushed from Cursor's rules directory:

- A `.mdc` file with no matching team rule. `.cursor/rules/` is also where Cursor's own *New Cursor Rule* command writes personal rules, so teamai never offers those as new team resources.
- The CLI built-in rules, which are deployed (as `.mdc` for Cursor) rather than synced.

A `.md` you put there yourself is left alone.
