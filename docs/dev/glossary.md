# Glossary

The terms teamai uses in code, docs, `skill-data/` and CLI output. Domains are grouped; a **bold** word in a definition is defined here too.

An _Avoid_ spelling in quotes is always wrong, and lint counts it. An unquoted one is wrong only in the context it names.

## Agents

**Agent**:
A **model** running in an **agent harness**.
_Avoid_: agent for a **tool** or an **agent definition**, bot

**Agent harness**:
A **tool** plus every **agent resource** teamai delivers to it. The **model** is not part of it.
_Avoid_: setup, config, environment

**Model**:
The LLM the **agent** runs on. teamai delivers which model a **tool** uses (`models`), not the model itself.
_Avoid_: LLM in user-facing text

**Model provider**:
The service that serves a **model**, as configured in `models`.
_Avoid_: bare provider where a **repo provider** could be meant

**Tool**:
An AI coding tool teamai delivers to, such as Claude Code or Codex. [Tool support](../guide/tool-support.md) lists them.
_Avoid_: agent, client, IDE

**Capability**:
What an **agent** can do thanks to one or more **resources** on a topic. An effect, not a file.
_Avoid_: feature, plugin, bundle

## Resources

**Agent resource**:
One thing teamai delivers to an **agent harness**: a skill, rule, agent definition, learning, model, MCP server, hook, workflow or scorer. Short form: **resource**, once the full form opens the page or section, or where nothing else could be meant, as in code.
_Avoid_: "asset" (also as AI asset), component, primitive, customization

**Agent definition**:
A **resource** that sets up an **agent** for a role: its prompt, and optionally its tools and model. A **tool** runs it as a subagent, or as the main agent when a member starts a conversation with it. It lives in `agents/`; short form: agent, where nothing else could be meant, as in code.
_Avoid_: subagent (a **tool**'s term for one way to run it), agent profile

**Context resource**:
A **resource** the **tool** loads into the **agent**'s context: skills, rules, agent definitions, learnings.
_Avoid_: prompt, instructions

**Lifecycle resource**:
A **resource** that runs on the **tool**'s lifecycle events instead of entering context: hooks.
_Avoid_: script, trigger

**Context pointer**:
Text always in context that tells the **agent** when to load more: a skill's or an agent definition's description, a rule's `paths`, an MCP tool description.
_Avoid_: metadata, summary, frontmatter (only some pointers live there)

**Progressive disclosure**:
Loading a **resource** in stages. Its **context pointer** is always in context; its body, and the files it names (such as a skill's `skill-data/` references), enter only when the **agent** loads them. A **lifecycle resource**'s text enters when its event fires.
_Avoid_: lazy loading, on-demand context

**Marker file**:
The file whose presence makes a directory a **resource folder**: `SKILL.md`, `WORKFLOW.yaml`, `HOOK.yaml`, `RULE.md`, `MCP.yaml`, `SUITE.yaml`.
_Avoid_: manifest, index file

**Resource folder**:
A **resource** written as a directory: its **marker file** and the files it needs.
_Avoid_: "folder resource", package, bundle

**Delivered folder**:
Pull's copy of a **resource folder**, one directory per version of its files (`<name>.<version>`). A version's files never change.
_Avoid_: cache, install dir

Files under `references/` or `assets/` inside a skill folder belong to that skill. They are not **resources**.

## Layers

**Layer**:
Where a definition comes from. Resolution order: `teamai` (**teamai default**), `root` (**team root**), `namespace` (**active namespace**). A later layer replaces an earlier one with the same name.
_Avoid_: level, source, scope (that is a **scope**)

**teamai default**:
A **resource** teamai ships, named `teamai-<name>`. A team replaces it with the same name at the **team root**. Short form: default, as in default workflow or default scorer.
_Avoid_: built-in, shipped, preset

**Team root**:
The top of the **team repo**, outside any namespace.
_Avoid_: repo root (ambiguous with the **workspace**'s own repo)

**Active namespace**:
The namespace the member's role selects.
_Avoid_: current folder, team folder

## Checkouts and state

**Team repo**:
The git repo that holds the team's **resources**.
_Avoid_: team clone (that is the local copy), source repo

**Repo provider**:
Where the **team repo** is hosted, as `teamai init --provider` names it: `github`, `gitlab`, `tgit`, `cnb`, `gitcode`, or plain `git`.
_Avoid_: bare provider where a **model provider** could be meant, host

**Team repo mode**:
Where the **team repo** lives, as `repo.kind` stores it: `git` (a separate repo teamai clones), `http` (read-only, through an API key) or `self` (**self mode**). Any mode works in either **scope**.
_Avoid_: repo type

**Self mode**:
The **team repo mode** where the team repo is the git repo teamai is set up in: `teamai init .` or `--self`.
_Avoid_: "single-repo" (it reads as a team repo that is one repo, or a monorepo), "self repo"

**Scope**:
Where teamai installs: a **workspace** (the default) or user (`~/.teamai`). Independent of the **team repo mode**.
_Avoid_: project for the workspace scope (its older name, still the code's)

**Workspace**:
A directory set up with `teamai init` in workspace **scope**.
_Avoid_: project (that is a **project**)

**Workspace child**:
A repo or folder set up inside a **workspace**, up to three folder levels down. Pull in the workspace also delivers each child's selection; a child on another **team repo**, or in **self mode**, is left out and named.
_Avoid_: subproject, nested workspace

**Project**:
A logical project `manifest/projects.yaml` declares. `teamai init --project` makes it active in a **workspace**, which then syncs that project's **resources** and learnings.
_Avoid_: project for a **workspace** or a repo

**Data home**:
Where teamai keeps a scope's state: `~/.teamai` for user scope, `~/.teamai/projects/<slug>` for a **workspace**.
_Avoid_: partition in user-facing text, cache dir

**Repo anchor**:
The first entry of `git worktree list`: the main worktree, or the git dir of a bare repo. A repo and all its worktrees share it, so it keys their **data home** (`~/.teamai/projects/<slug>`).
_Avoid_: project anchor (a **project** is something else), repo id, main worktree (a bare repo has none, and it reads like the **main checkout**), git dir (a worktree's git dir differs)

**Main checkout**:
The checkout that owns shared hooks and Codex trust. Null for a bare repo.
_Avoid_: primary repo

**Workspace root**:
The directory teamai delivers files into.
_Avoid_: project root, cwd

**Installation**:
One copy of teamai this machine has run, as `~/.teamai/installations.json` records it. `teamai update` and `teamai doctor` list them. Machine-local: it never enters a team report.

## Budgets

**Agent wait**:
The time an **agent** is blocked on teamai: the foreground pass of a hook, or a pull it runs. Work teamai does after the hook returns is not agent wait.
_Avoid_: latency, performance, overhead

**Agent wait budget**:
What a hook or a pull costs in **agent wait**, counted as the processes it starts and the files it writes, on its first run and on its second. The budget is those counts, never elapsed time; the time of each run is recorded beside them for reference only.
_Avoid_: benchmark (that is `teamai benchmark`), perf test

**Hook form**:
How teamai writes its built-in hooks into one hook file: waited, through a login shell, as a project file a repository may commit always keeps them; unwaited, where the **tool** starts the hook and does not wait for it; or login-deferred, where the hook starts teamai without a login shell and the background pass gets the login environment. A **tool**'s facts and its installed version decide the form of the member's own file on macOS and Linux; on Windows it stays waited.
_Avoid_: hook mode, hook style

**Agent context budget**:
The bytes of text teamai's defaults put in an **agent**'s context, split by when they enter: always, through **progressive disclosure**, or on a hook event.
_Avoid_: token budget, prompt size
