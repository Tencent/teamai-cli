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
_Avoid_: agent, "agent CLI", client, IDE

**Tool instance**:
A **tool** a team or member adds as another command or home of a shipped one, in `tools/<name>.yaml` or a **resource folder** with `TOOL.yaml`. It keeps the formats of the tool it extends. A team's runs once a member accepts its file's content.
_Avoid_: custom tool, tool variant, bare instance

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
The file whose presence makes a directory a **resource folder**: `SKILL.md`, `WORKFLOW.yaml`, `HOOK.yaml`, `RULE.md`, `MCP.yaml`, `SUITE.yaml`, `AGENT.md`, `SCORER.md`, `DRIVER.yaml`, `RUNTIME.yaml`, `SANDBOX.yaml`, `TOOL.yaml`.
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
A **resource** teamai ships, named `teamai-<name>`. A team replaces it, or some of its files, with a folder of the same name at the **team root**. A **driver definition**, **step runtime** or **sandbox profile** looked up by name is taken by the exact name in every **layer** first, then as `teamai-<name>`, so a team's `t3` replaces `teamai-t3` whole. Short form: default, as in default workflow or default scorer.
_Avoid_: built-in, shipped, preset

**Default parameters**:
The values of a **teamai default** a team may tune, in `params.yaml` of its **resource folder**. Read the same everywhere the default's code runs, inside a workflow run or outside one, and set for the whole team, unlike a workflow input, which one run sets. A team's `params.yaml` sets only the keys it changes; every other key keeps teamai's value.
_Avoid_: settings, config, `with:` (a step's inputs to another workflow)

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
_Avoid_: project (that is a **project**); bare workspace for a **step workspace**

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

## Workflows

**Driver**:
What moves a run's steps forward: the local driver, the skill driver in a coding session, or a script of the team's that calls `teamai workflow next` and `report`. The local driver runs on a **driver definition**.
_Avoid_: executor (a step's `command` or `prompt`), runner (an install that takes a published run)

**Driver definition**:
A YAML file `--driver <name>` selects, `drivers/<name>.yaml` or a **resource folder** with `DRIVER.yaml`: the **step runtimes** that run each step, in order, with their options, and optionally the **tool** prompt steps use. The ones teamai ships are **teamai defaults**, such as `teamai-local`, `teamai-t3` and `teamai-sandbox`. Short form: definition.
_Avoid_: driver for the file, profile

**Step runtime**:
Where and how a step's work runs: the **host slot**, or what one entry of a **driver definition** names with `use`: the **`tools` runtime** and `fleet`, in teamai's process, or an external program that speaks the **runtime protocol**, such as `t3`, `paseo` or `sandbox`. An external one is a **resource** of the member, the team or teamai: `runtimes/<name>.yaml`, whose `entry` names an executable on PATH, or a **resource folder** whose `RUNTIME.yaml` names its code. Short form: runtime, where nothing else could be meant.
_Avoid_: runtime for a tool's bundled runtime (the Node that WorkBuddy unpacks), backend

**Runtime protocol**:
The JSON lines teamai and an external **step runtime** exchange on stdio, protocol `1`. [Write a step runtime](../guide/runtime-protocol.md) describes it.
_Avoid_: "driver protocol" (a driver speaks `workflow next` and `report`)

**Runtime offer**:
What a **step runtime** answers at `init`: what it can do for a step (`can`), the tools it cannot run now and why, and whether it launches agents its own way.
_Avoid_: bare offer where an **offer** to other installs could be meant, capabilities (a **capability** is what an agent can do)

**Host slot**:
The **step runtime** in teamai's process that every **driver definition** keeps without listing it, recorded as `host`. It runs teamai's own command steps, a command step with `requires.host`, an `answer:` step, `deliver: publish`, and command steps when no runtime of the definition runs commands. It launches no prompt step's tool.
_Avoid_: bare host where a **session host** or a **repo provider** could be meant

**Host driver**:
The built-in **driver definition** `--driver host` selects: the **host slot** alone, with no **step runtime** listed, so it runs commands, gates and workflows whose steps need no AI tool, and refuses a prompt, `interactive`, `answer:` or scored step. No file defines or replaces it.
_Avoid_: bare host where the **host slot** could be meant

**`tools` runtime**:
The **step runtime** in teamai's process that launches this machine's **tools** for prompt steps and judges, in the member's own home: `use: tools`, whose old name is `use: local`. `local` names the default definition, `teamai-local`: `tools` plus the **host slot**.
_Avoid_: local for this runtime, "local runtime"

**Session host**:
The coding session `--driver skill` adopts, such as a Claude Code or T3 Code session, which runs each step as a child agent; `sessionHost` in identifiers. Stored values such as `SkillState.host` and `places: 'host'` keep the older spelling.
_Avoid_: bare host, parent session

**Attempt**:
One try of a step on a **step runtime**, with its own id and `attempts/<attempt>/` directory. A retry or a later pass is a new attempt.
_Avoid_: job, execution

**Lease**:
What `teamai workflow next` grants a **driver**: one **attempt** of a step, until the driver reports it. A prompt sent to a runtime carries the step's lease too.
_Avoid_: claim (that takes over a run), ticket

**Step workspace**:
The copy of the repository a step works in, as its `workspace` key picks: `new`, `continue`, `read-only`, `{ clone: … }` or `{ team: … }`. A step with `{ confined: … }` works in that directory instead, with no copy.
_Avoid_: bare workspace where a **workspace** could be meant

**Place**:
Where an **attempt** works: its **step workspace**, or what a **step runtime** makes around it, such as a container. The runtime opens it with `open` and names it by a handle.
_Avoid_: environment, box

**Held place**:
A **place** teamai keeps open after its step ends, because a later step continues the conversation there (`session: continue`) on a runtime that keeps conversations, such as T3 or Paseo. teamai closes it once no step continues it, at the end of the run, or on a **handoff**.
_Avoid_: "kept place", "pinned place"

**Composed runtime**:
One runtime entry that runs a **step runtime** through another, such as `use: t3` with `through: sandbox`, named `t3 through sandbox` in messages. The outer one, after `through`, gives where the tool runs; the inner one gives how it is launched.
_Avoid_: "nested runtime", "wrapper runtime"

**Sandbox provider**:
What runs the `sandbox` runtime's places, as a **sandbox profile**'s `provider` names it: `docker`, `podman`, `sbx`, `seatbelt`, `bwrap` or `vercel`.
_Avoid_: bare provider where a **model provider** or a **repo provider** could be meant

**Sandbox profile**:
What a `sandbox` runtime entry builds its sandbox from: a **sandbox provider** and its options, kept as `sandboxes/<name>.yaml` or a **resource folder** with its `SANDBOX.yaml` and the files it builds from. The entry names it with `sandbox: <name>`, `default` when it names none.
_Avoid_: sandbox config, sandbox options

**Provider instance**:
A tool as T3 Code or Paseo configures it, with its own command and home. A team's **tool instance** runs on one, which teamai adds when the app has none.
_Avoid_: bare provider, bare instance

**Fleet**:
The installs of the same business repository that take the **attempts** a run **offers** in a **pool**, through a `use: fleet` entry. The install that started the run is the **fleet owner**; each install that takes an attempt is a **fleet member**.
_Avoid_: cluster, workers

**Fleet owner**:
The install that offers a run's **attempts** to the **fleet** and takes their work back. Only it moves the workflow's branches. Short form: owner, where the fleet is the subject.
_Avoid_: coordinator, leader

**Fleet member**:
An install that takes an offered **attempt** with `teamai workflow resume --next --pool`, runs it on its machine with its own tools and sign-in, and pushes its work back. Short form: member, where the fleet is the subject; elsewhere a member is a person.
_Avoid_: worker, agent, runner (an install that takes a whole published run)

**Pool**:
A name the **fleet**'s **offers** go out under, `default` when none is set. A fleet entry offers in its own pool, and a **fleet member** takes from the pool it names.
_Avoid_: queue, channel

**Offer**:
An **attempt** or a run put on `teamai-reports` for another install to take: an attempt in a **pool**, or a whole run that `teamai workflow publish` offers to `resume --next`.
_Avoid_: job, listing

**Wake**:
The **fleet owner** asking a step runtime that reaches other machines, such as T3's linked environments, to start a **fleet member** for an **offer** nobody took. The member is sent one message: the command that takes one attempt.
_Avoid_: spawn, ping

**Handoff**:
A run passing to another **driver** or install. `teamai workflow publish` offers it on `teamai-reports`, and `resume --claim` or `--next` takes it. The local driver hands off a run whose steps left only a person can take, and the skill driver hands the person a run whose steps left it cannot run.
_Avoid_: transfer, migration

## Budgets

**Agent wait**:
The time an **agent** is blocked on teamai: the foreground pass of a hook, or a pull it runs. Work teamai does after the hook returns is not agent wait.
_Avoid_: latency, performance, overhead

**Agent wait budget**:
What a hook or a pull costs in **agent wait**, counted as the processes it starts and the files it writes, on its first run and on its second. The budget is those counts, never elapsed time; the time of each run and the file system calls each Node process made are recorded beside them for reference only.
_Avoid_: benchmark (that is `teamai benchmark`), perf test

**Hook form**:
How teamai writes its built-in hooks into one hook file: waited, through a login shell, as a project file a repository may commit always keeps them; unwaited, where the **tool** starts the hook and does not wait for it; or login-deferred, where the hook starts teamai without a login shell and the background pass gets the login environment. A **tool**'s facts and its installed version decide the form of the member's own file on macOS and Linux; on Windows it stays waited.
_Avoid_: hook mode, hook style

**Agent context budget**:
The bytes of text teamai's defaults put in an **agent**'s context, split by when they enter: always, through **progressive disclosure**, or on a hook event.
_Avoid_: token budget, prompt size
