# teamai command reference

Every public command the installed CLI accepts, rendered from its own command
table. Hidden commands are left out: they are hook plumbing the CLI runs itself,
never something to type. Flags marked `(hidden)` work but are absent from
`--help`, so treat this file — not `--help` — as the complete list of flags.

Generated: do not edit by hand. Regenerate with
`node scripts/check-docs.mjs --write` after changing a command or a flag.


## Global options

- `-V, --version` — output the version number
- `--dry-run` — Preview mode, no changes made; a command with no preview exits 1 without running
- `-v, --verbose` — Verbose output

## init

- `teamai init [repo]` — Initialize teamai (configure Git provider, clone repo, register member)
  - `--repo <repo>` — Team repo (alias of the positional argument)
  - `--http <url>` — Git-free HTTP team repo (read-only consumer; only needs an API key)
  - `--provider <name>` — Git provider for the team repo on this machine: tgit, github, cnb, gitlab, gitcode, or git. Skips auto-detection. `git` uses your existing Git auth and needs no platform token, but opens no PR/MR.
  - `--self` — Self mode: the current git repo is the team repo (equivalent to `teamai init .`). Knowledge lives on main under .teamai/; reports go to the teamai-reports orphan branch.
  - `--token <key>` — API key for HTTP team repo / status reporting (stored 0600, never committed). Also reads TEAMAI_API_TOKEN. With --http and a single --agent, an sk- token is kept for that agent only, next to the other agents' tokens (--force keeps them too); while that agent's current token still works it is kept and the new one is not used unless --replace-token is passed. Without --agent on a machine where one agent already holds a token, that agent takes it, or — keeping its working one — the new token serves the tools without a token of their own.
  - `--replace-token` — With --http and --token, use the supplied token without checking the old one. Only an sk- token changes: a shared key already replaced the old one, so the option has nothing to do for it. Other agents keep their tokens; the backend may invalidate this agent's old token.
  - `--scope <scope>` — Install scope: workspace (default, <cwd>/.teamai + <cwd>/.claude) or user (~/.teamai + ~/.claude); project is the older name for workspace
  - `--inherit-user-scope` — In workspace scope, also sync safe user-scope resources, load its env variables (not its secrets) in the workspace, and search its knowledge
  - `--no-inherit-user-scope` — Disable user-scope inheritance for this workspace
  - `--role <id>` — Primary role ID (e.g. hai_dev) for non-interactive setup
  - `--project <ids>` — Active logical project(s) from manifest/projects.yaml (comma-separated); scopes which project resources and learnings this directory syncs. Pass "all" to activate every project the manifest declares (a snapshot taken now)
  - `--agent <name>` — AI tools to set up (e.g. claude, codex, cursor, codebuddy, workbuddy, dsh). Repeatable or comma-separated. In self mode, selects which tool dirs to create; a custom agent defined only in teamai.yaml's toolPaths also gets its root created here (git-backed init only — an HTTP init has no local teamai.yaml to read custom paths from). Omit for an interactive picker. Additive on repeated runs, which ask before they rewrite the config; --force rewrites it without asking.
  - `--force` — Rewrite the existing config without confirmation, keeping the settings init does not set

## push

- `teamai push` — Push local resources to team repo
  - `--all` — Push all without confirmation
  - `--skill <path>` — Push a specific skill by path (e.g., ~/.claude/skills/hai/my-skill or skills/hai_dev/my-skill)
  - `--role <id>` — Namespace for every new resource type (skills/<id>/, rules/<id>/, docs/<id>/, env/<id>/, etc.). When the team has manifest/roles.yaml or manifest/projects.yaml, a role or project there must declare it for each type it places. Without --role, --project or --shared, the namespaces of your role and active projects decide
  - `--project <id>` — Target a project: each new resource goes to that project's namespace for its own type — skills, knowledge for rules, agents, learnings, docs, env, hooks, mcp, models, and more (from manifest/projects.yaml)
  - `--shared` — Place new resources at the shared root for all roles; cannot combine with --role or --project
  - `--branch <name>` — Push to this destination branch instead of a generated teamai/push branch
  - `--file <local file>` — Push exactly this local file, byte for byte, to the team path --path names, as a pull request. No other change in the team clone joins it; requires --path
  - `--path <team path>` — Where --file goes in the team repo, such as benchmarks/frontend/tasks/pod-startup.yaml or scorers/review.md. Placed exactly there, never relocated; cannot combine with --skill, --role, --project, --shared, --all or --carried
  - `--carried <path@blob>` — Override the stop for a push that would overwrite or delete a placed agent file a teammate changed. Use it only after carrying that change into your root copy, with the value the stop printed; a later team edit stops the push again. Repeatable

## pull

- `teamai pull` — Pull team resources and inject into local AI tools. Team docs land in sharing.docs.localDir: .teamai/docs/ in a workspace by default, a hidden directory, so search that path directly
  - `--silent` — Silent mode (for hooks)
  - `--force` — Force full sync even if repo is unchanged
  - `--team-ref <ref>` — Pin this workspace to a branch, tag or commit of the team repo; the default branch unpins it

## status

- `teamai status` — Show local vs team repo diff
  - `--all` — List every project data partition under ~/.teamai/projects (flags stale/orphan ones)

## list

- `teamai list [type]` — List resources (skills|rules|docs|env|agents|hooks|mcp|workflows). For skills, --source local/all also scans installed AI agent skill directories. Workflows show their source: team, teamai's default, or not runnable. A team folder over a teamai default shows how many of its files are its own and how many it inherits.
  - `--source <src>` — Where to look for skills: repo | local | all
  - `--agent <name>` — Filter local agents by id (only applies to skills)
  - `--reveal` — Show env values in plaintext (default: masked)
  - `--json` — Print the team repo's resources as JSON, env left out. Each file of a team folder over a teamai default has the layer it comes from: team or teamai

## skill

- `teamai skill` — List and inspect skills (default: repo + installed agents, then the CLI-served catalog)
  - `teamai skill list` — List team and installed skills, then the built-in catalog the CLI serves
    - `--json` — Output the CLI-served built-in skill catalog as JSON
  - `teamai skill get [names...]` — Print built-in skill content served by the installed CLI
    - `--full` — Append the skill's references/ and templates/ files
    - `--all` — Print every skill the CLI serves
  - `teamai skill path <name>` — Print the packaged directory of a built-in skill (for scripts and templates)
  - `teamai skill show <name>` — Show skill metadata: source / contributors / installed agents / description
  - `teamai skill exclude` — Manage per-user skill and MCP server exclusion (skip sync without affecting team repo)
    - `teamai skill exclude list` — List excluded skills and MCP servers
    - `teamai skill exclude add <skills...>` — Add skill(s) or MCP server(s) to the exclude list
    - `teamai skill exclude remove <skills...>` — Remove skill(s) or MCP server(s) from the exclude list

## members

- `teamai members` — Manage team members
  - `teamai members list` — List team members

## remove

- `teamai remove <type> <names...>` — Remove resource(s) from team repo and all local AI tools (type: skills|rules|agents|mcp)
  - `--force` — Skip confirmation prompt
  - `--role <ns>` — mcp: remove the server from namespace <ns> (mcp/<ns>/mcp.yaml or the folder mcp/<ns>/<name>/) instead of the root
  - `--project <id>` — mcp: remove the server from the project's mcp namespace instead of the root mcp/mcp.yaml

## packages

- `teamai packages [target]` — Install team npm packages and Claude plugins declared in teamai.yaml
  - `-g, --global` — Install an npm target globally (for CLI tools)
  - `--registry <url>` — Use a specific npm registry for this target
  - `--npm` — Treat an ambiguous target as an npm package
  - `--claude` — Treat the target as a Claude plugin
  - `teamai packages install [target]` — Install team npm packages and Claude plugins declared in teamai.yaml
    - `-g, --global` — Install an npm target globally (for CLI tools)
    - `--registry <url>` — Use a specific npm registry for this target
    - `--npm` — Treat an ambiguous target as an npm package
    - `--claude` — Treat the target as a Claude plugin

## doctor

- `teamai doctor` — Diagnose configuration issues, and print the run mode (attended or unattended) and what set it: TEAMAI_MODE, CI, or the default
  - `--json` — Output the report as JSON (suitable for CI)
  - `--fix` — Remove lock files left behind by dead processes, delete again the run branches a succeeded workflow run could not delete, remove what runs settled longer ago than workflows.retention left behind (branches but those a pull request uses, worktrees, kept refs, base pins on origin), remove the stored workflow folders no run and no pulled workflow uses, and remove the team hook entries a removed worktree of the repository left in HOME

## roles

- `teamai roles` — Manage team roles and resource namespaces
  - `teamai roles init` — Create a roles manifest for the team repo (admin)
  - `teamai roles list` — List all defined roles and your current role
    - `--json` — Print your effective roles and where they come from (assigned, default, local, none)
  - `teamai roles set <primary>` — Set your primary role (updates local config; refused when manifest/members.yaml assigns roles)
    - `--add <roles...>` — Additional roles to include
  - `teamai roles add <id>` — Add a new role to the manifest (admin)
    - `--namespaces <ns>` — Comma-separated resource namespaces (e.g. common,hai)
    - `-d, --description <desc>` — Description for the role
  - `teamai roles remove <id>` — Remove a role from the manifest (admin)
  - `teamai roles update <id>` — Update a role in the manifest (admin)
    - `--add-namespaces <ns>` — Comma-separated namespaces to add
    - `--remove-namespaces <ns>` — Comma-separated namespaces to remove
    - `-d, --description <desc>` — New description for the role

## projects

- `teamai projects` — Manage multi-project resource distribution (orthogonal to roles)
  - `teamai projects list` — List defined projects and the ones active in this directory
  - `teamai projects set [ids...]` — Set the projects active in this directory (comma-separated or repeated; empty to clear)
  - `teamai projects add <id>` — Add a project to manifest/projects.yaml, creating the file if needed (admin)
    - `--namespaces <ns>` — Comma-separated namespaces for knowledge, skills, learnings and agents (e.g. common,checkout); env, hooks, mcp, models, docs and wiki are declared by hand
    - `--name <name>` — Display name for the project
    - `-d, --description <desc>` — Description for the project
  - `teamai projects update <id>` — Update a project in manifest/projects.yaml (admin)
    - `--add-namespaces <ns>` — Comma-separated namespaces to add to knowledge, skills, learnings and agents
    - `--remove-namespaces <ns>` — Comma-separated namespaces to remove from knowledge, skills, learnings and agents
    - `--name <name>` — New display name for the project
    - `-d, --description <desc>` — New description for the project
  - `teamai projects remove <id>` — Remove a project from manifest/projects.yaml (admin)
  - `teamai projects members <id>` — List members registered for a project

## tags

- `teamai tags` — Manage tag-based skill/rule filtering
  - `teamai tags list` — List all available tags and subscription status
  - `teamai tags subscribe <tags...>` — Subscribe to tags (only matching skills/rules will be synced)
  - `teamai tags unsubscribe <tags...>` — Unsubscribe from tags
  - `teamai tags add <type> <name> <tags...>` — Add tags to a skill or rule in tags.yaml (admin)

  <type>  Resource type: "skills" or "rules"
  <name>  Name of the skill or rule (directory name)
  <tags>  One or more tags to add

  Examples:
    $ teamai tags add skills hai-deploy hai infra
    $ teamai tags add rules common-coding-style coding best-practices

  - `teamai tags remove <type> <name> <tags...>` — Remove tags from a skill or rule in tags.yaml (admin)

  <type>  Resource type: "skills" or "rules"
  <name>  Name of the skill or rule (directory name)
  <tags>  One or more tags to remove

  Examples:
    $ teamai tags remove skills hai-deploy infra
    $ teamai tags remove rules common-coding-style best-practices


## source

- `teamai source` — Manage cross-team skill sources
  - `teamai source add <repo>` — Add a cross-team source repo
    - `--name <name>` — Alias for this source
  - `teamai source remove <name>` — Remove a source and clean up its skills
  - `teamai source add-http <endpoint>` — Add an HTTP source (report/sync/ack) alongside a git main repo
    - `--token <key>` — API token for the HTTP endpoint (stored 0600, never committed)
    - `--replace-token` — Use --token without checking the old token. Only an sk- token changes: a shared key already replaced the old one. Other agents keep their tokens; the backend may invalidate this agent's old token.
    - `--agent <name>` — The AI tool this token is for (e.g. codebuddy, claude); hooks are injected into that tool only. Each agent keeps its own sk- token; a working token is kept unless --replace-token is passed.
    - `--force` — Overwrite an existing HTTP source config
  - `teamai source remove-http` — Remove the HTTP source and clean up its resources
  - `teamai source list` — List all configured sources
  - `teamai source browse <name>` — Browse public skills from a source

## update

- `teamai update` — Check for updates and upgrade teamai CLI
  - `--check` — Only check if an update is available, do not install

## uninstall

- `teamai uninstall` — Remove all teamai-managed resources and hooks from this machine
  - `--force` — Skip confirmation prompt
  - `--agent <name>` — Only uninstall this agent's resources in this checkout; shared resources, and the project's other checkouts, go only if it is the last tool

## script

- `teamai script` — Run a Node script the team declared in teamai.yaml
  - `teamai script run <event>` — Run preInit, postInit, prePull, postPull, or postDeploy for this checkout. preInit and postInit need a terminal. postInit then syncs MCP servers.

## env

- `teamai env` — Manage team environment variables
  - `--reveal` — Show env variable values in plaintext (default: masked)
  - `teamai env list` — List team environment variables
    - `--reveal` — Show env variable values in plaintext (default: masked)
  - `teamai env add <key> [value]` — Add or update a team environment variable, or declare a secret with --secret
    - `-d, --description <desc>` — Description for the variable or secret
    - `--secret` — Declare a secret in env/secrets.yaml: no value, each member sets their own
    - `--url <url>` — Where a member gets a value for the secret (with --secret)
    - `--role <ns>` — Write to env/<ns>/ instead of env/ (env.yaml, or secrets.yaml with --secret)
    - `--project <id>` — Write to the project's env namespace (resources.env in manifest/projects.yaml)
  - `teamai env remove <key>` — Remove a team environment variable or declared secret
    - `--secret` — Remove the declared secret only (env/secrets.yaml), for a key env.yaml also sets
    - `--role <ns>` — Remove from env/<ns>/ instead of env/
    - `--project <id>` — Remove from the project's env namespace (resources.env in manifest/projects.yaml)
  - `teamai env set <key>` — Set your value for a secret the team declares, or an env variable it sets, for this directory's team, on this machine (prompts without echo)
    - `--stdin` — Read the value from piped stdin
    - `--from-env <var>` — Read the value from this environment variable each time it is used; no copy is stored
    - `--global` — Set a secret for every team on this machine; a value set for a team still wins
  - `teamai env unset <key>` — Remove your value for a secret or env variable, for this directory's team, from this machine
    - `--global` — Remove the value set for every team on this machine instead
  - `teamai env exec <command...>` — Run a command with this directory's team env variables and secrets (put -- before the command)

## workflow

- `teamai workflow` — Run a validated workflow from workflows/<name>.yaml or the folder workflows/<name>/WORKFLOW.yaml. Writable steps may set deliver: pr to open review requests; TeamAI never merges them.
  - `teamai workflow start <name>` — Create a run. With --driver skill, the current coding session drives it; with --driver local, this process runs it headless, and in unattended mode (TEAMAI_MODE=unattended or CI) runs teamai score --drain once the run settles, before it exits, unless sessions.publish and session scoring are both off for unattended.
    - `--describe` — Show workflow metadata and required input schemas without creating a run. With --driver skill, also say how to start it: the start command, a question for the person, or the local driver.
    - `--driver <kind>` — Select skill for the current coding session, which then runs the commands each reply prints, or local for headless execution in this process.
    - `--parallel <n>` — With --driver skill: the most steps that run at once, as the describe reply offered
    - `--confirmed` — The person agreed to start this run, as the describe reply asked. From an agent session, an invoke: ask workflow starts only with it, with any driver; teamai takes the agent's word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot start an invoke: ask workflow, with or without it
    - `--hitl <mode>` — With --driver skill: who answers optional approvals and choices, as the describe reply offered: person (the agent asks the person; refused in an unattended run) or recommend (the agent answers). A required approval always goes to the person
    - `--no-judge` — With --driver skill: leave the scored steps unjudged on this machine, as the describe reply offered
    - `--tools <list>` — Override local prompt tools for this run, as comma-separated name=tool pairs, such as default=claude,review=codex. With --driver local the run remembers them on this install, and resume uses them. With --driver skill: only default=<tool>, the tool this coding session works in, which judges its scored steps and which its steps' models resolve for when teamai installs agents for it. Pass it when the describe reply says the session names no tool
    - `--auto-approve` — Answer optional approve HITL requests yes and choose requests with their default, for this run: with --driver local the run remembers it on this install, and resume uses it. A required approval still goes to the person
    - `--inputs <json>` — Values for the inputs the workflow declares, as a JSON object, for example {"issue":42}. Every declared input is required, except one the workflow's defaults.inputs gives a value.
    - `--timeout <duration>` — The longest the run may take, such as 30m or 2h: its steps stop and it fails with timeout once the shorter of this and the workflow's own timeout passes. Its finally steps still run after.
    - `--sandbox` — With --driver local, declare this machine a sandbox for this run: a disposable host such as a CI runner or container, where benchmark trials and steps that need sandbox isolation may run. The run remembers it on this install, and resume uses it; a claim on another machine does not. workflows.sandbox in config declares it for every process.
  - `teamai workflow next <run>` — Get a lease, hitl, wait, or done JSON envelope. Show hitl.message and hitl.respond to a person, who replaces <option> with a choice.
    - `--prepare` — Prepare the leased workspace in its original checkout; report commits and pushes it automatically. A step in a clone workspace, such as a benchmark trial, is leased only with --prepare: teamai makes the clone on this machine, installs its team resources and runs setup, and answers the lease with cwd, where the driver runs the step. So is a step that runs with a team role (role on its lease): teamai delivers the role into its copy. A step that requires strict sandbox isolation goes only to a driver that declares driver.can.isolation sandbox and driver.can.env true.
    - `--attempt <attempt>` — With --prepare: prepare this attempt, which an earlier next leased this driver, instead of taking a new lease. wrong_attempt when the run no longer leases it to the driver. With --driver skill: the attempt of a place action, with --adopt
    - `--adopt <dir>` — With --prepare --attempt: prepare the attempt in <dir>, a place the host made: a clean worktree of this repository on the lease's workspace branch, or detached at its start. A place that does not fit answers adopt_mismatch and leaves the attempt leased. TeamAI never removes an adopted place. With --driver skill --attempt: adopt <dir> as the place action of that attempt asked, as its adopt prints it
    - `--json <payload>` — Driver identity, for example {"driver":{"kind":"local","machine":"host","workspace":"/work"}}. Optional: running, the attempt ids of its open leases the driver still runs (an open lease left out is handed back), queued, those of them it has not started, whose own timeout then counts from this call (the answer gives their deadlines in deadlines), canTakeLease, false to poll while a tool runs without taking a new lease, and driver.can, what the driver can do on this request: hitl (a person can answer HITL requests and work interactively), workspace, env (true, or "commands" when the driver scopes team env for command steps and setup only), setup, tokens, max_turns, network, isolation, tools (the tools it launches a prompt step that names its tool on), end_turn (it ends a prompt's turn at the lease limits), role (it runs a step whose lease has role, the team role its copy runs with, on what teamai delivered there, with --prepare). An omitted key is not offered, so a step that needs it waits, and wait.held names what it lacks. Send driver.can on every next request, including busy polls. claim, true to take a run another install published from teamai-reports before leasing; a run this install owns stays as it is. Every answer lists in cancelled the running attempts whose tools the driver must stop.
    - `--driver <kind>` — skill: advance a run the current coding session drives, and print its turn: the actions to carry out and the command to run next
    - `--wait` — With --driver skill: wait until the run has something to show, up to 100 s. Run it in the background.
    - `--takeover` — With --driver skill: drive the run from this coding session instead of the one that drives it. Run it only when the person agrees, after an orchestrator_active answer
    - `--confirmed` — With --driver skill --takeover: the person agreed to take this run over, as the confirm_needed answer asked. From an agent session, a run of an invoke: ask workflow is taken over only with it; teamai takes the agent's word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot take over a run of an invoke: ask workflow, with or without it
    - `--choice <id>` — With --driver skill: answer the host question with the id of one of its options, as its run prints it
    - `--ack <offer>` — With --driver skill: acknowledge that the child of a dispatch started, as its ack prints it, so later turns stop offering it
  - `teamai workflow report <run>` — Report the outcome of a leased step. Prints a JSON envelope.
    - `--json <payload>` — attempt, revision, outcome (success, failed, or released), and driver. A prompt step's report also sends tool, the tool the driver launched, and durationMs (milliseconds around the tool launch) and cost ({"amount":0.12,"unit":"USD"}, only as the tool stated it) when known, and limit (timeout, budget or max_turns) when a limit in its lease's limits stopped the tool. queued, as on next: the attempts of its other open leases it has not started, whose own timeout then counts from this report.
    - `--driver <kind>` — skill: report an attempt of a run the current coding session drives, as its turn printed the command
    - `--attempt <id>` — With --driver skill: the attempt to report
    - `--model-unavailable` — With --driver skill and --attempt: the host cannot run the model the dispatch names, so the step fails model_unavailable
  - `teamai workflow respond <run> <step> <choice>` — Answer a waiting approve (yes/no) or choose HITL request. A required HITL request accepts only the person's answer: from their own terminal, or declared by a driver UI, sent from outside an agent session. Prints one JSON envelope.
    - `--json <payload>` — Driver identity {"driver":{"kind":"ide","machine":"host","workspace":"/work"}} declares an answer a person gave in the driver UI, never one its agent chose. Records channel driver; sent from inside an agent session it records agent true, which a required HITL request refuses. queued, as on next: the attempts of its open leases it has not started, whose own timeout then counts from this answer.
    - `--driver <kind>` — skill: answer an optional gate of a run the current coding session drives, as its choose action prints it, and print the turn. Records the agent's answer, which a required HITL request refuses
    - `--note <text>` — Keep a note with the answer, readable as steps.<id>.note
    - `--pass <n>` — Answer only this positive pass number; rejects an answered or replaced HITL request
  - `teamai workflow retry <run> <step>` — Retry a leased or stopped step, or a HITL request to answer it again, with a new pass and revision. A failed pull request delivery is retried in the same pass, without running the step again. Reopen its dependent steps and a settled run; keep earlier passes. After reopening, run resume or let your driver poll next. An isolated run, such as a benchmark run, cannot be retried; start a new one. Prints one JSON envelope.
  - `teamai workflow resume [run]` — Continue a run with the local driver after retry, respond, or a stopped driver (Ctrl-C or closed terminal), with the --tools, --auto-approve and --sandbox this install last drove it with, unless a flag overrides one. Uses this machine's open local lease workspace, then the latest local driver's workspace on this machine, then cwd. Another live local driver returns driver_running. A settled run returns done. A run this machine does not have is taken from teamai-reports, where workflow publish put it; a published run continues only while this install owns it, else not_owner names the owner. With --driver skill, the current coding session continues the run instead, as after a skill start, and the reply is its first turn. In unattended mode, the local driver runs teamai score --drain once the run settles, as start does. Without a run id, fetches teamai-reports as pull does and lists the runs this checkout can resume: the runs teamai-reports offers for its business repository (origin), each with what holds it back, and this machine's running runs, each with the command to resume it.
    - `--next` — Instead of a run id: take the oldest run teamai-reports offers for this checkout's business repository (origin) that nothing refuses this caller, claim it, and drive it as resume <run> does; a workflow publish offers a running run until someone claims it. When nobody here would answer (an unattended run, TEAMAI_MODE=unattended or CI, or the local driver with no terminal) it skips a run whose ready steps need a person now: a required approval, an interactive step, or a choice with no default (or any choice, without --auto-approve). A run whose person step is only possible later is taken; when it reaches one, the runner offers it back for a person and exits, and resume lists it as may need a person at <step>. It skips a run whose steps left require env with no value here and, with the local driver, one whose prompt steps left have no tool to run on here: none configured, or not on PATH, or that need a sandbox this machine does not declare (--sandbox or workflows.sandbox); resume without --next lists each as cannot run here, with what gives it, and --next says on stderr why it left each run. With --driver skill it also skips a run that needs the local driver. Prints {"data":{"idle":{"offered":N}}} when it takes none, N being the offered runs it left
    - `--driver <kind>` — local, the default, to drive the run in this process, or skill for the current coding session, which then runs the commands each reply prints. An agent runs it only when the person agrees
    - `--parallel <n>` — With --driver skill: the most steps that run at once; 1 when left out
    - `--hitl <mode>` — With --driver skill: who answers optional approvals and choices: person (the agent asks the person; the default, refused in an unattended run) or recommend (the agent answers). A required approval always goes to the person
    - `--no-judge` — With --driver skill: leave the scored steps unjudged on this machine
    - `--tools <list>` — With --driver local: override, a name at a time, the prompt tools this install last drove the run with, as comma-separated name=tool pairs, such as default=codex. The run remembers the result. With --driver skill: only default=<tool>, the tool this coding session works in, which judges its scored steps and which its steps' models resolve for when teamai installs agents for it. Pass it when the describe reply says the session names no tool
    - `--auto-approve` — Answer optional approve HITL requests yes and choose requests with their default: with --driver local the run remembers it on this install, with --driver skill for this run. A required approval still goes to the person
    - `--no-auto-approve` — With --driver local: stop answering optional HITL requests by auto-approve, though the run was started or last resumed with --auto-approve. The run remembers it
    - `--claim` — Take the published run over from the install that owns it, replacing this machine's copy and releasing its leases
    - `--confirmed` — The person agreed to continue this run, as the confirm_needed answer asked. From an agent session, a run of an invoke: ask workflow continues only with it, with any driver; teamai takes the agent's word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot continue a run of an invoke: ask workflow, with or without it
    - `--sandbox` — Declare this machine a sandbox for this run: a disposable host such as a CI runner or container, where benchmark trials and steps that need sandbox isolation may run. A run started or resumed with it on this install keeps it; a run claimed from another machine needs it again. workflows.sandbox in config declares it for every process.
  - `teamai workflow publish <run>` — Publish a run's state to teamai-reports so another member or a runner can continue it with workflow resume. A running run published from a checkout of its business repository (origin) is also offered: the first workflow resume --next in a checkout of that repository claims it, and any claim, or the owner's own workflow resume, takes the offer away, so two runners never take one run. Publish once you stop driving the run. The first publish makes this install the run's owner; publishing an unchanged run writes nothing. Refuses an isolated run, such as a benchmark run, a run of a private workflow, a run with a private step still open (private_open), a run with records not yet on teamai-reports, or one with a value that looks like a secret. Prints one JSON envelope with offered, and listing the leases still in flight.
    - `--sessions` — Also put the agent sessions that the run's unsettled steps continue (session: continue or session.from) in the team session archive, scrubbed, so whoever continues the run resumes them; listed in the envelope as sessions. Without it, those steps start new sessions on another machine
  - `teamai workflow cancel <run> [step]` — Cancel a whole run, or a pending, waiting, leased, running, or delivering step and its open descendants. Invalidates leases; drivers stop tools listed in next.cancelled. Prints one JSON envelope.

## self-improvement

- `teamai self-improvement` — Improve the team's harness from a scorer's repeated failures: change the resources teamai delivers so that work like the failing one passes, with one regression task per failure, proposed as one pull request on the team repo that the next run updates. run starts the workflow teamai-self-improvement, teamai's default or the team's file of that name.
  - `teamai self-improvement run <scorer>` — Start the workflow teamai-self-improvement with --inputs {"scorer":"<scorer>","suite":"<--suite>"} and drive it. A team's workflows/teamai-self-improvement.yaml replaces teamai's default, and must take inputs scorer and suite. The default reads digest --json --scorer and improves only when it says ready: two failures or more of the scorer in the last 30 days that a task can start from, or one more for a proposal already on origin. Its prompt step needs a sandbox, and runs in a fresh clone of the team repo on teamai/self-improvement/<scorer>, whose pull request it opens or updates. Prints the run's done envelope.
    - `--suite <dir>` — The suite the regression tasks go in, which the team repo's default branch must have
    - `--driver <kind>` — The driver that runs it: local, or skill, which only a team workflow with invoke: allow or ask accepts; teamai's default denies agents. Without it, workflows.driver decides, else local
    - `--tools <list>` — The tools its prompt steps run on, as workflow start --tools takes them, such as default=claude
    - `--sandbox` — With --driver local, declare this machine a sandbox for this run, where the prompt step, which edits files without asking, may run. The run remembers it on this install, so workflow resume keeps it. workflows.sandbox in config declares it for every process.

## benchmark

- `teamai benchmark` — Run a benchmark suite, and the commands its run's steps run. run starts the workflow teamai-benchmark, teamai's default or the team's file of that name, whose plan, check and report steps run the other commands; try needs no run.
  - `teamai benchmark run <suite>` — Plan benchmark suite <suite> without a run first, so a suite that cannot run leaves none, then start the workflow teamai-benchmark with --inputs {"suite":"<suite>","aliases":"team","tasks":[],"arms":[],"fail_on_regression":false} ("member" with --member-aliases; the ids --task and --arm name; true with --fail-on-regression) and the suite's timeout as --timeout, and drive it. A team's workflows/teamai-benchmark.yaml replaces teamai's default, and must take input suite; it gets aliases, tasks, arms and fail_on_regression only when it declares them. Prints the run's done envelope and, on stderr, the results. Exits 1 when the run failed or was cancelled, or a finally step, its report or its regression gate, failed or was cancelled; a record still pending publication never changes the exit code.
    - `--driver <kind>` — The driver that runs it: local, or skill. Without it, workflows.driver decides, else local
    - `--sandbox` — With --driver local, declare this machine a sandbox for this run, where the trials, which need strict sandbox isolation, may run. The run remembers it on this install, so workflow resume keeps it. workflows.sandbox in config declares it for every process.
    - `--member-aliases` — Resolve each arm's model alias with your own ~/.teamai/models/aliases.yaml over the team's models/aliases.yaml, which alone resolves them otherwise: starts the workflow with input aliases member instead of team. The results table and the record show member as the source of a model your file decided.
    - `--task <id>` — Run only this task of the suite: one baseline and its trials. Repeatable. Starts the workflow with input tasks, [] without it; a team file that takes no input tasks is refused.
    - `--arm <name>` — Run only this arm of the suite. Repeatable. Starts the workflow with input arms, [] without it; a team file that takes no input arms is refused.
    - `--fail-on-regression` — Also exit 1 when an arm's pass rate dropped by more than chance against the newest earlier succeeded run of the suite published on teamai-reports with the same arms, trials paired by task and repetition as the dashboard's Compare pairs them, a pair left out when its task changed or two different judges decided it: starts the workflow with input fail_on_regression true, false without it, and its regression step fails. With no such run, print a notice and leave the exit code alone. A team file that takes no input fail_on_regression is refused.
  - `teamai benchmark try <task-file>` — Try one task file before it joins a suite, in a checkout of the suite's repo: setup and the check run at startingCommit, where the check must fail, and at solutionCommit, if set, with the protected paths as startingCommit has them, where it must pass. Reads the task file, the SUITE.yaml (or suite.yaml) two directories up from it and the files its check.add entries name in that suite directory, needs no teamai init, and creates no run. Exits non-zero naming the commit and the cause when either goes the wrong way.
  - `teamai benchmark plan <suite>` — The first step of a benchmark run: freeze the team revision this checkout last pulled, fetch every commit a trial reads into the commit cache, and print {"definition":{"definition","workflows"},"plan"}, the workflow the run's trials step runs and the plan its check and report steps read, and write the correctness scorers of tasks judged by successCriteria as files of the run, where teamai score plan reads them. Refuses a run with no timeout, or a longer one than the suite's: start it with workflow start --timeout.
    - `--aliases <whose>` — Whose aliases resolve the arms' model aliases: team (default), the team's models/aliases.yaml, or member, your ~/.teamai/models/aliases.yaml over the team's
    - `--tasks <json>` — The task ids to plan, as a JSON array such as ["fix-login"]; [] or absent plans every task. A name the suite does not have is refused, listing the ones it has.
    - `--arms <json>` — The arm names to plan, as a JSON array such as ["claude"]; [] or absent plans every arm. A name the suite does not have is refused, listing the ones it has.
  - `teamai benchmark report` — The finally step of a benchmark run: classify the trials of the plan the run measured, write the run's benchmark record into its run directory and, when usage reporting allows, publish it to teamai-reports, and print {"text","table","regression"}. The text says record: pending while the record waits for publication. With COMPARE=true in its environment, it compares the record with the newest earlier succeeded one of the suite on teamai-reports with the same arms, adds what it found to the text, each arm's compared and excluded pairs first, and sets regression to dropped, held or no_comparable; otherwise regression is off. Refuses a run whose plan this teamai cannot read.
  - `teamai benchmark check` — Run the check of the benchmark step this process runs as, in its clone: the files check.add names, then the task's check. A trial's check stores the trial's correctness label, decided by the check: the highest-scoring label when it passes, the lowest when it fails. On a task with successCriteria too, a passing check stores none, and the judge decides. Prints {"result":"passed"|"failed"|"could_not_run","cause","label"}: cause, when it could not run, is not_found, not_executable, signal, timeout, spawn_failed or prepare_failed (putting back the protected paths or writing check.add failed); label is the version of the label it stored; each is '' when it has none. Exits 0 once it decided; exits 1 when it could not check at all. Refuses a run whose plan this teamai cannot read.
    - `--baseline` — The check of a task's baseline, on its starting commit
    - `--trial` — The check of a trial, after its prompt, with the protected paths put back as the starting commit has them first

## score

- `teamai score` — Label a workflow pass or a finished agent session with team scorers (scorers/<name>.md or scorers/<name>/SCORER.md). --run <id>, --session <id> or --team-session <name>, with --scorer, starts the default workflow teamai-score for that subject with demand named (no sampling; a failed or expired judgment opens again), on the driver --driver or workflows.driver names, else local, and prints the labels it wrote. A run for a driver this machine does not run waits for it, and the command says how to drive it here. A person starts it from their own terminal: from an agent session the start answers invoke_denied, and an agent judges its session with /teamai-share-session instead. The pass, session, scorers and --label value are checked before any run starts. When only a judge step no tool here can run is left, it exits 1 with judge_pending and the labels already written; a scorer with no label exits 1 with its code. A scorer file (--scorer ./scorers/x.md, or ./scorers/x/SCORER.md for a scorer folder) starts the default workflow teamai-try-scorer instead, which judges the session and its first prompt alone and stores no label; from an agent session it answers invoke_denied, and an agent tries a scorer with /teamai-new-scorer. Prints one JSON envelope; --drain prints lines.
  - `--run <id>` — Label a pass of this run on demand, with --scorer: a scorer a step of the run lists, read at the team revision the run started from. Refused with step_ambiguous, step_not_found or pass_not_found as --step and --pass say, and with evidence_missing, naming each, when a commit or a session the pass recorded is no longer on this machine; no run starts and no label is written.
  - `--step <path>` — With --run: the step path, such as review or check.review; optional when the run lists the scorers on one step only
  - `--pass <n>` — With --run: the pass to judge; default the step's latest succeeded pass
  - `--session <id>` — Label this finished session of an agent tool on this machine, with --scorer, whatever sampling, scoring.sessions or an earlier label say; it counts toward daily_limit, which never refuses it. Prints the session's first prompt and directory first, then the label; the session and the judge's reasoning are never published.
  - `--source <platform>` — With --session: the tool that holds it, as session migrate --source names it (claude-code, codex, opencode, …); needed unless the agent session variable names that session, or the captures its session-start hook wrote here name one platform for it
  - `--team-session <name>` — Judge a session a member pushed with session push instead of one on this machine, by the name session list prints for this directory's repository: read from teamai-reports, else from the archive the team kept on its default branch before, and redacted before a judge reads it. Run session pull first for the newest. Its label is about the session where it ran, so it pairs with that session's labels from the machine that ran it, and records no agent. Not with --session or --source
  - `--author <name>` — With --team-session: who pushed it, when two members pushed a session with that name
  - `--label <value>` — Label the session by hand with this value of the one --scorer: the teamai-score run skips the stages and the judge, score and passed come from the scorer, and no reasoning is kept. A value the scorer does not list fails before any run starts and lists the ones it does. Honoured only in a run a person started. A hand label and a model label of a session are kept side by side, so rescoring with the model never replaces yours; the dashboard Scorers page shows how often the model judge agrees with hand labels. Not with a scorer file or --batch
  - `--scorer <name>` — With --run: a scorer a step of the run lists, read at the team revision the run started from. With --session or --team-session: a scorer teamai pull cached, or a scorer file to try before pushing it: a path with / or ending in .md, tried by a teamai-try-scorer run. A file's label is never stored, so it takes no --push; the output adds the labels stored for its scorer (stored) and its verdict on the session's first prompt alone (control). Files and scorer names go in separate commands. Repeatable.
  - `--driver <driver>` — With --run, --session or --team-session: the driver of the teamai-score run, or of the teamai-try-scorer run a scorer file starts, local or none, which only starts the run and leaves it to any driver's workflow next. Without it, workflows.driver decides, else local
  - `--batch` — With --run or --session: the scorers share one judge launch when they take the same model, stages, and preferred or required tool; a scorer with a check, or a correctness scorer of a benchmark, never does
  - `--push` — Publish every pending label of this machine to scores/<member>/<YYYY-MM>.jsonl on teamai-reports, alone or after the labels of --run or --session. Labels only: never the session, the prompt or the judge's reasoning. With usage reporting off, or when the push fails, they stay pending for the next --push. Also pushes what a workflow step with deliver: publish left on this machine while origin could not take it.
  - `--drain` — What every unattended job runs before it ends, alone, in every scope this directory reaches: in unattended mode, finish each session captured unattended here; start the default workflow teamai-finished-sessions on the driver workflows.driver names, else local (a run for a driver this machine does not run waits for it), which archives, scrubbed, and judges the finished sessions as sessions.publish and scoring.sessions say, and starts teamai-score again for each pass and session whose judging lapsed (a failed judgment final and never retried); publish pending labels and workflow run records; where sessions.publish is auto for this run mode, archive the step sessions of its ended runs on teamai-reports; report usage to stats/<member>.yaml. Prints a line per kind of work and what it left for other drivers; exits 1 only when a judgment, a publish or that run failed, and what stayed pending goes on the next --drain.
  - `teamai score plan` — A step of a teamai-score run: sample each scorer on the subject, group the sampled ones that share a judge launch and take the same stages, and open their marks for the run. A non-empty label input of the teamai-score run is a hand label of its one scorer, honoured only when a person started the root run. Prints {"groups":[{"subject","hand","scorers","model","ci","protected"}]}: empty when nothing is sampled, every scorer is judged or held, or past daily_limit for an auto demand. Refused outside a leased attempt of a teamai-score step.
    - `--subject <subject>` — run:<runId>:<step path>:<pass>, session:<source>:<sessionId> or team-session:<author>:<archive name>
    - `--scorers <json>` — A JSON array of scorer names; [] takes the scorers the pass's step lists, or for a session every scorer with sessions: true. On an auto demand, a scorer whose judging of the subject lapsed or waits for CI is taken whatever it samples
    - `--batch <bool>` — true: the scorers share a judge launch where they can; false: as the step, the workflow's defaults.scorers.batch and scoring.yaml say
    - `--demand <demand>` — auto: sample, and stop at daily_limit; named: someone asked, so every scorer is taken, a closed mark opens again, and daily_limit counts it but never refuses it
  - `teamai score evidence` — A step of a teamai-score run: write the evidence of one group into $TEAMAI_RUN_DIR/<attempt>/: the redacted transcript and diff, evidence.json, the rubric prompt, the answer schema, and confined.json with the isolation level the team, the scorers and this machine require, and the judge tool a benchmark plan requires, else the tools to prefer. Prints {"dir","rubric","schema","delivers"}. A hand label only resolves the subject. Fails evidence_missing when a commit or session the pass recorded is gone, evidence_empty when nothing of it was kept.
    - `--subject <subject>` — The group's subject, as plan printed it
    - `--scorers <names>` — The group's scorers, joined by , as plan printed them
  - `teamai score stage <stage>` — A step of a teamai-score run: one stage that may decide a delivered pass before its judge, check (the scorer's check on the delivered commit, stopped after 30 minutes), ci (a failed CI of its pull request) or protected (a protected-path refusal). Writes its record in the evidence directory and prints {"decided":true} or {"decided":false}; ci also prints "pending", true while CI has not finished, else false. A stage no scorer of the group takes runs nothing and prints {"decided":false}. A check that cannot run prints {"decided":true}, and label gives check_could_not_run.
    - `--evidence <dir>` — The evidence directory its evidence step printed
    - `--wait <duration>` — With ci: past this long since this machine first saw the CI pending, such as 2h, judge as if the pass had no CI
  - `teamai score label` — A step of a teamai-score run: the labels of one group, from the run's hand label when a person started the root run, else the first stage that decided it (check, ci, protected), else the judge's --answer, each checked against the answer schema and the pinned scorer, with score and passed computed here. Writes them with reasoning to <dir>/labels.json and prints {"labels":[{"scorer","label","code"}]}, one per scorer and no reasoning; code is check_could_not_run, ci_pending, judge_failed or judge_answer_invalid for a scorer with no label. A label a stage decided records judge kind stage. Exits 0 with codes. Refused outside a leased attempt of a teamai-score step.
    - `--evidence <dir>` — The evidence directory its evidence step printed
    - `--answer <json>` — The judge step's answer, as its output rendered it; '' when it gave none
    - `--judge <outcome>` — The judge step's outcome: success, failed, timed_out, cancelled, or '' when it was skipped
  - `teamai score write` — A step of a teamai-score run: check the labels label left in <dir>/labels.json again, then write them to scores/labels.jsonl, reasoning/ and the pending outbox, and close each scorer's mark: labelled, failed with its code, or waiting for CI. A label of a private or isolated run stays out of the outbox. Writes nothing when a label fails a check. Prints {"written":<n>}. Refused outside a leased attempt of a teamai-score step.
    - `--evidence <dir>` — The evidence directory its evidence step printed
  - `teamai score publish` — A step of a teamai-score run, in the team workspace on teamai-reports with deliver: publish: stage this member's pending labels, without reasoning, into scores/<username>/<YYYY-MM>.jsonl of that checkout, merged by key with what origin's tip holds; the step publishes what it staged. A pending label origin's tip already holds, or holds a newer label of, leaves the outbox. Stages nothing with usage reporting off, for an http team repo, or outside a checkout of teamai-reports. Prints {"staged":<n>}. Refused outside a leased attempt of a teamai-score step.
  - `teamai score settle` — A step of a teamai-score run, after a verb of a group broke: record a failed attempt of each scorer whose mark the run holds, so automatic judging does not start the subject again. Works when evidence failed. Prints {"settled":<n>}.
    - `--subject <subject>` — The group's subject, as plan printed it
    - `--scorers <names>` — The group's scorers, joined by , as plan printed them
  - `teamai score report` — A step of a teamai-try-scorer run: the label each scorer file gave the session, read with its reasoning from the labels.json its teamai-score step left, beside the labels this scope keeps of that scorer on the session and the control's verdict on the session's first prompt alone. Stores nothing. Prints {"answer","text"}: answer is the envelope teamai score --scorer <file> prints, {"data":{"label","stored","control"}} for one file, by scorer for several, or {"error"} when the session got no label; text says it in lines.
    - `--labels <json>` — The labels output of the teamai-score step that judged the session
    - `--control <json>` — The labels output of the teamai-score step that judged its control
  - `teamai score subjects` — List subjects to start teamai-score on. --run <id> [--step <path>]: the judge-work passes of the run, settled on this machine, whose step says scorers.start: workflow, as {"list":["run:<runId>:<step path>:<pass>",…]}; --step is relative to the workflow of the step that runs this, and takes that step and every step inside it. --run <id> --calibration [--step <path>]: the trials of a benchmark run to calibrate its correctness judges on, as {"list":[{"subject":"run:<runId>:<step path>:<pass>","scorer":"teamai:correctness:<task>"},…]}: each trial of a task with a check and success criteria whose check failed, that the suite's calibration.rate samples by a hash of the run id and the trial's step. --lapsed: what teamai-finished-sessions scores again on this machine, as {"list":[{"subject":"<subject>","scorers":["<name>",…]},…]}: the passes and sessions whose mark lapsed (until the fourth lapse), those that waited for CI that has since finished, each with the scorers of those marks, named ones included, and the passes of a run inside its 14 days that no teamai-score run planned, with the unmarked scorers that sample them: one whose teamai-score run was started and never driven, and, once the run ended, one of a scorers.start: workflow step no step of its workflow scored.
    - `--run <id>` — The run whose passes to list
    - `--step <path>` — With --run: only that step and the steps inside it
    - `--calibration` — With --run: the benchmark trials to calibrate the correctness judges on, each with its scorer
    - `--lapsed` — This machine's subjects that automatic judging starts again

## hooks

- `teamai hooks` — Manage teamai hooks in AI tool settings
  - `teamai hooks list` — List hook install status + effective built-in (A) and team (B) hooks
  - `teamai hooks inject` — Inject teamai hooks into all AI tool settings
    - `--silent` — Silent mode (suppress success message)
  - `teamai hooks remove` — Remove teamai hooks from all AI tool settings

## mcp

- `teamai mcp` — Manage team MCP servers across AI tools
  - `teamai mcp list` — List team MCP servers and their per-tool install status
  - `teamai mcp inject` — Inject team MCP servers into all AI tool configs
    - `--dry-run` — Show what would change without writing
    - `--force` — Overwrite servers that collide with user-owned entries
  - `teamai mcp remove` — Remove all teamai-managed MCP servers from AI tool configs

## webhook

- `teamai webhook` — Manage webhook integrations for team notifications
  - `teamai webhook list` — List configured webhook endpoints
  - `teamai webhook test` — Send test event to webhook endpoints
    - `--url <url>` — Test specific endpoint URL

## models

- `teamai models` — Share gateway model profiles and switch agents to them
  - `teamai models list [profile]` — Show team and personal model profiles, or one profile, and the agents using them
  - `teamai models add <id>` — Add a personal model profile stored only on this machine
    - `--name <name>` — Display name
    - `--protocol <protocols>` — Comma-separated: anthropic, openai-chat-completions, openai-responses, gemini
    - `--base-url <url>` — Gateway root URL (without /v1)
    - `--model <ids>` — Comma-separated model IDs; the first is the default
    - `--from-env <name>` — Read the API key from this environment variable
    - `--api-key-stdin` — Read the API key from stdin without placing it in shell history
  - `teamai models configure <profile>` — Set the API key of a profile, or edit a personal profile
    - `--from-env <name>` — Read the API key from this environment variable
    - `--api-key-stdin` — Read the API key from stdin without placing it in shell history
    - `--name <name>` — Personal profiles: new display name
    - `--base-url <url>` — Personal profiles: new gateway root URL
    - `--protocol <protocols>` — Personal profiles: serve models over these protocols too
    - `--model <ids>` — Personal profiles: add model IDs
  - `teamai models switch [profile]` — Point agents at a model profile (every compatible agent by default); omit the profile to pick one
    - `--agent <name>` — Only switch this agent. Repeatable or comma-separated.
    - `--model <id>` — Default model to select (defaults to the first in the profile)
    - `--dry-run` — Show what would change without writing
  - `teamai models restore` — Restore agent model settings captured before the first TeamAI switch
    - `--agent <name>` — Only restore this agent. Repeatable or comma-separated.
    - `--dry-run` — Show what would change without writing
  - `teamai models remove <profile>` — Remove a personal model profile without changing agent settings

## stats

- `teamai stats` — Show local skill usage statistics
  - `--by-repo` — Break the local event log down per repository
  - `--by-time` — Show local event log activity by hour of day

## session

- `teamai session` — Session recording, cross-platform migration, and team sync
  - `teamai session save` — Record a privacy-scrubbed summary of a coding session to a local monthly log
    - `--session-id <id>` — Session to record (default: the agent's session, e.g. $CLAUDE_CODE_SESSION_ID, or the most recent)
    - `--push` — Also push the summary to the team repo (feeds `teamai digest`)
    - `--force` — Push even if the session is not flagged as valuable
    - `--include-prompt` — Include the redacted first-prompt line in the pushed summary (default: off)
    - `--scope <scope>` — Config scope for --push: user | workspace (default: auto-detect)
  - `teamai session platforms` — List supported and installed AI agent platforms
  - `teamai session migrate [sessionId]` — Migrate a session from one platform to another (or archive to same platform)
    - `-s, --source <platform>` — Source platform (e.g. claude-code, codebuddy)
    - `-t, --target <platform>` — Target platform
    - `--cwd <path>` — Working directory (defaults to current directory)
    - `--target-cwd <path>` — Override cwd for the target session
    - `--push` — Also push the migrated session to the team repo
    - `--repo-root <path>` — Team repo clone to archive into with --push (default: the teamai install for this directory, else your user install)
    - `--scrub` — Redact secrets (tokens/keys/passwords) from the session before writing it; with --push, also rewrite local paths in the archived copy
    - `--all` — Migrate every session from source (not just the 5 most recent)
    - `--limit <n>` — Max sessions to migrate (only caps --all; ignored otherwise)
    - `-y, --yes` — Skip confirmation prompts, including archiving unredacted transcripts
    - `--json` — Print one {data}|{error} JSON envelope on stdout; never prompts (needs a session id, -s and -t)
  - `teamai session push` — Push local sessions to the team repo
    - `--source <platform>` — Source platform to read sessions from
    - `--session <id>` — Push only this session of --source, from any workspace, redacted, without prompting, to teamai-reports of the teamai install for this directory (not with --all or --repo-root)
    - `--repo-root <path>` — Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)
    - `--cwd <path>` — Working directory (defaults to current directory)
    - `--limit <n>` — Max sessions to push (default: 5; ignored with --all or --session)
    - `--all` — Push every session of the platform across all workspace directories (ignores --limit)
    - `-y, --yes` — Skip confirmation prompts, including archiving unredacted transcripts (--all)
    - `--scrub` — Redact secrets and rewrite local paths (<repo>, ~, <tmp>) before archiving (archived sessions are team-readable)
  - `teamai session pull` — Pull team sessions for the current project
    - `--repo-root <path>` — Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)
    - `--cwd <path>` — Working directory (defaults to current directory)
    - `--all` — Rebuild indexes for every repo in the team repo (not just the current project)
  - `teamai session list` — List team sessions for the current project. With --finished, list instead the finished sessions of this machine that teamai-finished-sessions archives and judges, in the data home of this directory (inside a workflow step, of its run): each with its source, whether to publish it and the scorers to judge it with, and demand named when --scorers named them. A session teamai launched, such as a workflow step's, is never listed, nor a scorer whose mark is open or closed. With --finished --all, list every finished session of this machine to share learnings from, whatever the session policies and archive say, last active within --within, leaving out those a learning was contributed from, each with when it was last active and its first prompt, redacted; any run may list them, one an agent started too. With --suite, list instead the sessions a benchmark suite could take a task from, which teamai-sessions-to-tasks picks from.
    - `--repo-root <path>` — Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)
    - `--cwd <path>` — Working directory (defaults to current directory)
    - `--author <name>` — Filter by author
    - `--all` — List sessions across all projects in the team repo (not just the current one). With --finished: every finished session to share learnings from, not only those to archive and judge (no --publish or --scorers)
    - `--finished` — List the finished sessions of this machine to archive and judge, not the team's pushed ones
    - `--idle <duration>` — With --finished: how long an attended session has been idle to count as finished, such as 1h. Default: the idle of teamai-finished-sessions's params.yaml, 6h unless the team changed it. An unattended one counts once a drain reached it.
    - `--within <duration>` — With --finished --all: how recently a session was last active to be listed, such as 3d (default 7d)
    - `--publish <policy>` — With --finished: policy (sessions.publish for the session's run mode decides, the default), always or never. Inside a workflow step, only a run a person started may pass always or never.
    - `--scorers <json>` — With --finished: a JSON array of scorers to judge every finished session with, unsampled; [] (the default) takes the scorers scoring.sessions: auto names. Inside a workflow step, only a run a person started may name scorers.
    - `--suite <dir>` — With --finished --all, or for the team's pushed sessions of the suite's repository: list instead the sessions the benchmark suite in <dir>, such as benchmarks/fix-auth, could take a task from, each with its start and solution commits and the files and lines between them: only sessions with a recorded end, a start and an end with no tracked file modified, two different commits the suite's repo holds (fetched by SHA into the benchmark commit cache), and no task of the suite from the same session or solution commit; a learning contributed from one does not leave it out. Prints how many it left out and why
    - `--sizes <spec>` — With --suite: the largest S, M and L changes as lines,files, such as "S=40,3 M=200,10 L=800,30"; adds size, the smallest whose limits both fit the change, else XL
    - `--json` — With --finished: print {"list":[{"session","source","publish","scorers","demand"}]}; with --all, {"list":[{"session","source","ended","prompt"}]}; with --suite, {"list":[{...,"start","solution","files","lines","size"}],"leftOut":[{"reason","sessions"}]}, a pushed session's entry naming its teamSession and author
  - `teamai session show <sessionId>` — Print a session of this machine, your own or another, such as one session list --finished --all lists, or with --team-session one a teammate pushed: its transcript and its subagents', with the secrets this directory's teamai knows redacted, as a judge of it reads it. Exits 1 with session_not_found when no such session has anything to show.
    - `--source <platform>` — Platform a session of this machine belongs to, such as claude-code, codex or hermes. Not with --team-session
    - `--team-session <name>` — Show a session a member pushed with session push instead, by the name session list prints for this directory's repository, as teamai score --team-session reads it. Run session pull first for the newest. Not with --source
    - `--author <name>` — With --team-session: who pushed it, when two members pushed a session with that name
    - `--suite <dir>` — With --team-session: read it as pushed for the repository of the benchmark suite in <dir>, as session list --suite lists it, instead of for this directory's
    - `--cwd <path>` — Working directory (defaults to current directory)
    - `--json` — Print {"session","source","transcript"}, or {"error":{"code","message"}}
  - `teamai session resume <sessionName>` — Restore a team session to a local platform
    - `--platform <platform>` — Target platform to restore into
    - `--repo-root <path>` — Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)
    - `--cwd <path>` — Working directory for the restored session (defaults to current directory)
    - `--author <name>` — Author of the session (if ambiguous)
  - `teamai session search <query>` — Search team session content
    - `--repo-root <path>` — Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)
    - `--cwd <path>` — Working directory (defaults to current directory)
    - `--limit <n>` — Max results (default: 10)
    - `--all` — Search across all projects (not just current)
  - `teamai session rollback <sessionId>` — Rollback a migration (delete the target session)
    - `--platform <platform>` — Platform where the session was written
    - `--cwd <cwd>` — Only roll back the copy under this project path (default: all)

## digest

- `teamai digest` — Generate weekly team activity digest
  - `--json` — Print what an improvement starts from instead, as one JSON envelope: the failing score labels of the last 30 days, each with its subject and the commit its work started at, and each scorer's cohorts with the agreement of its model judge with hand labels. Never a judge's reasoning; a benchmark's labels are left out
  - `--scorer <name>` — With --json, also print data.improvement for this scorer: failures, its failures a regression task can start from (a recorded start commit this checkout has, and no task of --suite on the team repo's default branch or on an open --proposal names its subject), each subject once, newest first; covered, the tasks that name its other failures; refused, each failure no task can start from, with why: tracked_changes, not_recorded or not_in_checkout; and hasProposal, whether --proposal is open: origin has it, and its default branch neither merged it nor has each regression task it adds. The workflow's if decides from these whether it runs
  - `--suite <dir>` — With --scorer, the suite whose tasks cover a failure
  - `--proposal <branch>` — With --scorer, the team repo branch an open proposal is on, whose tasks cover failures too

## dashboard

- `teamai dashboard` — Start the AI coding session dashboard (Web UI)
  - `-p, --port <port>` — Port number

## bind-project

- `teamai bind-project` — Enroll the current workspace in HTTP local-agent sync and bind it to a ClawPro project. A workspace where this never ran is left alone
  - `--project-id <id>` — Project ID from /projects/mine
  - `--skip` — Enroll the current workspace without a project (never prompt again)

## contribute

- `teamai contribute` — Contribute session knowledge to team repo; projects list shows the default destination and allowed namespaces
  - `--file <path>` — Path to the contribution document
  - `--title <title>` — Title for the contribution document
  - `--namespace <ns>` — Write to an active learnings namespace, or to the shared root with "" (default: the only active namespace, or the shared root when none or several are active)
  - `--session-id <id>` — Session the learning came from (default: the agent's session, e.g. $CLAUDE_CODE_SESSION_ID). Recorded as `session` in the learning and counted as that session's outcome. Inside a workflow attempt, the learning is also recorded on the step
  - `--scope <scope>` — Target scope: user or workspace

## recall

- `teamai recall [query...]` — Search team learnings knowledge base
  - `--depth <level>` — Recall depth: route (entry-points only) | context (module-level, default) | lookup (full graph traversal)
  - `--check` — Relevance precheck only: print RELEVANT/NOT_RELEVANT + top score; no file reads, no upvote
  - `--caller <name>` (hidden) — Internal, set by the teamai-recall subagent to mark its own runs; do not pass it yourself
  - `teamai recall disable` — Disable automatic knowledge-base recall
  - `teamai recall enable` — Enable automatic knowledge-base recall
  - `teamai recall status` — Show recall feature status
  - `teamai recall feedback` — Record manual feedback for a recalled document
    - `--positive <docId>` — Upvote a document (marks as actually useful)
    - `--negative <docId>` — Record negative signal for a document
  - `teamai recall maintenance` — Automatic maintenance of team knowledge base
    - `--prune` — Remove low-confidence learnings
    - `--threshold <n>` — Confidence threshold for pruning (default 0.15)
    - `--archive` — Move to archive/ instead of deleting
    - `--confidence-writeback` — Update frontmatter confidence scores
    - `--update-quality` — Find stale docs/rules/skills and write a .draft.md update beside each: starts the default workflow teamai-draft-learning-updates on the driver workflows.driver names, else local, prints what it drafted, and exits 1 when an entry could not be drafted. --dry-run only lists the entries
    - `--json` — With --update-quality: print the run's JSON envelope instead of its text
    - `--dry-run` — Show what would be done without making changes
    - `teamai recall maintenance stale` — A step of a teamai-draft-learning-updates run: list the docs, rules and skills recalled often but rarely adopted, as --update-quality --dry-run does, on stderr. Prints {"entries":[{"doc_id","path","type","recalled_count","upvoted_count","user_count"}]}.
    - `teamai recall maintenance draft-context` — A step of a teamai-draft-learning-updates run: the content of one stale entry, and the learnings members adopted instead, as the prompt shows them. Prints {"content","related"}; related is empty when no learning was adopted. Fails when the entry cannot be read.
      - `--path <file>` — The entry, as stale printed its path
      - `--doc-id <id>` — The entry's doc_id, as stale printed it
    - `teamai recall maintenance write-draft` — A step of a teamai-draft-learning-updates run: write a draft update of one stale entry beside it, as <entry>.draft.md. Prints {"draft"}, its path.
      - `--path <file>` — The entry, as stale printed its path
      - `--draft <text>` — The draft's content
    - `teamai recall maintenance draft-report` — A step of a teamai-draft-learning-updates run: from the results of its draft step, what --update-quality prints: each entry it could not draft, and how to apply the drafts. Prints {"text","exit_code"}; exit_code is 1 when an entry could not be drafted.
      - `--results <json>` — The draft step's results, as a JSON array
    - `teamai recall maintenance promote-candidate` — A step of a teamai-promote-learning run: the learning to promote, as recall promote lists it, with its title, its content and the category its keywords suggest. Prints {"title","content","suggested"}. Exits 65, which fails its step as input_rejected, when it is not a candidate; fails when this workspace cannot publish one.
      - `--learning <id>` — The learning id, as recall promote lists it
    - `teamai recall maintenance promote-category` — A step of a teamai-promote-learning run: the category to promote to, and why: --given, else --chosen, else, when the AI could not choose, --suggested. Prints {"category","reason"}.
      - `--given <cat>` — The category recall promote --category gave, or ''
      - `--chosen <cat>` — The category the AI chose, or '' when it did not run or could not choose
      - `--reason <text>` — Why the AI chose it, or ''
      - `--suggested <cat>` — The category the learning's keywords suggest
    - `teamai recall maintenance promote-publish` — A step of a teamai-promote-learning run: write the promoted entry, push it on a teamai/push/ review branch, and open a pull request whose body says the category and why. With an empty --content the learning is published as written. Prints {"target","exit_code"}; exit_code is 1 when no pull request could be opened.
      - `--learning <id>` — The learning id, as recall promote lists it
      - `--category <cat>` — The category to promote to, as the category step chose it
      - `--reason <text>` — Why it is promoted to that category, as the pull request says it
      - `--content <text>` — The learning rewritten for its category, or '' to publish it as written
      - `--content-failure <message>` — Why the AI could not rewrite it, said when --content is empty
    - `teamai recall maintenance promote-mark` — A step of a teamai-promote-learning run: mark the learning as promoted to the entry publish pushed, and publish the mark to the learnings branch. Prints {"exit_code"}; it is 1 when the pull request or the mark could not be published.
      - `--learning <id>` — The learning id, as recall promote lists it
      - `--published <json>` — What the publish step printed: {"target","exit_code"}
  - `teamai recall promote [learningId]` — List the learnings ready to promote, high-confidence and adopted by several members, each with the category its keywords suggest; listing makes no AI call. With a learning id: starts the default workflow teamai-promote-learning on the driver workflows.driver names, else local. The AI picks the category, unless --category gives it, and rewrites the learning for it; the result is pushed on a review branch with a pull request that says the category and why, then the learning is marked promoted. Exits 1 when the learning is not a candidate. --dry-run only says where it would go
    - `--category <cat>` — Target category: skills | rules | docs; skills use <learningId>/SKILL.md. Without it, the AI picks one
    - `--dry-run` — Show what would be done without making changes

## import

- `teamai import` — Import knowledge from local directories, remote repos, organizations, MRs, AI tools' rules, or iWiki. --dir, --from-repo, --from-repo-list and --from-org start the default workflow teamai-import-from-repo; --from-tools starts teamai-import-rules and --from-iwiki teamai-import-from-iwiki, which ask you to accept, edit or skip each item unless --all is given
  - `--dir <path>` — Extract code knowledge from a local directory (same as --from-repo but no clone)
  - `--from-tools` — Import the rule files in the rules directory of every AI coding tool on this machine (~/.claude/rules, ~/.cursor/rules, ~/.codebuddy/rules, ...): the AI classifies each as a rule, doc or learning, and the accepted ones are pushed to the team repo's rules/, docs/ or learnings/
  - `--from-claude` (hidden) — Alias of --from-tools
  - `--from-mr <url...>` — Extract learning from one or more merged MRs/PRs and trigger incremental teamwiki update
  - `--no-discussions` — Leave the MR's review threads out of the extraction (with --from-mr)
  - `--from-iwiki <space-id-or-url>` — Import documents from iWiki Space ID or page URL (requires TAI_PAT_TOKEN): the AI classifies each as a rule, doc or learning, and the accepted ones are pushed to the team repo's rules/, docs/ or learnings/
  - `--resume` (hidden) — Replaced by teamai workflow resume <run>, which the import prints when it starts
  - `--all` — Accept all suggestions without interactive confirmation; needed where no person answers, such as inside a workflow step
  - `--output <path>` (hidden) — Write drafts to this directory instead of pushing to team repo; code knowledge goes to <path>/teamwiki
  - `--from-repo <url>` — Clone a remote repo and generate per-repo codebase summary
  - `--ssh` (hidden) — Force SSH clone even if HTTPS token is available
  - `--domain <name>` (hidden) — Skip AI recommendation and assign repo to this domain explicitly
  - `--from-repo-list <path>` — Batch import repos from a YAML whitelist
  - `--concurrency <n>` (hidden) — Concurrent repos for --from-repo-list (positive safe integer, default 3)
  - `--incremental` — Re-extract only files changed since the last import (with --dir, --from-repo or --from-repo-list; remote repos also reuse the cached clone)
  - `--skip-enrich` — Skip AI enrichment (only clone + extract + graph, no LLM calls)
  - `--max-files <n>` — Max source files collected per repository (default 200)
  - `--from-org <org>` — List repos under an org and generate a repo whitelist
  - `--max-repos <n>` (hidden) — Cap on repos pulled from --from-org (default 200)
  - `--exclude-archived` (hidden) — Exclude archived repos from --from-org (default true)
  - `--include-pattern <re>` (hidden) — Regex to include repos by full name (used with --from-org)
  - `--exclude-pattern <re>` (hidden) — Regex to exclude repos by full name (used with --from-org)
  - `--skip-import` (hidden) — Only write drafts; skip the actual --from-repo-list run
  - `--iwiki-dual` (hidden) — Enable dual-output mode for --from-iwiki (write codebase sections in addition to learning)
  - `--require-review` (hidden) — Defer codebase section writes to .teamai/pending-review.jsonl for human review
  - `--cache-status` — Show import cache status (repos cached, disk usage)
  - `--cache-gc` — Garbage-collect stale import cache entries
  - `--json` — Output cache status or GC result as JSON
  - `--max-bytes <n>` (hidden) — Override capacity cap for --cache-gc
  - `--stale-days <n>` (hidden) — Threshold for stale-eviction in days (default 30)
  - `teamai import scan-rules` — A step of a teamai-import-rules run: list the rule files in the user rules directory of every AI coding tool teamai supports. Prints {"candidates":[{"path","file"}]}.
  - `teamai import read-candidate` — A step of a teamai-import-learnings run: read the start of a file to classify, as much as the AI tool is shown. Prints {"content"}.
    - `--file <path>` — The file that holds the item's text
  - `teamai import classify-reply` — A step of a teamai-import-learnings run: read what the AI tool said a file is. A reply that is not the JSON asked for reads as personal, so the file is left out. Prints {"type","title","summary","tags","personal"}.
    - `--path <path>` — The path the file is shown as
    - `--reply <text>` — What the AI tool answered
  - `teamai import write-learnings` — A step of a teamai-import-learnings run: write each item that is not personal and was accepted, or edited with the note as its title, with its type in the frontmatter, into rules/, docs/ or learnings/ of the team repo by that type, or all into one directory. Prints {"kept","written"}.
    - `--classified <json>` — The results of the classify step
    - `--reviewed <json>` — The results of the review step; empty accepts every item
    - `--target <dir>` — The team repo, or the directory every item is written into
    - `--by-type <bool>` — true writes by type into rules/, docs/ and learnings/ of --target
  - `teamai import publish-rules` — A step of a teamai-import-rules run: commit and push what the import wrote into the team repo, then say the import is complete. Prints {}.
    - `--kept <n>` — How many items were not personal
    - `--written <json>` — The files the import wrote
    - `--target <dir>` — The team repo, or the directory every item was written into
    - `--by-type <bool>` — true when --target is the team repo, which is pushed
  - `teamai import fetch-mr` — A step of a teamai-import-from-mr run: read a merged MR or PR, with its review threads, as the extraction prompt shows it. Prints {"url","title","description","commits","diff","threads","thread_count","author","date"}.
    - `--url <url>` — The MR or PR URL: GitHub, TGit or GitLab
    - `--mrs <json>` — Every MR URL of the run, to say which of them this is
    - `--threads <bool>` — false leaves the review threads out
  - `teamai import draft-mr` — A step of a teamai-import-from-mr run: keep the learning the AI tool wrote for an MR in $TEAMAI_RUN_DIR, and say its title, its tags and the existing learnings it overlaps. Prints {"title","file","tags","overlaps","repo_url"}.
    - `--url <url>` — The MR or PR URL
    - `--title <title>` — The MR's title, the learning's title when its frontmatter has none
    - `--reply <markdown>` — What the AI tool answered
  - `teamai import publish-mr` — A step of a teamai-import-from-mr run: publish each accepted learning, or the edited one under the note as its title, as teamai contribute does, then update and push the teamwiki of each repository whose evidence the team repo holds; or write each into one directory. Prints {"published"}.
    - `--extracted <json>` — The results of the extract step
    - `--reviewed <json>` — The results of the review step; empty accepts every draft
    - `--target <dir>` — The team repo, or the directory every draft is written into
    - `--drafts <bool>` — true writes each draft into --target as learning.md and publishes nothing
  - `teamai import finish-mr` — A step of a teamai-import-from-mr run: sum up a run of several MRs and name each that failed. Prints {"text","exit_code","learnings"}: exit_code 1 when an MR failed.
    - `--extracted <json>` — The results of the extract step
  - `teamai import fetch-iwiki` — A step of a teamai-import-from-iwiki run: download the pages of an iWiki space, or one page, into $TEAMAI_RUN_DIR/iwiki/, with TAI_PAT_TOKEN. Prints {"source","documents","candidates":[{"path","file"}],"dual_context"}.
    - `--source <space-id-or-url>` — A numeric space id, or a page URL holding /p/<id>
    - `--dual <bool>` — true also prints the pages as the dual sections are asked about
  - `teamai import publish-iwiki` — A step of a teamai-import-from-iwiki run: link the imported pages to the teamwiki's code knowledge, then commit and push what the import wrote into the team repo. Prints {}.
    - `--kept <n>` — How many items were not personal
    - `--written <json>` — The files the import wrote
    - `--target <dir>` — The team repo, or the directory every item was written into
    - `--by-type <bool>` — true when --target is the team repo, which is pushed
    - `--documents <file>` — The JSON file of the documents the fetch-iwiki step printed
  - `teamai import write-sections` — A step of a teamai-import-from-iwiki run: write the business API, external knowledge and glossary sections the AI tool found into external-knowledge.md, or queue them in .teamai/pending-review.jsonl. Prints {}.
    - `--source <iwiki-url>` — iwiki://<id>, recorded in each section
    - `--reply <text>` — What the AI tool answered
    - `--failure <message>` — Why the AI tool did not answer, when it did not
    - `--sections-dir <dir>` — The directory that holds external-knowledge.md
    - `--review-dir <dir>` — The directory whose .teamai/pending-review.jsonl takes the sections with --review
    - `--review <bool>` — true queues the sections for teamai review instead of writing them
  - `teamai import stage` — A step of a teamai-import-from-repo run: fetch a repository into its clone cache, or read a local checkout, and extract it into a staging teamwiki under $TEAMAI_RUN_DIR, with no AI call. Prints {"slug","stage","updated","enrich","narrate","context","head","finished"}.
    - `--item <json>` — The item: {"kind":"repo"|"dir","source","domain","auth","slug","repo_url","mr_urls"}
    - `--settings <json>` — The run's settings: {"depth","ssh","incremental","skip_enrich","max_files","team_repo"}
    - `--wiki-root <dir>` — The teamwiki the item is imported into
  - `teamai import publish` — A step of a teamai-import-from-repo run: publish an item's staged evidence into the teamwiki, with the narrative the AI tool wrote for a repository and the domain its list entry names, then reconcile the teamwiki. Prints {"deep"}: whether deep enrich follows.
    - `--item <json>` — The item, as the stage step got it
    - `--settings <json>` — The run's settings, as the stage step got them
    - `--wiki-root <dir>` — The teamwiki the item is imported into
    - `--stage <dir>` — The staging directory the stage step printed
    - `--slug <slug>` — The codebase, its directory under evidence/code/
    - `--narrative <markdown>` — What the tool answered for a repository's narrative
    - `--narrative-failure <message>` — Why the tool could not answer for the narrative, when it could not
  - `teamai import finish-item` — A step of a teamai-import-from-repo run: say how an item's deep enrich ended and record the commit a repository was imported at. Prints {"deep_complete"}.
    - `--item <json>` — The item, as the stage step got it
    - `--settings <json>` — The run's settings, as the stage step got them
    - `--wiki-root <dir>` — The teamwiki the item is imported into
    - `--mode <mode>` — The command that started the run: dir, repo, list, org, update or ci
    - `--slug <slug>` — The codebase, its directory under evidence/code/
    - `--head <sha>` — The commit a repository was fetched at
    - `--deep <complete>` — What the deep-enrich run said: true, false, or empty when none ran
    - `--deep-failure <message>` — Why the deep-enrich run failed, when it did: the deep enrich did not finish
  - `teamai import finish` — A step of a teamai-import-from-repo run: once every item settled, rebuild the teamwiki indexes, publish the batch to the team repo, and sum it up. Prints {"text","exit_code","imported"}; exit_code is 1 when an item failed or its deep enrich did not finish.
    - `--mode <mode>` — The command that started the run: dir, repo, list, org, update or ci
    - `--wiki-root <dir>` — The teamwiki the items were imported into
    - `--settings <json>` — The run's settings
    - `--results <json>` — The results of the imports step
    - `--skipped <n>` — How many entries of the list were skipped before the run

## codebase

- `teamai codebase` — Inspect and maintain the teamwiki that `teamai import` writes
  - `--project <name>` (hidden) — Codebase slug under teamwiki/evidence/code/, required for --deep-enrich
  - `--upgrade-wiki` (hidden) — Migrate docs/team-codebase/ to teamwiki/ graph format
  - `--lint` — Run global consistency lint over the teamwiki knowledge graph, and count the member's resource relations (resources, relations, without a relation, unresolved)
  - `--reconcile` — Reconcile product and code knowledge in teamwiki
  - `--deep-enrich` — Generate deep knowledge docs from extracted evidence. In the team repo it starts the default workflow teamai-codebase-deep-enrich on the driver workflows.driver names, else local, which publishes the docs; an --output teamwiki is written by this process
  - `--fix` (hidden) — Deprecated: teamwiki lint has no autofix; runs lint in report-only mode
  - `--status` — Show knowledge-base git baseline (headSha / repoUrl / branch)
  - `--severity <level>` (hidden) — Minimum severity to report: high|medium|low|info
  - `--json` — Output report as JSON (suitable for CI)
  - `--output <path>` (hidden) — Use <path>/teamwiki, as written by `teamai import --output <path>`, instead of the team repo's
  - `teamai codebase deep-enrich-plan` — A step of a teamai-codebase-deep-enrich run: refuse a symbolic link on the way to the docs, drop the AI docs a newer extract made stale, and list what is still missing. Prints {"components":[{"slug","responsibilities","facts","call_chains","deps"}],"architecture":{"needed","modules","edges","interfaces"}}. Exits 65 when _manifest.json has no component.
    - `--wiki-root <dir>` — The teamwiki directory
    - `--codebase <slug>` — The codebase, its directory under evidence/code/
    - `--max-modules <n>` — Only the first n components of the manifest; 0 takes every one
  - `teamai codebase deep-enrich-write` — A step of a teamai-codebase-deep-enrich run: write one component's design doc, or the architecture overview, from what the AI tool answered, or say why it has none. Prints {"written"}.
    - `--wiki-root <dir>` — The teamwiki directory
    - `--codebase <slug>` — The codebase, its directory under evidence/code/
    - `--component <slug>` — The component whose doc this is
    - `--architecture` — The doc is the architecture overview
    - `--text <markdown>` — What the tool answered
    - `--failure <message>` — Why the tool could not answer, when it could not
  - `teamai codebase deep-enrich-graph` — A step of a teamai-codebase-deep-enrich run: write the deterministic graph docs and the G6 triples, and say whether the G5 scenarios are still to be asked for. Prints {"scenarios":{"needed","architecture","call_chains","modules"}}.
    - `--wiki-root <dir>` — The teamwiki directory
    - `--codebase <slug>` — The codebase, its directory under evidence/code/
    - `--max-modules <n>` — Only the first n components of the manifest; 0 takes every one
  - `teamai codebase deep-enrich-finish` — A step of a teamai-codebase-deep-enrich run: write the G5 scenarios from what the AI tool answered, the graph router, the teamwiki indexes and the quality reports, and say which AI docs are still missing. Prints {"text","exit_code","complete","missing_components","missing_architecture"}; exit_code is 1 when a doc is missing.
    - `--wiki-root <dir>` — The teamwiki directory
    - `--codebase <slug>` — The codebase, its directory under evidence/code/
    - `--max-modules <n>` — Only the first n components of the manifest; 0 takes every one
    - `--scenarios <markdown>` — What the tool answered for the scenarios
    - `--scenarios-failure <message>` — Why the tool could not answer for the scenarios, when it could not
  - `teamai codebase deep-enrich-publish` — A step of a teamai-codebase-deep-enrich run: commit and push the codebase's evidence and docs, with the teamwiki's router.md and index.md, to the team repo that holds the teamwiki. Prints {"pushed"}.
    - `--wiki-root <dir>` — The teamwiki directory
    - `--codebase <slug>` — The codebase, its directory under evidence/code/
  - `teamai codebase enrich-plan` — A step of a teamai-codebase-enrich run: list the modules of a codebase with at least five facts in the teamwiki's facts cache, which the last extract wrote. Prints {"modules":[{"name","files","components","interfaces"}],"interfaces"}.
    - `--wiki-root <dir>` — The teamwiki directory the codebase was extracted into
    - `--codebase <slug>` — The codebase, its directory under evidence/code/
  - `teamai codebase enrich-summary` — A step of a teamai-codebase-enrich run: read what the AI tool answered about each module, for the domain prompt. Prints {"count","project","modules"}; count is 0 when a module could not be asked or no answer parsed, and nothing is to be written.
    - `--codebase <slug>` — The codebase, its directory under evidence/code/
    - `--results <json>` — The results of the modules step
  - `teamai codebase enrich-write` — A step of a teamai-codebase-enrich run: write _manifest.json and _domains.json beside the codebase's evidence from what the AI tool answered. Prints {"modules","domain"}; modules is 0 when nothing was written.
    - `--wiki-root <dir>` — The teamwiki directory the codebase was extracted into
    - `--codebase <slug>` — The codebase, its directory under evidence/code/
    - `--results <json>` — The results of the modules step
    - `--domain <json>` — What the tool answered for the domain
    - `--domain-failure <message>` — Why the tool could not answer for the domain, when it could not

## review

- `teamai review [id]` — Inspect and process .teamai/pending-review.jsonl items; --dry-run validates apply decisions and previews rejections without writing documents or removing pending items. With --branch <name>, run read-only health checks on a team repo branch instead
  - `--apply` — Apply the change for the given id (only for codebase-section)
  - `--reject` — Reject the given id without applying
  - `--reason <msg>` — Reason for reject
  - `--all-apply` — Apply all items at or below --max-risk
  - `--max-risk <level>` — Risk ceiling for --all-apply: high|medium|low (default medium)
  - `--branch <name>` — Run read-only health checks on this team repo branch (e.g. teamai/push/<user>/<timestamp>) and report fail/warn/info findings
  - `--json` — Machine-readable output (dry-run decisions include dryRun: true; ok reports validation only; --branch prints the findings object)

## ci

- `teamai ci` — CI pipeline integration commands
  - `teamai ci extract-mr` — Extract knowledge from MR/PR and post as comment or write to team repo: starts the default workflow teamai-ci-extract-mr on the local driver, with no teamai init needed; a run with none takes --team-repo's teamai.yaml and workflows
    - `--url <url>` — MR/PR web URL
    - `--mode <mode>` — Operation mode: comment | write | both
    - `--team-repo <path>` — Team knowledge repo path (required for write mode)
    - `--comment-marker <marker>` — HTML comment anchor for idempotent updates
    - `--write-mode <mode>` — Write strategy: direct; pending-review has no effect and writes as direct does
    - `--output <dir>` — Write artifacts to directory
    - `--individual-comments` — Post each suggestion as separate comment with reaction/resolve support
    - `--no-discussions` — Leave the MR's review threads out of the extraction
  - `teamai ci comment` — A step of a teamai-ci-extract-mr run: post the drafted learning on the MR, as the comment --marker finds and updates or as its own comment, then the knowledge graph nodes of the source files the merge changed. Prints {}.
    - `--url <url>` — The MR or PR URL
    - `--learnings <json>` — The learnings output of the extract step
    - `--marker <marker>` — The HTML comment the MR comment is found and updated by
    - `--individual <bool>` — true posts the learning as its own comment, with reaction support
    - `--preview <bool>` — true says each comment instead of posting it
  - `teamai ci write` — A step of a teamai-ci-extract-mr run: update the team repo's teamwiki from the merged checkout when a source file changed, write the drafted learning into its learnings/, and commit and push both, leaving out what a reviewer rejected on an individual comment. Prints {}.
    - `--url <url>` — The MR or PR URL
    - `--learnings <json>` — The learnings output of the extract step
    - `--team-repo <path>` — The team repo's checkout
    - `--individual <bool>` — true reads the reactions on the individual comments
    - `--preview <bool>` — true says the learning's file and writes and pushes nothing
  - `teamai ci artifacts` — A step of a teamai-ci-extract-mr run: write the drafted learning into a directory as learning.md. Prints {}.
    - `--learnings <json>` — The learnings output of the extract step
    - `--dir <path>` — The directory
