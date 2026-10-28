# teamai command reference

Every public command the installed CLI accepts, rendered from its own command
table. Hidden commands are left out: they are hook plumbing the CLI runs itself,
never something to type. Flags marked `(hidden)` work but are absent from
`--help`, so treat this file — not `--help` — as the complete list of flags.

Generated: do not edit by hand. Regenerate with
`npx vitest run commands-reference -u` after changing a command or a flag.


## Global options

- `-V, --version` — output the version number
- `--dry-run` — Preview mode, no changes made; a command with no preview exits 1 without running
- `-v, --verbose` — Verbose output

## init

- `teamai init [repo]` — Initialize teamai (configure Git provider, clone repo, register member)
  - `--repo <repo>` — Team repo (alias of the positional argument)
  - `--http <url>` — Git-free HTTP team repo (read-only consumer; only needs an API key)
  - `--provider <name>` — Git provider for the team repo on this machine: tgit, github, cnb, gitlab, gitcode, or git. Skips auto-detection. `git` uses your existing Git auth and needs no platform token, but opens no PR/MR.
  - `--self` — Single-repo mode: the current git repo is the team repo (equivalent to `teamai init .`). Knowledge lives on main under .teamai/; reports go to the teamai-reports orphan branch.
  - `--token <key>` — API key for HTTP team repo / status reporting (stored 0600, never committed). Also reads TEAMAI_API_TOKEN.
  - `--scope <scope>` — Install scope: workspace (default, <cwd>/.teamai + <cwd>/.claude) or user (~/.teamai + ~/.claude); project is the older name for workspace
  - `--inherit-user-scope` — In workspace scope, also sync safe user-scope resources, load its env variables (not its secrets) in the workspace, and search its knowledge
  - `--no-inherit-user-scope` — Disable user-scope inheritance for this workspace
  - `--role <id>` — Primary role ID (e.g. hai_dev) for non-interactive setup
  - `--project <ids>` — Active logical project(s) from manifest/projects.yaml (comma-separated); scopes which project resources and learnings this directory syncs. Pass "all" to activate every project the manifest declares (a snapshot taken now)
  - `--agent <name>` — AI tools to set up (e.g. claude, codex, cursor, codebuddy, workbuddy, dsh). Repeatable or comma-separated. In single-repo mode, selects which tool dirs to create; a custom agent defined only in teamai.yaml's toolPaths also gets its root created here (git-backed init only — an HTTP init has no local teamai.yaml to read custom paths from). Omit for an interactive picker. Additive on repeated runs.
  - `--force` — Rewrite the existing config without confirmation, keeping the settings init does not set

## push

- `teamai push` — Push local resources to team repo
  - `--all` — Push all without confirmation
  - `--skill <path>` — Push a specific skill by path (e.g., ~/.claude/skills/hai/my-skill or skills/hai_dev/my-skill)
  - `--role <id>` — Namespace for every new resource type (skills/<id>/, rules/<id>/, docs/<id>/, env/<id>/, etc.). When the team has manifest/roles.yaml or manifest/projects.yaml, a role or project there must declare it for each type it places. Without --role, --project or --shared, the namespaces of your role and active projects decide
  - `--project <id>` — Target a project: each new resource goes to that project's namespace for its own type — skills, knowledge for rules, agents, learnings, docs, env, hooks, mcp, models, and more (from manifest/projects.yaml)
  - `--shared` — Place new resources at the shared root for all roles; cannot combine with --role or --project
  - `--branch <name>` — Push to this destination branch instead of a generated teamai/push branch
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

- `teamai list [type]` — List resources (skills|rules|docs|env|agents|hooks|mcp). For skills, --source local/all also scans installed AI agent skill directories.
  - `--source <src>` — Where to look for skills: repo | local | all
  - `--agent <name>` — Filter local agents by id (only applies to skills)
  - `--reveal` — Show env values in plaintext (default: masked)

## skill

- `teamai skill` — List and inspect skills (default: repo + installed agents, then the CLI-served catalog)
  - `teamai skill list` — List team and installed skills, then the built-in catalog the CLI serves
    - `--json` — Output the CLI-served built-in skill catalog as JSON
  - `teamai skill get [names...]` — Print built-in skill content served by the installed CLI
    - `--full` — Append the skill's references/ and templates/ files
    - `--all` — Print every skill the CLI serves
  - `teamai skill path <name>` — Print the packaged directory of a built-in skill (for scripts and templates)
  - `teamai skill show <name>` — Show skill metadata: source / contributors / installed agents / description
  - `teamai skill exclude` — Manage per-user skill exclusion (skip sync without affecting team repo)
    - `teamai skill exclude list` — List excluded skills
    - `teamai skill exclude add <skills...>` — Add skill(s) to the exclude list
    - `teamai skill exclude remove <skills...>` — Remove skill(s) from the exclude list

## members

- `teamai members` — Manage team members
  - `teamai members list` — List team members

## remove

- `teamai remove <type> <names...>` — Remove resource(s) from team repo and all local AI tools (type: skills|rules|agents|mcp)
  - `--force` — Skip confirmation prompt
  - `--role <ns>` — mcp: remove the server from mcp/<ns>/mcp.yaml instead of the root mcp/mcp.yaml
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
  - `--fix` — Remove lock files left behind by dead processes

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

- `teamai workflow` — Run a validated workflow from workflows/<name>.yaml. Writable steps may set deliver: pr to open review requests; TeamAI never merges them.
  - `teamai workflow start <name>` — Create a run. With --driver skill, the current coding session drives it; with --driver local, this process runs it headless, and in unattended mode (TEAMAI_MODE=unattended or CI) runs teamai score --drain once the run settles, before it exits, unless sessions.publish and session scoring are both off for unattended.
    - `--describe` — Show workflow metadata and required input schemas without creating a run. With --driver skill, also say how to start it: the start command, a question for the person, or the local driver.
    - `--driver <kind>` — Select skill for the current coding session, which then runs the commands each reply prints, or local for headless execution in this process.
    - `--parallel <n>` — With --driver skill: the most steps that run at once, as the describe reply offered
    - `--confirmed` — The person agreed to start this run, as the describe reply asked. From an agent session, an invoke: ask workflow starts only with it, with any driver; teamai takes the agent's word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot start an invoke: ask workflow, with or without it
    - `--hitl <mode>` — With --driver skill: who answers optional approvals and choices, as the describe reply offered: person (the agent asks the person; refused in an unattended run) or recommend (the agent answers). A required approval always goes to the person
    - `--no-judge` — With --driver skill: leave the scored steps unjudged on this machine, as the describe reply offered
    - `--tools <list>` — Override local prompt tools for this run, as comma-separated name=tool pairs. With --driver skill: only default=<tool>, the tool this coding session works in, which judges its scored steps and which its steps' models resolve for when teamai installs agents for it. Pass it when the describe reply says the session names no tool
    - `--auto-approve` — Answer optional approve HITL requests yes and choose requests with their default: with --driver local in this process, with --driver skill for this run. A required approval still goes to the person
    - `--inputs <json>` — Values for the inputs the workflow declares, as a JSON object, for example {"issue":42}. Every declared input is required.
  - `teamai workflow next <run>` — Get a lease, hitl, wait, or done JSON envelope. Show hitl.message and hitl.respond to a person, who replaces <option> with a choice.
    - `--prepare` — Prepare the leased workspace in its original checkout; report commits and pushes it automatically
    - `--attempt <attempt>` — With --prepare: prepare this attempt, which an earlier next leased this driver, instead of taking a new lease. wrong_attempt when the run no longer leases it to the driver. With --driver skill: the attempt of a place action, with --adopt
    - `--adopt <dir>` — With --prepare --attempt: prepare the attempt in <dir>, a place the host made: a clean worktree of this repository on the lease's workspace branch, or detached at its start. A place that does not fit answers adopt_mismatch and leaves the attempt leased. TeamAI never removes an adopted place. With --driver skill --attempt: adopt <dir> as the place action of that attempt asked, as its adopt prints it
    - `--json <payload>` — Driver identity, for example {"driver":{"kind":"local","machine":"host","workspace":"/work"}}. Optional: running, the attempt ids of its open leases the driver still runs (an open lease left out is handed back), canTakeLease, false to poll while a tool runs without taking a new lease, and driver.can, what the driver can do on this request: hitl (a person can answer HITL requests and work interactively), workspace, env (true, or "commands" when the driver scopes team env for command steps and setup only), setup, tokens, max_turns, network, isolation. An omitted key is not offered, so a step that needs it waits, and wait.held names what it lacks. Send driver.can on every next request, including busy polls. claim, true to take a run another install published from teamai-reports before leasing; a run this install owns stays as it is. Every answer lists in cancelled the running attempts whose tools the driver must stop.
    - `--driver <kind>` — skill: advance a run the current coding session drives, and print its turn: the actions to carry out and the command to run next
    - `--wait` — With --driver skill: wait until the run has something to show, up to 100 s. Run it in the background.
    - `--takeover` — With --driver skill: drive the run from this coding session instead of the one that drives it. Run it only when the person agrees, after an orchestrator_active answer
    - `--confirmed` — With --driver skill --takeover: the person agreed to take this run over, as the confirm_needed answer asked. From an agent session, a run of an invoke: ask workflow is taken over only with it; teamai takes the agent's word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot take over a run of an invoke: ask workflow, with or without it
    - `--choice <id>` — With --driver skill: answer the host question with the id of one of its options, as its run prints it
    - `--ack <offer>` — With --driver skill: acknowledge that the child of a dispatch started, as its ack prints it, so later turns stop offering it
  - `teamai workflow report <run>` — Report the outcome of a leased step. Prints a JSON envelope.
    - `--json <payload>` — attempt, revision, outcome (success, failed, or released), and driver
    - `--driver <kind>` — skill: report an attempt of a run the current coding session drives, as its turn printed the command
    - `--attempt <id>` — With --driver skill: the attempt to report
    - `--model-unavailable` — With --driver skill and --attempt: the host cannot run the model the dispatch names, so the step fails model_unavailable
  - `teamai workflow respond <run> <step> <choice>` — Answer a waiting approve (yes/no) or choose HITL request. A required HITL request accepts only the person's answer: from their own terminal, or declared by a driver UI, sent from outside an agent session. Prints one JSON envelope.
    - `--json <payload>` — Driver identity {"driver":{"kind":"ide","machine":"host","workspace":"/work"}} declares an answer a person gave in the driver UI, never one its agent chose. Records channel driver; sent from inside an agent session it records agent true, which a required HITL request refuses.
    - `--driver <kind>` — skill: answer an optional gate of a run the current coding session drives, as its choose action prints it, and print the turn. Records the agent's answer, which a required HITL request refuses
    - `--note <text>` — Keep a note with the answer, readable as steps.<id>.note
    - `--pass <n>` — Answer only this positive pass number; rejects an answered or replaced HITL request
  - `teamai workflow retry <run> <step>` — Retry a leased or stopped step, or a HITL request to answer it again, with a new pass and revision. A failed pull request delivery is retried in the same pass, without running the step again. Reopen its dependent steps and a settled run; keep earlier passes. After reopening, run resume or let your driver poll next. Prints one JSON envelope.
  - `teamai workflow resume [run]` — Continue a run with the local driver after retry, respond, or a stopped driver (Ctrl-C or closed terminal). Uses this machine's open local lease workspace, then the latest local driver's workspace on this machine, then cwd. Another live local driver returns driver_running. A settled run returns done. A run this machine does not have is taken from teamai-reports, where workflow publish put it; a published run continues only while this install owns it, else not_owner names the owner. With --driver skill, the current coding session continues the run instead, as after a skill start, and the reply is its first turn. In unattended mode, the local driver runs teamai score --drain once the run settles, as start does. Without a run id, fetches teamai-reports as pull does and lists the runs this checkout can resume: the runs teamai-reports offers for its business repository (origin), each with what holds it back, and this machine's running runs, each with the command to resume it.
    - `--next` — Instead of a run id: take the oldest run teamai-reports offers for this checkout's business repository (origin) that nothing refuses this caller, claim it, and drive it as resume <run> does; a workflow publish offers a running run until someone claims it. When nobody here would answer (an unattended run, TEAMAI_MODE=unattended or CI, or the local driver with no terminal) it skips a run whose steps left need a person: a required approval, an interactive step, or a choice with no default. It skips a run whose steps left require env with no value here and, with the local driver, one whose prompt steps left have no tool to run on here: none configured, or not on PATH; resume without --next lists each as cannot run here, with what gives it, and --next says on stderr why it left each run. With --driver skill it also skips a run that needs the local driver. Prints {"data":{"idle":{"offered":N}}} when it takes none, N being the offered runs it left
    - `--driver <kind>` — local, the default, to drive the run in this process, or skill for the current coding session, which then runs the commands each reply prints. An agent runs it only when the person agrees
    - `--parallel <n>` — With --driver skill: the most steps that run at once; 1 when left out
    - `--hitl <mode>` — With --driver skill: who answers optional approvals and choices: person (the agent asks the person; the default, refused in an unattended run) or recommend (the agent answers). A required approval always goes to the person
    - `--no-judge` — With --driver skill: leave the scored steps unjudged on this machine
    - `--tools <list>` — Override local prompt tools for this run, as comma-separated name=tool pairs. With --driver skill: only default=<tool>, the tool this coding session works in, which judges its scored steps and which its steps' models resolve for when teamai installs agents for it. Pass it when the describe reply says the session names no tool
    - `--auto-approve` — Answer optional approve HITL requests yes and choose requests with their default: with --driver local in this process, with --driver skill for this run. A required approval still goes to the person
    - `--claim` — Take the published run over from the install that owns it, replacing this machine's copy and releasing its leases
    - `--confirmed` — The person agreed to continue this run, as the confirm_needed answer asked. From an agent session, a run of an invoke: ask workflow continues only with it, with any driver; teamai takes the agent's word for it. In an unattended run (TEAMAI_MODE=unattended or CI) an agent cannot continue a run of an invoke: ask workflow, with or without it
  - `teamai workflow publish <run>` — Publish a run's state to teamai-reports so another member or a runner can continue it with workflow resume. A running run published from a checkout of its business repository (origin) is also offered: the first workflow resume --next in a checkout of that repository claims it, and any claim, or the owner's own workflow resume, takes the offer away, so two runners never take one run. Publish once you stop driving the run. The first publish makes this install the run's owner; publishing an unchanged run writes nothing. Refuses a run with records not yet on teamai-reports, or with a value that looks like a secret. Prints one JSON envelope with offered, and listing the leases still in flight.
    - `--sessions` — Also put the agent sessions that the run's unsettled steps continue (session: continue or session.from) in the team session archive, scrubbed, so whoever continues the run resumes them; listed in the envelope as sessions. Without it, those steps start new sessions on another machine
  - `teamai workflow cancel <run> [step]` — Cancel a whole run, or a pending, waiting, leased, running, or delivering step and its open descendants. Invalidates leases; drivers stop tools listed in next.cancelled. Prints one JSON envelope.

## score

- `teamai score` — Judge workflow passes with team scorers (scorers/<name>.md). Any driver takes judge work with --next, runs its own judge on the lease prompt with the lease evidence directory as its only readable root and settles it with --lease <ref> --submit, or judges it here with --lease <ref>. --run <id> --step <path> --scorer <name> judges a pass on demand. --scorer <name> [--session <id>] judges a finished agent session here: the one --session names, or, inside a session, the one its agent session variable names; it never guesses. --team-session <name> judges a session a member pushed instead. --label <value> labels the session by hand instead of judging it. With --json, it leases that session to the driver's own judge instead. workflow next never hands out judge work, and a driver never lists a judge ref in workflow next running. Prints one JSON envelope; --drain prints lines.
  - `--next` — Take judge work: workflow passes first, then finished sessions of each run mode whose scoring.sessions policy is auto (config.yaml, else scorers/scoring.yaml; by default off attended, auto unattended). An attended session is finished 6 hours after its last activity, an unattended one once a score --drain reached it. A lease has ref, source (workflow or session), scorer, subject, evidence, prompt, answer.schema, expiresAt, the cwd to submit from and a submit command line; else idle with counts. A batch lease, for scorers of one pass that share a judge call, has scorers and batched: true instead of scorer. --json {"driver":{"kind":"t3","machine":"host","workspace":"/work","can":{"judge":{"isolation":"verified","access":"read","tools":["claude"]}}},"running":["<ref>"]}. isolation is verified or best-effort; access is what your judge can do, answer (no tools), read (reads the evidence) or full (any tool), default full, and its labels record it; tools in your order of preference. running lists the judge refs you still run, which renews them; a live workflow lease of yours left out is handed back, and a session lease left out lapses: a session is judged once. A lease lapses 30 minutes after it was taken or renewed. Optional: run, a run id, to take only that run's workflow passes and never a session, from any directory, since the run's scope is found by its id; canTakeLease, false to renew running and take nothing, not even a lease handed back.
  - `--lease <ref>` — The judge lease, as --next printed it (s<13 hex>/a<8 hex>). Without --submit, judge it here with the tool the lease names, in a confined profile, and settle it through the submit path: --json {"driver":{…same as --next…}}.
  - `--submit` — Settle --lease <ref> with the payload {"driver":{…same as --next…},"outcome":"success","answer":{"label":"<one of answer.schema>","reasoning":"…"},"judge":{"tool":"claude","model":"…","usage":{"inputTokens":0,"outputTokens":0}}}. For a batch lease, answer is {"<scorer>":{"label":"…","reasoning":"…"},…} with one entry per scorer. outcome is success, failed, or released. A label a scorer does not list is refused, the whole answer with it, and the lease stays open; teamai computes score and passed.
  - `--json <payload>` — The payload as a JSON string
  - `--stdin` — Read the payload from stdin
  - `--run <id>` — Judge a pass of this run on demand, whatever sampling says, with --step and --scorer; this also reopens judge work that failed or expired. Without --queue, judges it here with the local judge and prints the label.
  - `--step <path>` — With --run: the step path, such as review or check.review
  - `--pass <n>` — With --run: the pass to judge; default the step's latest succeeded pass
  - `--session <id>` — Judge this finished session of an agent tool on this machine, whatever sampling says, with --scorer. Prints the session's first prompt and directory first, then the label; the session and the judge's reasoning are never published. With --json {"driver":{…same as --next…}}, prints a lease for your own judge, as --next does, instead of judging here; several --scorer need --batch. The lease is taken whatever sampling, the six idle hours, scoring.sessions, the scorer's sessions, an earlier label or daily_limit say, and counts toward the day's daily_limit. Nothing is taken when a scorer asks for more isolation than can.judge offers (isolation_unmet), when none of its tools runs a scorer's model (judge_model_unavailable), or while a live lease holds the work (busy).
  - `--source <platform>` — With --session: the tool that holds it, as session migrate --source names it (claude-code, codex, opencode, …); needed unless the agent session variable names that session, or the captures its session-start hook wrote here name one platform for it
  - `--team-session <name>` — Judge a session a member pushed with session push instead of one on this machine, by the name session list prints for this directory's repository: read from teamai-reports, else from the archive the team kept on its default branch before, and redacted before a judge reads it. Run session pull first for the newest. Its label is about the session where it ran, so it pairs with that session's labels from the machine that ran it, and records no agent. Not with --session, --source or --json
  - `--author <name>` — With --team-session: who pushed it, when two members pushed a session with that name
  - `--label <value>` — Label the session by hand with this value of the one --scorer: no judge runs, score and passed come from the scorer, and no reasoning is kept. A value the scorer does not list fails and lists the ones it does. A hand label and a model label of a session are kept side by side, so rescoring with the model never replaces yours; the dashboard Scorers page shows how often the model judge agrees with hand labels. Not with a scorer file, --batch or --json
  - `--scorer <name>` — With --run: a scorer the run pinned or one teamai pull cached. With --session, or alone inside a session: a scorer teamai pull cached, or a scorer file to try before pushing it: a path with / or ending in .md. A file's label is never stored, so it takes no --push; the output adds the labels stored for its scorer (stored) and its verdict on the session's first prompt alone (control). Repeatable.
  - `--queue` — With --run: leave the work to any driver's score --next instead of judging it here
  - `--batch` — With --run or --session: the scorers share one judge call when they resolve to the same tool and model
  - `--push` — Publish every pending label of this machine to scores/<member>/<YYYY-MM>.jsonl on teamai-reports, alone or after --session. Labels only: never the session, the prompt or the judge's reasoning. With usage reporting off, or when the push fails, they stay pending for the next --push.
  - `--drain` — What every unattended job runs before it ends, alone, in every scope this directory reaches: in unattended mode, finish each session captured unattended here; judge each pass and session a judge tool here can take, a failed judgment final and never retried; publish pending labels; where sessions.publish is auto for this run mode, archive, scrubbed, its finished sessions and the step sessions of its ended runs on teamai-reports; report usage to stats/<member>.yaml. Prints a line per kind of work and what it left for other drivers; exits 1 only when a judgment or a publish failed, and what stayed pending goes on the next --drain.

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
    - `--protocol <protocols>` — Comma-separated: anthropic, openai-chat-completions, openai-responses
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
    - `--scrub` — Redact secrets (tokens/keys/passwords) from the session before writing it
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
    - `--scrub` — Redact secrets before archiving (archived sessions are team-readable)
  - `teamai session pull` — Pull team sessions for the current project
    - `--repo-root <path>` — Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)
    - `--cwd <path>` — Working directory (defaults to current directory)
    - `--all` — Rebuild indexes for every repo in the team repo (not just the current project)
  - `teamai session list` — List team sessions for the current project
    - `--repo-root <path>` — Team repo clone that holds the session archive (default: the teamai install for this directory, else your user install)
    - `--cwd <path>` — Working directory (defaults to current directory)
    - `--author <name>` — Filter by author
    - `--all` — List sessions across all projects in the team repo (not just the current one)
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

## dashboard

- `teamai dashboard` — Start the AI coding session dashboard (Web UI)
  - `-p, --port <port>` — Port number

## bind-project

- `teamai bind-project` — Bind the current workspace to a ClawPro project for HTTP local-agent sync
  - `--project-id <id>` — Project ID from /projects/mine
  - `--skip` — Mark current workspace as skipped (never prompt again)

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
    - `--update-quality` — Find stale docs/rules/skills and suggest updates
    - `--dry-run` — Show what would be done without making changes
  - `teamai recall promote [learningId]` — Publish a high-confidence learning as new knowledge on a review branch, then mark it promoted
    - `--category <cat>` — Target category: skills | rules | docs; skills use <learningId>/SKILL.md
    - `--dry-run` — Show what would be done without making changes

## import

- `teamai import` — Import knowledge from local directories, remote repos, organizations, MRs, or iWiki
  - `--dir <path>` — Extract code knowledge from a local directory (same as --from-repo but no clone)
  - `--from-claude` (hidden) — Scan Claude/Cursor rule directories (the Claude root's rules/ — ~/.claude or the recorded toolRoots.claude — and ~/.cursor/rules)
  - `--from-mr <url...>` — Extract learning from one or more merged MRs/PRs and trigger incremental teamwiki update
  - `--no-discussions` — Leave the MR's review threads out of the extraction (with --from-mr)
  - `--from-iwiki <space-id-or-url>` — Import documents from iWiki Space ID or page URL (requires TAI_PAT_TOKEN)
  - `--resume` (hidden) — Resume an interrupted import session
  - `--all` — Accept all suggestions without interactive confirmation
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

## codebase

- `teamai codebase` — Inspect and maintain the teamwiki that `teamai import` writes
  - `--project <name>` (hidden) — Codebase slug under teamwiki/evidence/code/, required for --deep-enrich
  - `--upgrade-wiki` (hidden) — Migrate docs/team-codebase/ to teamwiki/ graph format
  - `--lint` — Run global consistency lint over the teamwiki knowledge graph
  - `--reconcile` — Reconcile product and code knowledge in teamwiki
  - `--deep-enrich` — Generate deep knowledge docs from extracted evidence
  - `--fix` (hidden) — Deprecated: teamwiki lint has no autofix; runs lint in report-only mode
  - `--status` — Show knowledge-base git baseline (headSha / repoUrl / branch)
  - `--severity <level>` (hidden) — Minimum severity to report: high|medium|low|info
  - `--json` — Output report as JSON (suitable for CI)
  - `--output <path>` (hidden) — Use <path>/teamwiki, as written by `teamai import --output <path>`, instead of the team repo's

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
  - `teamai ci extract-mr` — Extract knowledge from MR/PR and post as comment or write to team repo
    - `--url <url>` — MR/PR web URL
    - `--mode <mode>` — Operation mode: comment | write | both
    - `--team-repo <path>` — Team knowledge repo path (required for write mode)
    - `--comment-marker <marker>` — HTML comment anchor for idempotent updates
    - `--write-mode <mode>` — Write strategy: direct | pending-review
    - `--output <dir>` — Write artifacts to directory
    - `--individual-comments` — Post each suggestion as separate comment with reaction/resolve support
    - `--no-discussions` — Leave the MR's review threads out of the extraction
